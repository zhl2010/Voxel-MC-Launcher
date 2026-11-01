import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import yauzl from 'yauzl'
import ForgeLikeLoader from 'eml-lib/lib/launcher/forgelike.js'
import Patcher from 'eml-lib/lib/launcher/patcher.js'
import { fetchJson, fetchBuffer, friendlyError } from './fetcher.js'

const FABRIC_META = 'https://meta.fabricmc.net/v2/versions/loader'
const FABRIC_META_FALLBACK = 'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader'
const QUILT_META = 'https://meta.quiltmc.org/v3/versions/loader'
const FORGE_MAVEN = 'https://maven.minecraftforge.net'
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases'
// Bangbang93's MCBBS mirror: the only reachable path for the Maven artifacts from mainland China.
const BMCLAPI_MAVEN = 'https://bmclapi2.bangbang93.com/maven'

const SUPPORTED = new Set(['fabric', 'quilt', 'forge', 'neoforge'])

/**
 * Installs a loader as an independent, PCL/HMCL-style version instance.
 *
 * Each (Minecraft version + loader + loader build) becomes its own folder under
 * `versions/<id>/<id>.json` with `inheritsFrom` pointing at the vanilla version. The folder is
 * then the complete game directory for that instance (version isolation), so its mods, saves,
 * resource packs and config never mix with another loader's.
 *
 * Fabric / Quilt are installed from the official meta API profile json. Forge / NeoForge run the
 * real installer pipeline: download the installer jar, extract its libraries (universal jar,
 * client data), run the Java processors (binpatch) and write the version json.
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

  async install({ gameVersion, loader, loaderVersion = '', javaPath = '' }) {
    if (!SUPPORTED.has(loader)) {
      throw new Error(`${loader || '该加载器'} 暂不支持一键安装为独立版本。`)
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(String(gameVersion || ''))) {
      throw new Error('无效的 Minecraft 版本。')
    }
    const key = `${gameVersion}|${loader}|${loaderVersion}`
    if (this.installing.has(key)) throw new Error('正在安装中，请稍候。')
    this.installing.add(key)

    try {
      if (loader === 'forge' || loader === 'neoforge') {
        return await this.installForgeLike(gameVersion, loader, loaderVersion, javaPath)
      }
      return await this.installMetaInstance(gameVersion, loader, loaderVersion)
    } catch (error) {
      throw new Error(friendlyError(error, '加载器安装失败。'))
    } finally {
      this.installing.delete(key)
    }
  }

  /** Fabric / Quilt: fetch the official meta profile json and write the instance. */
  async installMetaInstance(gameVersion, loader, loaderVersion) {
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

    return this.writeMetaInstance(gameVersion, loader, version, profile)
  }

  /** Shared tail for meta-installed loaders: naming, idempotency, json + libraries. */
  async writeMetaInstance(gameVersion, loader, version, profile) {
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

    await fsp.mkdir(instanceDir, { recursive: true })
    await fsp.writeFile(jsonPath, JSON.stringify(profile, null, 2), 'utf8')
    const downloaded = await this.downloadLibraries(libraries)

    return {
      id: instanceId,
      loader,
      loaderVersion: version,
      alreadyInstalled: false,
      directory: instanceDir,
      librariesDownloaded: downloaded.length
    }
  }

  /** Forge / NeoForge: run the real installer pipeline and write the instance json. */
  async installForgeLike(gameVersion, loader, loaderVersion, javaPath) {
    // 1. Pick the loader build. Forge resolves to `<mc>-<forgeVer>` (e.g. 1.21.1-52.0.17),
    // NeoForge to a plain version (e.g. 21.1.179).
    const resolved = loaderVersion
      ? { type: loader, version: loaderVersion }
      : await this.loaders.resolve(gameVersion, loader, '')
    const version = resolved.version
    if (!version) throw new Error('没有找到可用的加载器版本。')
    const forgeVer = loader === 'forge' ? version.replace(`${gameVersion}-`, '') : version
    const instanceId = `${gameVersion}-${loader}-${forgeVer}`
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(instanceId)) {
      throw new Error(`生成的版本名无效：${instanceId}`)
    }

    const instanceDir = path.join(this.gameDir, 'versions', instanceId)
    const jsonPath = path.join(instanceDir, `${instanceId}.json`)
    if (fs.existsSync(jsonPath)) {
      const existing = readJsonFile(jsonPath)
      const downloaded = await this.downloadLibraries(
        Array.isArray(existing?.libraries) ? existing.libraries : []
      )
      return {
        id: instanceId,
        loader,
        loaderVersion: forgeVer,
        alreadyInstalled: true,
        directory: instanceDir,
        librariesDownloaded: downloaded.length
      }
    }

    // 2. Download the installer jar. Bangbang93 mirrors Forge/NeoForge Maven (installer included);
    // the official hosts are unreliable from mainland China, so they are only a fallback.
    const mavenBase = loader === 'forge' ? FORGE_MAVEN : NEOFORGE_MAVEN
    const groupPath = loader === 'forge' ? 'net/minecraftforge/forge' : 'net/neoforged/neoforge'
    const installerName = `${loader === 'forge' ? 'forge' : 'neoforge'}-${version}-installer.jar`
    const relativePath = `${groupPath}/${version}/${installerName}`
    const installerCandidates = [
      `${BMCLAPI_MAVEN}/${relativePath}`,
      `${mavenBase}/${relativePath}`
    ]
    let installerBuffer = null
    for (const url of installerCandidates) {
      try {
        installerBuffer = await fetchBuffer(url, { timeout: 180_000, retries: 2 })
        break
      } catch (error) {
        console.warn('[loader-install] 安装器下载失败：', url, error.message)
      }
    }
    if (!installerBuffer) throw new Error('Forge/NeoForge 安装器下载失败，请稍后重试。')
    await fsp.mkdir(instanceDir, { recursive: true })
    const installerPath = path.join(instanceDir, `${instanceId}-installer.jar`)
    await fsp.writeFile(installerPath, installerBuffer)
    const installer = { path: `versions/${instanceId}/`, name: `${instanceId}-installer.jar`, format: 'INSTALLER' }

    try {
      // 3. Read install_profile.json: `versionInfo` is the instance manifest (inheritsFrom +
      // libraries + mainClass + processors); `install` carries the universal jar coordinates.
      const installProfile = await readZipEntryJson(installerPath, 'install_profile.json')
      if (!installProfile || typeof installProfile !== 'object') {
        throw new Error('安装器内缺少 install_profile.json。')
      }
      // Newer installers ship the full instance manifest as a standalone `version.json` inside the
      // jar; older ones embed it as `versionInfo` in install_profile.json (possibly under `install`).
      let versionInfo = installProfile.versionInfo || installProfile.install?.versionInfo
      if (!versionInfo || typeof versionInfo !== 'object') {
        versionInfo = await readZipEntryJson(installerPath, 'version.json')
      }
      if (!versionInfo || typeof versionInfo !== 'object') {
        throw new Error('安装器内缺少版本信息（versionInfo）。')
      }
      versionInfo.inheritsFrom = gameVersion
      versionInfo.id = instanceId

      // 4. Extract the universal jar / client data from the installer into libraries.
      const config = {
        root: this.gameDir,
        minecraft: { loader: { loader, version } },
        java: { absolutePath: javaPath || findJavaPath(this.gameDir) }
      }
      const minecraftManifest = { id: gameVersion, javaVersion: { majorVersion: 17 } }
      const forgeLike = new ForgeLikeLoader(config, minecraftManifest, versionInfo, installProfile, installer)
      const extracted = await forgeLike.extractJar()

      // 5. Make sure every library the processors need is on disk, then run them (binpatch).
      //    The full `install_profile.libraries` set is downloaded too: NeoForge installers
      //    reference extra coordinates (e.g. `neoform ...@zip`) only through processor args /
      //    data values, so they would otherwise never land in `libraries`.
      const patchDeps = collectProcessorLibraries(installProfile, mavenBase)
      const processorDeps = patchDeps.filter(
        (lib) => !extracted.libraries.some((done) => done.name === lib.name)
      )
      if (processorDeps.length) await this.downloadLibraries(processorDeps)
      if (Array.isArray(installProfile.libraries) && installProfile.libraries.length) {
        await this.downloadLibraries(installProfile.libraries)
      }
      const patcher = new Patcher(config, minecraftManifest, versionInfo, installProfile)
      const patchedFiles = await patcher.patch()

      // 6. The patched client jar (binarypatcher output) and, for NeoForge, the universal hook
      //    jar are part of the runtime classpath. Forge manifests list them; NeoForge 21.x
      //    manifests do not, so append the coordinates (backed by real files) here.
      const data = installProfile.data || {}
      const side = loader === 'forge' ? 'forge' : 'neoforge'
      const patchedCoord = String(data.PATCHED?.[side] || data.PATCHED?.client || '').replace(/[[\]]/g, '')
      const extraCoords = []
      if (patchedCoord) extraCoords.push(patchedCoord)
      if (loader === 'neoforge') {
        const universal = (installProfile.libraries || []).find((lib) =>
          /^net\.neoforged:neoforge:[^:]+:universal$/.test(String(lib.name || ''))
        )
        if (universal) extraCoords.push(String(universal.name))
      }
      for (const coord of extraCoords) {
        if (!coord || (versionInfo.libraries || []).some((lib) => lib.name === coord)) continue
        const relative = libraryPath(coord)
        if (!relative) continue
        const dest = path.join(this.gameDir, 'libraries', relative)
        let sha1 = ''
        let size = 0
        try {
          const stats = await fsp.stat(dest)
          size = stats.size
          sha1 = crypto.createHash('sha1').update(await fsp.readFile(dest)).digest('hex')
        } catch {
          continue
        }
        versionInfo.libraries.push({
          name: coord,
          downloads: { artifact: { path: relative, url: '', sha1, size } }
        })
      }

      // 7. Write the instance json (the merged vanilla + loader manifest is resolved at launch).
      await fsp.writeFile(jsonPath, JSON.stringify(versionInfo, null, 2), 'utf8')

      // 8. Top up any remaining loader libraries that carry download URLs.
      const downloaded = await this.downloadLibraries(versionInfo.libraries || [])

      return {
        id: instanceId,
        loader,
        loaderVersion: forgeVer,
        alreadyInstalled: false,
        directory: instanceDir,
        librariesDownloaded: downloaded.length,
        patched: patchedFiles.length
      }
    } finally {
      await fsp.unlink(installerPath).catch(() => {})
    }
  }

  /** Download loader libraries into `gameDir/libraries`. `url`/`downloads.artifact` supported. */
  async downloadLibraries(libraries) {
    const jobs = []
    for (const library of libraries || []) {
      const artifact = library.downloads?.artifact
      const name = String(library.name || '')
      const relative =
        libraryPath(name) ||
        (typeof artifact?.path === 'string' ? artifact.path.replace(/\\/g, '/') : '')
      if (!relative) continue
      const candidates = []
      if (typeof artifact?.url === 'string' && artifact.url) candidates.push(artifact.url)
      // Fabric/Quilt meta profiles and Forge profiles carry `url` + `name` (maven coordinate)
      // instead of `downloads.artifact`; build the artifact URL from those.
      if (!artifact?.url && typeof library.url === 'string' && library.url && name) {
        candidates.push(`${library.url.replace(/\/+$/, '')}/${relative}`)
      }
      // The mirror is the reliable source from mainland China; the official URL is tried first
      // only when it was provided explicitly, then the mirror, then the provided URL again.
      if (!candidates.includes(`${BMCLAPI_MAVEN}/${relative}`)) {
        candidates.push(`${BMCLAPI_MAVEN}/${relative}`)
      }
      const destination = path.join(this.gameDir, 'libraries', relative)
      if (fs.existsSync(destination)) continue
      jobs.push({
        candidates: candidates.filter((u) => /^https?:\/\//i.test(u)),
        destination,
        sha1: typeof artifact?.sha1 === 'string' ? artifact.sha1 : ''
      })
    }

    const results = []
    for (const job of jobs) {
      try {
        await fsp.mkdir(path.dirname(job.destination), { recursive: true })
        let buffer = null
        let lastError = null
        for (const url of job.candidates) {
          try {
            buffer = await fetchBuffer(url, { timeout: 90_000, retries: 1 })
            break
          } catch (error) {
            lastError = error
          }
        }
        if (!buffer) throw lastError || new Error('所有下载源均失败')
        if (job.sha1) {
          const digest = crypto.createHash('sha1').update(buffer).digest('hex')
          if (digest !== job.sha1.toLowerCase()) {
            throw new Error(`校验失败：${path.basename(job.destination)}`)
          }
        }
        await fsp.writeFile(job.destination, buffer)
        results.push(path.basename(job.destination))
      } catch (error) {
        console.warn('[loader-install] 库下载失败：', path.basename(job.destination), error.message)
      }
    }
    return results
  }
}

/** The processor jars (their main-class is run with Java during install) and classpath deps. */
function collectProcessorLibraries(installProfile, mavenBase) {
  const seen = new Set()
  const result = []
  const push = (coordinate) => {
    const clean = String(coordinate || '').replace(/[[\]]/g, '')
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    // `url` is the download root for the maven coordinate; the mirror is preferred in
    // downloadLibraries, the official root is kept as a fallback.
    result.push({ name: clean, url: BMCLAPI_MAVEN })
  }
  for (const processor of installProfile?.processors || []) {
    if (processor?.sides && !processor.sides.includes('client')) continue
    if (processor?.jar) push(processor.jar)
    for (const dependency of processor?.classpath || []) push(dependency)
  }
  return result
}

/** Read a single named entry out of a zip archive and parse it as JSON. */
function readZipEntryJson(zipPath, entryName) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err)
      zipfile.on('entry', (entry) => {
        if (entry.fileName === entryName) {
          zipfile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr) return reject(streamErr)
            const chunks = []
            stream.on('data', (chunk) => chunks.push(chunk))
            stream.on('end', () => {
              try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
              } catch (parseErr) {
                reject(parseErr)
              }
            })
            stream.on('error', reject)
          })
        } else {
          zipfile.readEntry()
        }
      })
      zipfile.on('end', () => resolve(null))
      zipfile.on('error', reject)
      zipfile.readEntry()
    })
  })
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** Locate a usable java.exe: preferred setting first, then the launcher runtime, then common install roots, then PATH. */
function findJavaPath(gameDir = '', preferred = '') {
  if (preferred && fs.existsSync(preferred)) return preferred
  // The launcher downloads its own runtimes into `<gameDir>/runtime` (e.g. java-runtime-epsilon).
  if (gameDir) {
    let runtimes = []
    try {
      runtimes = fs.readdirSync(path.join(gameDir, 'runtime'), { withFileTypes: true })
    } catch {
      runtimes = []
    }
    const byMajor = runtimes
      .filter((e) => e.isDirectory())
      .map((e) => {
        const exe = path.join(gameDir, 'runtime', e.name, 'bin', 'java.exe')
        if (!fs.existsSync(exe)) return null
        const match = e.name.match(/(\d+)/)
        return { exe, major: match ? Number(match[1]) : 0 }
      })
      .filter(Boolean)
      .sort((a, b) => b.major - a.major)
    if (byMajor.length) return byMajor[0].exe
  }
  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Microsoft\\jdk',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java')
  ]
  let best = null
  for (const root of roots) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const exe = path.join(root, entry.name, 'bin', 'java.exe')
      if (!fs.existsSync(exe)) continue
      const match = entry.name.match(/(\d+)/)
      const major = match ? Number(match[1]) : 0
      if (!best || major > best.major) best = { exe, major }
    }
  }
  return best?.exe || preferred || 'java'
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
