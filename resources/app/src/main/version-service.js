import fs from 'node:fs'
import path from 'node:path'
import { fetchJson } from './fetcher.js'

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const CACHE_TTL = 10 * 60 * 1000

const FALLBACK_VERSIONS = [
  '26.3',
  '1.21.8',
  '1.21.4',
  '1.21.1',
  '1.20.6',
  '1.20.1',
  '1.19.4',
  '1.18.2',
  '1.16.5',
  '1.12.2',
  '1.8.9'
]

/**
 * Loads Mojang's version manifest, caches it on disk, and annotates versions that are already
 * present in the game directory. eml-lib performs the actual manifest download and installation;
 * this service exists so the renderer can offer a useful version picker.
 */
export class VersionService {
  constructor(gameDir) {
    this.gameDir = gameDir
    this.cache = null
    this.cacheTime = 0
    this.cacheFile = ''
    this.diskCache = null
  }

  init(userDataPath) {
    this.cacheFile = path.join(userDataPath, 'version-manifest-cache.json')
    this.loadDiskCache()
  }

  loadDiskCache() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'))
      if (parsed?.latest?.release && Array.isArray(parsed.versions)) {
        this.diskCache = parsed
        this.diskCache.savedAt = parsed.savedAt || 0
      }
    } catch {
      // No usable cache yet.
    }
  }

  async getVersions({ force = false } = {}) {
    const now = Date.now()
    let source = 'network'
    let error = null

    if (!force && this.cache && now - this.cacheTime < CACHE_TTL) {
      return this.format(this.cache, 'memory', null)
    }

    try {
      const data = await fetchJson(MANIFEST_URL, { timeout: 25_000, retries: 1 })
      if (!data?.latest?.release || !Array.isArray(data.versions)) {
        throw new Error('版本清单格式无效')
      }
      this.cache = data
      this.cacheTime = now
      this.saveDiskCache(data)
      this.diskCache = data
    } catch (caught) {
      error = caught
      source = 'cache'

      if (this.diskCache) {
        this.cache = this.diskCache
        this.cacheTime = now - CACHE_TTL + 60_000
      } else {
        source = 'fallback'
        const latest = { release: FALLBACK_VERSIONS[0], snapshot: FALLBACK_VERSIONS[0] }
        this.cache = {
          latest,
          versions: FALLBACK_VERSIONS.map((id) => ({
            id,
            type: 'release',
            releaseTime: new Date().toISOString()
          }))
        }
        this.cacheTime = now - CACHE_TTL + 60_000
      }
    }

    return this.format(this.cache, source, error)
  }

  format(data, source, error) {
    const installed = this.getInstalledVersions()
    const official = data.versions
      .filter((version) => version && typeof version.id === 'string')
      .map((version) => ({
        id: version.id,
        type: version.type || 'release',
        releaseTime: version.releaseTime || null,
        installed: installed.has(version.id),
        local: false
      }))
    const officialIds = new Set(official.map((version) => version.id))
    const local = this.getLocalVersions().filter((version) => !officialIds.has(version.id))

    return {
      latest: data.latest,
      versions: [...local, ...official],
      source,
      error: error ? String(error.message || error) : null,
      fetchedAt: new Date().toISOString()
    }
  }

  getLocalVersions() {
    const versionsDir = path.join(this.gameDir, 'versions')
    const local = []

    try {
      for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || isUnsafeVersionId(entry.name)) continue
        const jsonPath = path.join(versionsDir, entry.name, `${entry.name}.json`)
        if (!fs.existsSync(jsonPath)) continue
        try {
          const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''))
          const stats = fs.statSync(jsonPath)
          const type = json.type === 'snapshot' ? 'snapshot' : 'release'
          local.push({
            id: entry.name,
            type,
            releaseTime:
              typeof json.releaseTime === 'string'
                ? json.releaseTime
                : typeof json.time === 'string'
                  ? json.time
                  : stats.mtime.toISOString(),
            installed: true,
            local: true,
            baseVersion: detectBaseVersion(entry.name, json),
            loader: detectLoader(json)
          })
        } catch {
          // Ignore malformed local version metadata; the file remains on disk for PCL.
        }
      }
    } catch {
      // The game directory does not exist yet.
    }

    return local
  }

  getLocalVersion(id) {
    if (isUnsafeVersionId(id)) return null
    const jsonPath = path.join(this.gameDir, 'versions', id, `${id}.json`)
    try {
      if (!fs.existsSync(jsonPath)) return null
      return {
        id,
        path: jsonPath,
        json: JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''))
      }
    } catch {
      return null
    }
  }

  async resolveLocalVersion(id) {
    const local = this.getLocalVersion(id)
    if (!local) return null
    return this.resolveManifest(local.json, id, new Set())
  }

  async resolveManifest(json, id, seen) {
    if (seen.has(id)) throw new Error(`本地版本 ${id} 的 inheritsFrom 存在循环。`)
    seen.add(id)

    let manifest = { ...json }
    if (manifest.inheritsFrom) {
      const parentId = String(manifest.inheritsFrom)
      const localParent = this.getLocalVersion(parentId)
      const parent = localParent
        ? await this.resolveManifest(localParent.json, parentId, seen)
        : await this.fetchOfficialVersion(parentId)
      if (!parent) throw new Error(`找不到 ${id} 的父版本 ${parentId}。`)
      manifest = mergeVersionJson(parent, manifest)
    }

    manifest.id = id
    delete manifest.inheritsFrom
    return manifest
  }

  async fetchOfficialVersion(id) {
    try {
      let manifest = this.cache
      if (!manifest?.versions?.find((version) => version.id === id && version.url)) {
        manifest = await fetchJson(MANIFEST_URL, { timeout: 25_000, retries: 1 })
      }
      const entry = manifest?.versions?.find((version) => version.id === id)
      if (!entry?.url) return null
      return await fetchJson(entry.url, { timeout: 25_000, retries: 1 })
    } catch {
      return null
    }
  }

  getInstalledVersions() {
    const installed = new Set()
    const versionsDir = path.join(this.gameDir, 'versions')

    try {
      for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const jsonPath = path.join(versionsDir, entry.name, `${entry.name}.json`)
        if (fs.existsSync(jsonPath)) installed.add(entry.name)
      }
    } catch {
      // The game directory does not exist yet.
    }

    return installed
  }

  async hasVersion(id) {
    if (this.getInstalledVersions().has(id)) return true
    const data = await this.getVersions()
    return data.versions.some((version) => version.id === id)
  }

  async isOfficialVersion(id) {
    if (this.cache?.versions?.some((version) => version.id === id)) return true
    if (this.diskCache?.versions?.some((version) => version.id === id)) return true
    try {
      const data = await fetchJson(MANIFEST_URL, { timeout: 25_000, retries: 1 })
      return Boolean(data?.versions?.some((version) => version.id === id))
    } catch {
      return false
    }
  }

  saveDiskCache(data) {
    if (!this.cacheFile) return
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true })
      const payload = {
        latest: data.latest,
        versions: data.versions.map(({ id, type, releaseTime, url }) => ({ id, type, releaseTime, url })),
        savedAt: Date.now()
      }
      fs.writeFileSync(this.cacheFile, JSON.stringify(payload), 'utf8')
    } catch {
      // The on-disk cache is an optimization only.
    }
  }
}

function isUnsafeVersionId(id) {
  return (
    typeof id !== 'string' ||
    !id ||
    id === '.' ||
    id === '..' ||
    /[\\/:*?"<>|\r\n]/.test(id)
  )
}

function detectBaseVersion(folderName, json) {
  if (typeof json.inheritsFrom === 'string' && json.inheritsFrom) return json.inheritsFrom
  const match = String(folderName).match(/^(\d+(?:\.\d+)+)/)
  return match ? match[1] : null
}

function detectLoader(json) {
  const mainClass = String(json.mainClass || '').toLowerCase()
  const libraries = Array.isArray(json.libraries)
    ? json.libraries.map((library) => String(library?.name || '')).join(' ').toLowerCase()
    : ''

  if (mainClass.includes('fabric') || libraries.includes('fabric-loader')) return 'fabric'
  if (mainClass.includes('quilt') || libraries.includes('quilt-loader')) return 'quilt'
  if (mainClass.includes('neoforge') || libraries.includes('neoforge')) return 'neoforge'
  if (
    mainClass.includes('launchwrapper') ||
    libraries.includes('net.minecraftforge') ||
    libraries.includes('forge')
  ) {
    return 'forge'
  }
  return 'vanilla'
}

function mergeVersionJson(parent, child) {
  const merged = { ...parent, ...child }
  merged.id = child.id || parent.id
  merged.libraries = [...(parent.libraries || []), ...(child.libraries || [])]
  merged.downloads = { ...(parent.downloads || {}), ...(child.downloads || {}) }
  merged.arguments = mergeArguments(parent.arguments, child.arguments)
  if (!child.assetIndex && parent.assetIndex) merged.assetIndex = parent.assetIndex
  if (!child.assets && parent.assets) merged.assets = parent.assets
  if (!child.javaVersion && parent.javaVersion) merged.javaVersion = parent.javaVersion
  if (!child.mainClass && parent.mainClass) merged.mainClass = parent.mainClass
  delete merged.inheritsFrom
  return merged
}

function mergeArguments(parent, child) {
  if (!parent) return child
  if (!child) return parent
  if (Array.isArray(parent) || Array.isArray(child)) return child
  const merged = { ...parent, ...child }
  for (const key of ['game', 'jvm']) {
    if (Array.isArray(parent[key]) || Array.isArray(child[key])) {
      merged[key] = [...(parent[key] || []), ...(child[key] || [])]
    }
  }
  return merged
}
