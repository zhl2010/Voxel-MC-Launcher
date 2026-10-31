import http from 'node:http'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { CrackAuth, Launcher, MicrosoftAuth, YggdrasilAuth } from 'eml-lib'
import { friendlyError } from './fetcher.js'

const nativeFetch = globalThis.fetch.bind(globalThis)

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

function withTimeout(promise, milliseconds, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function splitArgs(value) {
  if (!value || !value.trim()) return []
  const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  return matches.map((part) => part.replace(/^["']|["']$/g, '')).filter(Boolean).slice(0, 100)
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

export class GameService {
  constructor({ getWindow, store, versions, loaders, gameDir, sessionStore }) {
    this.getWindow = getWindow
    this.store = store
    this.versions = versions
    this.loaders = loaders
    this.gameDir = gameDir
    this.sessionStore = sessionStore
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
    if (this.status !== 'idle') {
      throw new Error(this.status === 'running' ? '游戏已经在运行中。' : '启动流程正在进行中，请稍候。')
    }

    const settings = this.store.getSettings()
    if (!settings.version) throw new Error('请先选择一个 Minecraft 版本。')

    if (!this.account) this.restoreOfflineAccount()
    if (!this.account) throw new Error('请先登录账户，再开始游戏。')

    await this.refreshAccountIfNeeded()

    if (!(await this.versions.hasVersion(settings.version))) {
      throw new Error('所选版本不在版本清单中，请刷新版本列表后重试。')
    }

    const officialVersion = await this.versions.isOfficialVersion(settings.version)
    const localVersion = officialVersion ? null : this.versions.getLocalVersion(settings.version)
    let manifestUrl = null
    let loader
    let loaderLabel

    if (localVersion) {
      const manifest = await this.versions.resolveLocalVersion(settings.version)
      if (!manifest) throw new Error('本地版本 JSON 无法读取，请检查版本目录。')
      manifestUrl = await this.startLocalManifest(manifest)
      loader = { type: 'vanilla', version: settings.version }
      loaderLabel = '本地版本'
    } else {
      loader = await this.loaders.resolve(settings.version, settings.loader || 'vanilla')
      loaderLabel = LOADER_LABELS[loader.type] || loader.type
    }

    const javaArgs = splitArgs(settings.jvmArgs)
    const java =
      settings.javaMode === 'manual'
        ? {
            install: 'manual',
            absolutePath: settings.javaPath || 'java',
            args: javaArgs
          }
        : {
            install: 'auto',
            args: javaArgs
          }

    const config = {
      root: GAME_ROOT_NAME,
      storage: 'isolated',
      minecraft: {
        version: settings.version,
        loader: manifestUrl
          ? {
              loader: 'vanilla',
              version: settings.version,
              manifestUrl
            }
          : {
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
    } catch (error) {
      await this.closeLocalManifest()
      throw new Error(translateLaunchError(error))
    }

    // eml-lib resolves its `root` config as a hidden folder under appData, not as an arbitrary
    // absolute path. The launcher now supports a user-selected game directory, so replace the
    // resolved root after construction and point the auto-downloaded Java runtime at the same
    // directory. Everything after this point (downloads, versions, assets, mods, logs, cwd and
    // launch arguments) reads `launcher.config.root`.
    launcher.config.root = this.gameDir
    // setMinecraft() intentionally drops manifestUrl for vanilla entries, so re-attach the local
    // manifest after construction. getMinecraftManifestUrl() then fetches this JSON instead of
    // looking up the custom version id in Mojang's manifest.
    if (manifestUrl && launcher.config.minecraft?.loader) {
      launcher.config.minecraft.loader = {
        loader: 'vanilla',
        version: settings.version,
        manifestUrl
      }
    }
    if (launcher.config.java?.install === 'auto') {
      launcher.config.java.absolutePath = path.join(
        this.gameDir,
        'runtime',
        'jre-${X}',
        'bin',
        'java'
      )
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

    launcher
      .launch()
      .then(() => {
        if (this.launcher !== launcher) return
        if (this.cancelRequested) {
          this.finishCancel()
          return
        }
        // launch_close normally performs the cleanup. This is a safety net for unexpected
        // eml-lib exits.
        if (this.status !== 'idle') this.finishLaunch(null)
      })
      .catch((error) => {
        if (this.launcher !== launcher) return
        if (this.cancelRequested) {
          this.finishCancel()
          return
        }
        this.failLaunch(error)
      })

    return {
      version: settings.version,
      loader: loader.type,
      loaderLabel
    }
  }

  async startLocalManifest(manifest) {
    await this.closeLocalManifest()
    const token = randomBytes(16).toString('hex')
    const route = `/manifest-${token}.json`
    const server = http.createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== route) {
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
    this.originalFetch = globalThis.fetch
    globalThis.fetch = (input, init = {}) => {
      const signal = this.launchAbort?.signal
      return nativeFetch(input, signal ? { ...init, signal } : init)
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
    if (this.status !== 'launching') {
      throw new Error('当前没有可以取消的启动流程。')
    }
    this.cancelRequested = true
    this.status = 'cancelling'
    this.launchAbort?.abort()
    clearTimeout(this.cancelTimer)
    this.cancelTimer = setTimeout(() => {
      if (this.status === 'cancelling') this.finishCancel()
    }, 15_000)
    this.log('WARN', '正在取消游戏启动…')
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

    launcher.on('java_info', ({ version, arch } = {}) => {
      this.log('INFO', `Java ${version || '?'} (${arch || '?'}) 已就绪`)
      this.sendEvent('progress', {
        stage: 'java',
        indeterminate: true,
        detail: `Java ${version || ''} ${arch ? `· ${arch}` : ''}`.trim()
      })
    })

    launcher.on('launch_launch', () => {
      this.throwIfCancelled()
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
    if (this.status === 'idle') return
    if (this.cancelRequested) {
      this.finishCancel()
      return
    }
    const normalized = typeof code === 'number' ? code : null
    const version = this.current?.version || this.store.getSettings().version
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
    try {
      this.store.update({ lastPlayed: new Date().toISOString() })
    } catch {
      // A read-only config directory should not prevent the UI from receiving launch_close.
    }

    if (normalized === 0) {
      this.log('INFO', '游戏已正常退出。')
    } else if (normalized !== null) {
      this.log('WARN', `游戏进程已退出，代码 ${normalized}。`)
    }

    this.sendEvent('closed', { code: normalized, version })
    this.sendEvent('state', this.getState())
  }

  failLaunch(error) {
    if (this.cancelRequested) {
      this.finishCancel()
      return
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
    const message = translateLaunchError(error)
    const detail = String(error?.stack || error?.message || error || '')
    this.log('ERROR', `启动失败：${message}`)
    if (detail && detail !== message) this.log('DEBUG', detail.slice(0, 5000))
    this.sendEvent('error', { message, detail })
  }

  log(level, message) {
    this.sendEvent('log', {
      level,
      message,
      time: new Date().toISOString()
    })
  }

  sendEvent(type, data) {
    const window = this.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send('game:event', { type, data })
  }
}
