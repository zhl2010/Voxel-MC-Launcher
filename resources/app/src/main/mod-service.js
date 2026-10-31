import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fetchJson, friendlyError } from './fetcher.js'

const MODRINTH_API = 'https://api.modrinth.com/v2'
const MODRINTH_USER_AGENT = 'VoxelLauncher/1.0 (Electron Minecraft launcher; local app)'
const SEARCH_TTL = 2 * 60 * 1000
const MOD_LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge'])

/**
 * Modrinth integration. It searches only for files that match the active Minecraft version and
 * loader, then downloads the primary artifact straight into the instance's mods folder.
 */
export class ModService {
  constructor(gameDir) {
    this.gameDir = gameDir
    this.searchCache = new Map()
    this.installing = new Set()
  }

  get modsDir() {
    return path.join(this.gameDir, 'mods')
  }

  get manifestPath() {
    return path.join(this.modsDir, '.voxel-mods.json')
  }

  get busy() {
    return this.installing.size > 0
  }

  validateTarget(gameVersion, loader) {
    if (!/^[a-zA-Z0-9._-]+$/.test(String(gameVersion || ''))) {
      throw new Error('无效的 Minecraft 版本。')
    }
    if (!MOD_LOADERS.has(loader)) {
      throw new Error('请先选择一个 Fabric、Quilt、Forge 或 NeoForge 加载器。')
    }
  }

  async search({ query = '', gameVersion, loader }) {
    this.validateTarget(gameVersion, loader)
    const normalizedQuery = String(query || '').trim().slice(0, 80)
    const cacheKey = `${gameVersion}|${loader}|${normalizedQuery.toLowerCase()}`

    const cached = this.searchCache.get(cacheKey)
    if (cached && Date.now() - cached.time < SEARCH_TTL) {
      return cached.data
    }

    const facets = [
      ['project_type:mod'],
      [`categories:${loader}`],
      [`versions:${gameVersion}`]
    ]
    const params = new URLSearchParams({
      query: normalizedQuery,
      facets: JSON.stringify(facets),
      limit: '20',
      index: normalizedQuery ? 'relevance' : 'downloads'
    })

    const response = await fetchJson(`${MODRINTH_API}/search?${params.toString()}`, {
      timeout: 20_000,
      retries: 1,
      headers: { 'User-Agent': MODRINTH_USER_AGENT }
    })

    const data = {
      query: normalizedQuery,
      gameVersion,
      loader,
      total: Number(response.total_hits) || 0,
      hits: (response.hits || []).map((hit) => ({
        projectId: hit.project_id,
        slug: hit.slug,
        title: hit.title || '未命名模组',
        description: hit.description || '',
        author: hit.author || '',
        downloads: Number(hit.downloads) || 0,
        follows: Number(hit.follows) || 0,
        categories: Array.isArray(hit.display_categories)
          ? hit.display_categories.slice(0, 4)
          : Array.isArray(hit.categories)
            ? hit.categories.slice(0, 4)
            : [],
        clientSide: hit.client_side || 'unknown',
        serverSide: hit.server_side || 'unknown',
        license: hit.license || '',
        updated: hit.date_modified || null
      }))
    }

    this.searchCache.set(cacheKey, { data, time: Date.now() })
    if (this.searchCache.size > 80) {
      this.searchCache.delete(this.searchCache.keys().next().value)
    }
    return data
  }

  async install({ projectId, gameVersion, loader }) {
    this.validateTarget(gameVersion, loader)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(projectId || ''))) {
      throw new Error('无效的 Modrinth 项目 ID。')
    }
    if (this.installing.has(projectId)) {
      throw new Error('这个模组正在安装中，请稍候。')
    }

    this.installing.add(projectId)
    try {
      const params = new URLSearchParams({
        loaders: JSON.stringify([loader]),
        game_versions: JSON.stringify([gameVersion])
      })
      const versions = await fetchJson(
        `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${params.toString()}`,
        { timeout: 20_000, retries: 1, headers: { 'User-Agent': MODRINTH_USER_AGENT } }
      )

      if (!Array.isArray(versions) || versions.length === 0) {
        throw new Error('没有找到与当前游戏版本和加载器兼容的模组文件。')
      }

      const selectedVersion =
        versions.find((version) => version.version_type === 'release') || versions[0]
      const file = (selectedVersion.files || []).find((entry) => entry.primary) || selectedVersion.files?.[0]
      if (!file?.url) throw new Error('这个模组没有可下载的主文件。')

      const filename = safeFilename(file.filename || `${projectId}-${selectedVersion.version_number || 'mod'}.jar`)
      await fs.mkdir(this.modsDir, { recursive: true })
      const destination = path.join(this.modsDir, filename)
      const relative = path.relative(this.modsDir, destination)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('模组文件名无效。')
      }

      const versionLabel = selectedVersion.version_number || selectedVersion.name || ''
      const alreadyInstalled = await this.isExistingFileCurrent(destination, file)
      if (alreadyInstalled) {
        await this.rememberMod(filename, { projectId, version: versionLabel })
        return {
          projectId,
          filename,
          size: file.size || 0,
          version: versionLabel,
          alreadyInstalled: true
        }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 120_000)
      let buffer
      try {
        const response = await fetch(file.url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            Accept: 'application/octet-stream',
            'User-Agent': MODRINTH_USER_AGENT
          }
        })
        if (!response.ok) {
          throw new Error(`下载失败：HTTP ${response.status}`)
        }
        buffer = Buffer.from(await response.arrayBuffer())
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('模组下载超时，请重试。')
        throw error
      } finally {
        clearTimeout(timer)
      }

      if (file.size && buffer.length !== file.size) {
        throw new Error('模组文件大小不完整，请重试。')
      }
      verifyHash(buffer, file.hashes)

      const temporary = path.join(
        this.modsDir,
        `.${filename}.${process.pid}-${Date.now()}.part`
      )
      try {
        await fs.writeFile(temporary, buffer)
        await fs.rename(temporary, destination)
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {})
        throw error
      }

      await this.rememberMod(filename, { projectId, version: versionLabel })
      return {
        projectId,
        filename,
        size: buffer.length,
        version: versionLabel,
        alreadyInstalled: false
      }
    } catch (error) {
      throw new Error(friendlyError(error, '模组安装失败。'))
    } finally {
      this.installing.delete(projectId)
    }
  }

  async isExistingFileCurrent(destination, file) {
    try {
      const stat = await fs.stat(destination)
      if (!stat.isFile()) return false
      if (file.size && stat.size !== file.size) return false
      if (file.hashes?.sha1) {
        const hash = crypto.createHash('sha1').update(await fs.readFile(destination)).digest('hex')
        if (hash.toLowerCase() !== String(file.hashes.sha1).toLowerCase()) return false
      }
      return true
    } catch {
      return false
    }
  }

  async listInstalled() {
    await fs.mkdir(this.modsDir, { recursive: true })
    const manifest = await this.readManifest()
    const entries = await fs.readdir(this.modsDir, { withFileTypes: true }).catch(() => [])
    const files = []
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(jar|zip)$/i.test(entry.name)) continue
      try {
        const stat = await fs.stat(path.join(this.modsDir, entry.name))
        const metadata = manifest[entry.name] || {}
        files.push({
          name: entry.name,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          projectId: typeof metadata.projectId === 'string' ? metadata.projectId : null,
          version: typeof metadata.version === 'string' ? metadata.version : null
        })
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
    return files.sort((a, b) => b.modified.localeCompare(a.modified))
  }

  async readManifest() {
    try {
      const data = JSON.parse(await fs.readFile(this.manifestPath, 'utf8'))
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    } catch {
      return {}
    }
  }

  async rememberMod(filename, { projectId, version }) {
    try {
      const manifest = await this.readManifest()
      for (const [name, metadata] of Object.entries(manifest)) {
        if (name !== filename && metadata?.projectId === projectId) delete manifest[name]
      }
      manifest[filename] = {
        projectId,
        version,
        installedAt: new Date().toISOString()
      }
      const temporary = `${this.manifestPath}.${process.pid}.tmp`
      await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), 'utf8')
      await fs.rename(temporary, this.manifestPath)
    } catch {
      // The sidecar metadata is a convenience only; never fail an install because of it.
    }
  }
}

function safeFilename(value) {
  let filename = path
    .basename(String(value))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()

  if (!filename) filename = 'downloaded-mod.jar'
  if (!/\.(jar|zip)$/i.test(filename)) filename += '.jar'
  if (filename.length > 180) {
    const extension = path.extname(filename)
    filename = filename.slice(0, 180 - extension.length) + extension
  }
  return filename
}

function verifyHash(buffer, hashes = {}) {
  if (hashes.sha1) {
    const actual = crypto.createHash('sha1').update(buffer).digest('hex')
    if (actual.toLowerCase() !== String(hashes.sha1).toLowerCase()) {
      throw new Error('模组文件校验失败（SHA-1 不匹配）。')
    }
  }
  if (hashes.sha512) {
    const actual = crypto.createHash('sha512').update(buffer).digest('hex')
    if (actual.toLowerCase() !== String(hashes.sha512).toLowerCase()) {
      throw new Error('模组文件校验失败（SHA-512 不匹配）。')
    }
  }
}
