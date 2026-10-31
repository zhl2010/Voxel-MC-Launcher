import { fetchJson, fetchText } from './fetcher.js'

const CACHE_TTL = 10 * 60 * 1000
const NEOFORGE_METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'
const NEOFORGE_METADATA_FALLBACK =
  'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml'
const FORGE_PROMOTIONS_URL =
  'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
const FORGE_PROMOTIONS_FALLBACK =
  'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/promotions_slim.json'
const FABRIC_META_FALLBACK = 'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader'

/**
 * Resolves the newest usable loader build for a Minecraft version. Only metadata is fetched here;
 * eml-lib installs the loader itself during launch.
 */
export class LoaderService {
  constructor() {
    this.cache = new Map()
    this.inflight = new Map()
  }

  async getOptions(mcVersion, { force = false } = {}) {
    if (!/^[a-zA-Z0-9._-]+$/.test(mcVersion)) {
      throw new Error('无效的 Minecraft 版本。')
    }

    const cached = this.cache.get(mcVersion)
    if (!force && cached && Date.now() - cached.time < CACHE_TTL) {
      return cached.options
    }

    if (this.inflight.has(mcVersion)) {
      return this.inflight.get(mcVersion)
    }

    const task = this.resolveAll(mcVersion)
      .then((options) => {
        this.cache.set(mcVersion, { options, time: Date.now() })
        return options
      })
      .finally(() => {
        this.inflight.delete(mcVersion)
      })

    this.inflight.set(mcVersion, task)
    return task
  }

  async resolveAll(mcVersion) {
    const options = {
      vanilla: {
        type: 'vanilla',
        label: '原版',
        version: mcVersion,
        detail: '纯净的 Minecraft 体验',
        available: true
      }
    }

    const [fabric, quilt, forge, neoforge] = await Promise.allSettled([
      this.resolveFabric(mcVersion),
      this.resolveQuilt(mcVersion),
      this.resolveForge(mcVersion),
      this.resolveNeoForge(mcVersion)
    ])

    if (fabric.status === 'fulfilled' && fabric.value) options.fabric = fabric.value
    if (quilt.status === 'fulfilled' && quilt.value) options.quilt = quilt.value
    if (forge.status === 'fulfilled' && forge.value) options.forge = forge.value
    if (neoforge.status === 'fulfilled' && neoforge.value) options.neoforge = neoforge.value

    return options
  }

  async resolveFabric(mcVersion) {
    const encoded = encodeURIComponent(mcVersion)
    const list = await fetchFirstJson([
      {
        url: `https://meta.fabricmc.net/v2/versions/loader/${encoded}`,
        options: { timeout: 6_000, retries: 0 }
      },
      {
        url: `${FABRIC_META_FALLBACK}/${encoded}`,
        options: { timeout: 9_000, retries: 0 }
      }
    ])
    if (!Array.isArray(list) || !list.length) return null

    const entry = list.find((item) => item?.loader?.stable) || list[0]
    const version = entry?.loader?.version
    if (!version) return null

    return {
      type: 'fabric',
      label: 'Fabric',
      version,
      detail: `Fabric Loader ${version}`,
      available: true
    }
  }

  async resolveQuilt(mcVersion) {
    const list = await fetchJson(
      `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}`,
      { timeout: 9_000, retries: 0 }
    )
    if (!Array.isArray(list) || !list.length) return null

    const stable = list.find((item) => item?.loader?.stable)
    const nonBeta = list.find((item) => item?.loader?.version && !String(item.loader.version).includes('beta'))
    const entry = stable || nonBeta || list[0]
    const version = entry?.loader?.version
    if (!version) return null

    return {
      type: 'quilt',
      label: 'Quilt',
      version,
      detail: `Quilt Loader ${version}`,
      available: true
    }
  }

  async resolveForge(mcVersion) {
    const data = await fetchFirstJson([
      { url: FORGE_PROMOTIONS_URL, options: { timeout: 8_000, retries: 0 } },
      { url: FORGE_PROMOTIONS_FALLBACK, options: { timeout: 9_000, retries: 0 } }
    ])
    const promos = data?.promos
    if (!promos) return null

    const forgeVersion = promos[`${mcVersion}-recommended`] || promos[`${mcVersion}-latest`]
    if (!forgeVersion) return null

    return {
      type: 'forge',
      label: 'Forge',
      version: `${mcVersion}-${forgeVersion}`,
      detail: `Forge ${forgeVersion}`,
      available: true
    }
  }

  async resolveNeoForge(mcVersion) {
    const xml = await fetchFirstText([
      { url: NEOFORGE_METADATA_URL, options: { timeout: 6_000, retries: 0 } },
      { url: NEOFORGE_METADATA_FALLBACK, options: { timeout: 9_000, retries: 0 } }
    ])
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1].trim())
    if (!versions.length) return null

    // NeoForge follows the game's minor/patch version (1.21.1 -> 21.1.x, 1.21 -> 21.0.x).
    // For the newer 26.x game versions, the same convention carries over as 26.x.y.
    const parts = mcVersion.split('.')
    if (!/^\d+$/.test(parts[0] || '')) return null
    const prefix = parts[0] === '1'
      ? `${parts[1] ?? '0'}.${parts[2] ?? '0'}.`
      : `${parts[0]}.${parts[1] ?? '0'}.`

    const matching = versions
      .filter((version) => version.startsWith(prefix) && !/beta|alpha/i.test(version))
      .sort(compareVersions)

    const latest = matching.at(-1)
    if (!latest) return null

    return {
      type: 'neoforge',
      label: 'NeoForge',
      version: latest,
      detail: `NeoForge ${latest}`,
      available: true
    }
  }

  async resolve(mcVersion, loaderType) {
    if (loaderType === 'vanilla') {
      return { type: 'vanilla', version: mcVersion }
    }

    let options = await this.getOptions(mcVersion)
    if (!options[loaderType]) {
      options = await this.getOptions(mcVersion, { force: true })
    }

    const selected = options[loaderType]
    if (!selected) {
      const names = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }
      throw new Error(`${names[loaderType] || loaderType} 暂不支持 Minecraft ${mcVersion}，请选择其他加载器。`)
    }

    return { type: selected.type, version: selected.version }
  }
}

async function fetchFirstJson(requests) {
  let lastError
  for (const request of requests) {
    try {
      return await fetchJson(request.url, request.options)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('没有可用的元数据地址')
}

async function fetchFirstText(requests) {
  let lastError
  for (const request of requests) {
    try {
      return await fetchText(request.url, request.options)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('没有可用的元数据地址')
}

function compareVersions(a, b) {
  const left = String(a).split(/[.-]/).map((part) => Number(part) || 0)
  const right = String(b).split(/[.-]/).map((part) => Number(part) || 0)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const delta = (left[i] || 0) - (right[i] || 0)
    if (delta !== 0) return delta
  }
  return 0
}
