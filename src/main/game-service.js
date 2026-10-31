import http from 'node:http'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { CrackAuth, Launcher, MicrosoftAuth, YggdrasilAuth } from 'eml-lib'
import { installEmlPatches, patchArgumentManager } from './eml-runtime.js'
import { applyInstanceCompatibility } from './instance-compat.js'
import { downloadMissingLibraries } from './library-downloader.js'
import { fetchAssetIndex, downloadAssets, downloadClientJar } from './asset-downloader.js'
import { LIBRARY_SOURCES, ASSET_SOURCES, customSource } from './source-router.js'
import { verifyGameFiles, checkDiskSpace, formatSize as formatVerifySize } from './game-verifier.js'
import { prepareAgentDirectory, cacheManifestCopy, pointAgentToDirectory } from './game-cache.js'
import {
  buildLaunchArguments,
  formatCommand,
  prepareSpawning,
  spawnMinecraft,
  splitArgs
} from './minecraft-launcher.js'
import {
  setJavaProgressHandler,
  setDownloadTraceHandler
} from './eml-downloader-patch.js'
import { friendlyError } from './fetcher.js'
import fs from 'node:fs'
import { redactSensitive } from './redact.js'

export const GAME_ROOT_NAME = 'VoxelLauncher'

const TYPE_LABELS = {
  JAVA: 'Java 运行时',
  ASSET: '游戏资源',
  LIBRARY: '运行库',
  NATIVE: '本地库',
  OTHER: '游戏组件',
  MOD: '模组',
  CONFIG: '配置文件',
  FOLDER: '目录'
}

const LOADER_LABELS = {
  vanilla: '原版',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge'
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(0, Math.round(value / 1024))} KB`
}

function withTimeout(promise, milliseconds, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function isInstanceModArchive(name) {
  // PCL stores `mods/<fileName>` (sometimes `mods/<sub>/<fileName>`). Those archives are for Forge
  // to load, not for the JVM classpath.
  const value = String(name || '')
  return /^mods\//i.test(value) || /^(mods?$|mods[-_.])/i.test(value)
}

/**
 * Pick the Java binary without ever downloading one. Order: the path saved in 启动设置, then the
 * JDKs/JREs installed on disk (newest first), then `java` from PATH.
 */
function resolveJavaChoice(settings, baseVersion = '') {
  const configured = String(settings.javaPath || '').trim()
  if (configured && fs.existsSync(configured)) return { path: configured, source: 'settings' }

  const candidates = findInstalledJava()
  if (candidates.length) {
    const preferred = pickJavaForVersion(candidates, settings.version, baseVersion)
    return { path: preferred, source: 'detected' }
  }
  return { path: configured || 'java', source: 'path' }
}

function findInstalledJava() {
  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Microsoft\\jdk',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java')
  ]
  const found = []
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
      if (fs.existsSync(exe)) found.push({ exe, name: entry.name })
    }
  }
  const rank = (name) => {
    const match = name.match(/(\d+)(?:\.(\d+))?/)
    if (!match) return 0
    const major = Number(match[1])
    return major === 1 ? Number(match[2] || 0) : major
  }
  return found.sort((a, b) => rank(b.name) - rank(a.name))
}

/**
 * LaunchWrapper-era Minecraft (everything up to 1.16.x, including 1.0–1.6) only runs on Java 8: on
 * Java 9+ `launchwrapper.Launch` fails with
 * `AppClassLoader cannot be cast to URLClassLoader`. Minecraft 1.17+ requires Java 17+, and the
 * modern 26.x line requires whatever its JSON asks for, so those keep the newest local Java.
 */
function pickJavaForVersion(candidates, version, baseVersion = '') {
  const java8 = candidates.find((item) => /jre1\.8|jdk1\.8|1\.8\.0/.test(item.name))
  const isJava8Release = (text) => {
    const match = /^(\d+)\.(\d+)/.exec(String(text || ''))
    return Boolean(match) && Number(match[1]) === 1 && Number(match[2]) <= 16
  }
  // 1.0–1.16.x (LaunchWrapper era) require Java 8; 1.17+ and the 26.x line need a modern JDK.
  if (java8) {
    if (isJava8Release(version)) return java8.exe
    // Local instance names ("RLCraft", "1.21.1-Fabric 0.20.0", "1.7.10-Forge_...") are not release
    // numbers: use the parsed base version, or the release prefix in the name.
    if (!/^\d+\.\d+/.test(String(version || ''))) {
      if (isJava8Release(baseVersion)) return java8.exe
      const prefix = /^(\d+\.\d+)/.exec(String(version || ''))
      if (prefix && isJava8Release(prefix[1])) return java8.exe
    }
  }
  return candidates[0].exe
}


function parseJavaMajor(version) {
  const text = String(version || '').trim()
  const match = text.match(/^(\d+)/)
  if (!match) return 0
  const major = Number(match[1])
  // "1.8.0_511" is Java 8, "26.0.2.1" stays 26.
  return major === 1 ? Number(text.split('.')[1] || 0) : major
}

/**
 * Report the exact command line eml-lib is about to spawn. The classpath entries plus the
 * `-javaagent` (authlib-injector) position are printed to 运行日志, and the argument file is echoed
 * when the command line is too long for Windows.
 */
function installCommandLineLogger(gameService) {
  // Every global channel is registered before the launcher is built, and each one is guarded so a
  // logging failure can never abort a launch.
  const safeLog = (level, message) => {
    try {
      gameService.log(level, String(message))
    } catch {
      // Logging must never break the launch flow.
    }
  }
  globalThis.__voxelCommandLineReporter = ({ javaPath, javaArgs, entries, injector }) => {
    safeLog('INFO', `Java 可执行文件：${javaPath}`)
    safeLog('INFO', `classpath 共 ${entries.length} 个条目`)
    entries.forEach((entry, index) => safeLog('DEBUG', `cp[${index + 1}] ${entry}`))
    const keys = entries.filter((entry) =>
      /launchwrapper|lzma|asm-all|guava|minecraftforge[\\/]forge/i.test(entry)
    )
    for (const entry of keys) safeLog('INFO', `关键运行库：${entry}`)
    safeLog('INFO', `关键运行库命中 ${keys.length} 个${injector ? '，已启用 authlib-injector（-javaagent 位于 classpath 之前）' : ''}`)
    if (javaArgs.length) safeLog('DEBUG', `JVM 参数：${javaArgs.join(' ')}`)
  }
  // Warnings raised inside patched eml-lib code (e.g. an unwritable version cache) are surfaced in
  // 运行日志 instead of aborting the launch.
  globalThis.__voxelLaunchWarning = (message) => safeLog('WARN', message)
  // Java runtime download progress is INFO; warnings (429 / stalled / skipped files) use the WARN
  // channel above so they stand out in 运行日志.
  setJavaProgressHandler((message) => safeLog('INFO', message))
  globalThis.__voxelLaunchTrace = (message) => safeLog('DEBUG', message)
  setDownloadTraceHandler((message) => safeLog('DEBUG', message))
}

function translateLaunchError(error) {
  const raw = String(error?.message || error || '启动失败')
  if (/Unsupported OS|Unsupported architecture/i.test(raw)) {
    return '当前操作系统或 CPU 架构暂不受 eml-lib 支持。'
  }
  if (/Invalid username/i.test(raw)) {
    return '离线用户名无效，请使用 3–16 位字母、数字或下划线。'
  }
  if (/Minecraft not owned/i.test(raw)) {
    return '该 Microsoft 账户没有 Minecraft: Java Edition 的游玩权限。'
  }
  if (/AUTH_CANCELLED|User cancelled/i.test(raw)) {
    return '登录已取消。'
  }
  if (/Yggdrasil authentication failed.*(401|403)|Invalid credentials|ForbiddenOperationException/i.test(raw)) {
    return '第三方账户登录失败：账号或密码错误。'
  }
  if (/ENOENT.*java|spawn.*java|Java.*not found/i.test(raw)) {
    return '未找到可用的 Java。请切换到“自动下载 Java”，或检查手动指定的 Java 路径。'
  }
  return friendlyError(error, '启动失败，请查看日志了解详情。')
}

/**
 * Resolve the directory a version runs in. Without version isolation that is the shared game root;
 * with isolation it is `versions/<id>`, matching PCL's per-version folders.
 */
export function instanceDirFor(settings, gameRoot) {
  if (!settings?.versionIsolation || !settings.version) return gameRoot
  return path.join(gameRoot, 'versions', settings.version)
}

export class GameService {
  constructor({ getWindow, store, versions, loaders, gameDir, sessionStore, projectRoot }) {
    this.getWindow = getWindow
    this.store = store
    this.versions = versions
    this.loaders = loaders
    this.gameDir = gameDir
    this.projectRoot = projectRoot || process.cwd()
    this.account = null
    this.status = 'idle'
    this.current = null
    this.launcher = null
    this.lastProgressSent = 0
    this.downloadTotals = null
    this.downloadBase = { size: 0, files: 0 }
    this.currentGroup = { size: 0, files: 0 }
    this.cancelRequested = false
    this.launchAbort = null
    this.originalFetch = null
    this.cancelTimer = null
    this.localManifestServer = null
    this.restoreSessionAccount()
    if (!this.account) this.restoreOfflineAccount()
  }

  /** Directory for a specific version id, honouring the isolation setting. */
  instanceDirFor(versionId) {
    const settings = this.store.getSettings()
    if (!settings.versionIsolation || !versionId) return this.gameDir
    return path.join(this.gameDir, 'versions', versionId)
  }

  restoreSessionAccount() {
    try {
      const account = this.sessionStore?.load()
      if (account) this.account = account
    } catch {
      this.account = null
    }
  }

  persistAccount() {
    if (!this.account) return
    try {
      this.sessionStore?.save(this.account)
    } catch (error) {
      this.log('WARN', `登录状态保存失败：${error.message}`)
    }
  }

  setGameDir(nextDir, versions) {
    if (this.status !== 'idle') {
      throw new Error('游戏正在启动或运行中，暂时不能修改游戏目录。')
    }
    this.gameDir = nextDir
    this.versions = versions
    this.launcher = null
    this.current = null
  }

  restoreOfflineAccount() {
    const username = this.store.getSettings().username
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) return
    try {
      this.account = new CrackAuth().auth(username)
    } catch {
      this.account = null
    }
  }

  /** The full account object (includes tokens); only for main-process use such as skins. */
  getAccount() {
    return this.account
  }

  getAccountSummary() {
    if (!this.account) return null
    return {
      name: this.account.name,
      uuid: this.account.uuid,
      type: this.account.meta?.type || 'crack',
      online: Boolean(this.account.meta?.online),
      server: this.account.meta?.url || null
    }
  }

  getState() {
    return {
      status: this.status,
      current: this.current
        ? {
            version: this.current.version,
            loader: this.current.loader.type,
            loaderVersion: this.current.loader.version,
            loaderLabel: this.current.loaderLabel
          }
        : null,
      account: this.getAccountSummary()
    }
  }

  loginOffline(username) {
    if (this.status !== 'idle') {
      throw new Error('请等待当前启动流程结束后再切换账户。')
    }
    const name = String(username || '').trim()
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(name)) {
      throw new Error('用户名需为 3–16 位字母、数字或下划线。')
    }

    const account = new CrackAuth().auth(name)
    this.store.update({ username: name })
    this.account = account
    this.persistAccount()
    this.sendEvent('state', this.getState())
    return this.getAccountSummary()
  }

  async loginYggdrasil({ serverUrl, username, password } = {}) {
    if (this.status !== 'idle') {
      throw new Error('请等待当前启动流程结束后再切换账户。')
    }

    const name = String(username || '').trim()
    const secret = String(password || '')
    if (!name || !secret) throw new Error('请输入第三方账户的用户名和密码。')

    let url
    try {
      url = new URL(String(serverUrl || '').trim())
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid protocol')
      url.hash = ''
      url.search = ''
      url.pathname = url.pathname.replace(/\/+$/, '')
    } catch {
      throw new Error('Yggdrasil 服务器地址无效，请填写完整的 HTTP(S) 地址。')
    }

    const endpoint = url.toString().replace(/\/$/, '')
    try {
      const auth = new YggdrasilAuth(endpoint)
      let result = await withTimeout(auth.auth(name, secret), 30_000, '第三方认证服务器响应超时。')
      let autoSelectedProfile = false

      // LittleSkin accounts can expose more than one player profile. This flow selects the first
      // one; the chosen name is shown in the account card.
      if (result?.needsProfileSelection) {
        const profiles = Array.isArray(result.availableProfiles) ? result.availableProfiles : []
        if (!profiles.length) throw new Error('该账户没有可用的游戏角色。')
        autoSelectedProfile = profiles.length > 1
        result = auth.selectProfile(result, { id: profiles[0].id })
      }

      this.account = result
      try {
        // Do not persist the offline username when the session belongs to another service.
        this.store.update({ username: '' })
      } catch {
        // Keep the in-memory session even when the config file is read-only.
      }
      this.persistAccount()
      this.sendEvent('state', this.getState())
      return {
        ...this.getAccountSummary(),
        autoSelectedProfile
      }
    } catch (error) {
      throw new Error(translateLaunchError(error))
    }
  }

  async loginMicrosoft() {
    if (this.status !== 'idle') {
      throw new Error('请等待当前启动流程结束后再切换账户。')
    }

    const window = this.getWindow()
    if (!window) throw new Error('启动器窗口不可用。')

    try {
      const auth = new MicrosoftAuth(window, process.env.VOXEL_MSA_CLIENT_ID)
      const account = await auth.auth()
      this.account = account
      // Clear the saved offline name so a restart cannot silently fall back to a different local
      // account. The Microsoft session itself is stored separately with OS-backed encryption.
      try {
        this.store.update({ username: '' })
      } catch {
        // The in-memory session is still usable if the config file cannot be written.
      }
      this.persistAccount()
      this.sendEvent('state', this.getState())
      return this.getAccountSummary()
    } catch (error) {
      throw new Error(translateLaunchError(error))
    }
  }

  logout() {
    if (this.status !== 'idle') {
      throw new Error('游戏启动或运行期间无法退出账户。')
    }
    this.account = null
    this.store.update({ username: '' })
    this.sessionStore?.clear()
    this.sendEvent('state', this.getState())
    return null
  }

  async refreshAccountIfNeeded() {
    if (!this.account) return
    const type = this.account.meta?.type
    try {
      if (type === 'msa' && this.account.refreshToken) {
        const auth = new MicrosoftAuth(this.getWindow(), process.env.VOXEL_MSA_CLIENT_ID)
        if (await auth.validate(this.account)) return
        this.account = await auth.refresh(this.account)
        this.persistAccount()
        this.sendEvent('state', this.getState())
        this.log('INFO', 'Microsoft 登录状态已刷新。')
      } else if (type === 'yggdrasil' && this.account.meta?.url && this.account.accessToken) {
        const auth = new YggdrasilAuth(this.account.meta.url)
        if (await auth.validate(this.account)) return
        let refreshed = await auth.refresh(this.account)
        if (refreshed?.needsProfileSelection) {
          const profiles = Array.isArray(refreshed.availableProfiles) ? refreshed.availableProfiles : []
          const profile = profiles.find((item) => item.id === this.account.uuid) || profiles[0]
          if (!profile) throw new Error('第三方账户没有可用角色。')
          refreshed = auth.selectProfile(refreshed, { id: profile.id })
        }
        this.account = refreshed
        this.persistAccount()
        this.sendEvent('state', this.getState())
        this.log('INFO', '第三方登录状态已刷新。')
      }
    } catch (error) {
      // A temporary network problem should not block launching with a still-valid token.
      this.log('WARN', `登录状态刷新失败：${error.message}`)
    }
  }

  async launch() {
    const launchStarted = Date.now()
    let launcher = null
    try {
      return await this.launchInner({ onLauncher: (created) => { launcher = created } })
    } catch (error) {
      console.error('[launch] uncaught:', error)
      const message = redactSensitive(translateLaunchError(error))
      this.log('ERROR', `启动失败：${message}`)
      try {
        if (launcher && this.launcher === launcher) this.failLaunch(error)
        else this.failLaunch(error)
      } catch (failError) {
        console.error('[launch] failLaunch threw:', failError)
      }
      throw error
    } finally {
      this.log('DEBUG', `launch() 返回，用时 ${Math.round((Date.now() - launchStarted) / 1000)} 秒`)
    }
  }

  async launchInner(options) {
    const settings = this.store.getSettings()
    const logStep = (label) => this.log('INFO', `[launch] ${label}`)
    logStep(`开始启动流程：${settings.version || '(未选择版本)'} / ${settings.loader || 'vanilla'}`)
    if (this.status !== 'idle') {
      throw new Error(this.status === 'running' ? '游戏已经在运行中。' : '启动流程正在进行中，请稍候。')
    }

    if (this.status !== 'idle') {
      throw new Error(this.status === 'running' ? '游戏已经在运行中。' : '启动流程正在进行中，请稍候。')
    }
    this.startupLog = []
    const mark = (label) => {
      this.startupLog.push({ label, at: Date.now() })
      logStep(label)
    }

    if (!settings.version) throw new Error('请先选择一个 Minecraft 版本。')

    mark('检查账户')
    if (!this.account) this.restoreOfflineAccount()
    if (!this.account) throw new Error('请先登录账户，再开始游戏。')

    mark('刷新账户令牌')
    await this.refreshAccountIfNeeded()
    mark('账户就绪')

    mark('检查版本是否在清单中')
    if (!(await this.versions.hasVersion(settings.version))) {
      throw new Error('所选版本不在版本清单中，请刷新版本列表后重试。')
    }

    mark('扫描本地版本目录')
    const candidate = this.versions.getLocalVersion(settings.version)
    // A real folder in `versions/<id>` (even one that reuses an official id, e.g. a PCL "26.3"
    // instance with custom mods) must be launched from its own JSON, never from a freshly
    // downloaded official version.
    let localVersion = null
    if (settings.forceLocal && candidate) {
      localVersion = candidate
    } else {
      mark('确认是否为官方版本（官方版本会跳过本地 JSON）')
      const officialVersion = await this.versions.isOfficialVersion(settings.version)
      localVersion = officialVersion ? null : candidate
    }
    mark(`本地版本检查完成：${localVersion ? '使用本地 JSON' : '走官方清单'}`)
    // Forge / LiteLoader instances built by PCL list server-only libraries without `downloads`
    // (launchwrapper, lzma, asm-all, guava 17, the Forge universal jar). eml-lib drops those from
    // the download list and the classpath, and the game then dies in launchwrapper. Apply the
    // version-specific rules before the JSON is handed to eml-lib and to resolveLocalVersion().
    if (localVersion?.json) {
      const compatibility = applyInstanceCompatibility(localVersion.json, this.gameDir)
      for (const note of compatibility.notes) this.log('INFO', `本地实例兼容处理：${note}`)
      if (compatibility.added.length) {
        this.log(
          'INFO',
          `已补全 ${compatibility.added.length} 个本地运行库：${compatibility.added.slice(0, 6).join('、')}${compatibility.added.length > 6 ? ' 等' : ''}`
        )
      }
      const original = localVersion.json.libraries.length
      const modsSkipped = localVersion.json.libraries.filter((library) =>
        isInstanceModArchive(library?.name)
      ).length
      if (modsSkipped) {
        localVersion.json.libraries = localVersion.json.libraries.filter(
          (library) => !isInstanceModArchive(library?.name)
        )
        this.log('INFO', `已排除 ${original - localVersion.json.libraries.length} 个 mods 目录模组（保留在 mods 目录）。`)
      }
    }
    let loader
    let loaderLabel
    let manifestPromise = null

    if (localVersion) {
      const metadata = localVersion.metadata || {}
      this.log(
        'INFO',
        `本地实例 ${settings.version}：原版版本 ${metadata.baseVersion || '未解析'}，加载器 ${metadata.loader || '未知'}${metadata.loaderVersion ? ` ${metadata.loaderVersion}` : ''}`
      )
      if (!metadata.baseVersion) {
        this.log('WARN', metadata.baseError || '无法解析本地实例的原版版本，将使用完整本地 JSON 启动。')
      }
      mark('读取本地版本 JSON（含 inheritsFrom 合并）')
      manifestPromise = this.versions.resolveLocalVersion(settings.version).then((manifest) => {
        if (!manifest) throw new Error('本地版本 JSON 无法读取，请检查版本目录。')
        mark(`本地 JSON 读取完成：${manifest.id}（${manifest.libraries?.length || 0} 个运行库）`)
        const manifestCompat = applyInstanceCompatibility(manifest, this.gameDir)
        for (const note of manifestCompat.notes) this.log('INFO', `本地实例兼容处理：${note}`)
        manifest.libraries = (manifest.libraries || []).filter(
          (library) => !isInstanceModArchive(library?.name)
        )
        return manifest
      })
      loader = { type: 'vanilla', version: settings.version }
      loaderLabel = '本地版本'
    } else {
      mark('解析加载器版本（联网）')
      loader = await this.loaders.resolve(
        settings.version,
        settings.loader || 'vanilla',
        settings.loaderVersion || ''
      )
      loaderLabel = LOADER_LABELS[loader.type] || loader.type
      mark(`加载器解析完成：${loaderLabel} ${loader.version || ''}`)
      mark('获取官方版本 JSON（联网）')
      manifestPromise = this.resolveOfficialManifest(settings.version, loader)
    }
    mark(`构建启动器配置（加载器 ${loaderLabel}）`)

    const javaArgs = splitArgs(settings.jvmArgs)
    installCommandLineLogger(this)
    mark('选择 Java')
    // Java is never auto-downloaded any more. eml-lib's runtime download was the source of the
    // 429 / half-installed-runtime loops, and the game only needs a working `java.exe`. The manual
    // path is used when configured, otherwise the first installed JDK/JRE is picked (settings can
    // still override it in 启动设置 → Java 运行时).
    // The parsed base version (e.g. RLCraft -> 1.12.2) decides whether Java 8 is required.
    const baseVersion = localVersion?.metadata?.baseVersion || ''
    const javaChoice = resolveJavaChoice(settings, baseVersion)
    this.log(
      'INFO',
      `Java 选择：${javaChoice.path}${javaChoice.source === 'settings' ? '（来自启动设置）' : javaChoice.source === 'detected' ? '（自动检测到的本地 Java）' : '（PATH 中的 java）'}`
    )
    mark('构造 eml-lib Launcher 实例（仅用于补下缺失文件）')
    const java = {
      install: 'manual',
      absolutePath: javaChoice.path,
      args: javaArgs
    }

    const config = {
      root: GAME_ROOT_NAME,
      storage: 'isolated',
      minecraft: {
        version: settings.version,
        loader: {
          loader: loader.type,
          version: loader.version
        }
      },
      account: this.account,
      java,
      window: {
        width: settings.windowWidth,
        height: settings.windowHeight,
        fullscreen: Boolean(settings.fullscreen)
      },
      memory: {
        min: settings.minMemory,
        max: settings.maxMemory
      },
      cleaning: {
        // Never delete a player's mods, saves, or resource packs just because eml-lib does not
        // recognise them.
        enabled: false
      }
    }

    let launcher
    try {
      launcher = new Launcher(config)
      mark('eml-lib Launcher 构造完成')
    } catch (error) {
      await this.closeLocalManifest()
      throw new Error(translateLaunchError(error))
    }
    options.onLauncher?.(launcher)

    // eml-lib resolves its `root` config as a hidden folder under appData, not as an arbitrary
    // absolute path. The launcher now supports a user-selected game directory, so replace the
    // resolved root after construction and point the auto-downloaded Java runtime at the same
    // directory. Everything after this point (downloads, versions, assets, mods, logs, cwd and
    // launch arguments) reads `launcher.config.root`.
    launcher.config.root = this.gameDir
    // Isolated instances must not write `/versions/<id>/<id>.json` relative to the launcher profile
    // folder (`%APPDATA%\.voxellauncher`), which failed with EPERM; point the cache copy at the
    // writable game directory and give authlib-injector a directory to unpack into.
    launcher.config.versionsCacheDir = path.join(this.gameDir, 'cache')
    // eml-lib may only download; the process is spawned by our own launcher (see ownLaunch).
    launcher.config.downloadOnly = true
    launcher.config.agentDirectory = prepareAgentDirectory(path.join(this.gameDir, 'cache')).directory
    launcher.config.cacheManifest = (manifest) =>
      cacheManifestCopy(path.join(this.gameDir, 'cache'), manifest)
    // Java runtimes are downloaded with limited concurrency and 429 backoff (eml-downloader-patch).
    // A runtime left half-finished by an earlier download is irrelevant now that Java is never
    // downloaded automatically; the manual path below is what runs the game.
    // Java never comes from `runtime/jre-${X}` any more: make sure eml-lib spawns the resolved
    // local binary even if an older code path left `install: 'auto'` in the config.
    launcher.config.java = { ...launcher.config.java, install: 'manual', absolutePath: javaChoice.path }
    if (!fs.existsSync(javaChoice.path) && javaChoice.path !== 'java') {
      this.log('WARN', `指定的 Java 不存在：${javaChoice.path}，启动可能失败。请在「启动设置 → Java 运行时」重新选择。`)
    }

    this.status = 'launching'
    this.launcher = launcher
    this.current = {
      version: settings.version,
      loader,
      loaderLabel,
      startedAt: Date.now()
    }
    this.lastProgressSent = 0
    this.downloadTotals = null
    this.downloadBase = { size: 0, files: 0 }
    this.currentGroup = { size: 0, files: 0 }
    this.cancelRequested = false
    this.launchAbort = new AbortController()
    mark('接管 fetch/事件，启动自研启动核心')
    this.patchFetchForLaunch()

    this.bindLauncherEvents(launcher)
    this.sendEvent('state', this.getState())
    this.sendEvent('phase', {
      key: 'prepare',
      step: 0,
      label: '正在读取版本清单',
      detail: `${settings.version} · ${loaderLabel}`
    })
    this.log('INFO', `准备启动 Minecraft ${settings.version}（${loaderLabel}）`)

    this.ownLaunch({
      launcher,
      settings,
      javaPath: javaChoice.path,
      manifestPromise,
      loaderLabel
    })

    return {
      version: settings.version,
      loader: loader.type,
      loaderLabel
    }
  }

  /**
   * Serve a tiny version_manifest_v2.json that contains only the local instance id.
   *
   * Even when eml-lib's manifestUrl plumbing is bypassed (see eml-runtime.js), the worst case then
   * becomes a successful lookup of the local id instead of "not found in manifest".
   */
  /**
   * Own launch core: the arguments are assembled and the process is spawned here, not inside
   * eml-lib. eml-lib is still used, but only for the pieces it is good at (downloading missing
   * files through its Downloader); its `Launcher.launch()` state machine is no longer involved.
   */
  ownLaunch({ launcher, settings, javaPath, manifestPromise, loaderLabel }) {
    const startedAt = Date.now()
    const step = (label) => this.log('INFO', `[ownLaunch] ${label}`)
    const build = (manifest, agentDirectory) =>
      buildLaunchArguments({
        id: settings.version,
        manifest,
        gameDir: this.gameDir,
        instanceDir: this.instanceDirFor(settings.version),
        javaPath,
        account: this.account,
        settings,
        agentDirectory
      })
    const run = async () => {
      step(`准备进入下载/启动流程：${settings.version}（${loaderLabel}）`)
      let manifest
      step('等待版本 JSON（含 2 分钟超时）')
      try {
        manifest = await withTimeout(manifestPromise, 120_000, `读取 ${settings.version} 版本 JSON 超时`)
      } catch (error) {
        throw new Error(`读取版本 JSON 失败：${error.message}`)
      }
      step(`版本 JSON 已就绪：${manifest?.id}（${manifest?.libraries?.length || 0} 个运行库）`)
      this.phase('prepare', 0, '正在读取版本清单', `${settings.version} · ${loaderLabel}`)

      step('准备 authlib-injector（如需要）')
      const agentDirectory = this.prepareAgentDirectory(settings)
      const instanceDir = this.instanceDirFor(settings.version)
      if (instanceDir !== this.gameDir) {
        try {
          fs.mkdirSync(instanceDir, { recursive: true })
        } catch (error) {
          this.log('WARN', `无法创建版本隔离目录：${instanceDir}（${error.code || error.message}）`)
        }
        this.log('INFO', `版本隔离已启用：游戏目录 ${instanceDir}`)
      }
      step('第一次组装 JVM/游戏参数（扫描 libraries、解压 natives）')
      let built = build(manifest, agentDirectory)
      step(`第一次组装完成：classpath ${built.classpath.length} 条，缺失 ${built.missing.length} 个`)
      for (const note of built.notes) this.log('WARN', `参数组装：${note}`)

      // Silent pre-flight: a half-downloaded install (disk full, interrupted download) must be
      // repaired before Java is spawned, otherwise the game crashes with missing classes.
      if (built.missing.length > 0 || built.clientJarMissing) {
        const space = checkDiskSpace(this.gameDir)
        if (!space.ok) {
          throw new Error(
            `磁盘空间不足，请清理后再试（可用 ${formatVerifySize(space.free)}，至少需要 ${formatVerifySize(space.minimum)}）。`
          )
        }
        step('启动前静默校验并修补游戏文件')
        const repair = await this.verifyAndRepair(settings.version, { settings, verbose: true })
        if (!repair.ok && repair.remaining > 0) {
          throw new Error(
            `文件不完整，已为你自动触发修补，请稍后重试（仍有 ${repair.remaining} 个文件缺失或损坏）。`
          )
        }
        built = build(manifest, agentDirectory)
        step(`修补后重新组装：classpath ${built.classpath.length} 条，缺失 ${built.missing.length} 个`)
      }

      // Assets are required by the render thread: starting the game while they are still downloading
      // made Minecraft crash with `NoSuchFileException: assets\objects\...`. Always finish the asset
      // download before spawning.
      const assetsReady = await this.ensureAssetsComplete(settings.version, manifest, settings)
      if (!assetsReady) {
        throw new Error('游戏资源未下载完整，已停止启动，请检查网络后重试。')
      }

      // Give up only after the rebuild, when the classpath is genuinely unusable.
      if (built.classpath.length === 0 || !built.usable) {
        throw new Error(
          `核心运行库缺失过多，无法启动（缺失 ${built.missingLibraries.length} 个，classpath ${built.classpath.length} 条），请检查下载网络后重试。`
        )
      }
      if (built.missing.length) {
        this.log(
          'WARN',
          `补全后仍缺少 ${built.missing.length} 个文件（${built.missing.slice(0, 5).join('、')}），按现有文件继续启动。`
        )
      }
      step('拉起 Java 进程')
      this.finishOwnLaunch(launcher, built, startedAt)
    }

    run().catch((error) => {
      console.error('[ownLaunch] 失败：', error)
      try {
        this.log('ERROR', `启动流程异常：${error?.message || error}`)
      } catch {
        // Ignore logging failures.
      }
      if (this.launcher !== launcher) return
      if (this.cancelRequested) {
        this.finishCancel()
        return
      }
      this.failLaunch(error)
    })
  }

  finishOwnLaunch(launcher, built, startedAt) {
    const spawning = prepareSpawning({
      gameDir: this.gameDir,
      javaPath: built.javaPath,
      args: built.args
    })
    this.log('INFO', `Launching Minecraft with args: ${formatCommand(built.javaPath, spawning.args)}`)
    if (spawning.classpathJar) this.log('INFO', `classpath 清单：${spawning.classpathJar}`)
    this.log(
      'INFO',
      `classpath 共 ${built.classpath.length} 个条目，Java：${built.javaPath}，主类：${built.mainClass}`
    )
    this.phase('launch', 4, '正在启动游戏', 'Minecraft 进程即将出现')
    this.sendEvent('state', this.getState())

    if (this.cancelRequested) {
      this.finishCancel()
      return
    }

    this.launchResult = null
    this.gameProcess = null
    const session = spawnMinecraft({
      javaPath: built.javaPath,
      args: spawning.args,
      gameDir: this.instanceDirFor(this.current?.version || this.store.getSettings().version),
      onSpawn: (child) => {
        this.gameProcess = child
      },
      onOutput: (line) => {
        const text = String(line).trim()
        if (text) this.log('GAME', text)
      },
      onExit: (code, error) => {
        this.gameProcess = null
        if (this.launcher !== launcher) return
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        if (error) {
          this.log('ERROR', `无法启动 Java 进程：${error.code || ''} ${error.message}`)
          this.failLaunch(
            new Error(
              `无法启动 Java：${error.code === 'ENOENT' ? '找不到 java 程序' : error.message}。请检查「启动设置 → Java 运行时」的路径。`
            )
          )
          return
        }
        if (this.cancelRequested) {
          this.log('INFO', `已终止游戏进程（运行 ${elapsed} 秒）。`)
          this.finishCancel()
          return
        }
        this.log(
          code === 0 ? 'INFO' : 'ERROR',
          `游戏进程退出，退出码 ${code ?? '未知'}，运行 ${elapsed} 秒。`
        )
        if (code !== 0) {
          this.sendEvent('crash', {
            code: code ?? null,
            logsPath: path.join(this.gameDir, 'logs', 'latest.log'),
            crashReportsDir: path.join(this.gameDir, 'crash-reports')
          })
        }
        this.finishLaunch(code)
      }
    })
    session.then(() => {
      this.launchResult = null
    })

    this.status = 'running'
    this.current = { ...this.current, launchedAt: Date.now() }
    this.phase('running', 4, '游戏已启动', '祝你在方块世界里玩得开心')
    this.sendEvent('state', this.getState())
    this.log('INFO', 'Minecraft 进程已启动。')
  }

  /**
   * Verify every game file for a version and repair whatever is missing or the wrong size.
   * Shared by the manual "校验并修补" button and the silent check before a launch.
   *
   * @returns {Promise<{ok: boolean, repaired: number, remaining: number, summary: object}>}
   */
  async verifyAndRepair(versionId, { settings = null, verbose = true, categories } = {}) {
    const log = (level, message) => {
      if (verbose) this.log(level, message)
    }
    const effective = settings || this.store.getSettings()
    const space = checkDiskSpace(this.gameDir)
    if (!space.ok) {
      throw new Error(
        `磁盘空间不足，请清理后再试（可用 ${formatVerifySize(space.free)}，至少需要 ${formatVerifySize(space.minimum)}）。`
      )
    }

    const { manifest, assetIndex } = await this.loadVerificationInputs(versionId, effective)
    if (!manifest) throw new Error(`无法读取版本 ${versionId} 的 JSON，请检查版本目录。`)

    log('INFO', `开始校验 ${versionId} 的游戏文件…`)
    let report = verifyGameFiles(versionId, { gameDir: this.gameDir, manifest, assetIndex, categories })
    log(
      'INFO',
      `校验结果：完整 ${report.summary.ok} 个，缺失 ${report.summary.missing} 个，损坏 ${report.summary.corrupt} 个`
    )
    if (report.ok) {
      log('INFO', `校验完成：缺失 0 个，修补 0 个，损坏 0 个`)
      return { ok: true, repaired: 0, remaining: 0, summary: report.summary }
    }

    let repaired = 0
    // 1. Client jar.
    if (report.clientJar.state !== 'ok') {
      log('INFO', `修补客户端 jar：${versionId}.jar（${report.clientJar.state}）`)
      const client = await downloadClientJar(manifest, this.gameDir, { id: versionId })
      if (client.ok) repaired += 1
      else log('WARN', `客户端 jar 修补失败：${client.error}`)
    }

    // 2. Libraries: download every missing/corrupt coordinate in parallel.
    const libraryTargets = [...report.libraries.missing, ...report.libraries.corrupt]
    if (libraryTargets.length) {
      log('INFO', `修补运行库：${libraryTargets.length} 个`)
      const coordinates = libraryTargets.map((entry) => entry.name)
      const result = await downloadMissingLibraries(this.gameDir, coordinates, {
        concurrency: 16,
        sources: this.buildSources('libraries', effective),
        onLog: (message) => log('INFO', message),
        onWarning: (message) => log('INFO', message),
        onProgress: (progress) => this.reportDownloadProgress(progress)
      })
      repaired += result.downloaded.length
      if (result.failed.length) log('WARN', `仍有 ${result.failed.length} 个运行库下载失败`)
    }

    // 3. Assets.
    if (report.assets.missing.length || report.assets.corrupt.length || report.assets.total === 0) {
      if (assetIndex) {
        log('INFO', `修补游戏资源：${report.assets.missing.length + report.assets.corrupt.length} 个`)
        const before = report.assets.missing.length + report.assets.corrupt.length
        await downloadAssets(assetIndex, this.gameDir, {
          concurrency: 32,
          sources: this.buildSources('assets', effective),
          onWarning: (message) => log('INFO', message),
          onProgress: (progress) => this.reportDownloadProgress(progress)
        })
        repaired += before
      } else {
        log('WARN', '缺少资源索引，无法校验游戏资源')
      }
    }

    // 4. Verify again so the log reports the real state.
    report = verifyGameFiles(versionId, { gameDir: this.gameDir, manifest, assetIndex, categories })
    const remaining = report.summary.missing + report.summary.corrupt
    log(
      'INFO',
      `校验完成：缺失 ${report.summary.missing} 个，修补 ${repaired} 个，损坏 ${report.summary.corrupt} 个`
    )
    return { ok: report.ok, repaired, remaining, summary: report.summary }
  }

  /**
   * Block until every asset object for the version is on disk. The launch is never allowed to start
   * while assets are still being downloaded: the render thread needs them immediately and previously
   * crashed with `NoSuchFileException: assets/objects/...`.
   *
   * @returns {Promise<boolean>} true when the asset set is complete
   */
  async ensureAssetsComplete(versionId, manifest, settings) {
    const index = await fetchAssetIndex(manifest, this.gameDir).catch(() => null)
    if (!index?.objects) {
      this.log('WARN', '未能读取资源索引，跳过资源完整性检查')
      return true
    }
    const objects = Object.values(index.objects)
    const total = objects.length
    let present = 0
    for (const asset of objects) {
      if (!asset?.hash) continue
      const target = path.join(this.gameDir, 'assets', 'objects', asset.hash.slice(0, 2), asset.hash)
      try {
        const stat = fs.statSync(target)
        if (!asset.size || stat.size === asset.size) present += 1
      } catch {
        // Missing: counted as not present.
      }
    }
    if (present >= total) {
      this.log('INFO', `游戏资源已完整（${present}/${total}）`)
      return true
    }

    const space = checkDiskSpace(this.gameDir)
    if (!space.ok) {
      throw new Error(
        `磁盘空间不足，请清理后再试（可用 ${formatVerifySize(space.free)}，至少需要 ${formatVerifySize(space.minimum)}）。`
      )
    }

    this.log('INFO', `正在补全游戏资源（${present}/${total}），请稍候…`)
    this.sendEvent('phase', {
      key: 'assets',
      step: 2,
      label: `正在补全游戏资源 (${present}/${total})，请稍候…`,
      detail: '资源下载完成后才会启动游戏'
    })
    await downloadAssets(index, this.gameDir, {
      concurrency: 32,
      sources: this.buildSources('assets', settings),
      onWarning: (message) => this.log('INFO', message),
      onProgress: (progress) => {
        this.reportDownloadProgress(progress)
        if (progress?.done && progress?.total) {
          this.sendEvent('phase', {
            key: 'assets',
            step: 2,
            label: `正在补全游戏资源 (${progress.done}/${total})，请稍候…`,
            detail: '资源下载完成后才会启动游戏'
          })
        }
      }
    })

    let after = 0
    for (const asset of objects) {
      if (!asset?.hash) continue
      const target = path.join(this.gameDir, 'assets', 'objects', asset.hash.slice(0, 2), asset.hash)
      try {
        const stat = fs.statSync(target)
        if (!asset.size || stat.size === asset.size) after += 1
      } catch {
        // Still missing.
      }
    }
    this.log('INFO', `游戏资源下载结束：${after}/${total}`)
    if (after < total) {
      this.log(
        'ERROR',
        `游戏资源仍缺少 ${total - after} 个文件，已阻止启动以免游戏崩溃（NoSuchFileException）。`
      )
      return false
    }
    return true
  }

  /** Resolve the manifest + asset index used by the verifier for a version id. */
  async loadVerificationInputs(versionId, settings) {
    const local = this.versions.getLocalVersion(versionId)
    let manifest = null
    if (local) {
      const compat = applyInstanceCompatibility(local.json, this.gameDir)
      void compat
      manifest = await this.versions.resolveLocalVersion(versionId)
    }
    if (!manifest) manifest = await this.versions.fetchOfficialVersion(versionId)
    let assetIndex = null
    try {
      assetIndex = await fetchAssetIndex(manifest, this.gameDir)
    } catch {
      assetIndex = null
    }
    void settings
    return { manifest, assetIndex }
  }

  /**
   * Complete everything the launch needs without eml-lib's slow sequential downloader:
   *  - libraries: our own parallel Maven downloader (16–32 workers, 429 back-off);
   *  - assets: own worker pool over the asset index (32 workers) from BMCLAPI;
   *  - client jar / natives: still delegated to eml-lib, which is the only thing that knows how to
   *    install loaders and extract installers.
   */
  async downloadMissing(launcher, manifest, settings) {
    const build = () =>
      buildLaunchArguments({
        id: this.current?.version || this.store.getSettings().version,
        manifest,
        gameDir: this.gameDir,
        instanceDir: this.instanceDirFor(this.current?.version || this.store.getSettings().version),
        javaPath: 'java',
        account: this.account,
        settings: this.store.getSettings(),
        agentDirectory: ''
      })

    // 1. Libraries: skip eml-lib entirely and pull Maven coordinates in parallel.
    const librarySources = this.buildSources('libraries', settings)
    let check = build()
    if (check.missingLibraries.length) {
      this.log(
        'INFO',
        `开始并行下载 ${check.missingLibraries.length} 个运行库（跳过 eml-lib 的逐个下载）`
      )
      const result = await downloadMissingLibraries(this.gameDir, check.missingLibraries, {
        concurrency: 16,
        sources: librarySources,
        onLog: (message) => this.log('INFO', message),
        onWarning: (message) => this.log('INFO', message),
        onProgress: (progress) => this.reportDownloadProgress(progress)
      })
      this.log(
        'INFO',
        `运行库下载完成：成功 ${result.downloaded.length} 个，失败 ${result.failed.length} 个，共 ${formatBytes(result.bytes)}`
      )
      for (const failure of result.failed.slice(0, 10)) {
        this.log('WARN', `运行库下载失败：${failure.name}（${failure.error}）`)
      }
    } else {
      this.log('INFO', '运行库已齐全，跳过下载')
    }

    // 2. Client jar: must exist at versions/<id>/<id>.jar for Fabric/Forge to find the game.
    if (check.clientJarMissing) {
      this.log('INFO', `开始下载客户端 jar：${settings.version}.jar`)
      const client = await downloadClientJar(manifest, this.gameDir, { id: settings.version })
      if (client.ok) this.log('INFO', `客户端 jar 下载完成：${client.path}（${formatBytes(client.bytes || 0)}）`)
      else this.log('WARN', `客户端 jar 下载失败：${client.error}`)
    }

    // 3. Assets: our own pool, because a high-version launch needs thousands of tiny files.
    const assetSources = this.buildSources('assets', settings)
    try {
      const index = await fetchAssetIndex(manifest, this.gameDir)
      if (index) {
        await downloadAssets(index, this.gameDir, {
          concurrency: 32,
          sources: assetSources,
          onWarning: (message) => this.log('INFO', message),
          onProgress: (progress) => this.reportDownloadProgress(progress)
        })
      } else {
        this.log('WARN', '未能获取资源索引（assets index），跳过资源下载')
      }
    } catch (error) {
      this.log('WARN', `资源下载失败（继续尝试启动）：${error.message}`)
    }

    // 3. Anything left (client jar, loader installers) goes through eml-lib.
    check = build()
    if (check.clientJarMissing || check.missingLibraries.length) {
      this.log('INFO', '仍有客户端 / 加载器文件缺失，交给 eml-lib 补全…')
      try {
        await launcher.launch()
        this.log('INFO', 'eml-lib 下载流程完成。')
      } catch (error) {
        this.log('WARN', `eml-lib 下载流程报错（继续尝试启动）：${error.message}`)
      }
    } else {
      this.log('INFO', '客户端与加载器文件齐全，未调用 eml-lib 下载')
    }
  }

  /** Source list for a download category, with the user's custom base URL first when configured. */
  buildSources(kind, settings) {
    const list = kind === 'assets' ? [...ASSET_SOURCES] : [...LIBRARY_SOURCES]
    const custom = customSource(settings.downloadSource)
    if (!custom) return list
    const withKind = { ...custom, kind: kind === 'assets' ? 'assets' : 'maven' }
    this.log('INFO', `使用自定义下载源：${withKind.base}（优先于测速结果）`)
    return [withKind, ...list]
  }

  /** Periodic download speed/progress lines for the log (every ~50 files or 2 seconds). */
  reportDownloadProgress(progress) {
    if (!progress || typeof progress !== 'object') return
    const now = Date.now()
    if (!this.downloadReport) this.downloadReport = { at: 0, lastDone: 0, kind: '' }
    const state = this.downloadReport
    // Normalise the kind: asset progress reports `stage`, library progress reports `kind`. A missing
    // value used to throw `Cannot read properties of undefined (reading 'endsWith')`.
    const kind = typeof progress.kind === 'string' && progress.kind
      ? progress.kind
      : typeof progress.stage === 'string' && progress.stage
        ? progress.stage === 'assets' ? 'assets' : progress.stage
        : 'download'
    if (kind !== state.kind) {
      state.kind = kind
      state.lastDone = 0
      state.at = 0
    }
    const finished = kind.endsWith('-done')
    // Print every 50 files, and at least once every 3 seconds so a slow stretch is still visible.
    if (!finished && now - state.at < 3_000 && progress.done - state.lastDone < 50) return
    state.at = now
    state.lastDone = progress.done
    const speed = formatBytes(progress.speed || 0)
    const total = progress.total || 0
    if (finished) {
      this.log(
        'INFO',
        `${kind === 'libraries-done' ? '运行库' : '游戏资源'}下载结束：${progress.done}/${total}，失败 ${progress.failed}，共 ${formatBytes(progress.bytes)}`
      )
      return
    }
    this.log(
      'INFO',
      `已下载 ${progress.done}/${total} 个${kind === 'assets' ? '资源' : '库'}，速度 ${speed}/s${progress.concurrency ? `（并发 ${progress.concurrency}）` : ''}${typeof progress.source === 'string' && progress.source ? `（源 ${progress.source}）` : ''}`
    )
  }

  async resolveOfficialManifest(id, loader) {
    if (loader.type === 'vanilla') {
      const version = await this.versions.fetchOfficialVersion(id)
      if (!version) throw new Error(`无法从官方清单获取 ${id} 的版本 JSON。`)
      return version
    }
    const version = await this.versions.fetchOfficialVersion(id)
    if (!version) throw new Error(`无法从官方清单获取 ${id} 的版本 JSON。`)
    return version
  }

  prepareAgentDirectory(settings) {
    const isYggdrasil = this.account?.meta?.type === 'yggdrasil'
    if (!isYggdrasil) return ''
    const loginUrl = this.account?.serverUrl || this.account?.meta?.url || settings.authServer || ''
    if (!loginUrl) return ''
    const jar = path.join(this.gameDir, 'cache', 'authlib-injector.jar')
    if (!fs.existsSync(jar)) {
      this.log(
        'WARN',
        `需要使用 authlib-injector 登录 ${loginUrl}，但本地没有 ${jar}；本次将不带 -javaagent 启动（正版验证服务器会拒绝加入）。`
      )
      return ''
    }
    const { directory } = prepareAgentDirectory(path.join(this.gameDir, 'cache'))
    const converted = pointAgentToDirectory([`-javaagent:${jar}=${loginUrl}`], directory)
    return converted.converted ? directory : ''
  }

  async startLocalManifest(manifest) {
    await this.closeLocalManifest()
    const token = randomBytes(16).toString('hex')
    const route = `/manifest-${token}.json`
    const server = http.createServer((request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(404, { 'Content-Type': 'text/plain' })
        response.end('not found')
        return
      }
      if (request.url === '/' || request.url?.startsWith('/mc/game/')) {
        const id = manifest?.id || ''
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store'
        })
        response.end(
          JSON.stringify({
            latest: { release: id, snapshot: id },
            versions: [{ id, type: 'release', url: `http://127.0.0.1:${server.address().port}${route}` }]
          })
        )
        return
      }
      if (request.url !== route) {
        response.writeHead(404, { 'Content-Type': 'text/plain' })
        response.end('not found')
        return
      }
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      response.end(JSON.stringify(manifest))
    })

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    this.localManifestServer = server
    return `http://127.0.0.1:${server.address().port}${route}`
  }

  async closeLocalManifest() {
    const server = this.localManifestServer
    this.localManifestServer = null
    if (!server) return
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  patchFetchForLaunch() {
    if (!this.launchAbort || this.originalFetch) return
    const previousFetch = globalThis.fetch
    this.originalFetch = previousFetch
    globalThis.fetch = (input, init = {}) => {
      const signal = this.launchAbort?.signal
      return previousFetch(input, signal ? { ...init, signal } : init)
    }
  }

  restoreLaunchFetch() {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch
      this.originalFetch = null
    }
    this.launchAbort = null
  }

  throwIfCancelled() {
    if (!this.cancelRequested) return
    const error = new Error('LAUNCH_CANCELLED')
    error.code = 'LAUNCH_CANCELLED'
    throw error
  }

  cancelLaunch() {
    if (this.status !== 'launching' && this.status !== 'running') {
      throw new Error('当前没有可以取消的启动流程。')
    }
    this.cancelRequested = true
    this.status = 'cancelling'
    this.launchAbort?.abort()
    clearTimeout(this.cancelTimer)
    this.cancelTimer = setTimeout(() => {
      if (this.status === 'cancelling') this.finishCancel()
    }, 15_000)
    // Own-launch path: terminate the spawned Minecraft process.
    const child = this.gameProcess || this.launchResult?.child
    if (child && !child.killed) {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }
    }
    this.log('WARN', this.status === 'cancelling' ? '正在取消游戏启动…' : '正在取消…')
    this.sendEvent('state', this.getState())
    return true
  }

  finishCancel() {
    if (this.status === 'idle' && !this.cancelRequested) return
    const version = this.current?.version || this.store.getSettings().version
    this.closeLocalManifest()
    clearTimeout(this.cancelTimer)
    this.cancelTimer = null
    this.cancelRequested = false
    this.status = 'idle'
    this.current = null
    const cancelledLauncher = this.launcher
    this.launcher = null
    try {
      cancelledLauncher?.removeAllListeners?.()
    } catch {
      // eml-lib's event helper does not always expose removeAllListeners; dropping the reference
      // is enough because all handlers guard against a replaced launcher.
    }
    this.downloadTotals = null
    this.downloadBase = { size: 0, files: 0 }
    this.currentGroup = { size: 0, files: 0 }
    this.restoreLaunchFetch()
    this.log('WARN', '已取消游戏启动。')
    this.sendEvent('cancelled', { version })
    this.sendEvent('state', this.getState())
  }

  bindLauncherEvents(launcher) {
    // Console output from eml-lib and the game is mirrored here so an abort inside a phase always
    // leaves a trace in 运行日志.
    const originalEmit = launcher.emit.bind(launcher)
    launcher.emit = (event, ...rest) => {
      if (String(event) === 'download_progress' && rest[0]) {
        this.lastDownloadProgress = { ...rest[0], at: Date.now() }
      }
      const result = originalEmit(event, ...rest)
      if (String(event) === 'download_progress' && rest[0]?.total?.amount) {
        const { total, downloaded } = rest[0]
        if (!this.lastProgressDebug || Date.now() - this.lastProgressDebug > 5_000) {
          this.lastProgressDebug = Date.now()
          this.log(
            'DEBUG',
            `下载进度 ${downloaded?.amount || 0}/${total.amount} 个文件，${Math.round((downloaded?.size || 0) / 1048576)} MB`
          )
        }
      }
      return result
    }

    launcher.on('launch_compute_download', () => {
      this.throwIfCancelled()
      this.phase('prepare', 0, '正在计算所需文件', '校验版本、运行库与资源索引')
    })

    launcher.on('launch_download', ({ total } = {}) => {
      this.totals = total || { amount: 0, size: 0 }
      this.downloadTotals = { size: total?.size || 0, files: total?.amount || 0 }
      this.downloadBase = { size: 0, files: 0 }
      this.currentGroup = { size: 0, files: 0 }
      this.phase('download', 1, '正在下载游戏文件', `共 ${total?.amount || 0} 个文件`, {
        totalBytes: total?.size || 0,
        totalFiles: total?.amount || 0
      })
    })

    launcher.on('download_progress', (progress) => {
      if (!this.downloadTotals) return
      const now = Date.now()
      const downloaded = progress?.downloaded || { amount: 0, size: 0 }
      const total = progress?.total || { amount: 0, size: 0 }
      this.currentGroup = { size: total.size || 0, files: total.amount || 0 }

      const groupPercent = total.size > 0 ? Math.min(100, (downloaded.size / total.size) * 100) : 0
      const overallSize = this.downloadTotals.size || total.size || 1
      const overallBytes = Math.min(overallSize, this.downloadBase.size + (downloaded.size || 0))
      const overallPercent = Math.min(100, (overallBytes / overallSize) * 100)

      if (now - this.lastProgressSent < 120 && overallPercent < 100) return
      this.lastProgressSent = now

      const typeLabel = TYPE_LABELS[progress?.type] || '游戏组件'
      this.sendEvent('progress', {
        stage: 'download',
        percent: overallPercent,
        groupPercent,
        type: progress?.type || 'OTHER',
        typeLabel,
        speed: Number(progress?.speed) || 0,
        downloadedBytes: downloaded.size || 0,
        totalBytes: total.size || 0,
        downloadedFiles: downloaded.amount || 0,
        totalFiles: total.amount || 0,
        overallDownloadedBytes: overallBytes,
        overallTotalBytes: overallSize,
        overallDownloadedFiles: this.downloadBase.files + (downloaded.amount || 0),
        overallTotalFiles: this.downloadTotals.files || 0
      })
    })

    launcher.on('download_error', ({ filename, message }) => {
      this.log('WARN', `下载失败：${filename} — ${String(message?.message || message)}`)
    })

    launcher.on('download_end', () => {
      if (!this.downloadTotals) return
      this.downloadBase = {
        size: this.downloadBase.size + this.currentGroup.size,
        files: this.downloadBase.files + this.currentGroup.files
      }
      this.currentGroup = { size: 0, files: 0 }
      const overallSize = this.downloadTotals.size || 1
      const percent = Math.min(100, (this.downloadBase.size / overallSize) * 100)
      this.sendEvent('progress', {
        stage: 'download',
        percent,
        groupPercent: 100,
        finished: percent >= 99.9,
        overallDownloadedBytes: Math.min(overallSize, this.downloadBase.size),
        overallTotalBytes: overallSize,
        overallDownloadedFiles: this.downloadBase.files,
        overallTotalFiles: this.downloadTotals.files || 0
      })
    })

    launcher.on('launch_install_loader', ({ loader, version } = {}) => {
      this.phase('install', 2, '正在安装模组加载器', `${loader || 'loader'} ${version || ''}`.trim())
    })

    launcher.on('launch_patch_loader', () => {
      this.phase('install', 2, '正在应用加载器补丁', '这可能需要几秒钟')
    })

    launcher.on('launch_extract_natives', () => {
      this.phase('install', 2, '正在解压本地库', '准备游戏运行环境')
    })

    launcher.on('launch_copy_assets', () => {
      this.phase('install', 2, '正在整理游戏资源', '复制资源索引到实例目录')
    })

    launcher.on('patch_progress', ({ filename }) => {
      this.sendEvent('progress', {
        stage: 'install',
        indeterminate: true,
        detail: filename || '应用补丁'
      })
    })

    launcher.on('launch_clean', () => {
      this.phase('java', 3, '正在清理临时文件', '即将检查 Java 运行时')
    })

    launcher.on('launch_check_java', () => {
      this.phase('java', 3, '正在检查 Java 运行时', '首次启动会自动下载匹配的 Java')
    })

    // eml-lib's event helper has `on()` but no `once()`/`removeListener()`, so a `once()` call used
    // to throw and abort the launch silently. Nothing else needs a one-shot listener now.
    launcher.on('java_info', ({ version, arch } = {}) => {
      this.log('INFO', `Java ${version || '?'} (${arch || '?'}) 已就绪`)
      const major = parseJavaMajor(version)
      const wrapperVersion = /launchwrapper/i.test(String(this.current?.mainClass || ''))
      const manifestMainClass = this.current?.manifestMainClass
      if (
        major &&
        major > 8 &&
        (wrapperVersion || (manifestMainClass && /launchwrapper/i.test(manifestMainClass)))
      ) {
        this.log(
          'WARN',
          `当前 Java ${version} 无法运行 LaunchWrapper 版本的 Minecraft（需要 Java 8），请在「启动设置 → Java 运行时」改为手动指定 Java 8。`
        )
      }
      this.sendEvent('progress', {
        stage: 'java',
        indeterminate: true,
        detail: `Java ${version || ''} ${arch ? `· ${arch}` : ''}`.trim()
      })
    })

    launcher.on('launch_launch', (launchConfig) => {
      this.throwIfCancelled()
      // eml-lib strips the `${user_properties}` placeholder for legacy versions, and 1.7.10–1.12.2
      // require `--userProperties`; keep the argument manager patched for this launch.
      patchArgumentManager(launcher.argumentManager, launchConfig || launcher.config)
      this.status = 'running'
      this.current = { ...this.current, launchedAt: Date.now() }
      this.phase('launch', 4, '正在启动游戏', 'Minecraft 进程即将出现')
      this.sendEvent('phase', {
        key: 'running',
        step: 4,
        label: '游戏已启动',
        detail: '祝你在方块世界里玩得开心',
        done: true
      })
      this.sendEvent('state', this.getState())
      this.log('INFO', 'Minecraft 进程已启动。')
    })

    launcher.on('launch_data', (line) => {
      if (typeof line === 'string' && line.trim()) this.log('GAME', line.trim())
    })

    launcher.on('launch_debug', (line) => {
      if (typeof line === 'string') this.log('DEBUG', line)
    })

    launcher.on('launch_crash', (crash) => {
      this.log('ERROR', `游戏异常退出，退出代码 ${crash?.code ?? '未知'}。`)
      this.sendEvent('crash', {
        code: crash?.code ?? null,
        logsPath: crash?.logsPath || path.join(this.gameDir, 'logs', 'latest.log'),
        crashReportsDir: crash?.crashReportsDir || path.join(this.gameDir, 'crash-reports')
      })
    })

    launcher.on('launch_close', (code) => {
      this.finishLaunch(code)
    })
  }

  phase(key, step, label, detail = '', extra = {}) {
    this.throwIfCancelled()
    this.sendEvent('phase', { key, step, label, detail, ...extra })
  }

  finishLaunch(code) {
    // Always release the UI lock, even when the launch failed before `running` or a cancel raced
    // the exit. Without this a crashed game left the launcher stuck on "游戏已经在运行中".
    this.status = 'idle'
    this.gameProcess = null
    this.launchResult = null
    this.cancelRequested = false
    clearTimeout(this.cancelTimer)
    this.cancelTimer = null
    const normalized = typeof code === 'number' ? code : null
    const version = this.current?.version || this.store.getSettings().version
    try {
      this.closeLocalManifest()
    } catch {
      // Ignore.
    }
    try {
      this.restoreLaunchFetch()
    } catch {
      // Ignore.
    }
    this.current = null
    this.launcher = null
    this.downloadTotals = null
    this.downloadBase = { size: 0, files: 0 }
    this.currentGroup = { size: 0, files: 0 }
    try {
      this.store.update({ lastPlayed: new Date().toISOString() })
    } catch {
      // A read-only config directory should not prevent the UI from receiving launch_close.
    }

    if (normalized === 0) {
      this.log('INFO', '游戏已正常退出。')
    } else if (normalized !== null) {
      this.log('WARN', `游戏进程已退出，代码 ${normalized}，已重置为待命状态。`)
    }

    this.sendEvent('closed', { code: normalized, version })
    this.sendEvent('state', this.getState())
  }

  failLaunch(error) {
    if (this.cancelRequested) {
      this.finishCancel()
      return
    }
    // eml-lib keeps its own launcher log; dump the tail so a failure that happened deep inside a
    // phase (without throwing a useful error) is still visible in 运行日志.
    try {
      const launcherLogs = this.launcher?.launcherLogs
      if (Array.isArray(launcherLogs) && launcherLogs.length) {
        for (const line of launcherLogs.slice(-15)) this.log('DEBUG', `EML ${line}`)
      }
    } catch {
      // Ignore.
    }
    this.closeLocalManifest()
    this.restoreLaunchFetch()
    clearTimeout(this.cancelTimer)
    this.cancelTimer = null
    this.status = 'idle'
    this.current = null
    this.launcher = null
    this.downloadTotals = null
    this.downloadBase = { size: 0, files: 0 }
    this.currentGroup = { size: 0, files: 0 }
    this.sendEvent('state', this.getState())
    const message = redactSensitive(translateLaunchError(error))
    const detail = redactSensitive(String(error?.stack || error?.message || error || ''))
    this.log('ERROR', `启动失败：${message}`)
    if (detail && detail !== message) this.log('DEBUG', detail.slice(0, 5000))
    this.sendEvent('error', { message, detail })
  }

  log(level, message) {
    this.sendEvent('log', {
      level,
      message: redactSensitive(message),
      time: new Date().toISOString()
    })
  }

  sendEvent(type, data) {
    const window = this.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send('game:event', { type, data })
  }
}
