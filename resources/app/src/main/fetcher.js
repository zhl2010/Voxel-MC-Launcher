const DEFAULT_TIMEOUT = 20_000
// Keep launcher metadata requests independent from the temporary fetch wrapper used to cancel
// eml-lib's game downloads.
const nativeFetch = globalThis.fetch.bind(globalThis)

export class FetchError extends Error {
  constructor(message, { url, status, cause } = {}) {
    super(message, { cause })
    this.name = 'FetchError'
    this.url = url
    this.status = status
  }
}

/**
 * Fetch JSON with a timeout and a single retry. A fresh User-Agent is included because some
 * Minecraft metadata endpoints reject requests without one.
 */
export async function fetchJson(url, { timeout = DEFAULT_TIMEOUT, retries = 1, headers = {} } = {}) {
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await nativeFetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'VoxelLauncher/1.0 (+https://github.com/Electron-Minecraft-Launcher/EML-Lib)',
          ...headers
        }
      })

      if (!response.ok) {
        throw new FetchError(`HTTP ${response.status}`, { url, status: response.status })
      }

      return await response.json()
    } catch (error) {
      lastError = error
      if (attempt < retries && !controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
    } finally {
      clearTimeout(timer)
    }
  }

  if (lastError?.name === 'AbortError') {
    throw new FetchError('请求超时', { url, cause: lastError })
  }
  throw new FetchError(lastError?.message || '网络请求失败', { url, cause: lastError })
}

/**
 * Fetch a text document with the same timeout/retry semantics as fetchJson. Used for Maven
 * metadata (XML) that has no JSON representation.
 */
export async function fetchText(url, { timeout = DEFAULT_TIMEOUT, retries = 1, headers = {} } = {}) {
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await nativeFetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          Accept: 'text/plain, application/xml, text/xml, */*',
          'User-Agent': 'VoxelLauncher/1.0 (+https://github.com/Electron-Minecraft-Launcher/EML-Lib)',
          ...headers
        }
      })

      if (!response.ok) {
        throw new FetchError(`HTTP ${response.status}`, { url, status: response.status })
      }

      return await response.text()
    } catch (error) {
      lastError = error
      if (attempt < retries && !controller.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
    } finally {
      clearTimeout(timer)
    }
  }

  if (lastError?.name === 'AbortError') {
    throw new FetchError('请求超时', { url, cause: lastError })
  }
  throw new FetchError(lastError?.message || '网络请求失败', { url, cause: lastError })
}

export function friendlyError(error, fallback = '发生了未知错误') {
  const message = String(error?.message || error || fallback)

  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|socket|请求超时/i.test(message)) {
    return '网络连接失败，请检查网络或代理设置后重试。'
  }
  if (/HTTP 404/i.test(message)) {
    return '请求的资源不存在。'
  }
  if (/HTTP 5\d\d/i.test(message)) {
    return '远程服务暂时不可用，请稍后重试。'
  }
  if (/EPERM|EACCES|operation not permitted|access is denied/i.test(message)) {
    return '无法写入游戏目录，请检查磁盘权限或安全软件拦截。'
  }
  if (/ENOSPC/i.test(message)) {
    return '磁盘空间不足，请清理空间后重试。'
  }
  return message
}
