import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomBytes } from 'node:crypto'

// Helpers for isolated instances (eml-lib resolves their `root` to the launcher profile folder,
// which proved unwritable: EPERM under %APPDATA%). Everything here stays inside the user-selected
// game directory.

/**
 * Copy a resolved manifest (Minecraft or loader) into `<gameDir>/cache/versions/<id>.json`. This is
 * a write-only convenience copy: unlinking it here is deliberately avoided because external tools
 * (antivirus, indexers) may still hold a handle to a folder the previous run created, and a failed
 * delete is exactly the EPERM that aborted earlier launches.
 *
 * @returns {string|null} the cached path, or `null` when it could not be written
 */
export function cacheManifestCopy(cacheDir, manifest) {
  if (!manifest?.id || !cacheDir) return null
  try {
    const directory = path.join(cacheDir, 'versions')
    fs.mkdirSync(directory, { recursive: true })
    const safeName = String(manifest.id).replace(/[\\/:*?"<>|]+/g, '_')
    const file = path.join(directory, `${safeName}.json`)
    fs.writeFileSync(
      file,
      JSON.stringify({ cachedAt: new Date().toISOString(), manifest }, null, 2),
      'utf8'
    )
    return file
  } catch {
    return null
  }
}

/**
 * Per-launch authlib-injector directory under `<gameDir>/cache/authlib-injector/<token>/`.
 *
 * eml-lib packages the injector with `yazl` (a zip container), but Java cannot load a zip through
 * `-javaagent` ("Error opening zip file or JAR manifest missing" / truncated class). Since Java 9,
 * `-javaagent:<dir>` reads the manifest from `<dir>/META-INF/MANIFEST.MF`, so the launcher unpacks
 * the downloaded zip into a folder (and keeps the original jar next to it for reference).
 */
export function prepareAgentDirectory(cacheDir) {
  const token = randomBytes(8).toString('hex')
  const directory = path.join(cacheDir, 'authlib-injector', token)
  fs.mkdirSync(directory, { recursive: true })
  return { directory, token }
}

/**
 * Rewrite `-javaagent:<file>` to point at the unpacked directory.
 * @returns {{ args: string[], converted: boolean, detail: string }}
 */
export function pointAgentToDirectory(args, agentDirectory) {
  if (!agentDirectory) return { args, converted: false, detail: '未启用 authlib-injector' }
  const index = args.findIndex((arg) => String(arg).startsWith('-javaagent:'))
  if (index < 0) return { args, converted: false, detail: '参数里没有 -javaagent' }
  const value = String(args[index])
  const [head, ...rest] = value.split('=')
  const jarPath = head.slice('-javaagent:'.length)
  if (!fs.existsSync(jarPath)) {
    return { args, converted: false, detail: `injector 文件不存在：${jarPath}` }
  }
  try {
    unpackZip(jarPath, agentDirectory)
  } catch (error) {
    return { args, converted: false, detail: `injector 解包失败：${error?.message || error}` }
  }
  if (!fs.existsSync(path.join(agentDirectory, 'META-INF', 'MANIFEST.MF'))) {
    return { args, converted: false, detail: 'injector 包内缺少 META-INF/MANIFEST.MF' }
  }
  const next = [...args]
  next[index] = `-javaagent:${agentDirectory}${rest.length ? `=${rest.join('=')}` : ''}`
  return { args: next, converted: true, detail: `-javaagent 已指向解包目录 ${agentDirectory}` }
}

function unpackZip(zipPath, directory) {
  const buffer = fs.readFileSync(zipPath)
  // Prefer the central directory: the JDK/`yazl` writers may emit data descriptors (flag bit 3),
  // which leave the local header's sizes at zero.
  const entries = readCentralDirectory(buffer)
  let count = 0
  for (const entry of entries) {
    if (!entry.name || entry.name.endsWith('/')) continue
    const target = path.join(directory, ...entry.name.split('/'))
    if (!target.startsWith(directory)) continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, entry.data)
    count += 1
  }
  if (!count) throw new Error('zip 中没有可解包的文件')
}

function readCentralDirectory(buffer) {
  const end = findEndOfCentralDirectory(buffer)
  if (!end) throw new Error('不是有效的 zip 文件')
  const total = buffer.readUInt16LE(end + 10)
  let offset = buffer.readUInt32LE(end + 16)
  const entries = []
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    // Local header: skip its own name/extra fields to reach the data.
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    entries.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return 0
}
