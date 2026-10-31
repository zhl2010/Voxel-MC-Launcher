import fs from 'node:fs'
import path from 'node:path'
import {
  testSourcesSpeed,
  describeSources,
  fetchFromSources,
  SourceRouter,
  LIBRARY_SOURCES
} from './source-router.js'

// Fast, independent downloader for libraries. Sources are measured first (see source-router.js) so
// the worker pool always talks to the fastest reachable mirror, and switches away from a degrading
// or rate-limited source during the download.

const MAVEN_MIRRORS = [
  'https://bmclapi2.bangbang93.com/maven',
  'https://maven.fabricmc.net',
  'https://libraries.minecraft.net',
  'https://repo1.maven.org/maven2'
]
const LIBRARIES_MIRRORS = ['https://bmclapi2.bangbang93.com/maven', 'https://libraries.minecraft.net']
const FORGE_MIRRORS = ['https://bmclapi2.bangbang93.com/maven', 'https://maven.minecraftforge.net']
const NEOFORGE_MIRRORS = ['https://bmclapi2.bangbang93.com/maven', 'https://maven.neoforged.net/releases']

export const DEFAULT_CONCURRENCY = 16
export const MAX_CONCURRENCY = 32
export const MIN_CONCURRENCY = 4

/** `group:artifact:version[:classifier][@ext]` -> relative path inside `libraries/`. */
export function mavenRelativePath(coordinate) {
  const text = String(coordinate || '')
  const [withoutExt, ext = 'jar'] = text.split('@')
  const parts = withoutExt.split(':')
  if (parts.length < 3) return ''
  const [group, artifact, version, classifier] = parts
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`
  return path.join(...group.split('.'), artifact, version, file).replaceAll('\\', '/')
}

export function mirrorsFor(coordinate) {
  if (/^net\.minecraftforge:/.test(coordinate)) return FORGE_MIRRORS
  if (/^net\.neoforged:/.test(coordinate)) return NEOFORGE_MIRRORS
  if (/^net\.fabricmc:/.test(coordinate) || /^org\.quiltmc:/.test(coordinate)) return MAVEN_MIRRORS
  return LIBRARIES_MIRRORS
}

/** Shared adaptive limiter: 429 halves the concurrency, recover slowly on success. */
export class AdaptiveLimiter {
  constructor(concurrency = DEFAULT_CONCURRENCY) {
    this.concurrency = Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, concurrency))
    this.active = 0
    this.waiters = []
    this.penaltyUntil = 0
  }

  get effective() {
    return this.concurrency
  }

  async acquire() {
    const wait = Math.max(0, this.penaltyUntil - Date.now())
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    if (this.active < this.concurrency) {
      this.active += 1
      return
    }
    await new Promise((resolve) => this.waiters.push(resolve))
    this.active += 1
  }

  release() {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.shift()
    if (next) next()
  }

  /** A 429 means the mirror is unhappy: halve the pool and pause briefly. */
  penalize() {
    this.concurrency = Math.max(MIN_CONCURRENCY, Math.floor(this.concurrency / 2))
    this.penaltyUntil = Date.now() + 1_000
  }

  reward() {
    if (this.concurrency < MAX_CONCURRENCY) this.concurrency += 1
  }
}

class ProgressReporter {
  constructor(onProgress, kind) {
    this.onProgress = onProgress
    this.kind = kind
    this.done = 0
    this.failed = 0
    this.bytes = 0
    this.startedAt = Date.now()
    this.lastAt = 0
  }

  add(bytes) {
    this.bytes += bytes
  }

  finish() {
    this.done += 1
  }

  fail() {
    this.failed += 1
    this.done += 1
  }

  maybeReport(total, limiter) {
    const now = Date.now()
    if (now - this.lastAt < 1_000 && this.done !== total) return
    this.lastAt = now
    const elapsed = Math.max(0.001, (now - this.startedAt) / 1000)
    this.onProgress?.({
      kind: this.kind,
      done: this.done,
      total,
      failed: this.failed,
      bytes: this.bytes,
      speed: this.bytes / elapsed,
      concurrency: limiter?.effective
    })
  }
}

/**
 * Download one missing library from the mirrors into `<gameDir>/libraries`.
 * @returns {Promise<{ok: boolean, path?: string, error?: string, url?: string}>}
 */
export async function downloadLibrary(gameDir, coordinate, { timeout = 20_000 } = {}) {
  const relative = mavenRelativePath(coordinate)
  if (!relative) return { ok: false, error: `无法解析坐标：${coordinate}` }
  const target = path.join(gameDir, 'libraries', ...relative.split('/'))
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return { ok: true, path: target }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  let lastError = ''
  for (const mirror of mirrorsFor(coordinate)) {
    const url = `${mirror}/${relative}`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        if (response.status === 429) throw new RateLimitedError(url)
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (!buffer.length) {
        lastError = '空文件'
        continue
      }
      fs.writeFileSync(target, buffer)
      return { ok: true, path: target, url, bytes: buffer.length }
    } catch (error) {
      if (error instanceof RateLimitedError) throw error
      lastError = error?.message || String(error)
    }
  }
  return { ok: false, error: lastError || '所有镜像均失败' }
}

class RateLimitedError extends Error {
  constructor(url) {
    super(`HTTP 429（${url}）`)
    this.name = 'RateLimitedError'
    this.status = 429
  }
}

/**
 * Complete every missing library with a parallel pool.
 *
 * @returns {Promise<{downloaded: string[], failed: {name: string, error: string}[], skipped: string[], bytes: number}>}
 */
export async function downloadMissingLibraries(gameDir, missing, options = {}) {
  const {
    onProgress,
    onWarning,
    onLog,
    concurrency = DEFAULT_CONCURRENCY,
    signal,
    sources = LIBRARY_SOURCES
  } = options
  const downloaded = []
  const failed = []
  const skipped = []
  const queue = []

  for (const entry of missing) {
    const name = String(entry).replace(/（native）$/, '').trim()
    // Only Maven coordinates are libraries. Client jars (`26.3.jar`, `34.jar`) are handled by the
    // client-jar downloader — treating them as coordinates used to produce "无法解析坐标".
    if (/^[\w.-]+:[\w.-]+:[\w.+~-]+/.test(name)) queue.push(name)
    else skipped.push(name)
  }
  if (!queue.length) {
    return { downloaded, failed, skipped, bytes: 0 }
  }

  // 1. Measure the mirrors before downloading anything.
  const speed = await testSourcesSpeed(sources)
  onLog?.(describeSources(speed))
  const ordered = speed.sources.length ? speed.sources : sources
  if (!speed.sources.length) {
    onWarning?.('所有运行库下载源测速失败，按默认顺序尝试')
  }

  // 2. Route through the fastest source and degrade when it slows down or returns 429.
  const router = new SourceRouter(ordered, {
    onSwitch: ({ from, to, reason }) => onWarning?.(`运行库下载源切换：${from.name} → ${to.name}（${reason}）`)
  })
  const limiter = new AdaptiveLimiter(concurrency)
  const reporter = new ProgressReporter(onProgress, 'libraries')
  onWarning?.(
    `开始下载运行库：待下载 ${queue.length} 个（当前源 ${router.current.name}，并发 ${limiter.effective}${skipped.length ? `，跳过 ${skipped.length} 个非 Maven 项` : ''}）`
  )

  const total = queue.length
  const worker = async () => {
    while (queue.length > 0) {
      if (signal?.aborted) return
      const coordinate = queue.shift()
      if (!coordinate) continue
      const relative = mavenRelativePath(coordinate)
      if (!relative) {
        failed.push({ name: coordinate, error: '无法解析坐标' })
        reporter.fail()
        continue
      }
      const target = path.join(gameDir, 'libraries', ...relative.split('/'))
      try {
        if (fs.existsSync(target) && fs.statSync(target).size > 0) {
          reporter.finish()
          reporter.maybeReport(total, limiter)
          continue
        }
      } catch {
        // fall through to download
      }

      await limiter.acquire()
      let ms = 0
      let status = 0
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const result = await fetchFromSources(router.ordered, relative, {
          signal,
          onSourceError: ({ source, error }) => {
            if (String(error).startsWith('HTTP 4')) return
          }
        })
        if (result.buffer) {
          fs.writeFileSync(target, result.buffer)
          if (result.source && result.source.id !== router.current?.id) {
            onWarning?.(`运行库由备用源 ${result.source.name} 提供`)
          }
          downloaded.push(coordinate)
          reporter.add(result.buffer.length)
          reporter.finish()
          ms = result.ms
          router.record(ms, 0)
          limiter.reward()
        } else {
          failed.push({ name: coordinate, error: result.error })
          reporter.fail()
        }
      } catch (error) {
        status = error?.status || 0
        if (status === 429) {
          limiter.penalize()
          router.record(0, 429)
          try {
            const retry = await fetchFromSources(router.ordered, relative, { signal })
            if (retry.buffer) {
              fs.writeFileSync(target, retry.buffer)
              downloaded.push(coordinate)
              reporter.finish()
            } else {
              failed.push({ name: coordinate, error: retry.error })
              reporter.fail()
            }
          } catch {
            failed.push({ name: coordinate, error: 'HTTP 429' })
            reporter.fail()
          }
        } else {
          failed.push({ name: coordinate, error: error?.message || String(error) })
          reporter.fail()
        }
      } finally {
        limiter.release()
        reporter.maybeReport(total, limiter)
      }
    }
  }

  await Promise.all(Array.from({ length: limiter.effective }, worker))
  onProgress?.({
    kind: 'libraries-done',
    done: downloaded.length + failed.length,
    total,
    failed: failed.length,
    bytes: reporter.bytes,
    speed: 0,
    concurrency: limiter.effective,
    source: router.current?.name || ''
  })
  if (router.switches) onWarning?.(`运行库下载过程中切换了 ${router.switches} 次源，最终使用 ${router.current?.name}`)
  return { downloaded, failed, skipped, bytes: reporter.bytes }
}
