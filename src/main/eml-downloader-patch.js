import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

// This module loads inside eml-lib (see eml-runtime.js), so its own modules are reached through the
// setter below and every import resolves against eml-lib's folder.

/**
 * Make eml-lib's Downloader survive mirror rate limiting (HTTP 429).
 *
 * The stock Downloader runs 8 parallel workers and retries immediately. A Minecraft runtime has
 * ~2000 small files, so BMCLAPI answers `429 Too Many Requests` and the launch aborted on files
 * such as `ADDITIONAL_LICENSE_INFO` / `ASSEMBLY_EXCEPTION` that the JVM never reads.
 *
 * This patch:
 *  - limits Java runtime downloads to 4 parallel files (other downloads keep the upstream 8);
 *  - retries 429/5xx/network failures with exponential backoff plus jitter;
 *  - switches to the official source for a 429 (Mojang object URLs are not rate limited);
 *  - gives up on non-essential files (licences, .md/.txt, readme...) after a few attempts and marks
 *    them handled instead of failing the launch.
 */
const DEFAULT_CONCURRENCY = 8
const JAVA_CONCURRENCY = 4
const MAX_ATTEMPTS = 5
const MAX_ESSENTIAL_ATTEMPTS = 8

const NON_ESSENTIAL = /(^|[/\\])(ADDITIONAL_LICENSE_INFO|ASSEMBLY_EXCEPTION|LICEN[CS]E|COPYING|NOTICE|README|THIRDPARTYLICENSEREADME[^/\\]*)(\.[A-Za-z0-9]+)?$/i
const NON_ESSENTIAL_EXT = /\.(md|txt|html?|pdf|sha1|sha256|md5)$/i

export function isNonEssentialFile(file) {
  const name = String(file?.name || '')
  return NON_ESSENTIAL.test(name) || NON_ESSENTIAL_EXT.test(name)
}

/** Map a mirrored URL to its official counterpart for the 429 fallback. */
export function officialFallbackUrl(url) {
  const text = String(url || '')
  if (!text.includes('bangbang93')) return ''
  const objectIndex = text.indexOf('/v1/objects/')
  if (objectIndex >= 0) return `https://piston-data.mojang.com${text.slice(objectIndex)}`
  const mavenIndex = text.indexOf('/maven/')
  if (mavenIndex >= 0) return `https://libraries.minecraft.net${text.slice(mavenIndex + '/maven'.length)}`
  return ''
}

export function configureDownloader(Downloader, { onWarning, onTrace } = {}) {
  const prototype = Downloader?.prototype
  if (!prototype || prototype.__voxelDownloader) return Downloader
  Object.defineProperty(prototype, '__voxelDownloader', { value: true })

  prototype.download = async function downloadWithLimits(files, skipCheck = false) {
    const startedAt = Date.now()
    const describeQueue = (list) => {
      const counts = new Map()
      for (const entry of list) {
        const type = String(entry?.type || 'OTHER')
        counts.set(type, (counts.get(type) || 0) + 1)
      }
      return [...counts.entries()].map(([type, count]) => `${type}×${count}`).join(' / ') || '空'
    }
    if (onTrace) {
      onTrace(
        `download() 进入：传入 ${Array.isArray(files) ? files.length : 0} 个文件（${describeQueue(Array.isArray(files) ? files : [])}），skipCheck=${skipCheck}`
      )
    }

    const list = Array.isArray(files) ? files : []
    const isJava = list.some((file) => file?.type === 'JAVA')
    this.CONCURRENCY_LIMIT = isJava ? JAVA_CONCURRENCY : DEFAULT_CONCURRENCY

    let filesToDownload
    try {
      filesToDownload = !skipCheck ? await this.getFilesToDownload(list) : list
    } catch (error) {
      onWarning?.(`下载前校验文件失败：${error?.code || ''} ${error?.message || error}`)
      throw error
    }
    this.size = filesToDownload.reduce((acc, curr) => acc + (Number(curr.size) || 0), 0)
    // Runtime files report `size: 0`/absent sizes, so a byte-based early return would silently
    // download nothing. Only bail out when the queue itself is empty.
    this.amount = filesToDownload.length
    this.downloaded = { amount: 0, size: 0 }
    this.speed = 0
    this.lastTime = Date.now()
    this.lastSize = 0
    if (onTrace) {
      onTrace(`download() 待下载 ${filesToDownload.length} 个文件（${describeQueue(filesToDownload)}）`)
    }
    if (filesToDownload.length === 0) {
      this.emit('download_end', { downloaded: this.downloaded })
      return
    }

    if (isJava) {
      const totalBytes = filesToDownload.reduce((acc, curr) => acc + (Number(curr.size) || 0), 0)
      onWarning?.(
        `准备进入 Java 运行时下载流程：共 ${filesToDownload.length} 个文件${totalBytes ? `，约 ${formatMB(totalBytes)}` : ''}，并发 ${this.CONCURRENCY_LIMIT}`
      )
      startWatchdog(this, filesToDownload.length, onWarning, onTrace)
    }

    let failure = null
    try {
      const queue = [...filesToDownload]
      this.__voxelQueue = queue
      const workers = Array(Math.max(1, this.CONCURRENCY_LIMIT))
        .fill(null)
        .map(async () => {
          while (queue.length > 0) {
            const file = queue.shift()
            if (!file) continue
            try {
              if (onTrace && filesToDownload.length > 50 && (filesToDownload.length - queue.length) % 25 === 0) {
                onTrace(`下载队列推进：剩余 ${queue.length}/${filesToDownload.length}，当前文件 ${file.name}`)
              }
              await this.downloadFileWithRetry(file)
            } catch (error) {
              // Collect the first hard failure but never leave a worker rejected: a rejected worker
              // used to make Promise.all skip the error reporting for the remaining files.
              failure = failure || { file, error }
            }
          }
        })
      await Promise.all(workers)
    } catch (error) {
      failure = failure || { file: null, error }
    } finally {
      this.__voxelQueue = null
      if (isJava) stopWatchdog(this, onWarning, onTrace)
    }

    if (failure) {
      const name = failure.file?.name || '未知文件'
      const message = `${failure.error?.code || ''} ${failure.error?.message || failure.error}`.trim()
      onWarning?.(`Java 运行时下载失败：${name}（${message.slice(0, 300)}）`)
      throw failure.error
    }
    if (onTrace) {
      onTrace(
        `download() 完成：${this.downloaded.amount}/${this.amount} 个文件，用时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`
      )
    }
    this.emit('download_end', { downloaded: this.downloaded })
  }

  prototype.downloadFileWithRetry = async function downloadFileWithBackoff(file, attempt = 0) {
    // The only thing that matters is getting the game process started: if the file is already on
    // disk, accept it as-is (no hash check, no size check) instead of re-downloading.
    try {
      const existing = path.join(this.dest, file.path || '', file.name)
      if (file.type !== 'FOLDER' && fs.existsSync(existing) && fs.statSync(existing).size > 0) {
        this.downloaded.amount += 1
        if (file?.type === 'JAVA') reportJavaProgress(this, file)
        return
      }
    } catch {
      // Fall through to the download.
    }
    try {
      await this.downloadFile(file)
      this.downloaded.amount += 1
      if (file?.type === 'JAVA') reportJavaProgress(this, file)
      return
    } catch (error) {
      const status = Number(error?.status)
      const message = String(error?.message || error || '')
      const authFailure = status === 401 || status === 403
      if (authFailure && !isNonEssentialFile(file)) {
        this.emit('download_error', { filename: file.name, type: file.type, message })
        throw error
      }

      const essential = !isNonEssentialFile(file)
      const maxAttempts = essential ? MAX_ESSENTIAL_ATTEMPTS : MAX_ATTEMPTS
      const rateLimited = status === 429

      if (attempt >= maxAttempts - 1) {
        if (!essential) {
          this.downloaded.amount += 1
          onWarning?.(`非核心文件下载失败，已跳过：${file.name}（${message.slice(0, 140)}）`)
          return
        }
        this.emit('download_error', { filename: file.name, type: file.type, message })
        throw error
      }

      // 429 needs a longer pause than a transient network error, and the retry goes to the official
      // source so the mirror can recover.
      const base = rateLimited ? 2000 : 800
      const delay = Math.min(30_000, base * 2 ** attempt) + Math.floor(Math.random() * 500)
      if (rateLimited) {
        const fallback = officialFallbackUrl(file.url)
        if (fallback) file.url = fallback
        onWarning?.(
          `镜像限流（429）：${file.name}，${Math.round(delay / 1000)} 秒后重试${fallback ? '，已改用官方源' : ''}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
      return this.downloadFileWithRetry(file, attempt + 1)
    }
  }

  prototype.downloadFile = async function downloadFileWithStatus(file) {
    const dirPath = path.join(this.dest, file.path)
    const filePath = path.join(dirPath, file.name)
    let bytesDownloadedThisAttempt = 0
    await fs.promises.mkdir(dirPath, { recursive: true })
    const headers =
      this.token && String(file.url || '').includes('files/files-updater')
        ? { Authorization: `Bearer ${this.token}`, Accept: 'application/octet-stream' }
        : { Accept: 'application/octet-stream' }
    const response = await fetch(file.url, { headers })
    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '')
      const error = new Error(`Error while fetching ${file.name}: HTTP ${response.status} ${errorText}`)
      error.status = response.status
      throw error
    }
    const fileStream = fs.createWriteStream(filePath)
    const nodeStream = Readable.fromWeb(response.body)
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        nodeStream.removeAllListeners()
        fileStream.removeAllListeners()
        fileStream.destroy()
      }
      nodeStream.on('data', (chunk) => {
        bytesDownloadedThisAttempt += chunk.length
        this.downloaded.size += chunk.length
        const now = Date.now()
        const diffTime = now - this.lastTime
        if (diffTime > 500) {
          const diffSize = this.downloaded.size - this.lastSize
          this.speed = diffSize / (diffTime / 1000)
          this.lastTime = now
          this.lastSize = this.downloaded.size
        }
        this.emit('download_progress', {
          total: { amount: this.amount, size: this.size },
          downloaded: this.downloaded,
          speed: Math.floor(this.speed),
          type: file.type
        })
      })
      nodeStream.on('error', (error) => {
        this.downloaded.size -= bytesDownloadedThisAttempt
        this.lastSize = Math.min(this.lastSize, this.downloaded.size)
        cleanup()
        reject(error)
      })
      fileStream.on('finish', async () => {
        cleanup()
        try {
          if (process.platform !== 'win32' && file.executable) {
            await fs.promises.chmod(filePath, 0o755)
          }
          resolve()
        } catch (error) {
          reject(error)
        }
      })
      fileStream.on('error', (error) => {
        this.downloaded.size -= bytesDownloadedThisAttempt
        cleanup()
        reject(error)
      })
      nodeStream.pipe(fileStream)
    })
  }

  return Downloader
}

/**
 * Watchdog: reports WARN when no new Java file finished for 10 seconds, and keeps printing the
 * progress line so a stalled mirror is visible in 运行日志 instead of looking like a hang.
 */
function startWatchdog(downloader, total, onWarning, onTrace) {
  stopWatchdog(downloader)
  const state = { lastCount: -1, lastChange: Date.now(), timer: null, ticks: 0 }
  state.timer = setInterval(() => {
    state.ticks += 1
    const count = downloader.downloaded?.amount || 0
    if (count !== state.lastCount) {
      state.lastCount = count
      state.lastChange = Date.now()
      return
    }
    if (Date.now() - state.lastChange >= 10_000) {
      const remaining = Math.max(0, total - count)
      const queued = Array.isArray(downloader.__voxelQueue) ? downloader.__voxelQueue.length : remaining
      onWarning?.(
        `Java 运行时下载 10 秒没有新文件完成（已完成 ${count}/${total}，队列剩余 ${queued}）；当前网络可能较慢或被限流，请检查镜像与代理设置。`
      )
      onTrace?.(`看门狗触发：已运行 ${state.ticks * 2}s，已完成 ${count} 个，队列剩余 ${queued} 个`)
      // Reset so the next warning comes 10 seconds later rather than on every tick.
      state.lastChange = Date.now()
    }
  }, 2_000)
  state.timer.unref?.()
  downloader.__voxelWatchdog = state
  if (onTrace) onTrace('看门狗已启动（10 秒无新文件完成将输出 WARN）')
}

function stopWatchdog(downloader, onWarning, onTrace) {
  const state = downloader?.__voxelWatchdog
  if (state?.timer) clearInterval(state.timer)
  if (downloader) downloader.__voxelWatchdog = null
  if (downloader) {
    onWarning?.(
      `Java 运行时下载结束：已完成 ${downloader.downloaded?.amount || 0}/${downloader.amount || 0} 个文件`
    )
    onTrace?.('看门狗已停止')
  }
}

let lastJavaProgress = 0
function reportJavaProgress(downloader, file) {
  const now = Date.now()
  const total = downloader.amount || 0
  const done = downloader.downloaded?.amount || 0
  // Print the first file, then at most every 5 seconds, plus every 50th file.
  if (done !== 1 && done % 50 !== 0 && now - lastJavaProgress < 5_000) return
  lastJavaProgress = now
  const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0
  const speed = Number(downloader.speed) || 0
  const detail = Number(downloader.downloaded?.size) ? `，已下载 ${formatMB(downloader.downloaded.size)}` : ''
  onJavaProgress?.(`Java 运行时下载进度 ${done}/${total}（${percent}%）${detail}${speed ? `，${formatMB(speed)}/s` : ''}`)
}

let onJavaProgress = null
let onTrace = null
export function setJavaProgressHandler(handler) {
  onJavaProgress = typeof handler === 'function' ? handler : null
}

/** Detailed download tracing (queue counts, watchdog ticks); routed to the DEBUG log channel. */
export function setDownloadTraceHandler(handler) {
  onTrace = typeof handler === 'function' ? handler : null
}

function formatMB(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Remove a half-finished Java runtime so the next launch starts from a clean directory.
 * The marker file is written only after a full download; a runtime without it is incomplete.
 */
export function cleanIncompleteRuntime(runtimeRoot) {
  try {
    if (!runtimeRoot || !fs.existsSync(runtimeRoot)) return false
    if (fs.existsSync(path.join(runtimeRoot, '.voxel-runtime-ok'))) return false
    for (const entry of fs.readdirSync(runtimeRoot)) {
      try {
        fs.rmSync(path.join(runtimeRoot, entry), { recursive: true, force: true })
      } catch {
        // Locked files are left for the next attempt.
      }
    }
    return true
  } catch {
    return false
  }
}

export function markRuntimeComplete(runtimeRoot) {
  try {
    fs.mkdirSync(runtimeRoot, { recursive: true })
    fs.writeFileSync(path.join(runtimeRoot, '.voxel-runtime-ok'), new Date().toISOString(), 'utf8')
  } catch {
    // Best effort.
  }
}
