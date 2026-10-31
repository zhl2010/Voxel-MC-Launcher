import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { ConfigStore } from './main/config-store.js'
import { VersionService } from './main/version-service.js'
import { LoaderService } from './main/loader-service.js'
import { GameService, GAME_ROOT_NAME, instanceDirFor } from './main/game-service.js'
import { ModService } from './main/mod-service.js'
import { SessionStore } from './main/session-store.js'
import { SkinService } from './main/skin-service.js'
import { configureNetwork } from './main/network.js'
import { redactSensitive } from './main/redact.js'
import { friendlyError } from './main/fetcher.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.argv.includes('--dev') || !app.isPackaged
const appIcon = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')

app.setName('Voxel Launcher')

let mainWindow = null
let store = null
let skinService = null
let versions = null
let loaders = null
let game = null
let mods = null
let gameDir = null
// Version id of the verification currently running (`''` when idle).
let verifyingVersionId = ''
let defaultGameDir = null

function getAppDataFolder() {
  if (process.platform === 'win32') return process.env.APPDATA || app.getPath('appData')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  return os.homedir()
}

function resolveGameDir() {
  const folder = GAME_ROOT_NAME.replace(/[^a-z0-9]/gi, '_').toLowerCase()
  const name = process.platform === 'darwin' ? folder : `.${folder}`
  return path.join(getAppDataFolder(), name)
}

function expandPath(value) {
  let expanded = String(value || '').trim().replace(/^"(.*)"$/, '$1')
  if (process.platform === 'win32') {
    expanded = expanded.replace(/%([^%]+)%/g, (match, name) => process.env[name] || match)
  }
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(1))
  }
  return expanded
}

function resolveConfiguredGameDir(value, { strict = false } = {}) {
  const raw = expandPath(value)
  if (!raw) return defaultGameDir || resolveGameDir()
  if (!path.isAbsolute(raw)) {
    if (strict) throw new Error('请输入绝对路径，或点击「浏览」选择目录。')
    return defaultGameDir || resolveGameDir()
  }
  return path.normalize(raw)
}

function samePath(left, right) {
  if (!left || !right) return false
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function ensureWritableDirectory(directory) {
  const resolved = path.resolve(directory)
  if (fs.existsSync(resolved)) {
    const stats = fs.statSync(resolved)
    if (!stats.isDirectory()) throw new Error('所选路径不是文件夹，请重新选择。')
  } else {
    fs.mkdirSync(resolved, { recursive: true })
  }

  const probe = path.join(resolved, `.voxel-write-${process.pid}-${Date.now()}`)
  try {
    fs.writeFileSync(probe, 'ok')
  } catch {
    throw new Error(
      '目录不可写。请选择有写入权限的文件夹；Program Files 下通常需要管理员权限，建议把游戏目录移动到其他磁盘位置。'
    )
  } finally {
    try {
      fs.rmSync(probe, { force: true })
    } catch {
      // The write was already verified; a failed probe cleanup is harmless.
    }
  }
  return resolved
}

function getEmlVersion() {
  try {
    return require('eml-lib/package.json').version
  } catch {
    return '2.x'
  }
}

function appInfo() {
  return {
    version: app.getVersion(),
    emlVersion: getEmlVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    gameDir,
    defaultGameDir: defaultGameDir || resolveGameDir(),
    gameDirIsCustom: !samePath(gameDir, defaultGameDir || resolveGameDir()),
    versionsDir: path.join(gameDir, 'versions'),
    modsDir: path.join(gameDir, 'mods'),
    logsDir: path.join(gameDir, 'logs'),
    logsPath: path.join(gameDir, 'logs', 'latest.log'),
    crashReportsDir: path.join(gameDir, 'crash-reports'),
    savesDir: path.join(gameDir, 'saves'),
    resourcepacksDir: path.join(gameDir, 'resourcepacks'),
    shaderpacksDir: path.join(gameDir, 'shaderpacks'),
    userData: app.getPath('userData'),
    totalMemoryMB: Math.floor(os.totalmem() / 1024 / 1024),
    cpu: os.cpus()?.[0]?.model?.trim() || 'Unknown CPU',
    maximized: Boolean(mainWindow?.isMaximized()),
    // Where the selected version actually reads/writes mods (version isolation aware).
    instanceDir: game?.instanceDirFor(store.getSettings().version) || gameDir,
    modsDir: mods?.modsDir || path.join(gameDir, 'mods'),
    versionIsolation: Boolean(store.getSettings().versionIsolation)
  }
}

function assertSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('拒绝了来自未知页面的请求。')
  }
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertSender(event)
    try {
      return { ok: true, data: await handler(...args) }
    } catch (error) {
      if (isDev) console.error(`[ipc:${channel}]`, redactSensitive(error?.stack || error))
      return { ok: false, error: friendlyError(error) }
    }
  })
}

function createWindow() {
  const windowOptions = {
    width: 1240,
    height: 800,
    minWidth: 1020,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#07110c',
    title: 'Voxel Launcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: isDev
    }
  }

  if (process.platform === 'darwin') {
    windowOptions.titleBarStyle = 'hiddenInset'
    windowOptions.trafficLightPosition = { x: 16, y: 16 }
  }

  if (fs.existsSync(appIcon)) windowOptions.icon = appIcon

  mainWindow = new BrowserWindow(windowOptions)
  Menu.setApplicationMenu(null)

  if (process.platform === 'win32') {
    app.setAppUserModelId('com.voxel.launcher')
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  const reveal = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
  }
  mainWindow.once('ready-to-show', reveal)
  setTimeout(reveal, 4000)

  mainWindow.on('maximize', () => sendWindowState(true))
  mainWindow.on('unmaximize', () => sendWindowState(false))
  // Entering/leaving fullscreen (F11) is reported to the renderer so the title bar can show the
  // right state.
  mainWindow.on('enter-full-screen', () => sendFullScreenState(true))
  mainWindow.on('leave-full-screen', () => sendFullScreenState(false))
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('did-finish-load', () => {
    applyUiScale(store?.getSettings().uiScale)
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited:', details)
  })

  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

function sendWindowState(maximized) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('window:state', { maximized, fullScreen: mainWindow.isFullScreen?.() ?? false })
}

function sendFullScreenState(fullScreen) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('window:state', {
    maximized: mainWindow.isMaximized(),
    fullScreen
  })
}

function applyNetworkSettings(settings) {
  try {
    configureNetwork({
      ...settings,
      onRequest: ({ method, url, mirrored }) => {
        if (game) game.log('DEBUG', `NET ${method} ${url}${mirrored ? ' [mirror]' : ''}`)
      },
      onProbe: ({ url, originalUrl, mirrored }) => {
        if (game) {
          game.log(
            'DEBUG',
            `PROBE HEAD ${url}${mirrored ? ` [mirror of ${originalUrl}]` : ''}`
          )
        }
      }
    })
  } catch (error) {
    console.error('Network configuration failed:', error)
  }
}

function applyUiScale(percent) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const value = Math.min(130, Math.max(75, Number(percent) || 100))
  mainWindow.webContents.setZoomFactor(value / 100)
}

function applyGameDirectory(value) {
  if (!game || game.getState().status !== 'idle') {
    throw new Error('游戏正在启动或运行中，暂时不能修改游戏目录。')
  }
  if (mods?.busy) {
    throw new Error('正在安装模组，请等待安装完成后再修改游戏目录。')
  }

  const nextDir = ensureWritableDirectory(resolveConfiguredGameDir(value, { strict: true }))
  const nextVersions = new VersionService(nextDir)
  nextVersions.init(app.getPath('userData'))
  const nextMods = new ModService(nextDir)

  const settings = store.update({
    gameDir: samePath(nextDir, defaultGameDir || resolveGameDir()) ? '' : nextDir
  })

  gameDir = nextDir
  versions = nextVersions
  mods = nextMods
  game.setGameDir(nextDir, versions)
  syncModsInstance()

  return { settings, appInfo: appInfo() }
}

/** Guard version ids coming from the renderer before they are used as a path segment. */
function sanitizeVersionId(versionId) {
  const id = typeof versionId === 'string' ? versionId.trim() : ''
  if (!id || id === '.' || id === '..' || /[\\/:*?"<>|\r\n]/.test(id) || id.length > 128) {
    throw new Error('无效的版本名。')
  }
  return id
}

/** Keep ModService pointed at the directory the selected version actually loads mods from. */
function syncModsInstance() {
  if (!mods || !game) return
  mods.setInstanceDir(game.instanceDirFor(store.getSettings().version))
}

async function openTarget(target) {
  const targets = {
    game: gameDir,
    versions: path.join(gameDir, 'versions'),
    mods: mods?.modsDir || path.join(gameDir, 'mods'),
    instance: game ? game.instanceDirFor(store.getSettings().version) : gameDir,
    logs: path.join(gameDir, 'logs'),
    'latest-log': path.join(gameDir, 'logs', 'latest.log'),
    'crash-reports': path.join(gameDir, 'crash-reports'),
    saves: path.join(gameDir, 'saves'),
    resourcepacks: path.join(gameDir, 'resourcepacks'),
    shaderpacks: path.join(gameDir, 'shaderpacks'),
    userData: app.getPath('userData')
  }
  const destination = targets[target]
  if (!destination) throw new Error('不支持的目录。')

  if (target === 'latest-log') {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    if (!fs.existsSync(destination)) {
      fs.writeFileSync(destination, '尚未启动过游戏，日志文件还未生成。\n', 'utf8')
    }
  } else {
    fs.mkdirSync(destination, { recursive: true })
  }

  const error = await shell.openPath(destination)
  if (error) throw new Error(`无法打开目录：${error}`)
  return true
}

function registerIpc() {
  handle('app:bootstrap', async () => ({
    settings: store.getSettings(),
    account: game.getAccountSummary(),
    gameState: game.getState(),
    appInfo: appInfo()
  }))

  handle('app:info', async () => appInfo())

  handle('versions:list', async (force = false) => versions.getVersions({ force: Boolean(force) }))

  handle('mods:search', async (payload) => mods.search(payload || {}))
  handle('mods:install', async (payload) => {
    const request = payload || {}
    // A user-picked destination must stay inside the game directory.
    if (request.targetDir) {
      const resolved = path.resolve(String(request.targetDir))
      const root = path.resolve(gameDir)
      const relative = path.relative(root, resolved)
      request.targetDir =
        relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? resolved : ''
    }
    return mods.install(request)
  })
  // Native folder picker for "save mod to…"; defaults to the game directory root.
  handle('mods:choose-dir', async (currentDir) => {
    const fallback = mods?.modsDir || path.join(gameDir, 'mods')
    const start =
      typeof currentDir === 'string' && currentDir && fs.existsSync(currentDir)
        ? currentDir
        : gameDir && fs.existsSync(gameDir)
          ? gameDir
          : fallback
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择模组保存位置',
      defaultPath: start,
      buttonLabel: '保存到此处',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  handle('mods:versions', async (payload) => mods.listVersions(payload || {}))
  handle('mods:icon', async (payload) =>
    mods.iconFor(payload?.projectId, { iconUrl: payload?.iconUrl || '' })
  )
  handle('mods:installed', async () => mods.listInstalled())

  handle('loaders:list', async (mcVersion, versionType) => {
    if (typeof mcVersion !== 'string') throw new Error('缺少 Minecraft 版本。')
    // Loader metadata is cosmetic (it only fills the picker). While a launch is running it must
    // never compete for the main thread or the network, so answer locally with vanilla only.
    if (game && game.getState().status !== 'idle') {
      return {
        vanilla: {
          type: 'vanilla',
          label: '原版',
          version: mcVersion,
          detail: '启动进行中，暂不查询模组加载器',
          available: true
        }
      }
    }
    return loaders.getOptions(mcVersion, { versionType: typeof versionType === 'string' ? versionType : '' })
  })

  handle('settings:save', async (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效。')
    if (Object.prototype.hasOwnProperty.call(patch, 'gameDir')) {
      throw new Error('请通过「存储位置」中的游戏目录设置修改目录。')
    }
    const settings = store.update(patch)
    applyUiScale(settings.uiScale)
    applyNetworkSettings(settings)
    syncModsInstance()
    return settings
  })

  handle('directories:choose-game', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Minecraft 游戏目录',
      defaultPath: gameDir,
      buttonLabel: '选择此目录',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  handle('directories:set-game-dir', async (value) => applyGameDirectory(value))

  handle('ui:set-scale', async (value) => {
    const scale = Math.min(130, Math.max(75, Number(value) || 100))
    applyUiScale(scale)
    return scale
  })

  handle('auth:offline', async (username) => game.loginOffline(username))
  handle('auth:microsoft', async () => game.loginMicrosoft())
  handle('auth:yggdrasil', async (credentials) => game.loginYggdrasil(credentials || {}))
  handle('auth:logout', async () => game.logout())

  // Offline skins: upload a 64x64 PNG and read it back as a data URL for the lobby avatar.
  handle('skin:get', async () => {
    const account = game.getAccount()
    if (!account) return ''
    return skinService.getSkinDataUrl(account)
  })
  handle('skin:upload', async () => {
    const account = game.getAccount()
    if (!account) throw new Error('请先登录离线账户或正版账户后才能上传皮肤。')
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择皮肤 PNG（64×64）',
      buttonLabel: '上传',
      properties: ['openFile'],
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const buffer = fs.readFileSync(result.filePaths[0])
    await skinService.saveSkin(account, buffer)
    const dataUrl = await skinService.getSkinDataUrl(account)
    return { ok: true, dataUrl, name: path.basename(result.filePaths[0]) }
  })
  handle('skin:clear', async () => {
    const account = game.getAccount()
    if (!account) throw new Error('当前没有登录账户。')
    await skinService.clearSkin(account)
    return { ok: true }
  })
  handle('auth:state', async () => ({
    account: game.getAccountSummary(),
    state: game.getState()
  }))

  handle('game:launch', async () => game.launch())
  handle('game:verify', async (versionId) => {
    if (game.getState().status !== 'idle') {
      throw new Error('游戏正在启动或运行中，请等它结束后再校验文件。')
    }
    // Only one verification may run at a time; the UI also disables the button for the version
    // being verified, but a second IPC call must not start a parallel repair.
    if (verifyingVersionId) {
      throw new Error('请等待当前校验完成。')
    }
    const settings = store.getSettings()
    const target = typeof versionId === 'string' && versionId ? versionId : settings.version
    if (!target) throw new Error('请先在版本库中选择一个版本。')
    verifyingVersionId = target
    try {
      return await game.verifyAndRepair(target, { settings, verbose: true })
    } finally {
      verifyingVersionId = ''
    }
  })
  handle('game:cancel', async () => game.cancelLaunch())
  handle('game:state', async () => game.getState())

  handle('dialog:choose-java', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Java 可执行文件',
      properties: ['openFile'],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Java 可执行文件', extensions: ['exe'] }]
          : [{ name: '所有文件', extensions: ['*'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  handle('app:open-path', async (target) => openTarget(target))
  // Open the folder of a specific version (`versions/<id>`), creating it when it does not exist yet.
  handle('versions:open-folder', async (versionId) => {
    const id = sanitizeVersionId(versionId)
    const destination = path.join(gameDir, 'versions', id)
    fs.mkdirSync(destination, { recursive: true })
    const error = await shell.openPath(destination)
    if (error) throw new Error(`无法打开版本目录：${error}`)
    return destination
  })
  // Delete an installed version folder. The running version and the versions drive root are
  // protected; after deleting the applied version the launcher falls back to the newest release.
  handle('versions:delete', async (versionId) => {
    const id = sanitizeVersionId(versionId)
    if (game.getState().status !== 'idle') {
      throw new Error('游戏正在启动或运行中，请等它结束后再删除版本。')
    }
    if (mods?.busy) throw new Error('正在安装模组，请稍后再删除版本。')
    const target = path.join(gameDir, 'versions', id)
    const versionsRoot = path.join(gameDir, 'versions')
    if (path.dirname(path.resolve(target)) !== path.resolve(versionsRoot)) {
      throw new Error('拒绝删除：目标不在版本目录内。')
    }
    if (!fs.existsSync(target)) throw new Error(`版本 ${id} 不存在或已被删除。`)
    fs.rmSync(target, { recursive: true, force: true })

    const settings = store.getSettings()
    let nextVersion = settings.version
    let nextLoader = settings.loader
    if (settings.version === id) {
      const data = await versions.getVersions({ force: false }).catch(() => null)
      nextVersion = data?.latest?.release || data?.versions?.[0]?.id || ''
      nextLoader = 'vanilla'
      if (nextVersion) store.update({ version: nextVersion, loader: nextLoader })
    }
    return { deleted: id, version: nextVersion, loader: nextLoader }
  })

  ipcMain.handle('window:minimize', async (event) => {    assertSender(event)
    mainWindow.minimize()
  })
  ipcMain.handle('window:toggle-maximize', async (event) => {
    assertSender(event)
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window:toggle-fullscreen', async (event) => {
    assertSender(event)
    const next = !mainWindow.isFullScreen()
    mainWindow.setFullScreen(next)
    sendFullScreenState(next)
    return next
  })
  ipcMain.handle('window:close', async (event) => {
    assertSender(event)
    mainWindow.close()
  })
}

async function start() {
  const userData = app.getPath('userData')
  store = new ConfigStore()
  store.init(userData)
  const sessions = new SessionStore()
  sessions.init(userData)
  skinService = new SkinService(() => userData)
  applyNetworkSettings(store.getSettings())

  defaultGameDir = resolveGameDir()
  gameDir = resolveConfiguredGameDir(store.getSettings().gameDir)
  versions = new VersionService(gameDir)
  versions.init(userData)
  loaders = new LoaderService()
  mods = new ModService(gameDir)
  mods.setInstanceDir(instanceDirFor(store.getSettings(), gameDir))
  game = new GameService({
    getWindow: () => mainWindow,
    store,
    versions,
    loaders,
    gameDir,
    sessionStore: sessions,
    projectRoot: path.join(__dirname, '..')
  })

  registerIpc()
  createWindow()

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write')
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(start).catch((error) => {
    console.error(error)
    dialog.showErrorBox('Voxel Launcher 启动失败', friendlyError(error))
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', redactSensitive(reason?.stack || reason))
  })
}
