import { fetch as undiciFetch, ProxyAgent } from 'undici'

const BMCL = 'https://bmclapi2.bangbang93.com'
const nativeFetch = globalThis.fetch.bind(globalThis)
const mirrorableStatuses = new Set([403, 404, 410, 500, 502, 503, 504])

// eml-lib calls getRemoteFileSize()/getRemoteFileSha1() through the global fetch without a
// timeout. A direct Maven HEAD request can hang for over a minute in mainland China, which is what
// made the Fabric/Forge launch appear frozen. Every request routed through networkFetch is bounded.
const FETCH_IDLE_TIMEOUT = 15_000
const PROBE_TIMEOUT = 10_000
// JSON manifest/asset-index documents are buffered so eml-lib can parse them after the header
// timeout is released; anything bigger is streamed normally.
const MIRROR_BODY_LIMIT = 16 * 1024 * 1024
const MIRROR_CACHE_LIMIT = 100
const MIRROR_CACHE_TTL = 10 * 60 * 1000
const mirrorCache = new Map()

let config = {
  proxyUrl: '',
  mirrorMojang: true,
  mirrorFabric: true,
  mirrorForge: true,
  mirrorNeoForge: true,
  onRequest: null,
  onProbe: null
}
let proxyAgent = null
let installed = false

export function configureNetwork(next = {}) {
  const previousAgent = proxyAgent
  const nextConfig = {
    proxyUrl: String(next.proxyUrl || '').trim(),
    mirrorMojang: next.mirrorMojang !== false,
    mirrorFabric: next.mirrorFabric !== false,
    mirrorForge: next.mirrorForge !== false,
    mirrorNeoForge: next.mirrorNeoForge !== false,
    onRequest: typeof next.onRequest === 'function' ? next.onRequest : null,
    onProbe: typeof next.onProbe === 'function' ? next.onProbe : null
  }

  let nextAgent = null
  if (nextConfig.proxyUrl) {
    const url = new URL(nextConfig.proxyUrl)
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('代理地址只支持 http:// 或 https://。')
    }
    nextAgent = new ProxyAgent(nextConfig.proxyUrl)
  }

  config = nextConfig
  proxyAgent = nextAgent
  if (previousAgent && previousAgent !== nextAgent) {
    previousAgent.close?.().catch?.(() => {})
  }

  if (!installed) {
    installed = true
    // eml-lib does `fetch(new Request(url))` for the version/asset indexes, which would otherwise
    // lose the mirror host and hit Mojang directly. Replay the mirror first, then fall back.
    globalThis.fetch = (input, init) =>
      replayMirrorFetch(input, init).then((replayed) =>
        replayed === undefined ? networkFetch(input, init) : replayed
      )
  }
}

export async function networkFetch(input, init = {}) {
  const originalUrl = typeof input === 'string' ? input : input?.url
  if (!originalUrl) return nativeFetch(input, init)

  const method = String(init.method || input?.method || 'GET').toUpperCase()
  // Keep eml-lib's body reads bound to the mirror we actually served (see mirrorOf).
  rememberMirror(input, originalUrl, method)
  const candidates = buildCandidates(originalUrl, method)
  let lastError

  for (let index = 0; index < candidates.length; index += 1) {
    const url = candidates[index]
    const isLast = index === candidates.length - 1
    // HEAD and GET are both routed through the mirror. HEAD is what eml-lib uses to discover the
    // size of loader libraries, so it must not bypass the mirror.
    config.onRequest?.({ url, originalUrl, method, mirrored: url !== originalUrl })
    try {
      const options = { ...init }
      // Native fetch rejects unknown options such as `dispatcher`; keep it out unless undici runs.
      const useUndici = Boolean(proxyAgent)
      if (useUndici) options.dispatcher = proxyAgent
      options.signal = withTimeout(init.signal, FETCH_IDLE_TIMEOUT)
      const response = useUndici ? await undiciFetch(url, options) : await nativeFetch(url, options)
      // A response handed to the caller may be streamed for minutes; cancel the header timer only.
      options.signal.disposeTimer?.()
      // BMCLAPI answers JSON documents with a redirect to a signed download node. That node returns
      // chunked responses without a length, so read the body here once and hand back a buffered
      // Response. Otherwise eml-lib's `response.json()` reuses the aborted header signal and fails.
      const final = await finalizeResponse(input, originalUrl, url, method, response, isLast)
      if (!final) continue
      return final
    } catch (error) {
      lastError = error
      if (init.signal?.aborted) throw error
      if (isLast) throw error
    }
  }

  throw lastError || new Error('网络请求失败')
}

async function finalizeResponse(input, originalUrl, url, method, response, isLast) {
  if (method !== 'GET' || !response.body) return response

  const contentLength = response.headers.get('content-length')
  const exceedsMirrorLimit = contentLength && Number(contentLength) > MIRROR_BODY_LIMIT
  if (
    !response.ok &&
    !isLast &&
    mirrorableStatuses.has(response.status) &&
    !exceedsMirrorLimit
  ) {
    await response.body.cancel?.().catch(() => {})
    return null
  }

  const shouldBuffer =
    (url !== originalUrl && (response.redirected || !contentLength)) ||
    looksLikeJsonDocument(input, url, response)
  if (!shouldBuffer || exceedsMirrorLimit) return response

  const buffer = Buffer.from(await response.arrayBuffer())
  const buffered = new Response(buffer, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
  const record = mirrorCache.get(unwrapUrl(input))
  if (record) record.body = buffer
  return buffered
}

function looksLikeJsonDocument(input, url, response) {
  // eml-lib passes the manifest URL into `new Request(url)` before fetching it.
  if (input && typeof input === 'object' && typeof input.json === 'function') return true
  const type = String(response.headers.get('content-type') || '').toLowerCase()
  if (!type.includes('json')) return false
  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase()
    } catch {
      return ''
    }
  })()
  return (
    pathname.endsWith('.json') ||
    pathname.includes('/manifest') ||
    pathname.includes('/v1/packages/') ||
    pathname.includes('/version_manifest')
  )
}

function unwrapUrl(input) {
  return typeof input === 'string' ? input : input?.url || ''
}

function rememberMirror(input, originalUrl, method) {
  const key = unwrapUrl(input)
  const mirror = method === 'GET' ? buildCandidates(originalUrl, method).find((candidate) => candidate !== originalUrl) : ''
  if (!key || !mirror) return
  if (!mirrorCache.has(key)) {
    if (mirrorCache.size > MIRROR_CACHE_LIMIT) mirrorCache.clear()
    mirrorCache.set(key, { mirrorUrl: mirror, body: null, time: Date.now() })
  } else {
    mirrorCache.get(key).time = Date.now()
  }
}

function takeMirror(input) {
  const key = unwrapUrl(input)
  const record = key ? mirrorCache.get(key) : null
  if (!record) return null
  mirrorCache.delete(key)
  if (Date.now() - record.time > MIRROR_CACHE_TTL) return null
  return record
}

/**
 * Replay a later request for a URL that was already served from the mirror.
 *
 * eml-lib does `fetch(new Request(url))` for the Minecraft version and asset indexes, so the mirror
 * URL we actually streamed is lost and the second request goes to the official host and times out.
 * This serves the same mirror URL (or the already buffered body) instead. It returns `undefined`
 * when the request is unrelated, so the caller can fall back to networkFetch.
 */
export async function replayMirrorFetch(input, init = {}) {
  const record = takeMirror(input)
  if (!record) return undefined
  const originalUrl = unwrapUrl(input)
  const method = String(init.method || input?.method || 'GET').toUpperCase()
  if (record.body) {
    config.onRequest?.({ url: record.mirrorUrl, originalUrl, method, mirrored: true, cached: true })
    return new Response(record.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    })
  }
  config.onRequest?.({ url: record.mirrorUrl, originalUrl, method, mirrored: true })
  const options = { ...init }
  if (proxyAgent) options.dispatcher = proxyAgent
  options.signal = withTimeout(init.signal, FETCH_IDLE_TIMEOUT)
  const response = proxyAgent
    ? await undiciFetch(record.mirrorUrl, options)
    : await nativeFetch(record.mirrorUrl, options)
  options.signal.disposeTimer?.()
  return response
}

/**
 * Resolve the size (and SHA1 when available) of a remote file with a strict timeout. eml-lib's
 * getRemoteFileSize() issues an unbounded HEAD request, so probed URLs are kept here to serve those
 * HEAD requests from an earlier bounded probe instead of waiting on the network again.
 */
export async function probeRemoteFile(url, { timeout = PROBE_TIMEOUT } = {}) {
  const candidates = buildCandidates(url, 'HEAD')
  let lastError

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const isLast = index === candidates.length - 1
    config.onProbe?.({ url: candidate, originalUrl: url, mirrored: candidate !== url })
    try {
      const options = { method: 'HEAD', signal: withTimeout(undefined, timeout) }
      if (proxyAgent) options.dispatcher = proxyAgent
      const response = proxyAgent ? await undiciFetch(candidate, options) : await nativeFetch(candidate, options)
      await response.body?.cancel?.()
      if (!response.ok) {
        if (!isLast && mirrorableStatuses.has(response.status)) continue
        throw new Error(`HTTP ${response.status}`)
      }
      const size = Number(response.headers.get('content-length') ?? 0)
      let sha1 = ''
      try {
        const shaResponse = await (proxyAgent ? undiciFetch : nativeFetch)(`${candidate}.sha1`, {
          signal: withTimeout(undefined, Math.min(timeout, 6_000)),
          ...(proxyAgent ? { dispatcher: proxyAgent } : {})
        })
        if (shaResponse.ok) sha1 = (await shaResponse.text()).trim().split(/\s+/)[0] || ''
      } catch {
        // SHA1 side-car files are optional.
      }
      return { url: candidate, size, sha1 }
    } catch (error) {
      lastError = error
      if (isLast) throw lastError
    }
  }

  throw lastError || new Error('无法获取文件信息')
}

// Only the response headers are bounded here. The returned signal fires after `timeout` or when the
// caller aborts, and the timer is cancelled once the response arrives so long downloads keep
// working.
function withTimeout(signal, timeout, onSettled) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('NETWORK_TIMEOUT')), timeout)
  const dispose = () => {
    clearTimeout(timer)
    onSettled?.()
  }
  controller.disposeTimer = dispose
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else {
      signal.addEventListener(
        'abort',
        () => {
          dispose()
          controller.abort(signal.reason)
        },
        { once: true }
      )
    }
  }
  return controller.signal
}

export function buildCandidates(originalUrl, method = 'GET', settings = config) {
  const mirror = mirrorUrl(originalUrl, settings)
  if (!mirror || mirror === originalUrl) return [originalUrl]
  // The BMCLAPI manifest endpoint redirects through a download node and is often slower than
  // Mojang's metadata endpoint. Prefer official for tiny piston-meta documents; use the mirror for
  // everything else (libraries, assets, loader artefacts) and fall back to official on failure.
  try {
    if (new URL(originalUrl).hostname === 'piston-meta.mojang.com') {
      return [originalUrl, mirror]
    }
  } catch {
    // Fall through to mirror-first behavior.
  }
  return [mirror, originalUrl]
}

function mirrorUrl(originalUrl, settings = config) {
  let url
  try {
    url = new URL(originalUrl)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()
  const path = url.pathname

  if (settings.mirrorMojang) {
    if (host === 'piston-meta.mojang.com' || host === 'piston-data.mojang.com' || host === 'launchermeta.mojang.com') {
      return `${BMCL}${path}${url.search}`
    }
    if (host === 'resources.download.minecraft.net') {
      return `${BMCL}/assets${path}${url.search}`
    }
    if (host === 'libraries.minecraft.net') {
      return `${BMCL}/maven${path}${url.search}`
    }
  }

  if (settings.mirrorFabric && host === 'meta.fabricmc.net') {
    return `${BMCL}/fabric-meta${path}${url.search}`
  }
  if (settings.mirrorFabric && host === 'maven.fabricmc.net') {
    return `${BMCL}/maven${path}${url.search}`
  }

  if (settings.mirrorForge && host === 'files.minecraftforge.net') {
    return `${BMCL}/maven${path}${url.search}`
  }
  if (settings.mirrorForge && host === 'maven.minecraftforge.net') {
    return `${BMCL}/maven${path}${url.search}`
  }

  if (settings.mirrorNeoForge && host === 'maven.neoforged.net') {
    return `${BMCL}/maven${path.replace(/^\/releases/, '')}${url.search}`
  }

  return null
}
