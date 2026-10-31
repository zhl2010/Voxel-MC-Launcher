import { fetchJson, fetchText } from './fetcher.js'

const CACHE_TTL = 10 * 60 * 1000
const NEOFORGE_METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'
const NEOFORGE_METADATA_FALLBACK =
  'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml'
const FORGE_PROMOTIONS_URL =
  'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
const FORGE_PROMOTIONS_FALLBACK =
  'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/promotions_slim.json'
const FORGE_MAVEN_METADATA =
  'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'
const FORGE_MAVEN_METADATA_FALLBACK =
  'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/maven-metadata.xml'
const FABRIC_META_FALLBACK = 'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader'
// The loader picker is advisory only, so each lookup must answer within two seconds; browsing the
// version list must never queue slow metadata calls (and must never hit mirrors repeatedly).
const LOOKUP_TIMEOUT = 2_000

/**
 * Which loaders can exist for a version, decided without any network access.
 * Fabric/Quilt start at 1.14, NeoForge at 1.20.1, Forge supports 1.0+ but not alpha/beta snapshots.
 */
export function supportsLoaders(mcVersion, type = '') {
  const release = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(mcVersion || ''))
  const isOld = type === 'old_alpha' || type === 'old_beta' || /^[ab]\d/.test(String(mcVersion || ''))
  if (!release) return { fabric: false, quilt: false, forge: false, neoforge: false, any: false }
  const level = [Number(release[1]), Number(release[2] || 0), Number(release[3] || 0)]
  const atLeast = (major, minor, patch) =>
    level[0] !== major
      ? level[0] > major
      : level[1] !== minor
        ? level[1] > minor
        : level[2] >= patch
  const support = {
    fabric: !isOld && atLeast(1, 14, 0),
    quilt: !isOld && atLeast(1, 14, 0),
    forge: !isOld && atLeast(1, 0, 0),
    neoforge: !isOld && atLeast(1, 20, 1)
  }
  support.any = support.fabric || support.quilt || support.forge || support.neoforge
  return support
}

/**
 * Resolves the newest usable loader build for a Minecraft version. Only metadata is fetched here;
 * eml-lib installs the loader itself during launch.
 */
export class LoaderService {
  constructor() {
    this.cache = new Map()
    this.inflight = new Map()
  }

  async getOptions(mcVersion, { force = false, versionType = '' } = {}) {
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

    const task = this.resolveAll(mcVersion, versionType)
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

  async resolveAll(mcVersion, versionType = '') {
    const options = {
      vanilla: {
        type: 'vanilla',
        label: '原版',
        version: mcVersion,
        detail: '纯净的 Minecraft 体验',
        available: true
      }
    }
    const support = supportsLoaders(mcVersion, versionType)
    if (!support.any) return options

    const [fabric, quilt, forge, neoforge] = await Promise.allSettled([
      support.fabric ? this.withTimeout(this.resolveFabric(mcVersion)) : null,
      support.quilt ? this.withTimeout(this.resolveQuilt(mcVersion)) : null,
      support.forge ? this.withTimeout(this.resolveForge(mcVersion)) : null,
      support.neoforge ? this.withTimeout(this.resolveNeoForge(mcVersion)) : null
    ])

    if (fabric.status === 'fulfilled' && fabric.value) options.fabric = fabric.value
    if (quilt.status === 'fulfilled' && quilt.value) options.quilt = quilt.value
    if (forge.status === 'fulfilled' && forge.value) options.forge = forge.value
    if (neoforge.status === 'fulfilled' && neoforge.value) options.neoforge = neoforge.value

    return options
  }

  /** Resolve to `null` after `LOOKUP_TIMEOUT` so a slow mirror never holds the picker open. */
  withTimeout(promise) {
    if (!promise) return Promise.resolve(null)
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT)
    })
    return Promise.race([promise.catch(() => null), timeout]).finally(() => clearTimeout(timer))
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

    // The full history lets the UI offer "older versions" instead of only the newest stable build.
    const history = list
      .map((item) => ({
        version: item?.loader?.version,
        stable: Boolean(item?.loader?.stable)
      }))
      .filter((item) => item.version)
      .slice(0, 150)

    return {
      type: 'fabric',
      label: 'Fabric',
      version,
      detail: `Fabric Loader ${version}`,
      available: true,
      versions: history
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

    const history = list
      .map((item) => ({ version: item?.loader?.version, stable: Boolean(item?.loader?.stable) }))
      .filter((item) => item.version)
      .slice(0, 150)

    return {
      type: 'quilt',
      label: 'Quilt',
      version,
      detail: `Quilt Loader ${version}`,
      available: true,
      versions: history
    }
  }

  async resolveForge(mcVersion) {
    const data = await fetchFirstJson([
      { url: FORGE_PROMOTIONS_URL, options: { timeout: 8_000, retries: 0 } },
      { url: FORGE_PROMOTIONS_FALLBACK, options: { timeout: 9_000, retries: 0 } }
    ]).catch(() => null)
    const promos = data?.promos || {}

    const forgeVersion = promos[`${mcVersion}-recommended`] || promos[`${mcVersion}-latest`]

    // Every promotion for this game version, newest first, so older builds stay reachable.
    const seen = new Set()
    const history = []
    for (const [key, value] of Object.entries(promos)) {
      if (!key.startsWith(`${mcVersion}-`) || !value) continue
      if (seen.has(value)) continue
      seen.add(value)
      history.push({ version: `${mcVersion}-${value}`, stable: key.endsWith('-recommended') })
    }

    // Promotions only carry recommended/latest and lag behind for some game versions; the Maven
    // metadata lists every build (still capped by the 2 s lookup timeout).
    if (history.length < 2) {
      const extra = await this.withTimeout(this.resolveForgeMavenHistory(mcVersion))
      for (const entry of extra || []) {
        const stripped = entry.version.replace(`${mcVersion}-`, '')
        if (seen.has(stripped)) continue
        seen.add(stripped)
        history.push({ version: entry.version, stable: false })
      }
    }
    history.sort((a, b) => compareVersions(b.version, a.version))

    if (!forgeVersion && !history.length) return null
    const newest = history[0]?.version?.replace(`${mcVersion}-`, '') || forgeVersion

    return {
      type: 'forge',
      label: 'Forge',
      version: `${mcVersion}-${newest}`,
      detail: `Forge ${newest}`,
      available: true,
      versions: history.length ? history : [{ version: `${mcVersion}-${newest}`, stable: true }]
    }
  }

  /** All Forge builds for a game version from maven-metadata.xml (used when promotions lag). */
  async resolveForgeMavenHistory(mcVersion) {
    const xml = await fetchFirstText([
      { url: FORGE_MAVEN_METADATA, options: { timeout: 6_000, retries: 0 } },
      { url: FORGE_MAVEN_METADATA_FALLBACK, options: { timeout: 6_000, retries: 0 } }
    ])
    const prefix = `${mcVersion}-`
    return [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
      .map((match) => ({ version: match[1].trim() }))
      .filter((entry) => entry.version.startsWith(prefix))
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

    const history = matching
      .slice()
      .reverse()
      .map((version) => ({ version, stable: !/beta/i.test(version) }))
      .slice(0, 150)

    return {
      type: 'neoforge',
      label: 'NeoForge',
      version: latest,
      detail: `NeoForge ${latest}`,
      available: true,
      versions: history
    }
  }

  async resolve(mcVersion, loaderType, preferredVersion = '') {
    if (loaderType === 'vanilla') {
      return { type: 'vanilla', version: mcVersion }
    }

    // An explicitly chosen build (older loader version) wins over the newest stable one.
    if (preferredVersion) {
      const options = await this.getOptions(mcVersion).catch(() => null)
      const known = options?.[loaderType]?.versions || []
      if (!known.length || known.some((item) => item.version === preferredVersion)) {
        return { type: loaderType, version: preferredVersion }
      }
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
