import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'

// Own launch core. eml-lib's `Launcher.launch()` stays available for downloading missing files, but
// everything that decides *what* and *how* to spawn lives here so a failed launch always produces a
// concrete error message instead of a silent stall.

const OS_NAME = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
const OS_ARCH = process.arch
const WINDOWS_COMMAND_LIMIT = 30_000
const CLASSPATH_JAR = 'voxel-classpath.jar'
const INLINE_CLASSPATH_ENTRIES = 120

/**
 * Build the complete `java ...` argument list for a resolved version manifest.
 *
 * This function never throws for missing files: it reports them in `missing` (and whether the
 * classpath is usable in `usable`) so the caller can decide to download first and rebuild. It only
 * throws for structurally broken input (no manifest / no main class).
 *
 * @returns {{
 *   args: string[], classpath: string[], mainClass: string, javaPath: string,
 *   missing: string[], missingLibraries: string[], clientJarMissing: boolean,
 *   usable: boolean, notes: string[], command: string
 * }}
 */
export function buildLaunchArguments({
  id,
  manifest,
  gameDir,
  javaPath,
  account,
  settings,
  agentDirectory,
  assetsIndex = '',
  instanceDir = '',
  baseVersion = ''
}) {
  // With version isolation the game runs with `--gameDir` pointing at the instance folder
  // (`versions/<id>`) while libraries and assets stay in the shared root.
  const runtimeDir = instanceDir || gameDir
  const notes = []
  const missing = []
  const libraries = Array.isArray(manifest.libraries) ? manifest.libraries : []
  const nativesDirectory = path.join(gameDir, 'bin', id)
  const assetsRoot = path.join(gameDir, 'assets')
  try {
    fs.mkdirSync(nativesDirectory, { recursive: true })
  } catch (error) {
    // A read-only game directory only matters when a native jar actually has to be extracted.
    notes.push(`无法创建 natives 目录：${nativesDirectory}（${error.code || error.message}）`)
  }

  const classpath = []
  const seenPaths = new Set()
  for (const library of libraries) {
    if (!isLibraryAllowed(library)) continue
    const artifact = classifyArtifact(library, gameDir)
    if (!artifact) continue

    if (artifact.native) {
      const target = artifact.path
      if (!fs.existsSync(target)) {
        missing.push(`${library.name}（native）`)
        continue
      }
      try {
        extractNatives(target, nativesDirectory)
      } catch (error) {
        notes.push(`解压 native 失败：${path.basename(target)}（${error.message}）`)
      }
      continue
    }

    if (!fs.existsSync(artifact.path)) {
      missing.push(library.name)
      continue
    }
    const key = artifact.path.toLowerCase()
    if (seenPaths.has(key)) continue
    seenPaths.add(key)
    classpath.push(artifact.path)
  }

  // The client jar must be the last classpath entry. Its name comes from the base version (the
  // folder that owns the jar/json): for loader instances (`inheritsFrom`) the client jar lives in
  // the vanilla folder, e.g. `versions/1.21.1/1.21.1.jar` for id `1.21.1-fabric-0.16.9` — never
  // from the asset index id.
  const jarName = manifest.jar || baseVersion || id
  const clientJar = path.join(gameDir, 'versions', jarName, `${jarName}.jar`)
  const candidates = [clientJar]
  if (jarName !== id) candidates.push(path.join(gameDir, 'versions', id, `${id}.jar`))
  const resolvedJar = candidates.find((candidate) => fs.existsSync(candidate)) || clientJar
  if (fs.existsSync(resolvedJar)) classpath.push(resolvedJar)
  else missing.push(path.basename(resolvedJar))
  if (classpath.length === 0) missing.push('classpath 为空（没有任何可用的运行库）')
  // The caller decides when to give up; this reports whether the arguments can actually spawn.
  const realMissing = missing.filter((entry) => !entry.startsWith('classpath 为空'))
  const canSpawn = classpath.length > 0 && Boolean(manifest.mainClass)

  const assetIndexId = manifest.assetIndex?.id || manifest.assets || assetsIndex || 'legacy'
  const replacements = buildReplacements({
    manifest,
    id,
    gameDir,
    nativesDirectory,
    runtimeDir,
    assetsRoot,
    assetIndexId,
    account,
    settings,
    agentDirectory
  })

  const jvmArgs = collectArguments(manifest.arguments?.jvm, replacements, 'jvm')
  const gameArgs = collectArguments(
    manifest.arguments?.game,
    replacements,
    'game'
  )
  const legacyGameArgs = !gameArgs.length && manifest.minecraftArguments
    ? expandLegacyArguments(manifest.minecraftArguments, replacements)
    : gameArgs
  if (!legacyGameArgs.length) {
    notes.push('版本 JSON 没有任何游戏参数（arguments.game / minecraftArguments 均为空）')
  }

  const log4j = setupLogging(manifest.logging, gameDir)
  const memoryArgs = [`-Xmx${settings.maxMemory}M`, `-Xms${settings.minMemory}M`]
  // User JVM options go through the same classpath sanitiser: `-cp` typed there must not break the
  // layout either.
  const userJvmArgs = String(settings.jvmArgs || '').trim()
    ? sanitizeJvmArguments(splitArgs(settings.jvmArgs), notes)
    : []

  // The `arguments.jvm` list of modern manifests already replaces
  // `${natives_directory}` inside `-Djava.library.path`, but legacy versions (1.0–1.12, which use
  // `minecraftArguments`) never carry that flag. Without it LWJGL fails with
  // `UnsatisfiedLinkError: no lwjgl in java.library.path`, so inject it whenever it is missing.
  // The classpath and main class are emitted only by this function. Anything the manifest's JVM
  // arguments contain about classpath (`-cp`, `-classpath`, `-Djava.class.path`, `${classpath}`)
  // is removed first, otherwise the final command ends up with an empty `-cp` before the real one.
  const cleanJvmArgs = sanitizeJvmArguments(jvmArgs, notes)
  const cleanGameArgs = sanitizeGameArguments(legacyGameArgs, manifest, notes)
  const opts = [...cleanJvmArgs, ...memoryArgs, ...userJvmArgs]
  if (!opts.some((arg) => String(arg).startsWith('-Djava.library.path='))) {
    opts.unshift(`-Djava.library.path=${nativesDirectory}`)
    notes.push(`已注入 -Djava.library.path=${nativesDirectory}`)
  }

  // Strict three-part layout: [JVM options][-cp <classpath> <mainClass>][game arguments].
  const args = [
    ...opts,
    ...(log4j ? [log4j] : []),
    ...(agentDirectory ? [`-javaagent:${agentDirectory}${authServer(account) ? `=${authServer(account)}` : ''}`] : []),
    ...(agentDirectory ? ['-Djava.net.preferIPv4Stack=true'] : []),
    '-cp',
    classpath.join(path.delimiter),
    manifest.mainClass || 'net.minecraft.client.main.Main',
    ...cleanGameArgs
  ]

  if (settings.fullscreen) args.push('--fullscreen')

  return {
    args,
    classpath,
    mainClass: manifest.mainClass || 'net.minecraft.client.main.Main',
    javaPath,
    missing,
    missingLibraries: realMissing,
    clientJarMissing: !fs.existsSync(resolvedJar),
    usable: canSpawn,
    notes,
    command: formatCommand(javaPath, args)
  }
}

/** A display string for the launcher log; secrets are never included. */
export function formatCommand(javaPath, args) {
  const masked = args.map((arg) => (String(arg).startsWith('--accessToken') ? arg : arg))
  const tokenIndex = args.indexOf('--accessToken')
  if (tokenIndex >= 0) masked[tokenIndex + 1] = '**********'
  return `${javaPath} ${masked.join(' ')}`
}

export function prepareSpawning({ gameDir, javaPath, args }) {
  let finalArgs = args
  let classpathJar = ''
  const commandLength = args.reduce((sum, arg) => sum + String(arg).length + 3, javaPath.length)
  if (process.platform === 'win32' && commandLength > WINDOWS_COMMAND_LIMIT) {
    classpathJar = writeClasspathJars(gameDir, extractClasspath(args))
    const index = args.indexOf('-cp')
    if (index >= 0) {
      const entries = String(args[index + 1]).split(path.delimiter)
      finalArgs = [...args]
      finalArgs[index + 1] = [classpathJar, ...entries.slice(0, INLINE_CLASSPATH_ENTRIES)].join(path.delimiter)
    }
  }
  return { args: finalArgs, classpathJar }
}

/**
 * Spawn Minecraft and stream its console output. Resolves only when the process exits.
 *
 * @returns {Promise<{code: number|null, signal: string|null, spawnError: Error|null, spawnMs: number}>}
 */
export function spawnMinecraft({ javaPath, args, gameDir, onOutput, onExit, onSpawn }) {
  return new Promise((resolve) => {
    let child
    const spawnStarted = Date.now()
    try {
      child = spawn(javaPath, args, { cwd: gameDir, windowsHide: false })
    } catch (error) {
      onExit?.(null, error)
      resolve({ code: null, signal: null, spawnError: error, spawnMs: 0, child: null })
      return
    }
    onSpawn?.(child)

    let exited = false
    const finish = (code, signal, spawnError = null) => {
      if (exited) return
      exited = true
      onExit?.(code, spawnError)
      resolve({ code, signal, spawnError, spawnMs: Date.now() - spawnStarted, child })
    }

    bridgeStream(child.stdout, onOutput)
    bridgeStream(child.stderr, onOutput)
    child.once('error', (error) => finish(null, null, error))
    child.once('close', (code, signal) => finish(code, signal))
  })
}

function bridgeStream(stream, onOutput) {
  if (!stream) return
  let buffer = ''
  stream.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) onOutput?.(line)
  })
  stream.on('end', () => {
    if (buffer.trim()) onOutput?.(buffer)
  })
  stream.on('error', () => {
    // The process already reported its own error; ignore stream failures.
  })
}

function buildReplacements({ manifest, id, gameDir, nativesDirectory, runtimeDir, assetsRoot, assetIndexId, account, settings, agentDirectory }) {
  const assetsVersion = manifest.assets || assetIndexId
  const legacyAssets = assetsVersion === 'pre-1.6' || assetsVersion === 'legacy'
  const gameAssetsDir = legacyAssets ? path.join(runtimeDir || gameDir, 'resources') : assetsRoot
  const userType = account?.meta?.type === 'msa' ? 'Xbox' : account?.meta?.type === 'yggdrasil' ? 'Mojang' : (account?.meta?.type || 'legacy')
  // One canonical account shape for every argument that mentions the session:
  //  - `${auth_uuid}`      -> dashed UUID (vanilla 1.1 writes it like this)
  //  - `${auth_access_token}` -> the raw token, never `token:...`
  //  - `${auth_session}`   -> legacy `token:<accessToken>:<uuid>` used by pre-1.6 clients
  const uuid = String(account?.uuid || '')
  const token = String(account?.accessToken || '0')
  return {
    auth_player_name: account?.name || settings.username || 'Player',
    version_name: id,
    game_directory: runtimeDir || gameDir,
    assets_root: gameAssetsDir,
    game_assets: gameAssetsDir,
    assets_index_name: assetIndexId,
    auth_uuid: uuid,
    uuid,
    auth_access_token: token,
    access_token: token,
    auth_session: `token:${token}:${uuid}`,
    auth_xuid: account?.xbox?.xuid || '0',
    clientid: account?.xbox?.clientId || '0',
    user_type: userType,
    user_properties: JSON.stringify(account?.userProperties || {}),
    natives_directory: nativesDirectory,
    launcher_name: 'VoxelLauncher',
    launcher_version: '1.0',
    classpath_separator: path.delimiter,
    resolution_width: String(settings.windowWidth || 1280),
    resolution_height: String(settings.windowHeight || 720),
    library_directory: path.join(gameDir, 'libraries'),
    primary_jar: path.join(gameDir, 'versions', id, `${id}.jar`),
    authlib_injector: agentDirectory || ''
  }
}

function collectArguments(entries, replacements, kind) {
  const result = []
  if (!Array.isArray(entries)) return result
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const value = substitute(entry, replacements)
      if (!isUsableArgument(value)) continue
      result.push(value)
      continue
    }
    if (!entry || typeof entry !== 'object') continue
    if (entry.rules && !isRuleAllowed(entry.rules)) continue
    const value = entry.value
    const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
    const resolved = raw.map((item) => substitute(item, replacements))
    // Values such as `${quickPlayPath}` have no meaning for our launcher and an empty value would
    // leave the game with a dangling flag, so drop the whole entry (flag + value).
    if (resolved.some((item) => !isUsableArgument(item))) continue
    result.push(...resolved)
  }
  return result
}

/**
 * An argument is usable only when it has been fully resolved and is not empty. Unresolved
 * `${placeholder}` values (quick-play, custom resolution with no value, ...) are dropped instead of
 * being passed to the game, which produced `Only one quick play option can be specified`.
 */
function isUsableArgument(value) {
  const text = String(value ?? '')
  if (!text.trim()) return false
  if (text.includes('${')) return false
  return true
}

function expandLegacyArguments(argumentString, replacements) {
  return splitArgs(String(argumentString)).map((arg) => substitute(arg, replacements))
}

/**
 * Strip every classpath-related option from the manifest's JVM arguments. The classpath is always
 * rebuilt from the resolved library list, so a leftover `-cp`/`-Djava.class.path`/`${classpath}`
 * would make Java fail with `-cp requires class path specification`.
 */
function sanitizeJvmArguments(entries, notes) {
  const result = []
  const input = Array.isArray(entries) ? entries : []
  for (let index = 0; index < input.length; index += 1) {
    const value = String(input[index] ?? '')
    if (!value) continue
    if (value === '-cp' || value === '-classpath' || value === '--class-path') {
      // Drop the flag together with the classpath value that follows it.
      if (index + 1 < input.length) index += 1
      notes.push('已从版本 JSON 的 JVM 参数中移除 -cp（由启动器重新生成）')
      continue
    }
    if (/^-cp=/.test(value) || /^-classpath=/.test(value)) {
      notes.push('已从版本 JSON 的 JVM 参数中移除 -cp（由启动器重新生成）')
      continue
    }
    if (value.startsWith('-Djava.class.path')) {
      notes.push('已移除版本 JSON 中的 -Djava.class.path')
      continue
    }
    if (value.includes('${classpath}') || value.includes('${classpath_separator}')) {
      notes.push('已移除引用 ${classpath} 的 JVM 参数')
      continue
    }
    if (value.includes('${')) continue
    result.push(value)
  }
  return result
}

/**
 * Game arguments may carry the main class (Fabric profiles do this) or a bare `-cp`. Strip both so
 * only `[..., '-cp', <classpath>, mainClass, ...gameArgs]` remains.
 */
function sanitizeGameArguments(entries, manifest, notes) {
  const mainClass = String(manifest?.mainClass || '').trim()
  const result = []
  for (const entry of entries) {
    const value = String(entry ?? '')
    if (!value) continue
    if (value === '-cp' || value === '-classpath') {
      notes.push('已从游戏参数中移除多余的 -cp')
      continue
    }
    if (value.startsWith('-Djava.class.path')) continue
    if (mainClass && value === mainClass) {
      notes.push(`已从游戏参数中移除重复的主类 ${mainClass}`)
      continue
    }
    result.push(value)
  }
  return result
}

function substitute(value, replacements) {
  const input = String(value)
  const single = input.replace(/\$\{([^}]+)\}/g, (match, key) => {
    const replacement = replacements[key]
    return replacement === undefined || replacement === null ? match : String(replacement)
  })
  if (!/^\$\{list:/.test(single)) return single
  // ${list:path} expands to every jar in that directory, joined for the current OS.
  const key = single.slice('${list:'.length, -1)
  const directory = replacements[key] || replacements.game_directory
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.jar'))
      .map((name) => path.join(directory, name))
      .join(path.delimiter)
  } catch {
    return ''
  }
}

function isRuleAllowed(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return false
  let allowed = false
  for (const rule of rules) {
    const matches = ruleMatches(rule)
    if (matches === null) continue
    if (matches) allowed = rule.action === 'allow'
    else if (rule.action === 'allow') continue
  }
  return allowed
}

function ruleMatches(rule) {
  if (!rule?.os) return true
  const os = rule.os
  if (os.name && os.name !== OS_NAME) return false
  if (os.arch && os.arch !== OS_ARCH) return false
  if (os.version) {
    const match = String(os.version).match(/^\^?(\d+)/)
    if (match) {
      const required = Number(match[1])
      const actual = Number(process.getSystemVersion?.()?.split('.')[0] || 10)
      if (actual < required) return false
    }
  }
  return true
}

function isLibraryAllowed(library) {
  if (!library || !library.name) return false
  if (!library.rules) return true
  return isRuleAllowed(library.rules)
}

/** Resolve a library to its jar path (and whether it is a native). */
function classifyArtifact(library, gameDir) {
  const nativeKey = library.natives?.[OS_NAME]
  if (nativeKey) {
    const classifiers = library.downloads?.classifiers || {}
    const key = nativeKey.replace('${arch}', OS_ARCH.replace('x64', '64'))
    const artifact = classifiers[key] || classifiers[nativeKey]
    if (artifact?.path) return { path: path.join(gameDir, 'libraries', ...artifact.path.split('/')), native: true }
    const [group, name, version] = library.name.split(':')
    const guessed = path.join(
      gameDir,
      'libraries',
      ...group.split('.'),
      name,
      version,
      `${name}-${version}-${key}.jar`
    )
    return { path: guessed, native: true }
  }

  const artifact = library.downloads?.artifact
  if (artifact?.path) {
    return { path: path.join(gameDir, 'libraries', ...artifact.path.split('/')), native: false }
  }
  const [group, name, version, classifier] = library.name.split(':')
  if (!group || !name || !version) return null
  const fileName = `${name}-${version}${classifier ? `-${classifier}` : ''}.jar`
  return {
    path: path.join(gameDir, 'libraries', ...group.split('.'), name, version, fileName),
    native: false
  }
}

function authServer(account) {
  return account?.serverUrl || account?.meta?.url || ''
}

/** Extract a native jar (stored or deflated entries) into `<gameDir>/bin/<id>`. */
function extractNatives(jarPath, targetDirectory) {
  // Re-extracting the same native jar on every launch is wasted IO (it can reach tens of
  // thousands of small files for heavy modpacks). A marker records the jar's mtime/size so the
  // extraction is skipped unless the jar actually changed.
  const marker = path.join(targetDirectory, `.natives-${path.basename(jarPath)}.done`)
  try {
    const stat = fs.statSync(jarPath)
    try {
      if (fs.readFileSync(marker, 'utf8') === `${stat.mtimeMs}:${stat.size}`) return
    } catch {
      // No marker yet: extract.
    }
    const buffer = fs.readFileSync(jarPath)
    let offset = 0
    while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
      const method = buffer.readUInt16LE(offset + 8)
      const size = buffer.readUInt32LE(offset + 18)
      const nameLength = buffer.readUInt16LE(offset + 26)
      const extraLength = buffer.readUInt16LE(offset + 28)
      const nameStart = offset + 30
      const name = buffer.toString('utf8', nameStart, nameStart + nameLength)
      const dataStart = nameStart + nameLength + extraLength
      const data = buffer.subarray(dataStart, dataStart + size)
      offset = dataStart + size
      if (!name || name.endsWith('/') || name.startsWith('META-INF/')) continue
      const target = path.join(targetDirectory, path.basename(name))
      fs.writeFileSync(target, method === 8 ? zlib.inflateRawSync(data) : data)
    }
    fs.writeFileSync(marker, `${stat.mtimeMs}:${stat.size}`)
  } catch {
    // Extraction failure is not fatal here: Java reports missing natives at launch.
  }
}

function setupLogging(logging, gameDir) {
  if (!logging?.client?.file?.id) return ''
  const folder = path.join(gameDir, 'assets', 'log_configs')
  const file = path.join(folder, logging.client.file.id)
  try {
    fs.mkdirSync(folder, { recursive: true })
    if (!fs.existsSync(file) && logging.client.file.url) {
      // Fetched lazily by the caller through eml-lib's downloader when missing.
      return ''
    }
    return `-Dlog4j.configurationFile=${file}`
  } catch {
    return ''
  }
}

export function extractClasspath(args) {
  const index = args.indexOf('-cp')
  if (index < 0) return []
  return String(args[index + 1] || '').split(path.delimiter).filter(Boolean)
}

/** Classpath jar for command lines that exceed the Windows limit (Java 8 supports Class-Path). */
export function writeClasspathJars(gameDir, entries) {
  const directory = path.join(gameDir, 'libraries')
  fs.mkdirSync(directory, { recursive: true })
  const chunks = []
  for (let index = 0; index < entries.length; index += INLINE_CLASSPATH_ENTRIES * 2) {
    chunks.push(entries.slice(index, index + INLINE_CLASSPATH_ENTRIES * 2))
  }
  return chunks
    .map((chunk, chunkIndex) => {
      const file = path.join(
        directory,
        chunkIndex === 0 ? CLASSPATH_JAR : CLASSPATH_JAR.replace('.jar', `-${chunkIndex}.jar`)
      )
      fs.writeFileSync(file, createClasspathJar(chunk))
      return file
    })
    .join(path.delimiter)
}

function createClasspathJar(urls) {
  const manifest = Buffer.from(
    `Manifest-Version: 1.0\r\nClass-Path: ${urls.map(toFileUrl).join(' ')}\r\n\r\n`,
    'utf8'
  )
  const name = Buffer.from('META-INF/MANIFEST.MF', 'utf8')
  const crc = crc32(manifest)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(10, 4)
  local.writeUInt32LE(crc >>> 0, 14)
  local.writeUInt32LE(manifest.length, 18)
  local.writeUInt32LE(manifest.length, 22)
  local.writeUInt16LE(name.length, 26)
  const data = Buffer.concat([local, name, manifest])
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(10, 6)
  central.writeUInt32LE(crc >>> 0, 16)
  central.writeUInt32LE(manifest.length, 20)
  central.writeUInt32LE(manifest.length, 24)
  central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(data.length, 16)
  return Buffer.concat([data, central, name, end])
}

function toFileUrl(file) {
  return `file:${file.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`
}

function crc32(buffer) {
  const table = crc32.table || (crc32.table = buildCrcTable())
  let crc = 0xffffffff
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function buildCrcTable() {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
}

export function splitArgs(value) {
  const matches = String(value || '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  return matches.map((part) => part.replace(/^["']|["']$/g, '')).filter(Boolean)
}
