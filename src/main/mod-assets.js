import fs from 'node:fs'
import path from 'node:path'

// Mod display extras: project icons (fetched in the main process because the renderer CSP only
// allows data: images) and Chinese titles from Modrinth's community tags.

const ICON_CACHE = new Map()
const ICON_TTL = 30 * 60 * 1000
const MAX_ICON_BYTES = 512 * 1024
const ZH_CACHE = new Map()
const ZH_TTL = 6 * 60 * 60 * 1000
const DISK_CACHE_DIR = '.mod-icons'

function userAgent() {
  return 'VoxelLauncher/1.0 (Electron Minecraft launcher; local app)'
}

/**
 * Download an https image and return it as a data URL so the renderer can display it without
 * relaxing its CSP. Only remote http(s) URLs are accepted; nothing local is read.
 */
export async function fetchImageAsDataUrl(url, { cacheDir = '', timeout = 15_000 } = {}) {
  const value = typeof url === 'string' ? url.trim() : ''
  if (!/^https?:\/\//i.test(value)) return ''

  const cached = ICON_CACHE.get(value)
  if (cached && Date.now() - cached.time < ICON_TTL) return cached.data

  const diskKey = cacheDir ? path.join(cacheDir, `${hashKey(value)}.img`) : ''
  if (diskKey && fs.existsSync(diskKey)) {
    try {
      const data = fs.readFileSync(diskKey, 'utf8')
      if (data.startsWith('data:')) {
        ICON_CACHE.set(value, { data, time: Date.now() })
        return data
      }
    } catch {
      // Fall through to the network.
    }
  }

  try {
    const response = await fetch(value, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': userAgent(), Accept: 'image/*' }
    })
    if (!response.ok) return ''
    const type = (response.headers.get('content-type') || 'image/png').split(';')[0].trim()
    if (!/^image\//i.test(type)) return ''
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length || buffer.length > MAX_ICON_BYTES) return ''
    const data = `data:${type};base64,${buffer.toString('base64')}`
    ICON_CACHE.set(value, { data, time: Date.now() })
    if (diskKey) {
      try {
        fs.mkdirSync(cacheDir, { recursive: true })
        fs.writeFileSync(diskKey, data, 'utf8')
      } catch {
        // Disk caching is best effort.
      }
    }
    return data
  } catch {
    return ''
  }
}

// Modrinth does not publish Chinese titles through its API, so a small curated map covers the mods
// people actually install most often; everything else falls back to the original title.
// Every id below was resolved from the Modrinth search API, so a project is never mislabelled.
const KNOWN_CHINESE_TITLES = {
  P7dR8mSH: 'Fabric API',
  AANobbMI: '钠（Sodium）',
  YL57xq9U: '光影加载器（Iris Shaders）',
  gvQqBUqZ: '锂（Lithium）',
  mOgUt4GM: '模组菜单（Mod Menu）',
  uXXizFIs: '铁氧体核心（FerriteCore）',
  NNAgCjsB: '实体渲染优化（Entity Culling）',
  '9s6osm5g': '布质配置 API（Cloth Config API）',
  nvQzSEkH: '玉（Jade - 显示工具信息）',
  EsAfCjCV: '苹果皮（AppleSkin）',
  lfHFW1mp: '旅行地图（JourneyMap）',
  xuDOzCLy: '玉附属（Jade Addons）',
  fThnVRli: '玉附属（Jade Addons）'
}

/** Well-known Chinese titles, used before any network lookup. */
export function knownChineseTitle(projectId) {
  return KNOWN_CHINESE_TITLES[projectId] || ''
}

/** Map Modrinth project ids to their Chinese titles via community translations. */
export async function fetchChineseTitles(projectIds, { timeout = 20_000 } = {}) {
  const ids = (Array.isArray(projectIds) ? projectIds : [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^[a-zA-Z0-9_-]{1,64}$/.test(id))
  if (!ids.length) return {}
  const result = {}
  const missing = []
  for (const id of ids) {
    const known = knownChineseTitle(id)
    if (known) {
      result[id] = known
      continue
    }
    const cached = ZH_CACHE.get(id)
    if (cached && Date.now() - cached.time < ZH_TTL) result[id] = cached.title
    else missing.push(id)
  }
  if (!missing.length) return result

  // Modrinth's search response only carries the original title, but `/project/{id}` may include
  // `title_translations` (community translated names, keyed by locale).
  const batchUrl = 'https://api.modrinth.com/v2/projects'
  const requests = []
  if (missing.length <= 12) {
    for (const id of missing) {
      requests.push(`https://api.modrinth.com/v2/project/${encodeURIComponent(id)}`)
    }
  } else {
    requests.push(`${batchUrl}?${new URLSearchParams({ ids: JSON.stringify(missing) }).toString()}`)
  }

  for (const url of requests) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': userAgent() }
      })
      if (!response.ok) continue
      const payload = await response.json()
      const projects = Array.isArray(payload) ? payload : [payload]
      for (const project of projects) {
        const translations = project?.title_translations
        const chinese = typeof translations === 'object' && translations
          ? String(translations['zh-CN'] || translations.zh_CN || '').trim()
          : ''
        const id = project?.id || project?.project_id
        if (!id || !chinese) continue
        result[id] = chinese
        ZH_CACHE.set(id, { title: chinese, time: Date.now() })
      }
    } catch {
      // Translations are optional; callers fall back to the English title.
    }
  }
  return result
}

function hashKey(value) {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0
  }
  return `${Math.abs(hash).toString(36)}${value.length}`
}

export { DISK_CACHE_DIR }
