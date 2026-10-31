const api = window.voxel

const PAGE_TITLES = {
  home: '游戏大厅',
  versions: '版本库',
  mods: '模组工坊',
  settings: '启动设置',
  logs: '运行日志'
}

const TYPE_META = {
  release: { label: '正式版', className: 'release' },
  snapshot: { label: '快照', className: 'snapshot' },
  old_beta: { label: '远古 Beta', className: 'old_beta' },
  old_alpha: { label: '远古 Alpha', className: 'old_alpha' }
}

const LOADER_ORDER = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']
const LOADER_NAMES = {
  vanilla: '原版',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge'
}

const state = {
  settings: null,
  account: null,
  appInfo: null,
  gameDirDirty: false,
  versions: [],
  latest: { release: '', snapshot: '' },
  versionsSource: '',
  versionsError: '',
  versionsLoading: false,
  syncText: '',
  page: 'home',
  filter: 'release',
  search: '',
  visibleLimit: 120,
  pendingVersion: '',
  pendingLoader: 'vanilla',
  loaderCache: new Map(),
  loaderRequests: new Map(),
  loaderRequestSeq: 0,
  saveTimer: null,
  saving: false,
  saveWaiters: [],
  pendingSave: {},
  saveError: '',
  launch: {
    status: 'idle',
    step: 0,
    percent: 0,
    indeterminate: false,
    title: '',
    detail: '',
    speed: '',
    crashed: false,
    error: '',
    hudCollapsed: false,
    cancelReady: false
  },
  logs: [],
  hudTimer: null,
  loginBusy: false,
  authTab: 'offline',
  mods: {
    loading: false,
    installing: new Set(),
    results: [],
    total: 0,
    query: '',
    targetKey: '',
    loadedKey: '',
    error: '',
    requestSeq: 0,
    installed: [],
    installedLoading: false
  }
}

const dom = {}
const avatarCache = new Map()
const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

init()

async function init() {
  cacheDom()
  if (!api) {
    showBootError(new Error('Electron 预加载脚本未能加载，请重新启动启动器。'))
    return
  }
  if (api.platform === 'darwin') document.body.classList.add('platform-darwin')

  bindWindowControls()
  bindNavigation()
  bindHome()
  bindVersions()
  bindMods()
  bindSettings()
  bindDirectorySettings()
  bindAppearance()
  bindAccount()
  bindLogs()
  bindHud()
  bindKeyboard()

  subscribeGameEvents()
  setBoot(8, '正在读取本地配置…')
  renderLogEmpty()

  try {
    const bootstrap = await invoke(api.bootstrap())
    state.settings = bootstrap.settings
    state.account = bootstrap.account
    state.appInfo = bootstrap.appInfo
    if (bootstrap.gameState?.status) {
      state.launch.status = bootstrap.gameState.status
      state.launch.cancelReady = bootstrap.gameState.status === 'launching'
    }

    applySettingsToUI()
    renderAccount()
    updateSettingsMeta()
    updateStaticInfo()
    appendLog('INFO', 'Voxel Launcher 已就绪，正在同步 Minecraft 版本清单。')

    setBoot(38, '正在同步版本清单…')
    await loadVersions(false)

    setBoot(100, '准备就绪')
    setTimeout(hideBoot, 300)
    refreshHomeLoader()
  } catch (error) {
    console.error('Launcher initialization failed:', error)
    showBootError(error)
  }
}

function cacheDom() {
  const ids = [
    'bootScreen', 'bootBar', 'bootText', 'bootRetry',
    'pageTitle', 'tbStatusDot', 'tbStatusText',
    'windowMinimize', 'windowMaximize', 'maximizeIcon', 'windowClose',
    'sideStatusLabel', 'sideStatusText', 'sideProgress', 'sideAccount', 'sideAvatar',
    'sideAccountName', 'sideAccountType', 'sideEmelVersion',
    'syncChip', 'syncText', 'homeRefresh',
    'heroInstanceChip', 'heroVersion', 'heroLoader', 'changeVersion', 'launchStateLabel',
    'accountCard', 'homeAvatar', 'homeAccountName', 'homeAccountType',
    'homeJavaMode', 'homeMemory', 'openGameFolder',
    'launchButton', 'launchButtonLabel', 'launchButtonSub', 'launchHint', 'cancelLaunch',
    'runtimeMemoryValue', 'runtimeMemoryText', 'runtimeJava', 'runtimeInstalled',
    'quickVersions', 'versionsRefresh', 'versionSearch', 'versionCount', 'versionList',
    'loadMoreVersions', 'detailType', 'detailVersion', 'detailInstalled', 'detailDate',
    'loaderOptions', 'applyVersion', 'openVersionsFolder',
    'modsRefresh', 'modSearchInput', 'modSearchBtn', 'modsTarget', 'modsTargetLabel',
    'modsCompat', 'modsCompatTitle', 'modsCompatText', 'modsResultMeta', 'modResults',
    'modsGameVersion', 'modsLoaderName', 'modsFolderPath', 'installedModsCount',
    'installedModsList',
    'saveState', 'settingsAvatar', 'settingsAccountName', 'settingsAccountType',
    'settingsLogin', 'settingsLogout',
    'maxMemory', 'maxMemoryValue', 'maxMemoryLimit', 'minMemory', 'minMemoryValue',
    'minMemoryLimit', 'systemMemory', 'windowWidth', 'windowHeight', 'fullscreen',
    'javaModeControl', 'javaManualField', 'javaPath', 'browseJava', 'jvmArgs',
    'uiScale', 'uiScaleValue', 'fontScale', 'fontScaleValue', 'accentColor',
    'accentColorValue', 'themeSwatches',
    'gameDirPath', 'gameDirInput', 'browseGameDir', 'applyGameDir', 'resetGameDir', 'importPclVersion',
    'gameDirFeedback', 'gameDirMode', 'versionsDirPath', 'modsDirPath', 'savesDirPath',
    'resourcepacksDirPath', 'shaderpacksDirPath', 'logsDirPath', 'crashReportsDirPath', 'userDataPath',
    'aboutLauncher', 'aboutEml', 'aboutElectron', 'aboutPlatform',
    'copyLogs', 'clearLogs', 'openLatestLog', 'logConsole', 'logCount', 'logLiveDot',
    'accountModal', 'closeAccountModal', 'modalAvatar', 'modalAccountName',
    'modalAccountType', 'modalAuthBadge', 'usernameInput', 'offlineLoginButton',
    'microsoftLoginButton', 'yggdrasilServer', 'yggdrasilUsername', 'yggdrasilPassword',
    'yggdrasilLoginButton', 'loginError',
    'launchHud', 'hudKicker', 'hudTitle', 'hudPhases', 'hudBar', 'hudPercent',
    'hudDetail', 'hudSpeed', 'hudCollapse', 'hudRetry', 'hudLogs', 'hudHide', 'hudCancel',
    'hudPill', 'hudPillText', 'hudPillPercent', 'toastStack'
  ]

  for (const id of ids) dom[id] = document.getElementById(id)
  dom.navItems = Array.from(document.querySelectorAll('.nav-item'))
  dom.pages = Array.from(document.querySelectorAll('[data-page-panel]'))
  dom.filterTabs = Array.from(document.querySelectorAll('.filter-tab'))
  dom.javaSegments = Array.from(document.querySelectorAll('[data-java-mode]'))
  dom.authTabs = Array.from(document.querySelectorAll('[data-auth-tab]'))
  dom.authPanes = Array.from(document.querySelectorAll('[data-auth-pane]'))
  dom.themeSwatches = Array.from(document.querySelectorAll('.theme-swatch'))
  dom.themeModeButtons = Array.from(document.querySelectorAll('[data-theme-mode]'))
}

function bindWindowControls() {
  dom.windowMinimize.addEventListener('click', () => api.minimizeWindow())
  dom.windowMaximize.addEventListener('click', () => api.toggleMaximizeWindow())
  dom.windowClose.addEventListener('click', () => api.closeWindow())

  api.onWindowState(({ maximized }) => {
    const use = dom.maximizeIcon.querySelector('use')
    use.setAttribute('href', maximized ? '#i-restore' : '#i-maximize')
    dom.windowMaximize.setAttribute('aria-label', maximized ? '还原窗口' : '最大化窗口')
  })
}

function bindNavigation() {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-page]') : null
    if (!target) return
    const page = target.dataset.page
    if (page && PAGE_TITLES[page]) navigate(page)
  })

  document.addEventListener('click', async (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-open-path]') : null
    if (!target) return
    try {
      await invoke(api.openPath(target.dataset.openPath))
    } catch (error) {
      toast(error.message, 'error')
    }
  })
}

function bindHome() {
  dom.accountCard.addEventListener('click', openAccountModal)
  dom.sideAccount.addEventListener('click', openAccountModal)
  dom.changeVersion.addEventListener('click', () => navigate('versions'))
  dom.launchButton.addEventListener('click', handleLaunch)
  dom.cancelLaunch.addEventListener('click', handleCancelLaunch)
  dom.hudCancel.addEventListener('click', handleCancelLaunch)
  dom.homeRefresh.addEventListener('click', () => loadVersions(true))
  dom.versionsRefresh.addEventListener('click', () => loadVersions(true))
  dom.openGameFolder.addEventListener('click', () => openPath('game'))
  dom.openVersionsFolder.addEventListener('click', () => openPath('versions'))
}

function bindVersions() {
  dom.filterTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      state.filter = tab.dataset.filter
      state.visibleLimit = 120
      dom.filterTabs.forEach((item) => item.classList.toggle('active', item === tab))
      renderVersionList()
    })
  })

  dom.versionSearch.addEventListener('input', () => {
    state.search = dom.versionSearch.value.trim().toLowerCase()
    state.visibleLimit = 120
    renderVersionList()
  })

  dom.versionList.addEventListener('click', (event) => {
    const item = event.target instanceof Element ? event.target.closest('[data-version]') : null
    if (!item) return
    selectVersion(item.dataset.version, { scroll: false })
  })

  dom.loadMoreVersions.addEventListener('click', () => {
    state.visibleLimit += 120
    renderVersionList()
  })

  dom.applyVersion.addEventListener('click', applySelectedVersion)
}

function bindMods() {
  dom.modsRefresh.addEventListener('click', () => {
    loadInstalledMods(true)
    toast('已刷新 mods 文件夹。', 'success')
  })

  dom.modSearchBtn.addEventListener('click', () => {
    searchMods(dom.modSearchInput.value)
  })

  dom.modSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      searchMods(dom.modSearchInput.value)
    }
  })
}

function bindSettings() {
  dom.settingsLogin.addEventListener('click', openAccountModal)
  dom.settingsLogout.addEventListener('click', handleLogout)

  dom.maxMemory.addEventListener('input', () => {
    const max = Number(dom.maxMemory.value)
    if (state.settings.minMemory >= max) {
      state.settings.minMemory = Math.max(512, max - 512)
      dom.minMemory.value = String(state.settings.minMemory)
    }
    dom.minMemory.max = String(Math.max(1024, max - 512))
    state.settings.maxMemory = max
    updateMemoryFields()
    queueSave({ maxMemory: state.settings.maxMemory, minMemory: state.settings.minMemory })
  })

  dom.minMemory.addEventListener('input', () => {
    const max = Number(dom.minMemory.value)
    const maxAllowed = Number(dom.maxMemory.value) - 512
    state.settings.minMemory = Math.min(max, maxAllowed)
    if (max > maxAllowed) dom.minMemory.value = String(maxAllowed)
    updateMemoryFields()
    queueSave({ minMemory: state.settings.minMemory })
  })

  dom.windowWidth.addEventListener('change', () => saveNumberField(dom.windowWidth, 'windowWidth', 854, 3840))
  dom.windowHeight.addEventListener('change', () => saveNumberField(dom.windowHeight, 'windowHeight', 480, 2160))

  dom.fullscreen.addEventListener('change', () => {
    state.settings.fullscreen = dom.fullscreen.checked
    queueSave({ fullscreen: dom.fullscreen.checked })
  })

  dom.javaSegments.forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.javaMode
      state.settings.javaMode = mode
      dom.javaSegments.forEach((segment) => segment.classList.toggle('active', segment === button))
      dom.javaManualField.hidden = mode !== 'manual'
      queueSave({ javaMode: mode })
    })
  })

  dom.browseJava.addEventListener('click', async () => {
    try {
      const file = await invoke(api.chooseJava())
      if (!file) return
      dom.javaPath.value = file
      state.settings.javaPath = file
      queueSave({ javaPath: file })
    } catch (error) {
      toast(error.message, 'error')
    }
  })

  dom.javaPath.addEventListener('input', () => {
    state.settings.javaPath = dom.javaPath.value.trim()
    queueSave({ javaPath: state.settings.javaPath })
  })

  dom.jvmArgs.addEventListener('input', () => {
    state.settings.jvmArgs = dom.jvmArgs.value
    queueSave({ jvmArgs: dom.jvmArgs.value })
  })
}

function bindDirectorySettings() {
  dom.gameDirInput.addEventListener('input', () => {
    state.gameDirDirty = true
    setDirectoryFeedback('')
  })

  dom.gameDirInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    applyGameDirectory(dom.gameDirInput.value)
  })

  dom.browseGameDir.addEventListener('click', async () => {
    try {
      const directory = await invoke(api.chooseGameDir())
      if (!directory) return
      dom.gameDirInput.value = directory
      state.gameDirDirty = true
      setDirectoryFeedback('已选择目录，点击「应用目录」生效。')
    } catch (error) {
      setDirectoryFeedback(error.message, 'error')
      toast(error.message, 'error')
    }
  })

  dom.applyGameDir.addEventListener('click', () => applyGameDirectory(dom.gameDirInput.value))
  dom.resetGameDir.addEventListener('click', () => {
    dom.gameDirInput.value = ''
    state.gameDirDirty = true
    applyGameDirectory('')
  })
  dom.importPclVersion.addEventListener('click', handleImportPclVersion)
}

async function applyGameDirectory(value) {
  if (state.launch.status !== 'idle') {
    setDirectoryFeedback('游戏正在启动或运行中，暂时不能修改游戏目录。', 'error')
    return
  }

  const resetToDefault = !String(value || '').trim()
  setDirectoryBusy(true)
  setDirectoryFeedback(resetToDefault ? '正在恢复默认目录…' : '正在切换目录…')

  try {
    const result = await invoke(api.setGameDir(String(value || '').trim()))
    state.settings = { ...state.settings, ...result.settings }
    state.appInfo = result.appInfo
    state.gameDirDirty = false
    resetModsForGameDir()
    updateSettingsMeta()
    updateHomeVersion()
    setDirectoryFeedback(
      resetToDefault ? '已恢复默认目录；旧目录中的文件没有移动。' : '目录已切换；旧目录中的文件没有移动。',
      'ok'
    )
    toast(resetToDefault ? '已恢复默认游戏目录' : '游戏目录已更新')
    loadVersions(false).catch(() => {})
  } catch (error) {
    setDirectoryFeedback(error.message, 'error')
    toast(error.message, 'error')
  } finally {
    setDirectoryBusy(false)
  }
}

async function handleImportPclVersion() {
  if (state.launch.status !== 'idle') {
    setDirectoryFeedback('游戏正在启动或运行中，暂时不能导入版本。', 'error')
    return
  }

  setDirectoryBusy(true)
  setDirectoryFeedback('正在复制 PCL 版本文件，请稍候…')
  try {
    const result = await invoke(api.importPclVersion())
    if (!result) {
      setDirectoryFeedback('')
      return
    }
    state.settings = { ...state.settings, ...result.settings }
    state.appInfo = result.appInfo
    state.gameDirDirty = false
    resetModsForGameDir()
    updateSettingsMeta()
    updateHomeVersion()
    const importedId = result.imported?.versionId
    const suggested = result.imported?.suggested
    const suggestionText = importedId
      ? `已在版本库生成本地版本「${importedId}」，直接选择它即可启动。`
      : suggested
        ? `建议在版本库选择 ${suggested.version} + ${loaderDisplay(suggested.loader)}。`
        : '请在版本库选择基础 Minecraft 版本和对应加载器。'
    setDirectoryFeedback(`已导入到 ${result.appInfo.gameDir}；${suggestionText}`, 'ok')
    toast(importedId ? 'PCL 版本已导入，可在版本库直接选择' : 'PCL 版本已导入')
    loadVersions(false).catch(() => {})
  } catch (error) {
    setDirectoryFeedback(error.message, 'error')
    toast(error.message, 'error')
  } finally {
    setDirectoryBusy(false)
  }
}

function setDirectoryBusy(busy) {
  dom.gameDirInput.readOnly = busy
  dom.browseGameDir.disabled = busy
  dom.applyGameDir.disabled = busy
  dom.resetGameDir.disabled = busy
  dom.importPclVersion.disabled = busy
}

function setDirectoryFeedback(text, kind = '') {
  dom.gameDirFeedback.textContent = text
  dom.gameDirFeedback.className = `directory-feedback ${kind}`.trim()
}

function resetModsForGameDir() {
  state.mods.requestSeq += 1
  state.mods.loading = false
  state.mods.results = []
  state.mods.total = 0
  state.mods.query = ''
  state.mods.targetKey = ''
  state.mods.loadedKey = ''
  state.mods.error = ''
  state.mods.installed = []
  state.mods.installedLoading = false
  state.mods.installing.clear()
}

function bindAppearance() {
  dom.uiScale.addEventListener('input', () => {
    const value = Number(dom.uiScale.value)
    state.settings.uiScale = value
    dom.uiScaleValue.textContent = `${value}%`
    updateRangeFill(dom.uiScale)
    invoke(api.setUiScale(value)).catch((error) => toast(error.message, 'error'))
    queueSave({ uiScale: value })
  })

  dom.fontScale.addEventListener('input', () => {
    const value = Number(dom.fontScale.value)
    state.settings.fontScale = value
    dom.fontScaleValue.textContent = `${value}%`
    updateRangeFill(dom.fontScale)
    applyAppearanceSettings()
    queueSave({ fontScale: value })
  })

  dom.themeSwatches.forEach((swatch) => {
    swatch.addEventListener('click', () => {
      setAccentColor(swatch.dataset.accent, true)
    })
  })

  dom.accentColor.addEventListener('input', () => {
    setAccentColor(dom.accentColor.value, false)
  })
  dom.accentColor.addEventListener('change', () => {
    setAccentColor(dom.accentColor.value, true)
  })

  dom.themeModeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.themeMode === 'light' ? 'light' : 'dark'
      state.settings.themeMode = mode
      applyAppearanceSettings()
      queueSave({ themeMode: mode })
    })
  })
}

function setAccentColor(color, persist) {
  if (!/^#[0-9a-fA-F]{6}$/.test(String(color))) return
  state.settings.accentColor = color.toLowerCase()
  applyThemeColor(state.settings.accentColor)
  if (persist) queueSave({ accentColor: state.settings.accentColor })
}

function saveNumberField(input, key, min, max) {
  const raw = Number(input.value)
  const value = Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : state.settings[key]
  input.value = String(value)
  state.settings[key] = value
  queueSave({ [key]: value })
}

function bindAccount() {
  dom.closeAccountModal.addEventListener('click', closeAccountModal)
  dom.accountModal.addEventListener('click', (event) => {
    if (event.target === dom.accountModal) closeAccountModal()
  })
  dom.authTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      if (!state.loginBusy) switchAuthTab(tab.dataset.authTab)
    })
  })
  dom.offlineLoginButton.addEventListener('click', handleOfflineLogin)
  dom.microsoftLoginButton.addEventListener('click', handleMicrosoftLogin)
  dom.yggdrasilLoginButton.addEventListener('click', handleYggdrasilLogin)
  dom.usernameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleOfflineLogin()
  })
  dom.yggdrasilPassword.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleYggdrasilLogin()
  })
}

function bindLogs() {
  dom.copyLogs.addEventListener('click', copyLogs)
  dom.clearLogs.addEventListener('click', clearLogs)
  dom.openLatestLog.addEventListener('click', () => openPath('latest-log'))
}

function bindHud() {
  dom.hudCollapse.addEventListener('click', collapseHud)
  dom.hudHide.addEventListener('click', collapseHud)
  dom.hudPill.addEventListener('click', () => {
    dom.hudPill.hidden = true
    dom.launchHud.hidden = false
    state.launch.hudCollapsed = false
  })
  dom.hudLogs.addEventListener('click', () => navigate('logs'))
  dom.hudRetry.addEventListener('click', () => {
    dom.launchHud.hidden = true
    dom.hudPill.hidden = true
    handleLaunch()
  })
}

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!dom.accountModal.hidden) closeAccountModal()
      return
    }

    if (event.key !== 'Enter') return
    if (!dom.accountModal.hidden) return
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'SELECT') return
    if (state.page !== 'home') return
    handleLaunch()
  })
}

function subscribeGameEvents() {
  api.onGameEvent(({ type, data }) => {
    if (type === 'state') {
      handleGameState(data)
    } else if (type === 'phase') {
      handleGamePhase(data)
    } else if (type === 'progress') {
      handleGameProgress(data)
    } else if (type === 'log') {
      appendLog(data.level || 'INFO', data.message || '', data.time)
    } else if (type === 'error') {
      handleGameError(data)
    } else if (type === 'crash') {
      handleGameCrash(data)
    } else if (type === 'cancelled') {
      handleGameCancelled(data)
    } else if (type === 'closed') {
      handleGameClosed(data)
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

function setBoot(percent, text) {
  dom.bootBar.style.width = `${Math.min(100, Math.max(0, percent))}%`
  if (text) dom.bootText.textContent = text
}

function hideBoot() {
  dom.bootScreen.classList.add('hidden')
}

function showBootError(error) {
  dom.bootBar.style.width = '100%'
  dom.bootBar.style.background = 'linear-gradient(90deg, #b94d4d, #ff8585)'
  dom.bootText.textContent = error?.message || '启动器初始化失败'
  dom.bootText.style.color = '#ffbaba'
  dom.bootRetry.hidden = false
  dom.bootRetry.onclick = () => location.reload()
  appendLog('ERROR', `启动器初始化失败：${error?.message || error}`)
}

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

function navigate(page) {
  if (!PAGE_TITLES[page]) return
  state.page = page
  if (page === 'versions' && !state.pendingVersion) {
    state.pendingVersion = getActiveVersion() || state.versions[0]?.id || ''
    if (state.pendingVersion) selectVersion(state.pendingVersion, { scroll: false })
  }

  dom.pages.forEach((panel) => panel.classList.toggle('active', panel.dataset.pagePanel === page))
  dom.navItems.forEach((item) => item.classList.toggle('active', item.dataset.page === page))
  dom.pageTitle.textContent = PAGE_TITLES[page]

  if (page === 'logs') {
    dom.logLiveDot.hidden = true
    if (!dom.launchHud.hidden) collapseHud()
    requestAnimationFrame(() => {
      dom.logConsole.scrollTop = dom.logConsole.scrollHeight
    })
  }

  if (page === 'versions') {
    renderVersionList()
    requestAnimationFrame(scrollPendingVersionIntoView)
  }

  if (page === 'mods') loadModsPage()

  if (page === 'settings') updateSettingsMeta()

  document.getElementById('mainScroll').scrollTo({ top: 0, behavior: 'smooth' })
}

function scrollPendingVersionIntoView() {
  if (!state.pendingVersion) return
  const item = Array.from(dom.versionList.querySelectorAll('[data-version]')).find(
    (node) => node.dataset.version === state.pendingVersion
  )
  item?.scrollIntoView({ block: 'nearest' })
}

/* -------------------------------------------------------------------------- */
/* Versions                                                                    */
/* -------------------------------------------------------------------------- */

async function loadVersions(force = false) {
  if (state.versionsLoading) return
  state.versionsLoading = true
  setRefreshing(true)
  setSync('loading', force ? '正在刷新版本清单' : '正在同步版本清单')

  try {
    const data = await invoke(api.getVersions(Boolean(force)))
    state.versions = data.versions || []
    state.latest = data.latest || { release: '', snapshot: '' }
    state.versionsSource = data.source || 'network'
    state.versionsError = data.error || ''

    if (!state.versions.length) throw new Error('版本清单为空')

    if (!state.settings.version || !state.versions.some((version) => version.id === state.settings.version)) {
      const fallback = state.latest.release || state.versions[0]?.id
      if (fallback) {
        await saveImmediate({ version: fallback, loader: 'vanilla' }).catch(() => {})
      }
    }

    if (!state.pendingVersion || !state.versions.some((version) => version.id === state.pendingVersion)) {
      state.pendingVersion = getActiveVersion()
    }

    if (!state.pendingVersion) state.pendingVersion = state.versions[0]?.id || ''
    state.pendingLoader =
      state.pendingVersion === state.settings.version ? state.settings.loader : 'vanilla'

    updateSyncChip()
    renderVersionList()
    if (state.pendingVersion) selectVersion(state.pendingVersion, { scroll: false })
    renderQuickVersions()
    updateHomeVersion()
    updateRuntimeStats()
    refreshHomeLoader()
  } catch (error) {
    state.versions = []
    state.versionsError = error.message
    setSync('error', '版本清单加载失败')
    renderVersionError(error.message)
    renderQuickError()
    updateHomeVersion()
    toast(error.message, 'error')
  } finally {
    state.versionsLoading = false
    setRefreshing(false)
  }
}

function setRefreshing(refreshing) {
  dom.homeRefresh.disabled = refreshing
  dom.versionsRefresh.disabled = refreshing
  if (refreshing) {
    dom.homeRefresh.classList.add('is-spinning')
    dom.versionsRefresh.classList.add('is-spinning')
  } else {
    dom.homeRefresh.classList.remove('is-spinning')
    dom.versionsRefresh.classList.remove('is-spinning')
  }
}

function setSync(kind, text) {
  state.syncText = text
  dom.syncText.textContent = text
  const dot = dom.syncChip.querySelector('.status-dot')
  dot.className = 'status-dot'
  if (kind === 'loading') dot.classList.add('busy')
  if (kind === 'warn') dot.classList.add('warn')
  if (kind === 'error') dot.classList.add('error')
}

function updateSyncChip() {
  if (state.versionsSource === 'network' || state.versionsSource === 'memory') {
    setSync('ok', `${state.versions.filter((item) => item.type === 'release').length} 个正式版已同步`)
  } else if (state.versionsSource === 'cache') {
    setSync('warn', '网络不可用 · 使用本地缓存')
  } else if (state.versionsSource === 'fallback') {
    setSync('warn', '离线模式 · 内置版本列表')
  } else {
    setSync('ok', '版本清单已同步')
  }
  dom.syncChip.title = state.versionsError ? `最近一次同步错误：${state.versionsError}` : ''
}

function getFilteredVersions() {
  let list = state.versions
  if (state.filter === 'release') list = list.filter((version) => version.type === 'release')
  else if (state.filter === 'snapshot') list = list.filter((version) => version.type === 'snapshot')
  else if (state.filter === 'old') {
    list = list.filter((version) => version.type === 'old_beta' || version.type === 'old_alpha')
  }
  if (state.search) {
    list = list.filter((version) => version.id.toLowerCase().includes(state.search))
  }
  return list
}

function renderVersionList() {
  const list = getFilteredVersions()
  dom.versionCount.textContent = `显示 ${Math.min(state.visibleLimit, list.length)} / ${list.length} 个版本`
  dom.loadMoreVersions.hidden = state.visibleLimit >= list.length

  if (!state.versions.length) {
    if (state.versionsError) renderVersionError(state.versionsError)
    return
  }

  if (!list.length) {
    dom.versionList.replaceChildren(createStateBlock('没有匹配的版本', '试试其他关键词或切换版本类型。'))
    return
  }

  const fragment = document.createDocumentFragment()
  for (const version of list.slice(0, state.visibleLimit)) {
    const meta = version.local
      ? { label: '本地', className: 'local' }
      : TYPE_META[version.type] || { label: version.type, className: 'release' }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'version-item'
    button.dataset.version = version.id
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', version.id === state.pendingVersion ? 'true' : 'false')
    if (version.id === state.pendingVersion) button.classList.add('selected')
    if (version.id === state.settings.version) button.classList.add('current')

    const indicator = document.createElement('span')
    indicator.className = `version-indicator${version.installed ? ' installed' : ''}`

    const main = document.createElement('span')
    main.className = 'version-item-main'
    const title = document.createElement('strong')
    title.textContent = version.id
    const subtitle = document.createElement('span')
    const bits = version.local
      ? [
          '本地自定义版本',
          version.baseVersion ? `基于 ${version.baseVersion}` : '',
          version.loader && version.loader !== 'vanilla' ? loaderDisplay(version.loader) : ''
        ]
      : [formatDate(version.releaseTime), version.installed ? '已安装' : '']
    subtitle.textContent = bits.filter(Boolean).join(' · ')
    main.append(title, subtitle)

    const badge = document.createElement('span')
    badge.className = `type-badge ${meta.className}`
    badge.textContent = meta.label

    button.append(indicator, main, badge)
    fragment.append(button)
  }

  dom.versionList.replaceChildren(fragment)
}

function renderVersionError(message) {
  const block = createStateBlock('无法加载版本清单', message || '请检查网络连接后重试。')
  block.classList.add('list-error')
  const retry = document.createElement('button')
  retry.type = 'button'
  retry.className = 'ghost-btn small'
  retry.textContent = '重新加载'
  retry.addEventListener('click', () => loadVersions(true))
  block.append(retry)
  dom.versionList.replaceChildren(block)
  dom.versionCount.textContent = '0 个版本'
  dom.loadMoreVersions.hidden = true
}

function renderQuickVersions() {
  const releases = state.versions
    .filter((version) => version.type === 'release' && !version.local)
    .slice(0, 4)
  if (!releases.length) {
    renderQuickError()
    return
  }

  const fragment = document.createDocumentFragment()
  for (const version of releases) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'quick-version'
    button.dataset.version = version.id

    const dot = document.createElement('span')
    dot.className = 'dot'
    const name = document.createElement('strong')
    name.textContent = version.id
    name.style.fontWeight = '500'
    const type = document.createElement('span')
    type.className = 'quick-type'
    type.textContent = version.installed ? '已安装' : '正式版'
    if (version.installed) type.classList.add('quick-check')

    button.append(dot, name, type)
    button.addEventListener('click', () => {
      selectVersion(version.id, { scroll: false })
      navigate('versions')
      requestAnimationFrame(() => setTimeout(scrollPendingVersionIntoView, 40))
    })
    fragment.append(button)
  }
  dom.quickVersions.replaceChildren(fragment)
}

function renderQuickError() {
  const empty = document.createElement('div')
  empty.className = 'field-hint'
  empty.textContent = '版本清单暂不可用'
  dom.quickVersions.replaceChildren(empty)
}

function createStateBlock(title, detail) {
  const wrap = document.createElement('div')
  wrap.className = 'list-empty'
  const strong = document.createElement('strong')
  strong.textContent = title
  const span = document.createElement('span')
  span.textContent = detail
  wrap.append(strong, span)
  return wrap
}

function selectVersion(id, { scroll = true } = {}) {
  const version = state.versions.find((item) => item.id === id)
  if (!version) return

  state.pendingVersion = id
  state.pendingLoader = version.local
    ? version.loader || 'vanilla'
    : id === state.settings.version
      ? state.settings.loader
      : 'vanilla'
  updateVersionDetail()
  renderVersionList()
  if (scroll) requestAnimationFrame(scrollPendingVersionIntoView)
  if (version.local) {
    renderLocalLoader(version)
    updateVersionDetail()
    return
  }
  loadPendingLoaders()
}

function renderLocalLoader(version) {
  const note = document.createElement('div')
  note.className = 'loader-local-note'
  const title = document.createElement('strong')
  title.textContent = '本地自定义版本'
  const detail = document.createElement('span')
  detail.textContent = version.baseVersion
    ? `基于 Minecraft ${version.baseVersion}${version.loader && version.loader !== 'vanilla' ? ` · ${loaderDisplay(version.loader)}` : ''}，启动器会直接读取该版本的 JSON。`
    : '启动器会直接读取该版本的 JSON，加载器和依赖已包含在版本文件中。'
  note.append(title, detail)
  dom.loaderOptions.replaceChildren(note)
}

function updateVersionDetail() {
  const version = state.versions.find((item) => item.id === state.pendingVersion)
  if (!version) {
    dom.detailVersion.textContent = '选择一个版本'
    dom.detailDate.textContent = '从左侧列表中选择版本，查看安装信息。'
    dom.detailInstalled.hidden = true
    dom.applyVersion.disabled = true
    dom.applyVersion.textContent = '选择一个版本'
    return
  }

  const meta = version.local
    ? { label: '本地', className: 'local' }
    : TYPE_META[version.type] || { label: version.type, className: 'release' }
  dom.detailType.className = `type-pill ${meta.className}`
  dom.detailType.textContent = meta.label
  dom.detailVersion.textContent = version.id
  dom.detailInstalled.hidden = !version.installed
  dom.detailDate.textContent = version.local
    ? `本地自定义版本${version.baseVersion ? ` · 基于 ${version.baseVersion}` : ''}${version.loader && version.loader !== 'vanilla' ? ` · ${loaderDisplay(version.loader)}` : ''}`
    : `发布于 ${formatDate(version.releaseTime)} · ${version.installed ? '已安装，可直接启动' : '首次使用需要下载'}`

  const isApplied =
    state.pendingVersion === state.settings.version && state.pendingLoader === state.settings.loader
  dom.applyVersion.disabled = false
  dom.applyVersion.textContent = isApplied ? '返回游戏大厅' : '使用此版本'
}

async function loadPendingLoaders() {
  const mc = state.pendingVersion
  if (!mc) return
  const local = state.versions.find((item) => item.id === mc && item.local)
  if (local) {
    state.pendingLoader = local.loader || 'vanilla'
    renderLocalLoader(local)
    updateVersionDetail()
    return
  }
  const requestId = ++state.loaderRequestSeq

  if (state.loaderCache.has(mc)) {
    const options = state.loaderCache.get(mc)
    if (state.pendingLoader !== 'vanilla' && !options[state.pendingLoader]) state.pendingLoader = 'vanilla'
    renderLoaderOptions(options)
    updateVersionDetail()
    return
  }

  renderLoaderSkeletons()
  try {
    const options = await getLoaderOptions(mc)
    if (requestId !== state.loaderRequestSeq || state.pendingVersion !== mc) return
    if (state.pendingLoader !== 'vanilla' && !options[state.pendingLoader]) state.pendingLoader = 'vanilla'
    renderLoaderOptions(options)
    updateVersionDetail()
  } catch (error) {
    if (requestId !== state.loaderRequestSeq || state.pendingVersion !== mc) return
    state.pendingLoader = 'vanilla'
    renderLoaderOptions({ vanilla: vanillaOption(mc) }, error.message)
    updateVersionDetail()
  }
}

function getLoaderOptions(mcVersion) {
  if (state.loaderCache.has(mcVersion)) return Promise.resolve(state.loaderCache.get(mcVersion))
  if (state.loaderRequests.has(mcVersion)) return state.loaderRequests.get(mcVersion)

  const task = invoke(api.getLoaders(mcVersion))
    .then((options) => {
      state.loaderCache.set(mcVersion, options)
      return options
    })
    .finally(() => {
      state.loaderRequests.delete(mcVersion)
    })

  state.loaderRequests.set(mcVersion, task)
  return task
}

function vanillaOption(mcVersion) {
  return {
    type: 'vanilla',
    label: '原版',
    version: mcVersion,
    detail: '纯净的 Minecraft 体验',
    available: true
  }
}

function renderLoaderSkeletons() {
  const fragment = document.createDocumentFragment()
  for (let i = 0; i < 2; i++) {
    const skeleton = document.createElement('div')
    skeleton.className = 'loader-skeleton'
    fragment.append(skeleton)
  }
  dom.loaderOptions.replaceChildren(fragment)
}

function renderLoaderOptions(options, errorMessage = '') {
  const mc = state.pendingVersion
  const fragment = document.createDocumentFragment()
  const merged = options?.vanilla ? options : { ...options, vanilla: vanillaOption(mc) }

  for (const type of LOADER_ORDER) {
    const option = merged[type]
    if (!option) continue

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'loader-option'
    button.dataset.loader = type
    if (state.pendingLoader === type) button.classList.add('selected')

    const mark = document.createElement('span')
    mark.className = 'loader-option-mark'
    mark.textContent =
      type === 'vanilla' ? 'V' : type === 'fabric' ? 'F' : type === 'quilt' ? 'Q' : type === 'forge' ? 'Fo' : 'N'

    const copy = document.createElement('span')
    copy.className = 'loader-option-copy'
    const name = document.createElement('strong')
    name.textContent = option.label || LOADER_NAMES[type] || type
    const detail = document.createElement('small')
    detail.textContent = option.detail || (type === 'vanilla' ? '纯净原版' : option.version)
    copy.append(name, detail)

    button.append(mark, copy)
    button.addEventListener('click', () => {
      state.pendingLoader = type
      renderLoaderOptions(merged, errorMessage)
      updateVersionDetail()
    })
    fragment.append(button)
  }

  if (errorMessage) {
    const note = document.createElement('p')
    note.className = 'loader-error'
    note.textContent = '加载器信息获取失败，仍可使用原版启动。'
    note.title = errorMessage
    fragment.append(note)
  }

  dom.loaderOptions.replaceChildren(fragment)
}

async function applySelectedVersion() {
  if (!state.pendingVersion) return
  const isApplied =
    state.pendingVersion === state.settings.version && state.pendingLoader === state.settings.loader

  if (!isApplied) {
    dom.applyVersion.disabled = true
    const previousVersion = state.settings.version
    const previousLoader = state.settings.loader
    try {
      const localVersion = state.versions.find(
        (item) => item.id === state.pendingVersion && item.local
      )
      const loader = localVersion?.loader || state.pendingLoader
      await saveImmediate({ version: state.pendingVersion, loader })
      toast(
        localVersion
          ? `已选择本地版本 ${state.pendingVersion}`
          : `已选择 Minecraft ${state.pendingVersion} · ${loaderDisplay(loader)}`,
        'success'
      )
      updateHomeVersion()
      await refreshHomeLoader()
    } catch (error) {
      state.settings.version = previousVersion
      state.settings.loader = previousLoader
      state.pendingLoader = previousLoader
      updateVersionDetail()
      toast(error.message, 'error')
      dom.applyVersion.disabled = false
      return
    }
  }

  navigate('home')
}

function formatDate(value) {
  if (!value) return '日期未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '日期未知'
  return dateFormatter.format(date)
}

/* -------------------------------------------------------------------------- */
/* Mods                                                                       */
/* -------------------------------------------------------------------------- */

const MOD_LOADERS = new Set(['fabric', 'quilt', 'forge', 'neoforge'])

function getModTarget() {
  const activeId = getActiveVersion()
  const active = state.versions.find((item) => item.id === activeId)
  const version = active?.local ? active.baseVersion || '' : activeId
  const loader = state.settings?.loader || 'vanilla'
  return {
    version,
    loader,
    supported: Boolean(version) && MOD_LOADERS.has(loader),
    key: `${version || ''}|${loader}`
  }
}

async function loadModsPage() {
  if (!state.settings) return
  const target = getModTarget()
  updateModsTargetUI(target)
  await loadInstalledMods(true)

  if (!target.supported) {
    state.mods.loadedKey = ''
    state.mods.results = []
    state.mods.error = ''
    renderModsNoLoader(target)
    return
  }

  if (state.mods.loadedKey !== target.key && !state.mods.loading) {
    dom.modSearchInput.value = ''
    state.mods.results = []
    state.mods.query = ''
    await searchMods('')
  }
}

function updateModsTargetUI(target) {
  const loaderLabel = loaderDisplay(target.loader)
  dom.modsGameVersion.textContent = target.version || '—'
  dom.modsLoaderName.textContent = loaderLabel
  dom.modsTargetLabel.textContent = target.version ? `${target.version} · ${loaderLabel}` : '未选择版本'
  dom.modsFolderPath.textContent = state.appInfo?.modsDir || '—'
  dom.modsFolderPath.title = state.appInfo?.modsDir || ''
  dom.modSearchInput.disabled = !target.supported
  dom.modSearchBtn.disabled = !target.supported

  dom.modsCompat.className = `compat-banner${target.supported ? ' ok' : ' warn'}`
  if (target.supported) {
    dom.modsCompatTitle.textContent = '兼容性目标已锁定'
    dom.modsCompatText.textContent = `只显示支持 Minecraft ${target.version} 与 ${loaderLabel} 的模组。`
  } else if (!target.version) {
    dom.modsCompatTitle.textContent = '尚未选择 Minecraft 版本'
    dom.modsCompatText.textContent = '请先在版本库中选择游戏版本与模组加载器。'
  } else {
    dom.modsCompatTitle.textContent = '当前实例没有模组加载器'
    dom.modsCompatText.textContent = `原版 Minecraft ${target.version} 无法加载模组，请先在版本库选择 Fabric、Quilt、Forge 或 NeoForge。`
  }
}

function renderModsNoLoader(target) {
  const title = target.version ? '需要模组加载器' : '尚未选择版本'
  const detail = target.version
    ? `原版 Minecraft ${target.version} 不能加载模组。请前往版本库，为该版本选择 Fabric、Quilt、Forge 或 NeoForge。`
    : '请先在版本库中选定游戏版本和加载器，再回到模组工坊。'
  dom.modsResultMeta.textContent = '未启用模组加载器'
  const empty = createModsEmpty(title, detail)
  const action = document.createElement('button')
  action.type = 'button'
  action.className = 'ghost-btn small'
  action.textContent = '前往版本库'
  action.addEventListener('click', () => navigate('versions'))
  empty.append(action)
  dom.modResults.replaceChildren(empty)
}

function createModsEmpty(title, detail) {
  const wrap = document.createElement('div')
  wrap.className = 'mods-empty'
  const strong = document.createElement('strong')
  strong.textContent = title
  const span = document.createElement('span')
  span.textContent = detail
  wrap.append(strong, span)
  return wrap
}

async function searchMods(query) {
  const target = getModTarget()
  if (!target.supported) {
    renderModsNoLoader(target)
    return
  }

  const requestSeq = ++state.mods.requestSeq
  const normalizedQuery = String(query || '').trim()
  state.mods.loading = true
  state.mods.error = ''
  dom.modSearchBtn.disabled = true
  dom.modsResultMeta.textContent = '正在连接 MODRINTH / API V2…'
  renderModSkeletons()

  try {
    const data = await invoke(
      api.searchMods({
        query: normalizedQuery,
        gameVersion: target.version,
        loader: target.loader
      })
    )
    if (requestSeq !== state.mods.requestSeq || getModTarget().key !== target.key) return
    state.mods.results = data.hits || []
    state.mods.total = Number(data.total) || 0
    state.mods.query = data.query || normalizedQuery
    state.mods.loadedKey = target.key
    state.mods.error = ''
    renderModResults(target)
  } catch (error) {
    if (requestSeq !== state.mods.requestSeq || getModTarget().key !== target.key) return
    state.mods.error = error.message
    state.mods.results = []
    dom.modsResultMeta.textContent = 'MODRINTH 请求失败'
    const empty = createModsEmpty('无法获取模组列表', error.message)
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'ghost-btn small'
    retry.textContent = '重试'
    retry.addEventListener('click', () => searchMods(normalizedQuery))
    empty.append(retry)
    dom.modResults.replaceChildren(empty)
    toast(`Modrinth 搜索失败：${error.message}`, 'error')
  } finally {
    if (requestSeq === state.mods.requestSeq) {
      state.mods.loading = false
      dom.modSearchBtn.disabled = !target.supported
    }
  }
}

function renderModSkeletons() {
  const fragment = document.createDocumentFragment()
  for (let i = 0; i < 4; i++) {
    const skeleton = document.createElement('div')
    skeleton.className = 'mod-skeleton'
    skeleton.innerHTML =
      '<span class="skeleton-mark"></span><span class="skeleton-lines"><i></i><i></i><i></i></span>'
    fragment.append(skeleton)
  }
  dom.modResults.replaceChildren(fragment)
}

function renderModResults(target) {
  const hits = state.mods.results
  if (!hits.length) {
    dom.modsResultMeta.textContent = '0 个兼容项目'
    dom.modResults.replaceChildren(
      createModsEmpty(
        '没有找到兼容模组',
        `Modrinth 上没有返回适配 Minecraft ${target.version} · ${loaderDisplay(target.loader)} 的结果。`
      )
    )
    return
  }

  dom.modsResultMeta.textContent = `显示 ${hits.length} / ${state.mods.total} 个兼容项目`
  const fragment = document.createDocumentFragment()
  for (const mod of hits) {
    const card = document.createElement('article')
    card.className = 'mod-card'

    const mark = document.createElement('span')
    mark.className = 'mod-mark'
    mark.textContent = modInitials(mod.title)

    const main = document.createElement('div')
    main.className = 'mod-card-main'

    const titleRow = document.createElement('div')
    titleRow.className = 'mod-title-row'
    const title = document.createElement('h3')
    title.textContent = mod.title
    const source = document.createElement('span')
    source.className = 'mod-source-tag'
    source.textContent = 'MODRINTH'
    titleRow.append(title, source)

    const desc = document.createElement('p')
    desc.className = 'mod-desc'
    desc.textContent = mod.description || '这个项目没有公开描述。'

    const meta = document.createElement('div')
    meta.className = 'mod-meta'
    const downloads = document.createElement('span')
    downloads.className = 'mod-stat'
    downloads.textContent = `↓ ${formatCompactNumber(mod.downloads)}`
    meta.append(downloads)
    for (const category of (mod.categories || []).slice(0, 3)) {
      const tag = document.createElement('span')
      tag.className = 'mod-category'
      tag.textContent = category
      meta.append(tag)
    }

    main.append(titleRow, desc, meta)

    const installed = isProjectInstalled(mod)
    const installing = state.mods.installing.has(mod.projectId)
    const install = document.createElement('button')
    install.type = 'button'
    install.className = 'mod-install-btn'
    install.dataset.projectId = mod.projectId
    install.textContent = installed ? '已安装' : installing ? '下载中…' : '安装'
    install.disabled = installed || installing
    if (!installed) install.addEventListener('click', () => installMod(mod, install, target))

    card.append(mark, main, install)
    fragment.append(card)
  }
  dom.modResults.replaceChildren(fragment)
}

function modInitials(title) {
  const compact = String(title || 'MOD').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '')
  return (compact.slice(0, 2) || 'M').toUpperCase()
}

function isProjectInstalled(mod) {
  if (
    state.mods.installed.some(
      (file) => file.projectId && file.projectId === mod.projectId
    )
  ) {
    return true
  }
  const slug = String(mod.slug || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (slug.length < 3) return false
  return state.mods.installed.some((file) =>
    String(file.name).toLowerCase().replace(/[^a-z0-9]/g, '').includes(slug)
  )
}

async function installMod(mod, button, target) {
  if (state.mods.installing.has(mod.projectId)) return
  state.mods.installing.add(mod.projectId)
  button.disabled = true
  button.textContent = '下载中…'

  try {
    const result = await invoke(
      api.installMod({
        projectId: mod.projectId,
        gameVersion: target.version,
        loader: target.loader
      })
    )
    toast(
      result.alreadyInstalled
        ? `${result.filename} 已存在，无需重复下载。`
        : `已下载 ${result.filename} 到 mods 文件夹。`,
      'success'
    )
    appendLog('INFO', `已安装模组 ${result.filename}（${mod.title}）。`)
    await loadInstalledMods(true)
    button.textContent = '已安装'
    button.disabled = true
  } catch (error) {
    button.disabled = false
    button.textContent = '重试'
    toast(`模组安装失败：${error.message}`, 'error')
  } finally {
    state.mods.installing.delete(mod.projectId)
  }
}

async function loadInstalledMods(force = false) {
  if (state.mods.installedLoading) return
  if (state.mods.installed.length && !force) {
    renderInstalledMods()
    return
  }
  state.mods.installedLoading = true
  if (!state.mods.installed.length) renderInstalledSkeleton()
  try {
    const list = await invoke(api.getInstalledMods())
    state.mods.installed = Array.isArray(list) ? list : []
    renderInstalledMods()
    if (state.mods.results.length && state.page === 'mods') {
      renderModResults(getModTarget())
    }
  } catch (error) {
    dom.installedModsList.replaceChildren(
      createModsEmpty('无法读取 mods 文件夹', error.message)
    )
    dom.installedModsCount.textContent = '0'
  } finally {
    state.mods.installedLoading = false
  }
}

function renderInstalledSkeleton() {
  const fragment = document.createDocumentFragment()
  for (let i = 0; i < 2; i++) {
    const skeleton = document.createElement('div')
    skeleton.className = 'installed-skeleton'
    fragment.append(skeleton)
  }
  dom.installedModsList.replaceChildren(fragment)
}

function renderInstalledMods() {
  const mods = state.mods.installed
  dom.installedModsCount.textContent = String(mods.length)
  if (!mods.length) {
    const empty = createModsEmpty('mods 文件夹为空', '下载的模组会显示在这里。')
    empty.classList.add('small')
    dom.installedModsList.replaceChildren(empty)
    return
  }

  const fragment = document.createDocumentFragment()
  for (const mod of mods) {
    const row = document.createElement('div')
    row.className = 'installed-item'
    const mark = document.createElement('span')
    mark.className = 'installed-mark'
    mark.innerHTML = '<svg><use href="#i-package"></use></svg>'
    const copy = document.createElement('div')
    copy.className = 'installed-copy'
    const name = document.createElement('strong')
    name.textContent = mod.name
    name.title = mod.name
    const meta = document.createElement('span')
    meta.textContent = `${formatBytes(mod.size)} · ${formatDate(mod.modified)}`
    copy.append(name, meta)
    row.append(mark, copy)
    fragment.append(row)
  }
  dom.installedModsList.replaceChildren(fragment)
}

function formatCompactNumber(value) {
  const number = Number(value) || 0
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}B`
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`
  return String(number)
}

/* -------------------------------------------------------------------------- */
/* Home                                                                        */
/* -------------------------------------------------------------------------- */

function getActiveVersion() {
  if (state.settings?.version && state.versions.some((item) => item.id === state.settings.version)) {
    return state.settings.version
  }
  return state.latest.release || state.versions[0]?.id || ''
}

function loaderDisplay(type) {
  if (!type || type === 'vanilla') return '原版'
  return LOADER_NAMES[type] || type
}

function updateHomeVersion() {
  if (!state.settings) return
  const version = getActiveVersion()
  const versionInfo = state.versions.find((item) => item.id === version)
  const localLoader = versionInfo?.local
    ? versionInfo.loader && versionInfo.loader !== 'vanilla'
      ? `本地 · ${loaderDisplay(versionInfo.loader)}`
      : '本地版本'
    : ''
  dom.heroVersion.textContent = version || '—'
  dom.heroLoader.textContent = localLoader || loaderDisplay(state.settings.loader)
  dom.heroInstanceChip.textContent = versionInfo?.installed ? '已安装 · 可直接启动' : '新世界 · 等待首次安装'
  dom.heroInstanceChip.style.color = versionInfo?.installed ? 'var(--accent)' : 'var(--warm)'

  dom.homeMemory.textContent = memoryLabel(state.settings.maxMemory)
  dom.homeJavaMode.textContent = state.settings.javaMode === 'manual' ? '手动指定' : '自动下载'
  dom.runtimeMemoryValue.textContent = String(Math.round((state.settings.maxMemory / 1024) * 10) / 10)
  dom.runtimeMemoryText.textContent = `${state.settings.maxMemory} MB 上限`
  dom.runtimeJava.textContent = state.settings.javaMode === 'manual' ? '手动指定' : '自动管理'
  updateRuntimeStats()
  updateLaunchAvailability()

  const loaderText = localLoader || loaderDisplay(state.settings.loader)
  if (!state.account) {
    dom.launchButtonSub.textContent = '请先登录账户'
  } else if (!version) {
    dom.launchButtonSub.textContent = '请选择一个 Minecraft 版本'
  } else {
    dom.launchButtonSub.textContent = `${version} · ${loaderText}`
  }
}

function updateRuntimeStats() {
  const installed = state.versions.filter((version) => version.installed).length
  dom.runtimeInstalled.textContent = `${installed} 个版本`
}

async function refreshHomeLoader() {
  if (!state.settings) return
  const active = state.versions.find((item) => item.id === getActiveVersion())
  if (active?.local) {
    updateHomeVersion()
    return
  }
  if (state.settings.loader === 'vanilla') {
    updateHomeVersion()
    return
  }

  const version = getActiveVersion()
  if (!version) return

  try {
    const options = await getLoaderOptions(version)
    if (!options[state.settings.loader]) {
      // This can mean "not supported" or just "the metadata endpoint is unreachable right now".
      // Keep the saved choice instead of silently downgrading the player's instance. The launch
      // path performs a forced lookup and reports the precise problem if it is really unsupported.
      toast(
        `${loaderDisplay(state.settings.loader)} 的版本信息暂不可用，已保留当前选择；启动时会再次尝试。`,
        'error'
      )
    }
  } catch {
    // Keep the saved loader; eml-lib will report a precise error at launch time.
  }
  updateHomeVersion()
}

function updateLaunchAvailability() {
  if (!state.settings) return
  const status = state.launch.status
  const cancelling = status === 'cancelling'
  const active = status === 'launching' || status === 'running' || cancelling
  const canCancel =
    (status === 'launching' && state.launch.cancelReady) || status === 'cancelling'

  dom.launchButton.disabled = active
  dom.cancelLaunch.hidden = !canCancel
  dom.cancelLaunch.disabled = cancelling
  dom.cancelLaunch.textContent = cancelling ? '正在取消…' : '取消启动'
  dom.hudCancel.hidden = !canCancel
  dom.hudCancel.disabled = cancelling
  dom.hudCancel.textContent = cancelling ? '正在取消…' : '取消启动'

  dom.launchStateLabel.textContent = cancelling
    ? '取消中'
    : status === 'running'
      ? '运行中'
      : status === 'launching'
        ? '启动中'
        : '待命'
  dom.launchButtonLabel.textContent = cancelling
    ? '正在取消…'
    : status === 'running'
      ? '游戏运行中'
      : status === 'launching'
        ? '正在启动…'
        : '开始游戏'

  if (status === 'running') {
    dom.launchHint.textContent = '游戏进程运行中，关闭启动器不会结束游戏。'
  } else if (status === 'launching') {
    dom.launchHint.textContent = '正在准备游戏文件，可以点击下方按钮取消启动。'
  } else if (cancelling) {
    dom.launchHint.textContent = '正在停止下载和启动流程，请稍候。'
  } else if (!state.account) {
    dom.launchHint.textContent = '登录账户后即可开始游戏。'
  } else {
    dom.launchHint.textContent = '首次启动会自动下载游戏文件与 Java 运行时。'
  }
}

async function handleCancelLaunch() {
  if (state.launch.status === 'cancelling') return
  if (state.launch.status !== 'launching') {
    toast('当前没有正在启动的游戏。')
    return
  }

  state.launch.status = 'cancelling'
  updateLaunchAvailability()
  updateTitlebarStatus()
  try {
    await invoke(api.cancelLaunch())
  } catch (error) {
    state.launch.status = 'launching'
    updateLaunchAvailability()
    updateTitlebarStatus()
    toast(error.message, 'error')
  }
}

async function handleLaunch() {
  if (
    state.launch.status === 'launching' ||
    state.launch.status === 'running' ||
    state.launch.status === 'cancelling'
  ) {
    return
  }
  if (!state.account) {
    toast('请先登录账户，再开始游戏。', 'error')
    openAccountModal()
    return
  }
  if (!state.settings.version) {
    toast('请先选择一个 Minecraft 版本。', 'error')
    navigate('versions')
    return
  }

  state.launch.status = 'launching'
  state.launch.cancelReady = false
  state.launch.crashed = false
  state.launch.error = ''
  state.launch.step = 0
  state.launch.percent = 0
  state.launch.indeterminate = true
  updateLaunchAvailability()
  setSideState('busy', '正在启动', `${state.settings.version} · ${loaderDisplay(state.settings.loader)}`, 3)
  resetHud()
  showHud()
  setHudPhase(0, '正在准备启动', `${state.settings.version} · ${loaderDisplay(state.settings.loader)}`, true)

  try {
    await invoke(api.launch())
  } catch (error) {
    state.launch.status = 'idle'
    updateLaunchAvailability()
    setSideState('error', '启动失败', error.message, 0)
    showHudError(error.message)
    toast(error.message, 'error')
  }
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

function applySettingsToUI() {
  if (!state.settings) return
  const settings = state.settings

  dom.windowWidth.value = String(settings.windowWidth)
  dom.windowHeight.value = String(settings.windowHeight)
  dom.fullscreen.checked = Boolean(settings.fullscreen)
  dom.javaPath.value = settings.javaPath || ''
  dom.jvmArgs.value = settings.jvmArgs || ''
  dom.javaManualField.hidden = settings.javaMode !== 'manual'
  dom.javaSegments.forEach((button) => {
    button.classList.toggle('active', button.dataset.javaMode === settings.javaMode)
  })

  dom.uiScale.value = String(settings.uiScale ?? 100)
  dom.uiScaleValue.textContent = `${settings.uiScale ?? 100}%`
  dom.fontScale.value = String(settings.fontScale ?? 100)
  dom.fontScaleValue.textContent = `${settings.fontScale ?? 100}%`
  dom.accentColor.value = settings.accentColor || '#eef0ea'
  updateRangeFill(dom.uiScale)
  updateRangeFill(dom.fontScale)
  applyAppearanceSettings()
  invoke(api.setUiScale(settings.uiScale ?? 100)).catch(() => {})

  updateMemoryFields()
  updateSettingsMeta()
  updateHomeVersion()
}

function applyAppearanceSettings() {
  if (!state.settings) return
  const mode = state.settings.themeMode === 'light' ? 'light' : 'dark'
  state.settings.themeMode = mode
  document.documentElement.dataset.theme = mode
  dom.themeModeButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.themeMode === mode)
  })
  document.documentElement.style.setProperty(
    '--font-scale',
    String((Number(state.settings.fontScale) || 100) / 100)
  )
  applyThemeColor(state.settings.accentColor || '#eef0ea')
}

function applyThemeColor(color) {
  const hex = /^#[0-9a-fA-F]{6}$/.test(String(color)) ? color : '#eef0ea'
  const sourceRgb = hexToRgb(hex)
  let rgb = sourceRgb

  // A light UI needs a darker accent for white-on-accent controls and progress fills.
  // Keep the swatch showing the original color, but apply a contrast-safe variant.
  if (state.settings?.themeMode === 'light') {
    let amount = 0
    while (luminance(rgb) > 0.3 && amount < 0.84) {
      amount += 0.06
      rgb = mixRgb(sourceRgb, [0, 0, 0], amount)
    }
  }

  const appliedHex = rgbToHex(rgb)
  const ink = luminance(rgb) > 0.55 ? '#090a0a' : '#f2f3ef'
  const root = document.documentElement
  root.style.setProperty('--accent', appliedHex)
  root.style.setProperty('--accent-bright', rgbToHex(mixRgb(rgb, [255, 255, 255], 0.32)))
  root.style.setProperty('--accent-deep', rgbToHex(mixRgb(rgb, [0, 0, 0], 0.35)))
  root.style.setProperty('--accent-ink', ink)
  dom.accentColor.value = hex
  dom.accentColorValue.textContent = hex.toUpperCase()
  dom.themeSwatches.forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.accent.toLowerCase() === hex.toLowerCase())
  })
}

function luminance(rgb) {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16)
  ]
}

function rgbToHex(rgb) {
  return `#${rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`
}

function mixRgb(from, to, amount) {
  return from.map((value, index) => value + (to[index] - value) * amount)
}

function updateMemoryFields() {
  if (!state.settings || !state.appInfo) return
  const totalMemoryMB = state.appInfo.totalMemoryMB || 8192
  const safeMax = Math.max(2048, Math.floor((totalMemoryMB - 2048) / 512) * 512)
  const sliderMax = Math.min(32768, Math.max(safeMax, 4096, Number(state.settings.maxMemory) || 0))
  const maxValue = Math.min(sliderMax, Number(state.settings.maxMemory) || 4096)
  const minMax = Math.max(1024, maxValue - 512)
  const minValue = Math.min(minMax, Number(state.settings.minMemory) || 1024)

  dom.maxMemory.max = String(sliderMax)
  dom.maxMemory.value = String(maxValue)
  dom.minMemory.max = String(minMax)
  dom.minMemory.value = String(minValue)
  dom.maxMemoryLimit.textContent = memoryLabel(sliderMax)
  dom.minMemoryLimit.textContent = memoryLabel(minMax)
  dom.systemMemory.textContent = `${Math.round(totalMemoryMB / 1024)} GB`
  dom.maxMemoryValue.textContent = `${maxValue} MB`
  dom.minMemoryValue.textContent = `${minValue} MB`
  updateRangeFill(dom.maxMemory)
  updateRangeFill(dom.minMemory)

  dom.homeMemory.textContent = memoryLabel(maxValue)
  dom.runtimeMemoryValue.textContent = String(Math.round((maxValue / 1024) * 10) / 10)
  dom.runtimeMemoryText.textContent = `${maxValue} MB 上限`
}

function memoryLabel(megabytes) {
  const value = Number(megabytes) || 0
  const gigabytes = value / 1024
  return Number.isInteger(gigabytes) ? `${gigabytes} GB` : `${gigabytes.toFixed(1)} GB`
}

function updateRangeFill(input) {
  const min = Number(input.min)
  const max = Number(input.max)
  const value = Number(input.value)
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0
  input.style.setProperty('--range-progress', `${Math.max(0, Math.min(100, percent))}%`)
}

function updateSettingsMeta() {
  if (!state.appInfo) return
  const info = state.appInfo
  dom.gameDirPath.textContent = info.gameDir
  dom.gameDirPath.title = info.gameDir
  dom.gameDirMode.textContent = info.gameDirIsCustom ? '自定义目录' : '默认目录'
  dom.gameDirMode.classList.toggle('custom', Boolean(info.gameDirIsCustom))
  if (!state.gameDirDirty) dom.gameDirInput.value = info.gameDir
  dom.gameDirInput.title = info.gameDir
  dom.gameDirInput.placeholder = info.defaultGameDir ? `默认：${info.defaultGameDir}` : '默认目录'

  const directoryBindings = [
    [dom.versionsDirPath, info.versionsDir],
    [dom.modsDirPath, info.modsDir],
    [dom.savesDirPath, info.savesDir],
    [dom.resourcepacksDirPath, info.resourcepacksDir],
    [dom.shaderpacksDirPath, info.shaderpacksDir],
    [dom.logsDirPath, info.logsDir],
    [dom.crashReportsDirPath, info.crashReportsDir],
    [dom.userDataPath, info.userData]
  ]
  for (const [element, value] of directoryBindings) {
    element.textContent = value || '—'
    element.title = value || ''
  }

  dom.aboutLauncher.textContent = `v${info.version}`
  dom.aboutEml.textContent = `v${info.emlVersion}`
  dom.aboutElectron.textContent = `v${info.electron}`
  dom.aboutPlatform.textContent = `${platformName(info.platform)} · ${info.arch}`
  dom.sideEmelVersion.textContent = info.emlVersion
}

function updateStaticInfo() {
  if (!state.appInfo) return
  updateSettingsMeta()
  dom.systemMemory.textContent = `${Math.round(state.appInfo.totalMemoryMB / 1024)} GB`
}

function platformName(platform) {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return platform
}

function queueSave(patch) {
  Object.assign(state.settings, patch)
  state.pendingSave = { ...state.pendingSave, ...patch }
  setSaveState('saving')
  clearTimeout(state.saveTimer)
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null
    runSaveQueue()
  }, 360)
  updateHomeVersion()
}

function saveImmediate(patch) {
  Object.assign(state.settings, patch)
  state.pendingSave = { ...state.pendingSave, ...patch }
  clearTimeout(state.saveTimer)
  state.saveTimer = null
  return new Promise((resolve, reject) => {
    state.saveWaiters.push({ resolve, reject })
    runSaveQueue()
  })
}

async function runSaveQueue() {
  if (state.saving) return
  if (!Object.keys(state.pendingSave).length) {
    resolveSaveWaiters(true)
    return
  }

  state.saving = true
  setSaveState('saving')
  const patch = state.pendingSave
  state.pendingSave = {}
  let ok = true
  let failure = ''

  try {
    const data = await invoke(api.saveSettings(patch))
    state.settings = { ...state.settings, ...data }
    state.saveError = ''
    setSaveState('saved')
  } catch (error) {
    ok = false
    failure = error.message
    state.saveError = error.message
    setSaveState('error')
    toast(`设置保存失败：${error.message}`, 'error')
  } finally {
    state.saving = false
    updateHomeVersion()
    if (Object.keys(state.pendingSave).length) {
      runSaveQueue()
    } else {
      resolveSaveWaiters(ok, failure)
    }
  }
}

function resolveSaveWaiters(ok, failure = '') {
  const waiters = state.saveWaiters.splice(0)
  for (const waiter of waiters) {
    if (ok) waiter.resolve()
    else waiter.reject(new Error(failure || '设置保存失败'))
  }
}

function setSaveState(kind) {
  const labels = {
    saved: '已自动保存',
    saving: '正在保存…',
    error: '保存失败'
  }
  dom.saveState.className = `save-state ${kind === 'saved' ? '' : kind}`.trim()
  dom.saveState.innerHTML = '<svg><use href="#i-check"></use></svg>'
  dom.saveState.append(document.createTextNode(labels[kind] || labels.saved))
}

function handleLogout() {
  invoke(api.logout())
    .then(() => {
      state.account = null
      state.settings.username = ''
      renderAccount()
      updateLaunchAvailability()
      toast('已退出当前账户。', 'success')
    })
    .catch((error) => toast(error.message, 'error'))
}

/* -------------------------------------------------------------------------- */
/* Account                                                                     */
/* -------------------------------------------------------------------------- */

function renderAccount() {
  const account = state.account
  const name = account?.name || '未登录'
  const typeText = accountTypeText(account)
  const shortType = accountShortText(account)

  dom.homeAccountName.textContent = name
  dom.homeAccountType.textContent = typeText
  dom.sideAccountName.textContent = name
  dom.sideAccountType.textContent = shortType
  dom.settingsAccountName.textContent = name
  dom.settingsAccountType.textContent = !account ? '登录后即可启动游戏' : typeText
  dom.settingsLogin.textContent = account ? '切换账户' : '登录账户'
  dom.settingsLogout.hidden = !account
  dom.modalAccountName.textContent = name
  dom.modalAccountType.textContent = typeText
  dom.modalAuthBadge.hidden = !account
  dom.modalAuthBadge.textContent =
    account?.type === 'msa' ? '正版' : account?.type === 'yggdrasil' ? '第三方' : '离线'
  dom.usernameInput.value = account?.type === 'crack' ? account.name : state.settings?.username || ''

  const seed = account?.uuid || account?.name || 'voxel-guest'
  applyAvatar(dom.homeAvatar, seed)
  applyAvatar(dom.sideAvatar, seed)
  applyAvatar(dom.settingsAvatar, seed)
  applyAvatar(dom.modalAvatar, seed)
  updateTitlebarStatus()
  updateHomeVersion()
}

function updateTitlebarStatus() {
  if (state.launch.status === 'running') {
    dom.tbStatusDot.className = 'status-dot busy'
    dom.tbStatusText.textContent = '游戏运行中'
    return
  }
  if (state.launch.status === 'launching') {
    dom.tbStatusDot.className = 'status-dot busy'
    dom.tbStatusText.textContent = '正在启动'
    return
  }
  if (state.launch.status === 'cancelling') {
    dom.tbStatusDot.className = 'status-dot warn'
    dom.tbStatusText.textContent = '正在取消启动'
    return
  }
  if (state.account) {
    dom.tbStatusDot.className = 'status-dot'
    dom.tbStatusText.textContent =
      state.account.type === 'msa'
        ? '正版在线'
        : state.account.type === 'yggdrasil'
          ? accountShortText(state.account)
          : '离线模式'
  } else {
    dom.tbStatusDot.className = 'status-dot warn'
    dom.tbStatusText.textContent = '未登录'
  }
}

function accountServerLabel(server) {
  if (!server) return 'Yggdrasil'
  try {
    const host = new URL(server).hostname.replace(/^www\./i, '')
    return /littleskin\.cn$/i.test(host) ? 'LittleSkin' : host
  } catch {
    return 'Yggdrasil'
  }
}

function accountTypeText(account) {
  if (!account) return '点击选择登录方式'
  if (account.type === 'msa') return 'Microsoft 正版账户'
  if (account.type === 'yggdrasil') return `${accountServerLabel(account.server)} · Yggdrasil`
  return '离线账户 · 本地游戏'
}

function accountShortText(account) {
  if (!account) return '点击登录账户'
  if (account.type === 'msa') return '正版在线'
  if (account.type === 'yggdrasil') return accountServerLabel(account.server)
  return '离线模式'
}

function openAccountModal() {
  dom.accountModal.hidden = false
  dom.loginError.hidden = true
  dom.loginError.textContent = ''
  dom.modalAuthBadge.hidden = !state.account
  const preferredTab =
    state.account?.type === 'msa'
      ? 'microsoft'
      : state.account?.type === 'yggdrasil'
        ? 'yggdrasil'
        : 'offline'
  switchAuthTab(preferredTab, false)
  setTimeout(() => {
    if (state.authTab === 'yggdrasil') {
      ;(dom.yggdrasilUsername.value ? dom.yggdrasilPassword : dom.yggdrasilUsername).focus()
    } else if (state.authTab === 'microsoft') {
      dom.microsoftLoginButton.focus()
    } else {
      dom.usernameInput.focus()
      dom.usernameInput.select()
    }
  }, 40)
}

function switchAuthTab(method, focus = true) {
  if (!['offline', 'microsoft', 'yggdrasil'].includes(method)) method = 'offline'
  state.authTab = method
  dom.authTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.authTab === method)
    tab.setAttribute('aria-selected', tab.dataset.authTab === method ? 'true' : 'false')
  })
  dom.authPanes.forEach((pane) => {
    pane.hidden = pane.dataset.authPane !== method
  })
  dom.loginError.hidden = true
  if (!focus) return
  setTimeout(() => {
    if (method === 'yggdrasil') {
      ;(dom.yggdrasilUsername.value ? dom.yggdrasilPassword : dom.yggdrasilUsername).focus()
    } else if (method === 'microsoft') {
      dom.microsoftLoginButton.focus()
    } else {
      dom.usernameInput.focus()
    }
  }, 20)
}

function closeAccountModal(force = false) {
  if (state.loginBusy && !force) return
  dom.accountModal.hidden = true
  dom.yggdrasilPassword.value = ''
}

async function handleOfflineLogin() {
  if (state.loginBusy) return
  const username = dom.usernameInput.value.trim()
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
    showLoginError('用户名需为 3–16 位字母、数字或下划线。')
    return
  }

  setLoginBusy(true, 'offline')
  try {
    state.account = await invoke(api.loginOffline(username))
    state.settings.username = username
    renderAccount()
    closeAccountModal(true)
    toast(`已登录离线账户 ${state.account.name}`, 'success')
    appendLog('INFO', `已切换到离线账户 ${state.account.name}。`)
  } catch (error) {
    showLoginError(error.message)
  } finally {
    setLoginBusy(false)
  }
}

async function handleMicrosoftLogin() {
  if (state.loginBusy) return
  setLoginBusy(true, 'microsoft')
  try {
    state.account = await invoke(api.loginMicrosoft())
    state.settings.username = ''
    renderAccount()
    closeAccountModal(true)
    toast(`欢迎回来，${state.account.name}`, 'success')
    appendLog('INFO', `已通过 Microsoft 登录：${state.account.name}。`)
  } catch (error) {
    showLoginError(error.message)
  } finally {
    setLoginBusy(false)
  }
}

async function handleYggdrasilLogin() {
  if (state.loginBusy) return
  const serverUrl = dom.yggdrasilServer.value.trim()
  const username = dom.yggdrasilUsername.value.trim()
  const password = dom.yggdrasilPassword.value

  if (!serverUrl || !username || !password) {
    showLoginError('请填写服务器地址、用户名和密码。')
    return
  }

  setLoginBusy(true, 'yggdrasil')
  try {
    state.account = await invoke(api.loginYggdrasil({ serverUrl, username, password }))
    state.settings.username = ''
    dom.yggdrasilPassword.value = ''
    renderAccount()
    closeAccountModal(true)
    const provider = accountServerLabel(state.account.server)
    toast(
      state.account.autoSelectedProfile
        ? `已登录 ${provider} 账户 ${state.account.name}，并自动选择第一个角色。`
        : `已登录 ${provider} 账户 ${state.account.name}`,
      'success'
    )
    appendLog('INFO', `已通过 ${provider} 登录：${state.account.name}。`)
  } catch (error) {
    showLoginError(error.message)
  } finally {
    setLoginBusy(false)
  }
}

function setLoginBusy(busy, source = 'offline') {
  state.loginBusy = busy
  dom.offlineLoginButton.disabled = busy
  dom.microsoftLoginButton.disabled = busy
  dom.yggdrasilLoginButton.disabled = busy
  dom.closeAccountModal.disabled = busy
  dom.authTabs.forEach((tab) => {
    tab.disabled = busy
  })

  if (!busy) {
    dom.offlineLoginButton.textContent = '使用离线账户'
    dom.microsoftLoginButton.querySelector('strong').textContent = '使用 Microsoft 账户登录'
    dom.yggdrasilLoginButton.textContent = '登录 LittleSkin'
    return
  }

  dom.offlineLoginButton.textContent = source === 'offline' ? '正在登录…' : '使用离线账户'
  dom.microsoftLoginButton.querySelector('strong').textContent =
    source === 'microsoft' ? '正在等待 Microsoft 登录…' : '使用 Microsoft 账户登录'
  dom.yggdrasilLoginButton.textContent =
    source === 'yggdrasil' ? '正在验证第三方账户…' : '登录 LittleSkin'
}

function showLoginError(message) {
  dom.loginError.hidden = false
  dom.loginError.textContent = message
}

function applyAvatar(element, seed) {
  if (!element) return
  const key = String(seed || 'voxel-guest')
  if (!avatarCache.has(key)) avatarCache.set(key, createAvatarDataUrl(key))
  element.style.backgroundImage = `url("${avatarCache.get(key)}")`
}

function createAvatarDataUrl(seed) {
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 8
  const ctx = canvas.getContext('2d')
  const hash = hashString(seed)
  const palettes = [
    { hair: '#1b1c1a', skin: '#d6d8d1', shirt: '#40433f', eye: '#0c0d0c' },
    { hair: '#2a2c29', skin: '#babdb6', shirt: '#555954', eye: '#111211' },
    { hair: '#4b4d49', skin: '#e4e5e0', shirt: '#6b6f69', eye: '#202220' },
    { hair: '#73766f', skin: '#c7cac3', shirt: '#343733', eye: '#0f100f' },
    { hair: '#242624', skin: '#999d96', shirt: '#5e625c', eye: '#0a0b0a' },
    { hair: '#5c5f59', skin: '#d0d2cc', shirt: '#454945', eye: '#151615' }
  ]
  const palette = palettes[hash % palettes.length]
  const bg = ['#2a2c2a', '#333633', '#3f423e', '#252725', '#484b46'][hash % 5]

  ctx.fillStyle = bg
  ctx.fillRect(0, 0, 8, 8)
  ctx.fillStyle = palette.shirt
  ctx.fillRect(1, 7, 6, 1)
  ctx.fillStyle = palette.skin
  ctx.fillRect(1, 2, 6, 5)
  ctx.fillRect(0, 3, 1, 3)
  ctx.fillRect(7, 3, 1, 3)
  ctx.fillStyle = palette.hair
  ctx.fillRect(1, 0, 6, 2)
  ctx.fillRect(0, 1, 1, 2)
  ctx.fillRect(7, 1, 1, 2)
  ctx.fillRect(1, 2, 1, 1)
  ctx.fillRect(6, 2, 1, 1)

  const eyeY = 3 + (hash % 2)
  ctx.fillStyle = '#f2eee3'
  ctx.fillRect(2, eyeY, 1, 1)
  ctx.fillRect(5, eyeY, 1, 1)
  ctx.fillStyle = palette.eye
  ctx.fillRect(2, eyeY, 1, 1)
  ctx.fillRect(5, eyeY, 1, 1)
  ctx.fillRect(5 - (hash % 3 === 0 ? 0 : 1), eyeY + 1, 2, 1)
  ctx.fillStyle = 'rgba(24, 25, 23, 0.7)'
  ctx.fillRect(3, 6, 2, 1)

  if (hash % 3 === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.62)'
    ctx.fillRect(1, 2, 1, 1)
  }

  return canvas.toDataURL('image/png')
}

function hashString(value) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/* -------------------------------------------------------------------------- */
/* Game events                                                                 */
/* -------------------------------------------------------------------------- */

function handleGameState(data) {
  if (!data) return
  if (state.launch.status !== 'idle' && data.status === 'idle') {
    // The terminal events carry richer information; just sync the state machine here.
  }
  state.launch.status = data.status || 'idle'
  state.launch.cancelReady = state.launch.status === 'launching' || state.launch.status === 'cancelling'
  updateLaunchAvailability()
  updateTitlebarStatus()

  if (state.launch.status === 'running') {
    state.launch.step = 4
    setSideState('success', '游戏运行中', state.settings.version, 100)
    markHudRunning()
  } else if (state.launch.status === 'launching') {
    setSideState('busy', '正在启动', state.settings.version, 5)
  } else if (state.launch.status === 'cancelling') {
    setSideState('busy', '正在取消启动', '正在停止下载与安装', 0)
  } else if (state.launch.status === 'idle' && !state.launch.crashed) {
    if (!state.launch.error) setSideState('idle', '准备就绪', '等待开始新的冒险', 0)
  }
}

function handleGamePhase(data) {
  if (!data || state.launch.status === 'cancelling') return
  state.launch.step = Number(data.step) || 0
  const indeterminate = !data.done && data.key !== 'download'
  setHudPhase(data.step, data.label || '正在处理', data.detail || '', indeterminate)
  const progress = data.done ? 100 : Math.min(96, 8 + state.launch.step * 20)
  setSideState('busy', data.label || '正在启动', data.detail || state.settings.version, progress)
}

function handleGameProgress(data) {
  if (!data || state.launch.status === 'cancelling') return
  if (data.stage === 'download') {
    if (data.finished) {
      setHudProgress(100, false, '游戏文件下载完成', '', '')
      setSideState('busy', '正在安装', '游戏文件下载完成', 90)
      return
    }
    const percent = Math.max(0, Math.min(100, Number(data.percent) || 0))
    state.launch.percent = percent
    state.launch.indeterminate = false
    const totalBytes = data.overallTotalBytes ?? data.totalBytes
    const downloadedBytes = data.overallDownloadedBytes ?? data.downloadedBytes
    const files = data.overallTotalFiles
      ? `${data.overallDownloadedFiles || 0}/${data.overallTotalFiles} 个文件`
      : `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
    const detail = `${data.typeLabel || '游戏组件'} · ${files} · ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
    setHudProgress(percent, false, detail, `${formatSpeed(data.speed)}/s`, `${Math.round(percent)}%`)
    setSideState('busy', '正在下载游戏文件', data.typeLabel || '获取文件', 8 + percent * 0.82)
    dom.hudTitle.textContent = `正在下载 ${data.typeLabel || '游戏组件'}`
  } else if (data.indeterminate) {
    setHudProgress(null, true, data.detail || '正在处理', '', '')
  }
}

function handleGameCancelled(data) {
  state.launch.status = 'idle'
  state.launch.cancelReady = false
  state.launch.error = ''
  state.launch.crashed = false
  state.launch.indeterminate = false
  clearTimeout(state.hudTimer)
  dom.launchHud.hidden = true
  dom.hudPill.hidden = true
  state.launch.hudCollapsed = false
  updateLaunchAvailability()
  updateTitlebarStatus()
  setSideState('idle', '准备就绪', '等待开始新的冒险', 0)
  toast('已取消游戏启动。')
}

function handleGameError(data) {
  state.launch.status = 'idle'
  state.launch.error = data?.message || '启动失败'
  state.launch.indeterminate = false
  updateLaunchAvailability()
  showHudError(state.launch.error)
  setSideState('error', '启动失败', state.launch.error, 0)
  updateTitlebarStatus()
  toast(state.launch.error, 'error')
}

function handleGameCrash(data) {
  state.launch.crashed = true
  const message = `游戏异常退出${data?.code != null ? `（代码 ${data.code}）` : ''}`
  state.launch.error = message
  showHudError(message)
  setSideState('error', '游戏异常退出', '查看日志以获取更多信息', 0)
  toast(`${message}，详细原因请查看日志。`, 'error')
}

function handleGameClosed(data) {
  const code = data?.code
  const wasCrashed = state.launch.crashed
  state.launch.status = 'idle'
  state.launch.percent = 100
  state.launch.indeterminate = false
  updateLaunchAvailability()
  updateTitlebarStatus()
  setSideState('idle', '准备就绪', '等待开始新的冒险', 0)

  if (!wasCrashed) {
    if (code === 0 || code === null) {
      dom.hudPill.querySelector('.status-dot').className = 'status-dot'
      dom.launchHud.className = 'launch-hud'
      dom.hudKicker.textContent = 'SESSION ENDED'
      dom.hudTitle.textContent = '游戏已退出'
      dom.hudDetail.textContent = code === 0 ? '本次游戏正常结束' : '游戏进程已结束'
      dom.hudPercent.textContent = '100%'
      dom.hudSpeed.textContent = ''
      dom.hudRetry.hidden = true
      markHudComplete()
      dom.hudPill.hidden = true
      dom.launchHud.hidden = false
      state.launch.hudCollapsed = false
      clearTimeout(state.hudTimer)
      state.hudTimer = setTimeout(() => {
        if (state.launch.status === 'idle' && !state.launch.hudCollapsed) collapseHud()
      }, 4200)
      toast(code === 0 ? '游戏已正常退出。' : '游戏已退出。', 'success')
    } else {
      const message = `游戏进程异常退出（代码 ${code}）`
      state.launch.error = message
      showHudError(message)
      toast(message, 'error')
    }
  }

  state.launch.crashed = false
  loadVersions(false).catch(() => {})
}

function resetHud() {
  clearTimeout(state.hudTimer)
  dom.launchHud.className = 'launch-hud'
  dom.launchHud.hidden = false
  dom.hudPill.hidden = true
  dom.hudKicker.textContent = 'LAUNCH SEQUENCE'
  dom.hudTitle.textContent = '正在准备启动'
  dom.hudPercent.textContent = '0%'
  dom.hudDetail.textContent = '正在初始化'
  dom.hudSpeed.textContent = ''
  dom.hudBar.style.width = '0%'
  dom.hudBar.parentElement.className = 'hud-track'
  dom.hudRetry.hidden = true
  state.launch.hudCollapsed = false
  state.launch.indeterminate = true
  updateHudPhases(0)
}

function setHudPhase(step, label, detail, indeterminate) {
  if (state.launch.hudCollapsed) {
    dom.hudPillText.textContent = label || '正在启动'
    dom.hudPill.hidden = false
  } else {
    dom.launchHud.hidden = false
  }
  dom.hudTitle.textContent = label || '正在启动'
  dom.hudDetail.textContent = detail || ''
  dom.hudKicker.textContent = 'LAUNCH SEQUENCE'
  if (indeterminate) {
    dom.hudBar.parentElement.className = 'hud-track indeterminate'
    dom.hudBar.style.width = '35%'
    dom.hudPercent.textContent = '…'
  } else {
    dom.hudBar.parentElement.className = 'hud-track'
  }
  updateHudPhases(Number(step) || 0)
}

function setHudProgress(percent, indeterminate, detail, speed, label) {
  dom.hudDetail.textContent = detail || ''
  dom.hudSpeed.textContent = speed || ''
  if (indeterminate || percent === null) {
    dom.hudBar.parentElement.className = 'hud-track indeterminate'
    dom.hudBar.style.width = '35%'
    dom.hudPercent.textContent = '…'
    return
  }
  const value = Math.max(0, Math.min(100, Number(percent) || 0))
  state.launch.percent = value
  state.launch.indeterminate = false
  dom.hudBar.parentElement.className = 'hud-track'
  dom.hudBar.style.width = `${value}%`
  dom.hudPercent.textContent = label || `${Math.round(value)}%`
  dom.hudPillPercent.textContent = `${Math.round(value)}%`
}

function updateHudPhases(step) {
  const items = Array.from(dom.hudPhases.querySelectorAll('[data-hud-step]'))
  items.forEach((item, index) => {
    item.classList.toggle('active', index === step)
    item.classList.toggle('done', index < step)
  })
}

function markHudRunning() {
  state.launch.status = 'running'
  dom.launchHud.className = 'launch-hud running'
  if (state.launch.hudCollapsed) {
    dom.hudPill.hidden = false
    dom.hudPillText.textContent = '游戏运行中'
    dom.hudPillPercent.textContent = ''
  } else {
    dom.launchHud.hidden = false
    dom.hudPill.hidden = true
  }
  dom.hudKicker.textContent = 'MINECRAFT IS RUNNING'
  dom.hudTitle.textContent = '游戏已启动'
  dom.hudDetail.textContent = `${state.settings.version} · ${loaderDisplay(state.settings.loader)}`
  dom.hudPercent.textContent = '100%'
  dom.hudSpeed.textContent = ''
  dom.hudBar.parentElement.className = 'hud-track'
  dom.hudBar.style.width = '100%'
  dom.hudRetry.hidden = true
  updateHudPhases(5)
}

function markHudComplete() {
  dom.hudBar.parentElement.className = 'hud-track'
  dom.hudBar.style.width = '100%'
  updateHudPhases(5)
}

function showHudError(message) {
  clearTimeout(state.hudTimer)
  dom.launchHud.hidden = false
  dom.hudPill.hidden = true
  state.launch.hudCollapsed = false
  dom.launchHud.className = 'launch-hud error'
  dom.hudKicker.textContent = 'LAUNCH FAILED'
  dom.hudTitle.textContent = '启动没有完成'
  dom.hudDetail.textContent = message
  dom.hudPercent.textContent = '—'
  dom.hudSpeed.textContent = ''
  dom.hudBar.parentElement.className = 'hud-track error'
  dom.hudBar.style.width = '100%'
  dom.hudRetry.hidden = false
  dom.hudPillText.textContent = '启动失败'
  dom.hudPill.querySelector('.status-dot').className = 'status-dot error'
}

function showHud() {
  clearTimeout(state.hudTimer)
  dom.launchHud.hidden = false
  dom.hudPill.hidden = true
  state.launch.hudCollapsed = false
  dom.hudPill.querySelector('.status-dot').className = 'status-dot'
}

function collapseHud() {
  if (dom.launchHud.hidden) return
  dom.launchHud.hidden = true
  state.launch.hudCollapsed = true
  if (state.launch.status === 'running') {
    dom.hudPillText.textContent = '游戏运行中'
    dom.hudPillPercent.textContent = ''
  } else if (state.launch.status === 'launching') {
    dom.hudPillText.textContent = '正在启动'
    dom.hudPillPercent.textContent = `${Math.round(state.launch.percent)}%`
  } else if (state.launch.error) {
    dom.hudPillText.textContent = '启动失败'
    dom.hudPillPercent.textContent = ''
  } else {
    dom.hudPillText.textContent = '本次会话已结束'
    dom.hudPillPercent.textContent = ''
  }
  dom.hudPill.hidden = false
}

function setSideState(kind, label, detail, progress) {
  dom.sideStatusLabel.textContent = label
  dom.sideStatusText.textContent = detail || ''
  const dot = dom.sideStatusLabel.parentElement.querySelector('.status-dot')
  dot.className = 'status-dot'
  if (kind === 'busy') dot.classList.add('busy')
  if (kind === 'success') dot.classList.add('busy')
  if (kind === 'error') dot.classList.add('error')
  if (kind === 'idle') dot.classList.remove('busy')
  dom.sideProgress.style.width = `${Math.max(0, Math.min(100, Number(progress) || 0))}%`
  if (kind === 'error') dom.sideProgress.style.background = 'linear-gradient(90deg, #b94d4d, #ff8585)'
  else dom.sideProgress.style.background = ''
  updateTitlebarStatus()
}

/* -------------------------------------------------------------------------- */
/* Logs                                                                        */
/* -------------------------------------------------------------------------- */

function appendLog(level, message, time) {
  if (!message) return
  const normalized = String(level || 'INFO').toUpperCase()
  const entry = {
    level: normalized,
    message: String(message),
    time: time || new Date().toISOString()
  }
  state.logs.push(entry)
  if (state.logs.length > 1200) state.logs.shift()

  const empty = dom.logConsole.querySelector('.console-empty')
  if (empty) empty.remove()

  const nearBottom =
    dom.logConsole.scrollHeight - dom.logConsole.scrollTop - dom.logConsole.clientHeight < 60
  const row = renderLogEntry(entry)
  dom.logConsole.append(row)
  while (dom.logConsole.childElementCount > 1200) dom.logConsole.firstElementChild?.remove()
  dom.logCount.textContent = `${state.logs.length} 条记录`

  if (nearBottom || state.page === 'logs') {
    dom.logConsole.scrollTop = dom.logConsole.scrollHeight
  }

  if (state.page !== 'logs' && !['DEBUG', 'INFO'].includes(normalized)) dom.logLiveDot.hidden = false
}

function renderLogEntry(entry) {
  const row = document.createElement('div')
  const level = entry.level.toLowerCase()
  row.className = `log-line ${['info', 'warn', 'error', 'game', 'debug'].includes(level) ? level : 'info'}`

  const time = document.createElement('span')
  time.className = 'log-time'
  time.textContent = formatTime(entry.time)
  const badge = document.createElement('span')
  badge.className = 'log-level'
  badge.textContent = entry.level
  const message = document.createElement('span')
  message.className = 'log-message'
  message.textContent = entry.message

  row.append(time, badge, message)
  return row
}

function formatTime(value) {
  const date = value ? new Date(value) : new Date()
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return date.toLocaleTimeString('zh-CN', { hour12: false })
}

function renderLogEmpty() {
  const wrap = document.createElement('div')
  wrap.className = 'console-empty'
  const strong = document.createElement('strong')
  strong.textContent = '还没有运行记录'
  const span = document.createElement('span')
  span.textContent = '启动游戏后，这里会实时显示下载、Java 与游戏输出。'
  wrap.append(strong, span)
  dom.logConsole.replaceChildren(wrap)
  dom.logCount.textContent = '0 条记录'
}

function clearLogs() {
  state.logs = []
  dom.logConsole.replaceChildren()
  renderLogEmpty()
  dom.logLiveDot.hidden = true
  toast('本次运行日志已清空。', 'success')
}

async function copyLogs() {
  const text = state.logs
    .map((entry) => `[${formatTime(entry.time)}] [${entry.level}] ${entry.message}`)
    .join('\n')
  if (!text) {
    toast('当前没有可复制的日志。', 'error')
    return
  }

  try {
    await navigator.clipboard.writeText(text)
    toast('日志已复制到剪贴板。', 'success')
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.append(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
    toast('日志已复制到剪贴板。', 'success')
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function openPath(target) {
  try {
    await invoke(api.openPath(target))
  } catch (error) {
    toast(error.message, 'error')
  }
}

function unwrap(result) {
  if (!result || typeof result !== 'object') throw new Error('启动器没有返回有效数据。')
  if (!result.ok) throw new Error(result.error || '操作失败。')
  return result.data
}

function invoke(promise) {
  return Promise.resolve(promise).then((result) => unwrap(result))
}

function toast(message, kind = 'info') {
  if (!message) return
  const duplicate = Array.from(dom.toastStack.children).some(
    (item) => item.dataset.message === String(message) && item.dataset.kind === kind
  )
  if (duplicate) return
  const element = document.createElement('div')
  element.className = `toast ${kind}`
  element.dataset.message = String(message)
  element.dataset.kind = kind
  const dot = document.createElement('span')
  dot.className = 'toast-dot'
  const text = document.createElement('span')
  text.textContent = message

  element.append(dot, text)
  dom.toastStack.append(element)
  while (dom.toastStack.childElementCount > 4) dom.toastStack.firstElementChild?.remove()

  const remove = () => {
    element.classList.add('leaving')
    setTimeout(() => element.remove(), 220)
  }
  setTimeout(remove, kind === 'error' ? 5200 : 3200)
}

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatSpeed(value) {
  const bytes = Number(value) || 0
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
