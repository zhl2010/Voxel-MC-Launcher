import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { ConfigStore } from './main/config-store.js'
import { VersionService } from './main/version-service.js'
import { LoaderService } from './main/loader-service.js'
import { GameService, GAME_ROOT_NAME } from './main/game-service.js'
import { ModService } from './main/mod-service.js'
import { SessionStore } from './main/session-store.js'
import { friendlyError } from './main/fetcher.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.argv.includes('--dev') || !app.isPackaged
const appIcon = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')

app.setName('Voxel Launcher')

let mainWindow = null
let store = null
let versions = null
let loaders = null
let game = null
let mods = null
let gameDir = null
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
    maximized: Boolean(mainWindow?.isMaximized())
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
      if (isDev) console.error(`[ipc:${channel}]`, error)
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
  mainWindow.webContents.send('window:state', { maximized })
}

function applyUiScale(percent) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const value = Math.min(130, Math.max(75, Number(percent) || 100))
  mainWindow.webContents.setZoomFactor(value / 100)
}

function suggestPclVersion(folderName) {
  const match = String(folderName).trim().match(/^(\d+(?:\.\d+)+)(?:[-_ ]+(.*))?$/)
  if (!match) return null
  const version = match[1]
  const suffix = String(match[2] || '').toLowerCase()
  let loader = 'vanilla'
  if (suffix.includes('neoforge')) loader = 'neoforge'
  else if (suffix.includes('fabric')) loader = 'fabric'
  else if (suffix.includes('quilt')) loader = 'quilt'
  else if (suffix.includes('forge')) loader = 'forge'
  return { version, loader }
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

  return { settings, appInfo: appInfo() }
}

async function openTarget(target) {
  const targets = {
    game: gameDir,
    versions: path.join(gameDir, 'versions'),
    mods: path.join(gameDir, 'mods'),
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
  handle('mods:install', async (payload) => mods.install(payload || {}))
  handle('mods:installed', async () => mods.listInstalled())

  handle('loaders:list', async (mcVersion) => {
    if (typeof mcVersion !== 'string') throw new Error('缺少 Minecraft 版本。')
    return loaders.getOptions(mcVersion)
  })

  handle('settings:save', async (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置格式无效。')
    if (Object.prototype.hasOwnProperty.call(patch, 'gameDir')) {
      throw new Error('请通过「存储位置」中的游戏目录设置修改目录。')
    }
    const settings = store.update(patch)
    applyUiScale(settings.uiScale)
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

  handle('directories:import-pcl', async (sourcePath) => {
    if (!game || game.getState().status !== 'idle') {
      throw new Error('游戏正在启动或运行中，请先结束游戏再导入 PCL 版本。')
    }
    if (mods?.busy) throw new Error('正在安装模组，请稍后再导入。')

    let selectedPath = typeof sourcePath === 'string' ? sourcePath.trim() : ''
    if (!selectedPath) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择 PCL 版本文件夹（versions\\版本名）',
        defaultPath: path.join(gameDir, 'versions'),
        buttonLabel: '导入此版本',
        properties: ['openDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return null
      selectedPath = result.filePaths[0]
    }

    const source = path.resolve(selectedPath)
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      throw new Error('请选择一个有效的版本文件夹。')
    }
    if (fs.existsSync(path.join(source, 'assets')) && fs.existsSync(path.join(source, 'libraries'))) {
      throw new Error('这里看起来是整个 .minecraft，请选择 .minecraft\\versions 下的具体版本文件夹。')
    }
    const entries = fs.readdirSync(source)
    if (!entries.some((name) => name.toLowerCase().endsWith('.json'))) {
      throw new Error('所选文件夹里没有版本 JSON，请选择 PCL 的具体版本文件夹。')
    }

    const sourceName = path.basename(source)
    const safeName =
      sourceName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) ||
      'pcl-instance'
    const destinationRoot = path.join(app.getPath('userData'), 'instances')
    fs.mkdirSync(destinationRoot, { recursive: true })
    const destination = path.join(destinationRoot, `${safeName}-${Date.now()}`)
    const ignoredTopLevel = new Set(['pcl', 'logs', 'downloads', 'natives', 'crash-reports', '.fabric'])

    await fs.promises.cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (entry) => {
        const relative = path.relative(source, entry)
        if (!relative) return true
        const topLevel = relative.split(path.sep)[0].toLowerCase()
        return !ignoredTopLevel.has(topLevel)
      }
    })

    // Turn the imported folder into a normal launcher instance: keep mods/saves/config at the
    // instance root and move the version JSON/JAR into versions/<id>. The local version scanner
    // then exposes the PCL version name directly in the version library.
    const copiedEntries = fs.readdirSync(destination)
    const jsonName =
      copiedEntries.find((name) => name === `${sourceName}.json`) ||
      copiedEntries.find((name) => name.toLowerCase().endsWith('.json'))
    let importedVersionId = null
    if (jsonName) {
      const versionDir = path.join(destination, 'versions', sourceName)
      fs.mkdirSync(versionDir, { recursive: true })
      fs.renameSync(
        path.join(destination, jsonName),
        path.join(versionDir, `${sourceName}.json`)
      )
      const jarName =
        copiedEntries.find((name) => name === `${sourceName}.jar`) ||
        copiedEntries.find((name) => name.toLowerCase().endsWith('.jar'))
      if (jarName) {
        fs.renameSync(path.join(destination, jarName), path.join(versionDir, `${sourceName}.jar`))
      }
      importedVersionId = sourceName
    }

    const applied = applyGameDirectory(destination)
    return {
      ...applied,
      imported: {
        source,
        destination,
        versionId: importedVersionId,
        suggested: suggestPclVersion(sourceName)
      }
    }
  })

  handle('ui:set-scale', async (value) => {
    const scale = Math.min(130, Math.max(75, Number(value) || 100))
    applyUiScale(scale)
    return scale
  })

  handle('auth:offline', async (username) => game.loginOffline(username))
  handle('auth:microsoft', async () => game.loginMicrosoft())
  handle('auth:yggdrasil', async (credentials) => game.loginYggdrasil(credentials || {}))
  handle('auth:logout', async () => game.logout())
  handle('auth:state', async () => ({
    account: game.getAccountSummary(),
    state: game.getState()
  }))

  handle('game:launch', async () => game.launch())
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

  ipcMain.handle('window:minimize', async (event) => {
    assertSender(event)
    mainWindow.minimize()
  })
  ipcMain.handle('window:toggle-maximize', async (event) => {
    assertSender(event)
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
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

  defaultGameDir = resolveGameDir()
  gameDir = resolveConfiguredGameDir(store.getSettings().gameDir)
  versions = new VersionService(gameDir)
  versions.init(userData)
  loaders = new LoaderService()
  mods = new ModService(gameDir)
  game = new GameService({
    getWindow: () => mainWindow,
    store,
    versions,
    loaders,
    gameDir,
    sessionStore: sessions
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
    console.error('Unhandled rejection:', reason)
  })
}
