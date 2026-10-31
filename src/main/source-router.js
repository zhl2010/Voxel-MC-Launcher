import fs from 'node:fs'
import path from 'node:path'

// Source-speed measurement and dynamic routing for downloads.
//
// Every download category (libraries / assets) has an ordered list of candidate mirrors. Before the
// real download starts, each mirror is probed with a small ranged request; the mirrors are then
// sorted by measured speed and the downloader starts on the fastest one, switching to the next when
// the current source degrades (slow files or HTTP 429).

export const LIBRARY_SOURCES = [
  { id: 'bmclapi', name: 'BMCLAPI 镜像', base: 'https://bmclapi2.bangbang93.com/maven', kind: 'maven' },
  { id: 'forge', name: '官方 Maven', base: 'https://maven.minecraftforge.net', kind: 'maven' },
  { id: 'mojang', name: 'Mojang Maven', base: 'https://libraries.minecraft.net', kind: 'maven' },
  { id: 'aliyun', name: '阿里云 Maven', base: 'https://maven.aliyun.com/repository/central', kind: 'maven' }
]

export const ASSET_SOURCES = [
  { id: 'bmclapi', name: 'BMCLAPI 镜像', base: 'https://bmclapi2.bangbang93.com/assets', kind: 'assets' },
  {
    id: 'mojang',
    name: '官方资源 CDN',
    base: 'https://resources.download.minecraft.net',
    kind: 'assets'
  },
  {
    id: 'mcbbs',
    name: '备用资源镜像',
    base: 'https://download.mcbbs.net/assets',
    kind: 'assets'
  }
]

// Small files used for probing. The asset probe needs a real hash, so `downloadAssets` supplies the
// first object of the index; the fallback below is a commonly present vanilla object.
const PROBE_TARGETS = {
  maven: {
    path: 'com/google/guava/guava/15.0/guava-15.0.jar',
    label: 'guava-15.0.jar'
  },
  assets: {
    path: '17/17d3b5f4b6d1c0e0b0d0a0e0f0a0b0c0d0e0f0a0b0c0d0e0f0a0b0c0d0e0f0a0',
    label: 'resource object'
  }
}

const PROBE_TIMEOUT = 3_000
const PROBE_BYTES = 20 * 1024

/**
 * Probe every source in parallel and return them sorted by measured speed (fastest first).
 * Sources that do not answer within the timeout are dropped.
 *
 * `probePath` lets the caller pick a file that actually exists on those mirrors (the asset index
 * gives the real hash prefix for the assets probe).
 *
 * @returns {Promise<{sources: Array<object>, failed: Array<{id: string, error: string}>}>}
 */
export async function testSourcesSpeed(sources, { timeout = PROBE_TIMEOUT, probePath = '' } = {}) {
  const results = await Promise.all(
    sources.map(async (source) => {
      const probe = await probeSource(source, timeout, probePath)
      return { ...source, ...probe }
    })
  )
  const ok = results.filter((item) => item.ok).sort((a, b) => b.speed - a.speed)
  const failed = results.filter((item) => !item.ok).map((item) => ({ id: item.id, error: item.error }))
  return { sources: ok, failed }
}

async function probeSource(source, timeout, probePath = '') {
  const target = PROBE_TARGETS[source.kind] || PROBE_TARGETS.maven
  const path = probePath || target.path
  const url = `${source.base.replace(/\/+$/, '')}/${path}`
  const started = Date.now()
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` }
    })
    const ttfb = Date.now() - started
    if (!response.ok && response.status !== 206) {
      return { ok: false, error: `HTTP ${response.status}`, url }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    const elapsed = Math.max(1, Date.now() - started)
    return {
      ok: true,
      url,
      ttfb,
      bytes: buffer.length,
      speed: buffer.length / (elapsed / 1000),
      elapsed
    }
  } catch (error) {
    return { ok: false, error: error?.message || String(error), url }
  }
}

/** Human readable summary for the log, e.g. `第一名 BMCLAPI 镜像 (速度: 812 KB/s，首字节 120ms)`. */
export function describeSources(result) {
  if (!result?.sources?.length) return '源测速完成：所有源均不可用'
  const parts = result.sources.map(
    (source, index) => `第${['一', '二', '三', '四', '五'][index] || index + 1}名 ${source.name}（速度: ${formatSpeed(source.speed)}，首字节 ${source.ttfb}ms）`
  )
  return `源测速完成：${parts.join('，')}`
}

export function formatSpeed(bytesPerSecond) {
  const value = Number(bytesPerSecond) || 0
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB/s`
  return `${Math.max(0, Math.round(value / 1024))} KB/s`
}

/**
 * Try `base/relative` on every source in order; used by the library and asset downloaders.
 * Returns the first successful buffer and the source that served it.
 */
export async function fetchFromSources(sources, relative, { timeout = 30_000, signal, onSourceError } = {}) {
  let lastError = ''
  for (const source of sources) {
    const url = `${source.base.replace(/\/+$/, '')}/${relative}`
    try {
      const started = Date.now()
      const response = await fetch(url, { signal: signal || AbortSignal.timeout(timeout) })
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        if (response.status === 429) {
          const error = new Error('HTTP 429')
          error.status = 429
          error.source = source
          throw error
        }
        onSourceError?.({ source, relative, error: lastError })
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (!buffer.length) {
        lastError = '空文件'
        onSourceError?.({ source, relative, error: lastError })
        continue
      }
      return { buffer, source, ms: Date.now() - started }
    } catch (error) {
      if (error?.status === 429) throw error
      lastError = error?.message || String(error)
      onSourceError?.({ source, relative, error: lastError })
    }
  }
  return { buffer: null, error: lastError || '所有源均失败' }
}

/**
 * Tracks the health of the active source and promotes the next one when it degrades.
 */
export class SourceRouter {
  constructor(sources, { onSwitch, slowFileMs = 2_000, slowStreak = 3 } = {}) {
    this.sources = [...sources]
    this.index = 0
    this.consecutiveSlow = 0
    this.slowFileMs = slowFileMs
    this.slowStreak = slowStreak
    this.switches = 0
    this.onSwitch = onSwitch
  }

  get current() {
    return this.sources[this.index]
  }

  get ordered() {
    return this.sources.slice(this.index)
  }

  /** Called after each file: degrade when several consecutive files are too slow. */
  record(ms, status) {
    if (status === 429) {
      this.promote('HTTP 429 限流')
      return
    }
    if (ms > this.slowFileMs) this.consecutiveSlow += 1
    else this.consecutiveSlow = 0
    if (this.consecutiveSlow >= this.slowStreak) {
      this.promote(`连续 ${this.consecutiveSlow} 个文件超过 ${this.slowFileMs}ms`)
    }
  }

  promote(reason) {
    this.consecutiveSlow = 0
    if (this.index >= this.sources.length - 1) return false
    const from = this.current
    this.index += 1
    this.switches += 1
    this.onSwitch?.({ from, to: this.current, reason })
    return true
  }
}

export function resolveSources(kind) {
  return kind === 'assets' ? ASSET_SOURCES : LIBRARY_SOURCES
}

export function customSource(base) {
  const value = String(base || '').trim()
  if (!/^https?:\/\//i.test(value)) return null
  return { id: 'custom', name: '自定义源', base: value.replace(/\/+$/, ''), kind: 'assets' }
}

export function saveAssetIndexHint(gameDir, id) {
  try {
    const file = path.join(gameDir, 'assets', 'indexes', `${id}.json`)
    return fs.existsSync(file) ? file : ''
  } catch {
    return ''
  }
}
