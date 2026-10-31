import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { patchRemoteProbes } from './eml-probe.js'
import { patchEmlLoader } from './eml-loader-patch.js'
import { patchFileManagerTolerantWrites, patchFileManagerSkipVerify, setFileManagerUtils } from './eml-filemanager-patch.js'
import { configureDownloader, cleanIncompleteRuntime, markRuntimeComplete, setJavaProgressHandler } from './eml-downloader-patch.js'
import { pointAgentToDirectory } from './game-cache.js'

/**
 * eml-lib 2.7.4 has two launch-blocking behaviours for local instances:
 *
 * 1. `Launcher.setMinecraft()` and `loader.updateMinecraftConfig()` drop
 *    `minecraft.loader.manifestUrl` for vanilla entries, so `manifests.getMinecraftManifestUrl()`
 *    looks the *instance* id (e.g. `1.12.2-Forge_14.23.5`) up in Mojang's manifest and fails with
 *    "not found in manifest"; the local manifest served by the launcher was never read.
 * 2. `utils.getRemoteFileSize()` / `getRemoteFileSha1()` issue unbounded HEAD requests, which can
 *    hang for over a minute when Maven is unreachable.
 *
 * Both live on module-level singletons (`utils`, `loader`, `manifests`) that `Launcher.launch()`
 * imports directly, so they have to be patched on those exact module instances. They are reached by
 * absolute file URL, which resolves to the same modules eml-lib already loaded. `node_modules` is
 * never modified.
 */
let installed = null
const argumentManagers = []

export function installEmlPatches(projectRoot) {
  if (!installed) {
    installed = install(projectRoot).catch((error) => {
      console.error('EML runtime patch failed:', error)
      return null
    })
  }
  return installed
}

/**
 * Patch a freshly constructed `ArgumentManager` instance (or its prototype). eml-lib builds the
 * manager inside `launch()`, so there is no module-level singleton to patch; the prototype is
 * patched once and per-instance patching stays available for the captured manager.
 */
export function patchArgumentManager(argumentManager, config = {}) {
  if (!argumentManager || argumentManager.__voxelPatched) return
  Object.defineProperty(argumentManager, '__voxelPatched', { value: true })
  const original = argumentManager.getArgs
  if (typeof original !== 'function') return

  argumentManager.getArgs = function getArgsWithProfileProperties(libraries, customAuth) {
    const args = original.call(this, libraries, customAuth)
    return ensureUserProperties(args, config)
  }
}

function patchArgumentManagerPrototype(ArgumentManager) {
  const prototype = ArgumentManager?.prototype
  if (!prototype || prototype.__voxelPatched || typeof prototype.getArgs !== 'function') return
  const original = prototype.getArgs
  Object.defineProperty(prototype, '__voxelPatched', { value: true })
  prototype.getArgs = function getArgsWithProfileProperties(libraries, customAuth) {
    const classpath = typeof original.getClasspath === 'function' ? original.getClasspath(libraries) : ''
    const entries = String(classpath || '').split(path.delimiter).filter(Boolean)
    // Every launch reports the exact classpath it is about to spawn, so missing libraries are
    // visible in 运行日志 without opening any file.
    globalThis.__voxelCommandLineReporter?.({
      javaPath: this?.config?.java?.absolutePath || '',
      javaArgs: Array.isArray(this?.config?.java?.args) ? this.config.java.args : [],
      entries,
      injector: Boolean(customAuth?.injectorPath)
    })
    const args = original.call(this, libraries, customAuth)
    return ensureUserProperties(args, this?.config)
  }
}

/**
 * Minecraft 1.7.x–1.12.x require `--userProperties <json>`. eml-lib renders `${user_properties}`
 * from the account's `userProperties`, which our offline/Yggdrasil sessions leave empty, so the
 * game exited with `MissingRequiredOptionException: Missing required option(s) ['userProperties']`.
 */
function ensureUserProperties(args, config) {
  const value = JSON.stringify(config?.account?.userProperties || {})
  const index = args.indexOf('--userProperties')
  if (index >= 0) {
    const next = [...args]
    const current = next[index + 1]
    if (typeof current !== 'string' || !current.trim() || current.startsWith('--')) {
      if (current?.startsWith('--')) next.splice(index + 1, 0, value)
      else next[index + 1] = value
    }
    return next
  }
  if (!args.some((arg) => arg === '--username')) return args
  return [...args, '--userProperties', value]
}

async function install(projectRoot) {
  const emlRoot = path.join(projectRoot, 'node_modules', 'eml-lib')
  const utilsModule = await import(
    pathToFileURL(path.join(emlRoot, 'lib', 'utils', 'utils.js')).href
  )
  const loaderModule = await import(
    pathToFileURL(path.join(emlRoot, 'lib', 'utils', 'loader.js')).href
  )
  const manifestsModule = await import(
    pathToFileURL(path.join(emlRoot, 'lib', 'utils', 'manifests.js')).href
  )
  const launcherModule = await import(
    pathToFileURL(path.join(emlRoot, 'lib', 'launcher', 'launcher.js')).href
  )

  patchRemoteProbes(utilsModule.default)
  patchEmlLoader(loaderModule.default, utilsModule.default, manifestsModule.default)
  patchCommandLine(launcherModule.default, projectRoot)
  const fileManagerModule = await import(
    pathToFileURL(path.join(emlRoot, 'lib', 'launcher', 'filemanager.js')).href
  ).catch(() => null)
  if (fileManagerModule?.default) {
    setFileManagerUtils(utilsModule.default)
    patchFileManagerTolerantWrites(fileManagerModule.default, {
      onWarning: (message) => globalThis.__voxelLaunchWarning?.(message)
    })
    if (globalThis.__voxelSkipVerify !== false) patchFileManagerSkipVerify(fileManagerModule.default)
  }
  const downloaderModule = await import(
    pathToFileURL(path.join(emlRoot, 'lib', 'utils', 'downloader.js')).href
  ).catch(() => null)
  if (downloaderModule?.default) {
    configureDownloader(downloaderModule.default, {
      onWarning: (message) => globalThis.__voxelLaunchWarning?.(message),
      onTrace: (message) => globalThis.__voxelLaunchTrace?.(message)
    })
  }  const argumentManagerModule = await import(
    pathToFileURL(path.join(emlRoot, 'lib', 'launcher', 'argumentmanager.js')).href
  ).catch(() => null)
  const ArgumentManager = argumentManagerModule?.default
  if (ArgumentManager) {
    argumentManagers.push(ArgumentManager)
    patchArgumentManagerPrototype(ArgumentManager)
  }
  return {
    utils: utilsModule.default,
    loader: loaderModule.default,
    manifests: manifestsModule.default,
    Launcher: launcherModule.default,
    ArgumentManager
  }
}

// Windows CreateProcess rejects command lines longer than 32767 characters. A PCL library folder
// shared by many instances produced a ~115k character classpath, and `spawn` then failed with
// ENAMETOOLONG inside eml-lib's Launcher.run().
//
// A Java argument file (`@file`) is NOT a solution here: LaunchWrapper-era instances run on Java 8,
// and Java 8 cannot read argument files (verified: `java @file -version` → "Could not find or load
// main class @file"). Instead rewrite the single `-cp` argument into a classpath jar manifest
// (`Class-Path:`), which Java 8 supports and which keeps the command line short.
const WINDOWS_COMMAND_LIMIT = 30_000
const CLASSPATH_JAR = 'voxel-classpath.jar'
const CLASSPATH_JAR_ENTRIES = 200

function patchCommandLine(LauncherClass, projectRoot) {
  if (!LauncherClass?.prototype || LauncherClass.prototype.__voxelCmdPatched) return
  const originalRun = LauncherClass.prototype.run
  if (typeof originalRun !== 'function') return
  Object.defineProperty(LauncherClass.prototype, '__voxelCmdPatched', { value: true })

  /**
   * Isolated instances keep version data outside the game directory: eml-lib resolves `root` to the
   * launcher profile folder, whose `versions/<id>/` write failed with EPERM. Point that copy at
   * `<gameDir>/cache/versions` (the launcher sets `config.versionsCacheDir` per launch), and move the
   * authlib-injector `-javaagent` onto an unpacked directory because eml-lib ships it as a zip that
   * Java cannot load directly.
   */
  const redirectIsolatedCache = (launcher) => {
    const config = launcher?.config
    const cacheDir = config?.versionsCacheDir
    if (!cacheDir) return true
    if (config.root === cacheDir) return true
    if (!(config.storage === 'isolated' || config.storageMode === 'isolated')) return true
    config.root = cacheDir
    return true
  }

  LauncherClass.prototype.run = async function runWithClasspathJar(javaPath, args) {
    redirectIsolatedCache(this)
    // Own-launch mode: eml-lib is only allowed to download. Its `Launcher.launch()` calls `run()`
    // as its final step, and that used to spawn a *second* Minecraft process (looking like a
    // duplicate launch with different arguments). Downloading stops here.
    if (this.config?.downloadOnly) {
      if (typeof this.emit === 'function') {
        this.emit('launch_debug', 'download-only 模式：跳过 eml-lib 的进程启动，由启动器自己拉起游戏')
      }
      return
    }
    const cacheDir = this.config?.versionsCacheDir
    if (cacheDir) {
      const injected = pointAgentToDirectory(args, this.config.agentDirectory)
      if (injected.args !== args) {
        args = injected.args
        if (typeof this.emit === 'function') this.emit('launch_debug', injected.detail)
      }
    }
    const commandLength = args.reduce((sum, arg) => sum + String(arg).length + 3, javaPath.length)
    const emit = (message) => {
      if (typeof this.emit === 'function') this.emit('launch_debug', message)
    }
    const root = this.config?.root

    if (process.platform !== 'win32' || commandLength < WINDOWS_COMMAND_LIMIT || !root) {
      reportFinalCommand(emit, javaPath, args)
      return originalRun.call(this, javaPath, args)
    }

    const entries = extractClasspath(args)
    if (!entries.length) {
      reportFinalCommand(emit, javaPath, args)
      return originalRun.call(this, javaPath, args)
    }

    try {
      const jarPath = writeClasspathJars(root, entries)
      const cpIndex = args.indexOf('-cp')
      const shortened = [...args]
      const inlineCount = Math.min(CLASSPATH_JAR_ENTRIES, entries.length)
      shortened[cpIndex + 1] = [jarPath, ...entries.slice(0, inlineCount)].join(path.delimiter)
      const newLength = shortened.reduce((sum, arg) => sum + String(arg).length + 3, javaPath.length)
      emit(
        `命令行长度 ${commandLength} 字符，已改用 classpath 清单（${jarPath}）承载其余 ${entries.length - inlineCount} 个条目，新长度 ${newLength} 字符`
      )
      reportFinalCommand(emit, javaPath, shortened, args, jarPath)
      return originalRun.call(this, javaPath, shortened)
    } catch (error) {
      emit(`classpath 清单写入失败（${error.message}），按原命令启动`)
      reportFinalCommand(emit, javaPath, args)
      return originalRun.call(this, javaPath, args)
    }
  }
}

/**
 * Write one or more classpath jars whose `Class-Path` manifest attribute lists the absolute paths
 * Java 8 otherwise cannot receive on the command line. Java 8 expands `Class-Path` at startup, so
 * every library still ends up on the real classpath.
 */
function writeClasspathJars(gameDir, entries) {
  const chunks = []
  for (let index = 0; index < entries.length; index += CLASSPATH_JAR_ENTRIES * 2) {
    chunks.push(entries.slice(index, index + CLASSPATH_JAR_ENTRIES * 2))
  }
  const directory = path.join(gameDir, 'libraries')
  fs.mkdirSync(directory, { recursive: true })
  const jars = []
  chunks.forEach((chunk, chunkIndex) => {
    const file = path.join(
      directory,
      chunkIndex === 0 ? CLASSPATH_JAR : CLASSPATH_JAR.replace('.jar', `-${chunkIndex}.jar`)
    )
    fs.writeFileSync(file, createClasspathJar(chunk))
    jars.push(file)
  })
  return jars.join(path.delimiter)
}

function createClasspathJar(urls) {
  const manifest = Buffer.from(
    `Manifest-Version: 1.0\r\nClass-Path: ${urls.map(toFileUrl).join(' ')}\r\n\r\n`,
    'utf8'
  )
  const name = Buffer.from('META-INF/MANIFEST.MF', 'utf8')
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0) // local file header
  header.writeUInt16LE(10, 4) // version needed
  header.writeUInt16LE(0, 6) // flags
  header.writeUInt16LE(0, 8) // stored
  header.writeUInt32LE(0, 14) // crc32 for a 0-byte... replaced below
  header.writeUInt32LE(0, 18) // size
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)

  const localA = Buffer.alloc(30)
  localA.writeUInt32LE(0x04034b50, 0)
  localA.writeUInt16LE(10, 4)
  localA.writeUInt16LE(0, 6)
  localA.writeUInt16LE(0, 8)
  localA.writeUInt32LE(crc32(manifest) >>> 0, 14)
  localA.writeUInt32LE(manifest.length, 18)
  localA.writeUInt32LE(manifest.length, 22)
  localA.writeUInt16LE(name.length, 26)
  localA.writeUInt16LE(0, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(10, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(crc32(manifest) >>> 0, 16)
  central.writeUInt32LE(manifest.length, 20)
  central.writeUInt32LE(manifest.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 42) // relative offset of local header

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  const centralOffset = localA.length + name.length + manifest.length
  end.writeUInt32LE(centralOffset, 16)

  void header
  return Buffer.concat([localA, name, manifest, central, name, end])
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
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

function reportFinalCommand(emit, javaPath, spawnedArgs, fullArgs = spawnedArgs, classpathJar = '') {
  try {
    const entries = extractClasspath(fullArgs)
    emit(`最终启动命令：${javaPath} ${spawnedArgs.join(' ')}`)
    if (classpathJar) emit(`classpath 清单：${classpathJar}`)
    emit(`classpath：共 ${entries.length} 个条目${classpathJar ? '（全部条目已写入清单）' : ''}`)
    entries.forEach((entry, index) => emit(`  cp[${index + 1}] ${entry}`))
    const interesting = entries.filter((entry) =>
      /launchwrapper|lzma|asm-all|guava|minecraftforge[\\/]forge/i.test(entry)
    )
    emit(`关键运行库检查：${interesting.length ? interesting.length : 0} 个命中`)
    interesting.forEach((entry) => emit(`  KEY ${entry}`))
    const agent = fullArgs.find((arg) => String(arg).startsWith('-javaagent:'))
    if (agent) emit(`authlib-injector 参数：${agent}`)
  } catch {
    // Logging must never break a launch.
  }
}

function extractClasspath(args) {
  const index = args.indexOf('-cp')
  const value = index >= 0 ? args[index + 1] : args.find((arg) => String(arg).startsWith('-cp'))
  const classpath = value ? String(value).replace(/^-cp/, '') : ''
  return classpath.split(path.delimiter).filter(Boolean)
}

function writeArgumentFile(gameDir, args) {
  const file = path.join(gameDir, 'logs', 'voxel-args.txt')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, args.map(quoteArgument).join('\n'), 'utf8')
    return file
  } catch {
    const fallback = path.join(os.tmpdir(), `voxel-args-${Date.now()}.txt`)
    fs.writeFileSync(fallback, args.map(quoteArgument).join('\n'), 'utf8')
    return fallback
  }
}

function quoteArgument(value) {
  const text = String(value)
  if (!/[\s"'\\]/.test(text)) return text
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Keep only the first entry of every library directory (plus the instance jar). Minecraft still
 * loads its own libraries; extra Minecraft versions bundled into the same `libraries` folder are
 * dropped from the classpath, which is what made the command line explode.
 */
function compactClasspath(args) {
  const index = args.indexOf('-cp')
  if (index < 0) return args
  const seen = new Set()
  const kept = []
  for (const entry of String(args[index + 1]).split(path.delimiter)) {
    const directory = path.dirname(entry)
    const parts = directory.split(/[\\/]/)
    const libIndex = parts.lastIndexOf('libraries')
    const key = libIndex >= 0 ? parts.slice(0, libIndex + 2).join('/').toLowerCase() : directory.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(entry)
  }
  const next = [...args]
  next[index + 1] = kept.join(path.delimiter)
  return next
}
