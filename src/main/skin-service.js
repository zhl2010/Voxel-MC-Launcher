import fs from 'node:fs'
import path from 'node:path'
import { nativeImage } from 'electron'
import { fetchJson } from './fetcher.js'
import { networkFetch } from './network.js'

// Offline skins: a 64x64 PNG uploaded by the player, stored per account and exposed to the renderer
// as a data URL. The launcher also derives the head crop used by the sidebar/lobby avatars.
// Online accounts (Microsoft / Yggdrasil) can fetch their real player face from the session
// server and cache the cropped 32x32 PNG under <dataDir>/faces/<uuid>.png.

const SKIN_SIZE = 64
const MAX_SKIN_BYTES = 1024 * 1024

export class SkinService {
  constructor(getDataDir, assetsDir = '') {
    this.getDataDir = getDataDir
    this.assetsDir = assetsDir
    this.defaultFaceCache = new Map()
  }

  get skinDir() {
    return path.join(this.getDataDir(), 'skins')
  }

  get faceDir() {
    return path.join(this.getDataDir(), 'faces')
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

  /**
   * The cropped face (32x32 PNG data URL) of an online player, or '' when the account is offline
   * or has no reachable skin. Cached on disk under <dataDir>/faces/<uuid>.png.
   */
  async getAccountFaceDataUrl(account) {
    const type = account?.meta?.type
    if (type !== 'msa' && type !== 'yggdrasil') return ''
    const uuid = String(account?.uuid || '').trim()
    if (!uuid) return ''
    const cacheFile = path.join(this.faceDir, `${uuid}.png`)
    try {
      const cached = await fs.promises.readFile(cacheFile).catch(() => null)
      if (cached && cached.length > 32) return `data:image/png;base64,${cached.toString('base64')}`
    } catch {
      // fall through to fetch
    }

    try {
      const profileUrl = sessionProfileUrl(account, type, uuid)
      if (!profileUrl) return ''
      const profile = await fetchJson(profileUrl, { timeout: 8000, retries: 1 })
      const textureValue = profile?.properties?.find?.((entry) => entry.name === 'textures')?.value
      if (!textureValue) return ''
      const decoded = JSON.parse(Buffer.from(textureValue, 'base64').toString('utf8'))
      const skinUrl = decoded?.textures?.SKIN?.url
      if (!skinUrl) return ''
      const png = await fetchSkinPng(skinUrl)
      if (!png) return ''
      const face = cropFace(png)
      if (!face) return ''
      await fs.promises.mkdir(this.faceDir, { recursive: true }).catch(() => {})
      await fs.promises.writeFile(cacheFile, face).catch(() => {})
      return `data:image/png;base64,${face.toString('base64')}`
    } catch {
      return ''
    }
  }

  /**
   * Face of the built-in default skin (Steve or Alex), picked deterministically from the account
   * name. This is the avatar for players who have no uploaded skin and no online skin to fetch.
   */
  async getDefaultFaceDataUrl(account) {
    const key = pickDefaultSkin(account)
    if (this.defaultFaceCache.has(key)) return this.defaultFaceCache.get(key)
    const file = path.join(this.assetsDir, `${key}.png`)
    try {
      const png = await fs.promises.readFile(file)
      const face = cropFace(png)
      if (!face) return ''
      const dataUrl = `data:image/png;base64,${face.toString('base64')}`
      this.defaultFaceCache.set(key, dataUrl)
      return dataUrl
    } catch {
      return ''
    }
  }
}

/** Even-hash accounts get Steve, odd-hash accounts get Alex — stable per account. */
function pickDefaultSkin(account) {
  const seed = String(account?.uuid || account?.name || '')
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return hash % 2 === 0 ? 'steve' : 'alex'
}

/** Session-server profile URL for an online account (Microsoft or a Yggdrasil server). */
function sessionProfileUrl(account, type, uuid) {
  if (type === 'msa') {
    return `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`
  }
  const server = account?.meta?.url
  if (!server) return ''
  try {
    const url = new URL(server)
    const match = url.pathname.match(/^(.*\/api\/yggdrasil\/)authserver\/?$/)
    if (match) {
      url.pathname = `${match[1]}sessionserver/session/minecraft/profile/${uuid}`
      return url.toString()
    }
    url.pathname = url.pathname.replace(/\/+$/, '')
    if (/\/api\/yggdrasil$/.test(url.pathname)) {
      url.pathname += `/sessionserver/session/minecraft/profile/${uuid}`
    } else {
      url.pathname += `/api/yggdrasil/sessionserver/session/minecraft/profile/${uuid}`
    }
    return url.toString()
  } catch {
    return ''
  }
}

/** Download a skin PNG with a timeout, or null on any failure. */
async function fetchSkinPng(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await networkFetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'VoxelLauncher/1.0 (+https://github.com/zhl2010/Voxel-MC-Launcher)' }
    })
    if (!response.ok) return null
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length > 32 ? bytes : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Crop the 8x8 face region out of a Minecraft skin and overlay the hat layer, returning a
 * 32x32 PNG buffer. Works for 64x64 classic skins and 128x128 HD skins (regions scale by 1/8).
 */
function cropFace(pngBuffer) {
  const image = nativeImage.createFromBuffer(pngBuffer)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (!width || !height || width < 64 || height < 32) return null
  const bitmap = image.toBitmap() // BGRA, row-major
  // The head is a square whose width is half the skin's width (64x64, 128x128 and compact
  // 64x32 skins alike); the 8x8 face sits at the head's top-left eighth, so every face metric
  // derives from the WIDTH, never from the height (a 64x32 compact skin would give y = 4).
  const faceSize = Math.floor(width / 8)
  if (faceSize < 4) return null
  const faceX = Math.floor(width / 8)
  const faceY = Math.floor(width / 8)
  const hatX = faceX + Math.floor(width / 2)
  if (faceY + faceSize > height || faceX + faceSize > width) return null

  const out = Buffer.alloc(faceSize * faceSize * 4)
  for (let y = 0; y < faceSize; y++) {
    for (let x = 0; x < faceSize; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      const baseIndex = ((faceY + y) * width + (faceX + x)) * 4
      b = bitmap[baseIndex]
      g = bitmap[baseIndex + 1]
      r = bitmap[baseIndex + 2]
      a = bitmap[baseIndex + 3]
      const hatIndex = ((faceY + y) * width + (hatX + x)) * 4
      const hatAlpha = bitmap[hatIndex + 3]
      if (hatAlpha > 0) {
        const blend = hatAlpha / 255
        r = Math.round(r * (1 - blend) + bitmap[hatIndex + 2] * blend)
        g = Math.round(g * (1 - blend) + bitmap[hatIndex + 1] * blend)
        b = Math.round(b * (1 - blend) + bitmap[hatIndex] * blend)
        a = 255
      }
      const outIndex = (y * faceSize + x) * 4
      out[outIndex] = b
      out[outIndex + 1] = g
      out[outIndex + 2] = r
      out[outIndex + 3] = a
    }
  }

  // Nearest-neighbour upscale (pixel-art must not be smoothed: bicubic blending of skin tone
  // and hair produces a muddy brown face) from faceSize×faceSize to 32×32.
  const scale = 32 / faceSize
  const big = Buffer.alloc(32 * 32 * 4)
  for (let y = 0; y < 32; y++) {
    const sy = Math.min(faceSize - 1, Math.floor(y / scale))
    for (let x = 0; x < 32; x++) {
      const sx = Math.min(faceSize - 1, Math.floor(x / scale))
      const si = (sy * faceSize + sx) * 4
      const di = (y * 32 + x) * 4
      big[di] = out[si]
      big[di + 1] = out[si + 1]
      big[di + 2] = out[si + 2]
      big[di + 3] = out[si + 3]
    }
  }

  const face = nativeImage.createFromBitmap(big, {
    width: 32,
    height: 32,
    scaleFactor: 1
  })
  if (face.isEmpty()) return null
  return face.toPNG()
}

export { SKIN_SIZE }
