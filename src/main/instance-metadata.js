import fs from 'node:fs'
import path from 'node:path'

const INSTANCE_FILES = ['voxel-instance.json', 'version.json']
const LOADER_KEYS = ['VersionNeoForge', 'VersionForge', 'VersionFabric', 'VersionQuilt']

/**
 * Reads instance metadata without using the folder name. PCL / other launchers can rename a
 * version folder arbitrarily; the base Minecraft version must come from metadata, never from the
 * folder title.
 */
export function readInstanceMetadata(versionDir, id, fallbackJson = {}) {
  const instanceData = {}
  let hasInstanceFile = false

  for (const fileName of [...INSTANCE_FILES, `${id}_instance.json`]) {
    const filePath = path.join(versionDir, fileName)
    const data = readJson(filePath)
    if (!data) continue
    hasInstanceFile = true
    Object.assign(instanceData, data)
  }

  const setup = readPclSetup(versionDir)
  const json = fallbackJson || {}
  const detectedLoader = detectLoader(json)
  const detectedLoaderVersion = detectLoaderVersion(json, detectedLoader)
  const setupLoader = LOADER_KEYS.find((key) => setup[key])
  const loader = normalizeLoader(instanceData.loader || mapSetupLoader(setupLoader) || detectedLoader)
  const loaderVersion =
    instanceData.loaderVersion ||
    (setupLoader ? setup[setupLoader] : '') ||
    detectedLoaderVersion ||
    ''

  const baseVersion =
    instanceData.baseVersion ||
    instanceData.minecraftVersion ||
    instanceData.mcVersion ||
    instanceData.vanillaVersion ||
    instanceData.inheritsFrom ||
    json.baseVersion ||
    json.minecraftVersion ||
    json.inheritsFrom ||
    setup.VersionVanillaName ||
    ''

  return {
    baseVersion: baseVersion ? String(baseVersion).trim() : '',
    loader,
    loaderVersion: loaderVersion ? String(loaderVersion).trim() : '',
    source: hasInstanceFile ? 'instance' : setupLoader || setup.VersionVanillaName ? 'pcl' : 'local',
    hasInstanceFile,
    pclSetup: setup,
    baseError: baseVersion ? '' : '无法解析本地实例的原版版本'
  }
}

export function readPclSetup(versionDir) {
  const filePath = path.join(versionDir, 'PCL', 'Setup.ini')
  if (!fs.existsSync(filePath)) return {}
  const values = {}
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const index = line.indexOf(':')
      if (index <= 0) continue
      const key = line.slice(0, index).trim()
      const value = line.slice(index + 1).trim()
      if (key) values[key] = value
    }
  } catch {
    // Metadata is optional.
  }
  return values
}

export function detectLoader(json) {
  const mainClass = String(json?.mainClass || '').toLowerCase()
  const libraries = Array.isArray(json?.libraries)
    ? json.libraries.map((library) => String(library?.name || '')).join(' ').toLowerCase()
    : ''

  if (mainClass.includes('fabric') || libraries.includes('fabric-loader')) return 'fabric'
  if (mainClass.includes('quilt') || libraries.includes('quilt-loader')) return 'quilt'
  if (mainClass.includes('neoforge') || libraries.includes('neoforge')) return 'neoforge'
  if (
    mainClass.includes('launchwrapper') ||
    libraries.includes('net.minecraftforge') ||
    libraries.includes('forge')
  ) {
    return 'forge'
  }
  return 'vanilla'
}

export function detectLoaderVersion(json, loader) {
  const pattern =
    loader === 'fabric'
      ? /net\.fabricmc:fabric-loader:([^:\s]+)/i
      : loader === 'quilt'
        ? /org\.quiltmc:quilt-loader:([^:\s]+)/i
        : loader === 'neoforge'
          ? /net\.neoforged:neoforge:([^:\s]+)/i
          : loader === 'forge'
            ? /net\.minecraftforge:forge:([^:\s]+)/i
            : null
  if (!pattern) return ''
  for (const library of json?.libraries || []) {
    const match = String(library?.name || '').match(pattern)
    if (match) return match[1]
  }
  return ''
}

function mapSetupLoader(key) {
  if (key === 'VersionNeoForge') return 'neoforge'
  if (key === 'VersionForge') return 'forge'
  if (key === 'VersionFabric') return 'fabric'
  if (key === 'VersionQuilt') return 'quilt'
  return ''
}

function normalizeLoader(value) {
  const loader = String(value || '').toLowerCase()
  return ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(loader) ? loader : 'vanilla'
}

function readJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}
