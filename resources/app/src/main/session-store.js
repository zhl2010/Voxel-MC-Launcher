import fs from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

const SESSION_FILE = 'account-session.json'
const ACCOUNT_TYPES = new Set(['crack', 'msa', 'yggdrasil', 'azuriom'])

/**
 * Persists the active account separately from the regular settings file. Tokens are encrypted
 * with Electron's OS-backed safeStorage when available, so offline usernames, Microsoft refresh
 * tokens and Yggdrasil sessions survive a launcher restart without writing passwords anywhere.
 */
export class SessionStore {
  constructor() {
    this.filePath = ''
    this.ready = false
  }

  init(userDataPath) {
    this.filePath = path.join(userDataPath, SESSION_FILE)
    this.ready = true
  }

  get encryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  load() {
    if (!this.ready) return null
    try {
      if (!fs.existsSync(this.filePath)) return null
      const wrapper = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (wrapper?.version !== 1 || typeof wrapper.payload !== 'string') return null

      const payload = Buffer.from(wrapper.payload, 'base64')
      let serialized
      if (wrapper.encrypted) {
        if (!this.encryptionAvailable) return null
        serialized = safeStorage.decryptString(payload)
      } else {
        serialized = payload.toString('utf8')
      }
      return normalizeAccount(JSON.parse(serialized))
    } catch {
      return null
    }
  }

  save(account) {
    if (!this.ready) return false
    const normalized = normalizeAccount(account)
    if (!normalized) return false

    const encrypted = this.encryptionAvailable
    const serialized = JSON.stringify(normalized)
    const payload = encrypted
      ? safeStorage.encryptString(serialized).toString('base64')
      : Buffer.from(serialized, 'utf8').toString('base64')

    const wrapper = JSON.stringify({ version: 1, encrypted, payload })
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    fs.writeFileSync(tempPath, wrapper, { mode: 0o600 })
    fs.renameSync(tempPath, this.filePath)
    return true
  }

  clear() {
    if (!this.ready) return
    try {
      fs.rmSync(this.filePath, { force: true })
    } catch {
      // A read-only userData folder should not prevent logout from clearing the in-memory account.
    }
  }
}

function normalizeAccount(account) {
  if (!account || typeof account !== 'object') return null
  const type = String(account.meta?.type || '')
  if (!ACCOUNT_TYPES.has(type)) return null

  const name = String(account.name || '').trim().slice(0, 64)
  const uuid = String(account.uuid || '').trim().slice(0, 64)
  const accessToken = String(account.accessToken || '').slice(0, 4096)
  if (!name || !accessToken) return null

  const result = {
    name,
    uuid,
    clientToken: String(account.clientToken || '').slice(0, 4096),
    accessToken,
    userProperties:
      account.userProperties && typeof account.userProperties === 'object'
        ? account.userProperties
        : {},
    meta: {
      online: Boolean(account.meta?.online),
      type
    }
  }

  if (account.meta?.url) result.meta.url = String(account.meta.url).slice(0, 2048)
  if (account.refreshToken) result.refreshToken = String(account.refreshToken).slice(0, 8192)
  if (account.xbox && typeof account.xbox === 'object') {
    result.xbox = {
      xuid: String(account.xbox.xuid || '').slice(0, 128),
      gamertag: String(account.xbox.gamertag || '').slice(0, 128),
      ageGroup: String(account.xbox.ageGroup || '').slice(0, 32)
    }
  }
  return result
}
