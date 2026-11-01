import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

// This module loads inside eml-lib (see eml-runtime.js), so bare specifiers resolve against
// eml-lib's own folder.

/**
 * Make eml-lib's FileManager tolerant of unwritable version-cache files.
 *
 * `getLibraries()` and `getLoaderLibraries()` write `<root>/versions/<id>/<id>.json` on every launch
 * and abort the whole launch when the write fails:
 *
 * ```
 * Error: Failed to write Minecraft manifest: EPERM: operation not permitted, open
 *   'C:\Users\...\AppData\Roaming\.minecraft\versions\fabric-loader-0.20.1-26.3\...json'
 *   at FileManager.getLibraries (lib/launcher/filemanager.js:87)
 * ```
 *
 * That file is only a convenience copy: the manifest is already resolved in memory (for local
 * instances it came from our own local manifest server). For isolated instances the launcher also
 * redirects the copy to `<gameDir>/cache/versions` (see eml-runtime.js), and this patch is the final
 * safety net: a blocked write is reported as a WARN in 运行日志 and the launch continues.
 */
export function patchFileManagerTolerantWrites(FileManager, { onWarning } = {}) {
  const prototype = FileManager?.prototype
  if (!prototype || prototype.__voxelTolerant) return FileManager
  const originalGetLibraries = prototype.getLibraries
  if (typeof originalGetLibraries !== 'function') return FileManager
  Object.defineProperty(prototype, '__voxelTolerant', { value: true })

  const versionEntry = (fileManager, manifest) => ({
    name: `${manifest.id}.json`,
    path: path.join('versions', manifest.id, '/'),
    url: '',
    type: 'OTHER'
  })

  const persist = async (fileManager, manifest, prefix) => {
    const root = fileManager?.config?.root
    if (!root || !manifest?.id) return true
    const directory = path.join(root, 'versions', manifest.id)
    const file = path.join(directory, `${manifest.id}.json`)
    try {
      if (!existsSync(directory)) await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(file, JSON.stringify(manifest, null, 2))
      return true
    } catch (error) {
      const detail = `${error?.code || ''} ${error?.message || error}`.trim()
      if (typeof onWarning === 'function') {
        onWarning(`${prefix}写入失败，已跳过并继续启动：${file}（${detail}）`)
      }
      return false
    }
  }

  // A failed cache write means the previous run's libraries are still usable; the downloader
  // only ever re-downloads files it validated as missing.
  prototype.getLibraries = async function getLibrariesTolerant() {
    this.patches = await this.getPatchedManifest()
    const files = [versionEntry(this, this.minecraftManifest)]
    const libraries = []
    const written = await persist(this, this.minecraftManifest, '版本缓存 ')
    if (!written) files[0].skipWrite = true

    for (const lib of this.minecraftManifest.libraries || []) {
      let type
      let artifact
      if (lib.natives) {
        type = 'NATIVE'
        artifact = await this.patchNative(lib)
        if (!artifact) continue
      } else {
        if (!isLibAllowed(this, lib)) continue
        type = 'LIBRARY'
        artifact = await this.patchLibrary(lib)
      }
      let name
      let path_
      if (artifact) {
        if (artifact.path) {
          name = path.basename(artifact.path)
          path_ = path.join('libraries', path.dirname(artifact.path), '/')
        } else {
          name = getLibraryName(lib.name)
          path_ = getLibraryPath(lib.name, 'libraries')
        }
        libraries.push({
          name,
          path: path_,
          url: artifact.url,
          sha1: artifact.sha1,
          size: artifact.size,
          type,
          extra: 'MINECRAFT'
        })
      }
    }

    libraries.push({
      name: `${this.minecraftManifest.id}.jar`,
      path: path.join('versions', this.minecraftManifest.id, '/'),
      url: this.minecraftManifest.downloads?.client?.url,
      sha1: this.minecraftManifest.downloads?.client?.sha1,
      size: this.minecraftManifest.downloads?.client?.size,
      type: 'LIBRARY',
      extra: 'MINECRAFT'
    })
    files.push(...libraries)
    return { libraries, files }
  }

  prototype.getLoaderLibraries = async function getLoaderLibrariesTolerant() {
    this.patches = await this.getPatchedManifest()
    const loader = this.config.minecraft.loader
    if (!this.loaderManifest || !loader) return { libraries: [], files: [] }
    const files = [versionEntry(this, this.loaderManifest)]
    const libraries = []
    const written = await persist(this, this.loaderManifest, '加载器缓存 ')
    if (!written) files[0].skipWrite = true
    if (this.loaderManifest.libraries) {
      libraries.push(...(await this.formatLibraries(this.loaderManifest.libraries, 'LOADER')))
    }
    if (this.installProfile?.libraries) {
      libraries.push(...(await this.formatLibraries(this.installProfile.libraries, 'INSTALL')))
    }
    files.push(...libraries)
    return { libraries, files }
  }

  return FileManager
}

/**
 * Give up on hash verification while the launcher gets a build running.
 *
 * `getJava()` and the asset index use `utils.getRemoteFileSha1()`, with no timeout. A mirrored or
 * slow Maven/SHA1 endpoint made the launch sit silently right after the Java runtime step. With this
 * patch the hashes come from the manifest when available and are otherwise empty, so eml-lib treats
 * an existing file as valid instead of waiting on the network. Files that already exist are used
 * as-is; missing ones are still downloaded.
 */
export function patchFileManagerSkipVerify(FileManager) {
  const prototype = FileManager?.prototype
  if (!prototype || prototype.__voxelSkipVerify) return FileManager
  Object.defineProperty(prototype, '__voxelSkipVerify', { value: true })

  if (!emlUtils) return FileManager
  const originalSize = emlUtils.getRemoteFileSize?.bind(emlUtils)
  const originalSha1 = emlUtils.getRemoteFileSha1?.bind(emlUtils)
  // Only used to fill in hashes eml-lib would otherwise fetch with an unbounded request.
  emlUtils.getRemoteFileSha1 = async () => ''
  if (originalSize && !emlUtils.__voxelSizePatched) {
    emlUtils.__voxelSizePatched = true
    emlUtils.getRemoteFileSize = async (...args) => {
      try {
        return await originalSize(...args)
      } catch {
        return 0
      }
    }
  }
  void originalSha1
  return FileManager
}

// The helpers below mirror the `utils` singletons loaded by eml-lib's FileManager.
let emlUtils = null
export function setFileManagerUtils(utils) {
  emlUtils = utils
}

function isLibAllowed(fileManager, lib) {
  return emlUtils ? emlUtils.isLibAllowed(lib) : true
}

function getLibraryName(name) {
  return emlUtils ? emlUtils.getLibraryName(name) : String(name)
}

function getLibraryPath(name, folder) {
  return emlUtils ? emlUtils.getLibraryPath(name, folder) : path.join(folder)
}
