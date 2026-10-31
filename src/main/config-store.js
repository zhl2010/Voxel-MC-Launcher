import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_SETTINGS = Object.freeze({
  username: '',
  version: '',
  loader: 'vanilla',
  loaderVersion: '',
  minMemory: 1024,
  maxMemory: 4096,
  windowWidth: 1280,
  windowHeight: 720,
  fullscreen: false,
  javaMode: 'auto',
  javaPath: '',
  jvmArgs: '',
  uiScale: 100,
  fontScale: 100,
  accentColor: '#eef0ea',
  themeMode: 'dark',
  gameDir: '',
  proxyUrl: '',
  mirrorMojang: true,
  mirrorFabric: true,
  mirrorForge: true,
  mirrorNeoForge: true,
  forceLocal: false,
  versionIsolation: false,
  downloadSource: '',
  lastPlayed: ''
})

const LOADERS = new Set(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'])
const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS))

export function sanitizeSettings(input = {}, base = DEFAULT_SETTINGS) {
  const next = { ...base }

  for (const [key, rawValue] of Object.entries(input)) {
    if (!SETTING_KEYS.has(key) || rawValue === undefined) continue

    if (key === 'username') {
      const value = String(rawValue).trim().slice(0, 32)
      if (!value || /^[a-zA-Z0-9_]{1,32}$/.test(value)) next.username = value
    } else if (key === 'version') {
      const value = String(rawValue).trim().slice(0, 128)
      if (
        !value ||
        (value !== '.' && value !== '..' && !/[\\/:*?"<>|\r\n]/.test(value))
      ) {
        next.version = value
      }
    } else if (key === 'loader') {
      const value = String(rawValue).toLowerCase()
      if (LOADERS.has(value)) next.loader = value
    } else if (key === 'loaderVersion') {
      // An explicitly picked loader build; empty means "newest stable".
      const value = String(rawValue).trim().slice(0, 64)
      next.loaderVersion = /^[a-zA-Z0-9._+\-]*$/.test(value) ? value : ''
    } else if (key === 'minMemory' || key === 'maxMemory') {
      const value = Number(rawValue)
      if (!Number.isFinite(value)) continue
      if (key === 'minMemory') next.minMemory = clamp(Math.round(value / 128) * 128, 512, 16384)
      else next.maxMemory = clamp(Math.round(value / 128) * 128, 1024, 32768)
    } else if (key === 'windowWidth' || key === 'windowHeight') {
      const value = Number(rawValue)
      if (!Number.isFinite(value)) continue
      if (key === 'windowWidth') next.windowWidth = clamp(Math.round(value), 854, 3840)
      else next.windowHeight = clamp(Math.round(value), 480, 2160)
    } else if (key === 'uiScale') {
      const value = Number(rawValue)
      if (Number.isFinite(value)) next.uiScale = clamp(Math.round(value), 75, 130)
    } else if (key === 'fontScale') {
      const value = Number(rawValue)
      if (Number.isFinite(value)) next.fontScale = clamp(Math.round(value), 80, 140)
    } else if (key === 'accentColor') {
      const value = String(rawValue).trim()
      if (/^#[0-9a-fA-F]{6}$/.test(value)) next.accentColor = value.toLowerCase()
    } else if (key === 'themeMode') {
      const value = String(rawValue)
      if (value === 'dark' || value === 'light') next.themeMode = value
    } else if (key === 'gameDir') {
      const value = String(rawValue).trim().replace(/^"(.*)"$/, '$1')
      if (!value) next.gameDir = ''
      else if (value.length <= 1024 && path.isAbsolute(value)) next.gameDir = path.normalize(value)
    } else if (key === 'proxyUrl') {
      const value = String(rawValue).trim().slice(0, 1024)
      if (!value) next.proxyUrl = ''
      else {
        try {
          const parsed = new URL(value)
          if (['http:', 'https:'].includes(parsed.protocol)) next.proxyUrl = value
        } catch {
          // Malformed proxy URLs are ignored; network access falls back to direct connections.
        }
      }
    } else if (
      key === 'mirrorMojang' ||
      key === 'mirrorFabric' ||
      key === 'mirrorForge' ||
      key === 'mirrorNeoForge' ||
      key === 'forceLocal' ||
      key === 'versionIsolation'
    ) {
      next[key] = Boolean(rawValue)
    } else if (key === 'downloadSource') {
      const value = String(rawValue).trim().slice(0, 512)
      if (!value) next.downloadSource = ''
      else if (/^https?:\/\/[^\s]+$/i.test(value)) next.downloadSource = value.replace(/\/+$/, '')
    } else if (key === 'fullscreen') {
      next[key] = Boolean(rawValue)
    } else if (key === 'javaMode') {
      const value = String(rawValue)
      if (value === 'auto' || value === 'manual') next.javaMode = value
    } else if (key === 'javaPath') {
      next.javaPath = String(rawValue).trim().slice(0, 1024)
    } else if (key === 'jvmArgs') {
      next.jvmArgs = String(rawValue).replace(/[\r\n]+/g, ' ').trim().slice(0, 4000)
    } else if (key === 'lastPlayed') {
      const value = String(rawValue).slice(0, 64)
      if (!value || !Number.isNaN(Date.parse(value))) next.lastPlayed = value
    }
  }

  if (next.minMemory >= next.maxMemory) {
    next.minMemory = Math.max(512, next.maxMemory - 512)
  }

  return next
}

export class ConfigStore {
  constructor() {
    this.filePath = ''
    this.data = { settings: { ...DEFAULT_SETTINGS } }
  }

  init(userDataPath) {
    this.filePath = path.join(userDataPath, 'launcher-config.json')
    this.data = this.read()
    return this.data
  }

  read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      return {
        settings: sanitizeSettings(parsed.settings || {}),
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString()
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        try {
          fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
        } catch {
          // A corrupt config should never prevent the launcher from starting.
        }
      }
      return { settings: { ...DEFAULT_SETTINGS }, createdAt: new Date().toISOString() }
    }
  }

  getSettings() {
    return { ...this.data.settings }
  }

  update(patch = {}) {
    const settings = sanitizeSettings(patch, this.getSettings())
    this.data = { ...this.data, settings }
    this.write()
    return { ...settings }
  }

  write() {
    if (!this.filePath) return
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tempPath, this.filePath)
  }
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
