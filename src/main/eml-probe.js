import { probeRemoteFile } from './network.js'

// This module loads inside eml-lib (see eml-runtime.js), so bare specifiers resolve against
// eml-lib's own folder and share the same class instances.

/**
 * Bound eml-lib's getRemoteFileSize()/getRemoteFileSha1().
 *
 * eml-lib uses a bare `fetch(url, { method: 'HEAD', headers: { Connection: 'close' } })` with no
 * timeout. In mainland China a direct Maven HEAD can hang for over a minute, which froze the launch
 * after the download phase. network.js already bounds and mirrors every request through the global
 * fetch, and this decorator adds a hard timeout on top for the HEAD/SHA1 probes themselves.
 */
export function patchRemoteProbes(utils) {
  if (!utils || utils.__voxelProbesPatched) return utils

  const originalSize = utils.getRemoteFileSize.bind(utils)
  const originalSha1 = utils.getRemoteFileSha1.bind(utils)

  utils.getRemoteFileSize = async (url, errorMsg) => {
    try {
      return await withTimeout(originalSize(url, errorMsg), 10_000)
    } catch (error) {
      const probe = await probeRemoteFile(url).catch(() => null)
      if (probe && probe.size > 0) return probe.size
      throw error
    }
  }

  utils.getRemoteFileSha1 = async (url, errorMsg) => {
    try {
      return await withTimeout(originalSha1(url, errorMsg), 10_000)
    } catch (error) {
      const probe = await probeRemoteFile(url).catch(() => null)
      if (probe?.sha1) return probe.sha1
      throw error
    }
  }

  Object.defineProperty(utils, '__voxelProbesPatched', { value: true, enumerable: false })
  return utils
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`getRemoteFile timeout after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
