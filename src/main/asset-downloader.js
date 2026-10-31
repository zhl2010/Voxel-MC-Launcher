import fs from 'node:fs'
import path from 'node:path'
import {
  testSourcesSpeed,
  describeSources,
  fetchFromSources,
  SourceRouter,
  ASSET_SOURCES
} from './source-router.js'

// Fast, independent downloader for the assets a version needs. eml-lib's asset step compares every
// object hash one by one and runs at its own pace; high-version launches need thousands of small
// files, so they are fetched here with a worker pool and a speed-tested source list.

const META_MIRRORS = [
  'https://bmclapi2.bangbang93.com',
  'https://piston-meta.mojang.com'
]

/**
 * Make sure `<gameDir>/versions/<id>/<id>.jar` exists. The download URL and hash come from the
 * version JSON's `downloads.client`; the file must live at the version id path because Fabric and
 * Forge look the game jar up there.
 *
 * @returns {Promise<{ok: boolean, path: string, bytes?: number, error?: string}>}
 */
export async function downloadClientJar(manifest, gameDir, { id, timeout = 60_000 } = {}) {
  const versionId = id || manifest?.id
  if (!versionId) return { ok: false, path: '', error: '缺少版本号' }
  const client = manifest?.downloads?.client
  const target = path.join(gameDir, 'versions', versionId, `${versionId}.jar`)
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return { ok: true, path: target }
  if (!client?.url) return { ok: false, path: target, error: '版本 JSON 中没有客户端下载地址' }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  const mirrors = []
  try {
    const parsed = new URL(client.url)
    mirrors.push(`https://bmclapi2.bangbang93.com${parsed.pathname}`, client.url)
  } catch {
    mirrors.push(client.url)
  }
  let lastError = ''
  for (const url of mirrors) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        continue
      }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (!buffer.length) {
        lastError = '空文件'
        continue
      }
      fs.writeFileSync(target, buffer)
      return { ok: true, path: target, bytes: buffer.length, url }
    } catch (error) {
      lastError = error?.message || String(error)
    }
  }
  return { ok: false, path: target, error: lastError || '所有源均失败' }
}

export async function fetchAssetIndex(manifest, gameDir, { timeout = 20_000 } = {}) {
  const index = manifest?.assetIndex
  if (!index?.id) return null
  const target = path.join(gameDir, 'assets', 'indexes', `${index.id}.json`)
  if (fs.existsSync(target)) {
    try {
      return JSON.parse(fs.readFileSync(target, 'utf8'))
    } catch {
      // Re-download a corrupt index.
    }
  }
  const candidates = []
  // The JSON in the manifest points at Mojang; route its path through the mirror first.
  if (index.url) {
    try {
      const parsed = new URL(index.url)
      candidates.push(...META_MIRRORS.map((mirror) => `${mirror}${parsed.pathname}`))
    } catch {
      candidates.push(index.url)
    }
  }
  for (const url of candidates) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
      if (!response.ok) continue
      const text = await response.text()
      const data = JSON.parse(text)
      if (!data?.objects) continue
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text)
      return data
    } catch {
      // Try the next mirror.
    }
  }
  return null
}

/**
 * Download every missing asset object into `assets/objects/<ab>/<hash>`.
 *
 * @returns {Promise<{downloaded: number, failed: number, skipped: number, bytes: number}>}
 */
export async function downloadAssets(index, gameDir, options = {}) {
  const {
    concurrency = 32,
    onProgress,
    onWarning,
    signal,
    sources = ASSET_SOURCES
  } = options
  const objects = Object.values(index?.objects || {})
  const total = objects.length
  if (!total) return { downloaded: 0, failed: 0, skipped: 0, bytes: 0 }

  const pending = []
  let existingBytes = 0
  for (const asset of objects) {
    if (!asset?.hash) continue
    const relative = path.join('objects', asset.hash.slice(0, 2), asset.hash)
    const target = path.join(gameDir, 'assets', relative)
    let exists = false
    try {
      const stat = fs.statSync(target)
      // An object with the expected size is good enough; hashing 2000 files is too slow here.
      exists = !asset.size || stat.size === asset.size
      if (exists) existingBytes += stat.size
    } catch {
      exists = false
    }
    if (!exists) pending.push({ hash: asset.hash, size: asset.size || 0, relative, target })
  }
  if (!pending.length) return { downloaded: 0, failed: 0, skipped: total, bytes: 0 }

  onWarning?.(
    `开始下载游戏资源：待下载 ${pending.length}/${total} 个（并发 ${concurrency}，已存在 ${total - pending.length} 个）`
  )

  // Measure the asset mirrors using a real object hash so a 404 cannot skew the result.
  const probePath = pending[0] ? `${pending[0].hash.slice(0, 2)}/${pending[0].hash}` : ''
  const speed = await testSourcesSpeed(sources, { probePath })
  onWarning?.(describeSources(speed))
  const ordered = speed.sources.length ? speed.sources : sources
  const router = new SourceRouter(ordered, {
    onSwitch: ({ from, to, reason }) =>
      onWarning?.(`游戏资源下载源切换：${from.name} → ${to.name}（${reason}）`)
  })
  onWarning?.(`游戏资源当前源：${router.current?.name || '未知'}`)

  const state = {
    done: 0,
    failed: 0,
    bytes: 0,
    concurrency,
    startedAt: Date.now(),
    lastReportAt: 0
  }
  const queue = [...pending]

  const worker = async () => {
    while (queue.length > 0) {
      if (signal?.aborted) return
      const item = queue.shift()
      if (!item) continue
      const result = await downloadObject(item, state, router, signal)
      state.done += 1
      if (!result) state.failed += 1
      else router.record(result.ms, 0)
      reportAssets(state, pending.length, total, onProgress, router.current?.name || '')
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  if (router.switches) {
    onWarning?.(`资源下载过程中切换了 ${router.switches} 次源，最终使用 ${router.current?.name}`)
  }
  // The launcher's progress bar measures the whole asset index, so include already-present bytes.
  onProgress?.({
    stage: 'assets-done',
    done: pending.length,
    total: pending.length,
    failed: state.failed,
    bytes: state.bytes + existingBytes,
    speed: 0
  })
  return {
    downloaded: state.done - state.failed,
    failed: state.failed,
    skipped: total - pending.length,
    bytes: state.bytes,
    totalBytes: state.bytes + existingBytes
  }
}

function reportAssets(state, pendingTotal, total, onProgress, source = '') {
  onProgress?.({
    stage: 'assets',
    done: state.done,
    total: pendingTotal,
    largest: total,
    failed: state.failed,
    bytes: state.bytes,
    speed: state.bytes / Math.max(1, (Date.now() - state.startedAt) / 1000),
    source
  })
}

async function downloadObject(item, state, router, signal) {
  const relative = `${item.hash.slice(0, 2)}/${item.hash}`
  try {
    const result = await fetchFromSources(router.ordered, relative, { signal, timeout: 30_000 })
    if (!result.buffer) return null
    fs.mkdirSync(path.dirname(item.target), { recursive: true })
    fs.writeFileSync(item.target, result.buffer)
    state.bytes += result.buffer.length
    return { ms: result.ms, source: result.source }
  } catch (error) {
    if (error?.status === 429) router.record(0, 429)
    return null
  }
}
