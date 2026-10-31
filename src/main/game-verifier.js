import fs from 'node:fs'
import path from 'node:path'

// Game file verification and repair. Disk-space failures during a download left half-written
// libraries and assets behind; this module reports what is missing vs. corrupt and repairs it using
// the same parallel downloaders the launcher uses.

const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024
const SIZE_TOLERANCE = 0.02
const SIZE_TOLERANCE_EXACT_LIMIT = 0

/**
 * @param {string} versionId
 * @param {{
 *   gameDir: string,
 *   manifest: object,
 *   assetIndex?: object|null,
 *   categories?: string[],
 * }} options
 * @returns {{
 *   ok: boolean,
 *   clientJar: {state: string, path: string, expected: number, actual: number},
 *   libraries: {ok: object[], missing: object[], corrupt: object[]},
 *   assets: {ok: number, missing: object[], corrupt: object[], total: number},
 *   summary: {ok: number, missing: number, corrupt: number}
 * }}
 */
export function verifyGameFiles(versionId, options) {
  const { gameDir, manifest, assetIndex = null, categories = ['client', 'libraries', 'assets'] } = options || {}
  const want = new Set(categories)
  const libraries = { ok: [], missing: [], corrupt: [] }
  const assets = { ok: 0, missing: [], corrupt: [], total: 0 }
  let clientJar = { state: 'skipped', path: '', expected: 0, actual: 0 }

  if (want.has('client')) {
    const jarPath = path.join(gameDir, 'versions', versionId, `${versionId}.jar`)
    const expected = Number(manifest?.downloads?.client?.size) || 0
    clientJar = checkFile(jarPath, expected)
    clientJar.path = jarPath
  }

  if (want.has('libraries')) {
    for (const library of manifest?.libraries || []) {
      if (!isLibraryAllowed(library)) continue
      const entry = libraryPath(library, gameDir, versionId)
      if (!entry) continue
      const expected = Number(entry.size) || 0
      const state = checkFile(entry.path, expected)
      const record = { name: library.name, path: entry.path, expected, actual: state.actual, native: entry.native }
      if (state.state === 'ok') libraries.ok.push(record)
      else if (state.state === 'missing') libraries.missing.push(record)
      else libraries.corrupt.push(record)
    }
  }

  if (want.has('assets') && assetIndex?.objects) {
    for (const asset of Object.values(assetIndex.objects)) {
      if (!asset?.hash) continue
      assets.total += 1
      const relative = path.join('objects', asset.hash.slice(0, 2), asset.hash)
      const target = path.join(gameDir, 'assets', relative)
      const state = checkFile(target, Number(asset.size) || 0)
      const record = { hash: asset.hash, path: target, expected: Number(asset.size) || 0, actual: state.actual }
      if (state.state === 'ok') assets.ok += 1
      else if (state.state === 'missing') assets.missing.push(record)
      else assets.corrupt.push(record)
    }
  }

  const missing =
    (clientJar.state === 'missing' ? 1 : 0) + libraries.missing.length + assets.missing.length
  const corrupt =
    (clientJar.state === 'corrupt' ? 1 : 0) + libraries.corrupt.length + assets.corrupt.length
  return {
    ok: missing === 0 && corrupt === 0,
    clientJar,
    libraries,
    assets,
    summary: {
      ok: libraries.ok.length + assets.ok + (clientJar.state === 'ok' ? 1 : 0),
      missing,
      corrupt
    }
  }
}

/**
 * Compare an existing file with its expected size. A file is `ok` when it exists and the size
 * matches the manifest value; when the manifest has no size (some loader artefacts), an existing
 * non-empty file counts as ok. Small size drift is tolerated to avoid false positives from
 * launchers that rewrite files.
 */
export function checkFile(filePath, expected = 0) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return { state: 'missing', path: filePath, expected, actual: 0 }
  }
  if (!stat.isFile()) return { state: 'missing', path: filePath, expected, actual: 0 }
  const actual = stat.size
  if (actual === 0) return { state: 'corrupt', path: filePath, expected, actual }
  if (!expected) return { state: 'ok', path: filePath, expected, actual }
  if (actual === expected) return { state: 'ok', path: filePath, expected, actual }
  const delta = Math.abs(actual - expected)
  const allowed = Math.max(SIZE_TOLERANCE_EXACT_LIMIT, expected * SIZE_TOLERANCE)
  if (delta <= allowed) return { state: 'ok', path: filePath, expected, actual }
  return { state: 'corrupt', path: filePath, expected, actual }
}

/** Disk space guard: refuse to download when the target drive is nearly full. */
export function checkDiskSpace(directory, minimum = MIN_FREE_BYTES) {
  try {
    const stat = fs.statfsSync(directory)
    const free = Number(stat.bavail) * Number(stat.bsize)
    return { ok: free >= minimum, free, minimum }
  } catch {
    try {
      let current = path.resolve(directory)
      for (let i = 0; i < 5 && !fs.existsSync(current); i += 1) current = path.dirname(current)
      const stat = fs.statfsSync(current)
      const free = Number(stat.bavail) * Number(stat.bsize)
      return { ok: free >= minimum, free, minimum }
    } catch {
      // Cannot determine: do not block the launch on an platform without statfs.
      return { ok: true, free: -1, minimum }
    }
  }
}

export function formatSize(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(0, Math.round(value / 1024))} KB`
}

function libraryPath(library, gameDir, versionId) {
  const nativeKey = library.natives?.[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux']
  if (nativeKey) {
    const classifiers = library.downloads?.classifiers || {}
    const key = nativeKey.replace('${arch}', process.arch.replace('x64', '64'))
    const artifact = classifiers[key] || classifiers[nativeKey]
    if (artifact?.path) {
      return { path: path.join(gameDir, 'libraries', ...artifact.path.split('/')), size: artifact.size, native: true }
    }
    return null
  }
  const artifact = library.downloads?.artifact
  if (artifact?.path) {
    return { path: path.join(gameDir, 'libraries', ...artifact.path.split('/')), size: artifact.size, native: false }
  }
  const [group, name, version, classifier] = String(library.name || '').split(':')
  if (!group || !name || !version) return null
  const fileName = `${name}-${version}${classifier ? `-${classifier}` : ''}.jar`
  return {
    path: path.join(gameDir, 'libraries', ...group.split('.'), name, version, fileName),
    size: 0,
    native: false
  }
}

function isLibraryAllowed(library) {
  if (!library?.rules) return true
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  let allowed = false
  for (const rule of library.rules) {
    if (rule.os?.name && rule.os.name !== osName) continue
    if (rule.os?.arch && rule.os.arch !== process.arch) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}

export { MIN_FREE_BYTES }
