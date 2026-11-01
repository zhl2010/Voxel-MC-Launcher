import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fetchJson, fetchBuffer, friendlyError } from './fetcher.js'

const FABRIC_META = 'https://meta.fabricmc.net/v2/versions/loader'
const FABRIC_META_FALLBACK = 'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader'
const QUILT_META = 'https://meta.quiltmc.org/v3/versions/loader'

const SUPPORTED = new Set(['fabric', 'quilt'])

/**
 * Installs a loader as an independent, PCL/HMCL-style version instance.
 *
 * Each (Minecraft version + loader + loader build) becomes its own folder under
 * `versions/<id>/<id>.json` with `inheritsFrom` pointing at the vanilla version. The folder is
 * then the complete game directory for that instance (version isolation), so its mods, saves,
 * resource packs and config never mix with another loader's.
 *
 * Forge / NeoForge need a real installer run (extract + patch) and are not handled here yet.
 */
export class LoaderInstallService {
  constructor(gameDir, versions, loaders) {
    this.gameDir = gameDir
    this.versions = versions
    this.loaders = loaders
    this.installing = new Set()
  }

  get busy() {
    return this.installing.size > 0
  }

  async install({ gameVersion, loader, loaderVersion = '' }) {
    if (!SUPPORTED.has(loader)) {
      throw new Error(`${loader || '该加载器'} 暂不支持一键安装为独立版本，请先在版本库中手动选择加载器（仅 Fabric / Quilt 可用）。`)
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(String(gameVersion || ''))) {
      throw new Error('无效的 Minecraft 版本。')
    }
    const key = `${gameVersion}|${loader}|${loaderVersion}`
    if (this.installing.has(key)) throw new Error('正在安装中，请稍候。')
    this.installing.add(key)

    try {
      // 1. Pick the loader build (explicit choice wins, otherwise newest stable).
      const resolved = loaderVersion
        ? { type: loader, version: loaderVersion }
        : await this.loaders.resolve(gameVersion, loader, '')
      const version = resolved.version
      if (!version) throw new Error('没有找到可用的加载器版本。')

      // 2. Fetch the official profile json: `versions/<id>/<id>.json` with inheritsFrom=<gameVersion>.
      const profileUrl =
        loader === 'fabric'
          ? `${FABRIC_META}/${encodeURIComponent(gameVersion)}/${encodeURIComponent(version)}/profile/json`
          : `${QUILT_META}/${encodeURIComponent(gameVersion)}/${encodeURIComponent(version)}/profile/json`
      let profile
      try {
        profile = await fetchJson(profileUrl, { timeout: 20_000, retries: 2 })
      } catch (error) {
        if (loader === 'fabric') {
          profile = await fetchJson(
            `${FABRIC_META_FALLBACK}/${encodeURIComponent(gameVersion)}/${encodeURIComponent(version)}/profile/json`,
            { timeout: 25_000, retries: 1 }
          )
        } else {
          throw error
        }
      }
      if (!profile || typeof profile !== 'object') throw new Error('加载器元数据无效。')
      // PCL / HMCL naming: `<mc>-<loader>-<loaderVer>` (e.g. 1.21.1-fabric-0.16.9). The meta API's
      // own id (`fabric-loader-<ver>-<mc>`) is overridden to match what the version list shows.
      const instanceId = `${gameVersion}-${loader}-${version}`
      if (!/^[a-zA-Z0-9._-]{1,128}$/.test(instanceId)) {
        throw new Error(`生成的版本名无效：${instanceId}`)
      }
      profile.inheritsFrom = gameVersion
      profile.id = instanceId

      const instanceDir = path.join(this.gameDir, 'versions', instanceId)
      const jsonPath = path.join(instanceDir, `${instanceId}.json`)
      // Idempotent: an existing instance still tops up any loader libraries that are missing
      // (a previous install may have been interrupted or capped).
      const libraries = Array.isArray(profile.libraries) ? profile.libraries : []
      if (fs.existsSync(jsonPath)) {
        const downloaded = await this.downloadLibraries(libraries)
        return {
          id: instanceId,
          loader,
          loaderVersion: version,
          alreadyInstalled: true,
          directory: instanceDir,
          librariesDownloaded: downloaded.length
        }
      }

      // 3. Write the instance json (with the profile's mainClass/libraries for this loader).
      await fsp.mkdir(instanceDir, { recursive: true })
      await fsp.writeFile(jsonPath, JSON.stringify(profile, null, 2), 'utf8')

      // 4. Download the loader's own libraries into the shared library store.
      const downloaded = await this.downloadLibraries(libraries)

      return {
        id: instanceId,
        loader,
        loaderVersion: version,
        alreadyInstalled: false,
        directory: instanceDir,
        librariesDownloaded: downloaded.length
      }
    } catch (error) {
      throw new Error(friendlyError(error, '加载器安装失败。'))
    } finally {
      this.installing.delete(key)
    }
  }

  /** Download loader libraries (Fabric/Quilt ship one or two jars) into `gameDir/libraries`. */
  async downloadLibraries(libraries) {
    const jobs = []
    for (const library of libraries || []) {
      const artifact = library.downloads?.artifact
      let url = typeof artifact?.url === 'string' ? artifact.url : ''
      let sha1 = typeof artifact?.sha1 === 'string' ? artifact.sha1 : ''
      // Fabric/Quilt meta profiles carry `url` + `name` (maven coordinate) instead of
      // `downloads.artifact`; build the artifact URL from those.
      if (!url && typeof library.url === 'string' && library.url && typeof library.name === 'string') {
        const relative = libraryPath(String(library.name))
        if (relative) url = `${library.url.replace(/\/+$/, '')}/${relative.replace(/\\/g, '/')}`
      }
      if (!url || !/^https?:\/\//i.test(url)) continue
      const relative = libraryPath(String(library.name || ''))
      if (!relative) continue
      const destination = path.join(this.gameDir, 'libraries', relative)
      if (fs.existsSync(destination)) continue
      jobs.push({ url, destination, sha1 })
    }

    // Sequential with a small concurrency cap; loader libraries are tiny.
    const results = []
    for (const job of jobs.slice(0, 6)) {
      try {
        await fsp.mkdir(path.dirname(job.destination), { recursive: true })
        const buffer = await fetchBuffer(job.url, { timeout: 60_000, retries: 2 })
        if (job.sha1) {
          const digest = crypto.createHash('sha1').update(buffer).digest('hex')
          if (digest !== job.sha1.toLowerCase()) {
            throw new Error(`校验失败：${path.basename(job.destination)}`)
          }
        }
        await fsp.writeFile(job.destination, buffer)
        results.push(path.basename(job.destination))
      } catch (error) {
        console.warn('[loader-install] 库下载失败：', error.message)
      }
    }
    return results
  }
}

/** `group:artifact:version[:classifier][@ext]` -> maven relative path with hashes kept lowercase. */
export function libraryPath(coordinate) {
  if (typeof coordinate !== 'string' || !coordinate) return ''
  const match = /^([^:]+):([^:]+):([^:@]+)(?::([^@]+))?(?:@([A-Za-z0-9]+))?$/.exec(coordinate)
  if (!match) return ''
  const [, group, artifact, version, classifier, ext] = match
  const extension = ext || 'jar'
  const folder = group.replace(/\./g, '/')
  const base = `${artifact}-${version}${classifier ? `-${classifier}` : ''}`
  return path.join(folder, artifact, version, `${base}.${extension}`)
}
