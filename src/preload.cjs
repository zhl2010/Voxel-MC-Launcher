const { contextBridge, ipcRenderer } = require('electron')

const GAME_EVENTS = new Set(['state', 'phase', 'progress', 'log', 'error', 'closed', 'crash', 'cancelled'])

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args)
}

contextBridge.exposeInMainWorld('voxel', {
  platform: process.platform,

  bootstrap: () => invoke('app:bootstrap'),
  getInfo: () => invoke('app:info'),
  getVersions: (force = false) => invoke('versions:list', force),
  getLoaders: (mcVersion) => invoke('loaders:list', mcVersion),
  saveSettings: (patch) => invoke('settings:save', patch),
  setUiScale: (value) => invoke('ui:set-scale', value),

  searchMods: (payload) => invoke('mods:search', payload),
  installMod: (payload) => invoke('mods:install', payload),
  chooseModDir: (currentDir) => invoke('mods:choose-dir', currentDir),
  getModVersions: (payload) => invoke('mods:versions', payload),
  getModIcon: (payload) => invoke('mods:icon', payload),
  getInstalledMods: () => invoke('mods:installed'),

  loginOffline: (username) => invoke('auth:offline', username),
  loginMicrosoft: () => invoke('auth:microsoft'),
  loginYggdrasil: (credentials) => invoke('auth:yggdrasil', credentials),
  logout: () => invoke('auth:logout'),
  getSkin: () => invoke('skin:get'),
  uploadSkin: () => invoke('skin:upload'),
  clearSkin: () => invoke('skin:clear'),

  launch: () => invoke('game:launch'),
  verifyFiles: (versionId) => invoke('game:verify', versionId),
  cancelLaunch: () => invoke('game:cancel'),
  getGameState: () => invoke('game:state'),

  chooseJava: () => invoke('dialog:choose-java'),
  chooseGameDir: () => invoke('directories:choose-game'),
  setGameDir: (value) => invoke('directories:set-game-dir', value),
  openPath: (target) => invoke('app:open-path', target),
  openVersionFolder: (versionId) => invoke('versions:open-folder', versionId),
  deleteVersion: (versionId) => invoke('versions:delete', versionId),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  toggleFullScreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  onWindowState: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('window:state', listener)
    return () => ipcRenderer.removeListener('window:state', listener)
  },

  onGameEvent: (callback) => {
    const listener = (_event, payload) => {
      if (!payload || !GAME_EVENTS.has(payload.type)) return
      callback(payload)
    }
    ipcRenderer.on('game:event', listener)
    return () => ipcRenderer.removeListener('game:event', listener)
  }
})
