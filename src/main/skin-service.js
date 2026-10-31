import fs from 'node:fs'
import path from 'node:path'

// Offline skins: a 64x64 PNG uploaded by the player, stored per account and exposed to the renderer
// as a data URL. The launcher also derives the head crop used by the sidebar/lobby avatars.

const SKIN_SIZE = 64
const MAX_SKIN_BYTES = 1024 * 1024

export class SkinService {
  constructor(getDataDir) {
    this.getDataDir = getDataDir
  }

  get skinDir() {
    return path.join(this.getDataDir(), 'skins')
  }

  /** Sanitise an account key (uuid or offline name) into a safe file name. */
  keyFor(account) {
    const raw = String(account?.uuid || account?.name || '').trim()
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
    return safe || ''
  }

  fileFor(account) {
    const key = this.keyFor(account)
    return key ? path.join(this.skinDir, `${key}.png`) : ''
  }

  /** Read the stored skin as a data URL, or '' when the account has none. */
  async getSkinDataUrl(account) {
    const file = this.fileFor(account)
    if (!file) return ''
    try {
      const buffer = await fs.promises.readFile(file)
      if (!buffer.length) return ''
      return `data:image/png;base64,${buffer.toString('base64')}`
    } catch {
      return ''
    }
  }

  /** Persist a PNG skin after validating the signature and the 64x64 dimension. */
  async saveSkin(account, pngBuffer) {
    if (!Buffer.isBuffer(pngBuffer) || !pngBuffer.length) throw new Error('没有收到皮肤文件。')
    if (pngBuffer.length > MAX_SKIN_BYTES) throw new Error('皮肤文件过大（最大 1 MB）。')
    const isPng = pngBuffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    if (!isPng) throw new Error('皮肤必须是 PNG 图片。')
    const width = pngBuffer.readUInt32BE(16)
    const height = pngBuffer.readUInt32BE(20)
    if (width !== SKIN_SIZE || height !== SKIN_SIZE) {
      throw new Error(`皮肤尺寸必须是 ${SKIN_SIZE}×${SKIN_SIZE}，当前为 ${width}×${height}。`)
    }
    const file = this.fileFor(account)
    if (!file) throw new Error('请先登录或使用离线账户。')
    await fs.promises.mkdir(this.skinDir, { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    await fs.promises.writeFile(temporary, pngBuffer)
    await fs.promises.rename(temporary, file)
    return { ok: true, path: file, size: pngBuffer.length }
  }

  async clearSkin(account) {
    const file = this.fileFor(account)
    if (!file) return { ok: true }
    await fs.promises.rm(file, { force: true })
    return { ok: true }
  }
}

export { SKIN_SIZE }
