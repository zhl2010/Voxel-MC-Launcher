import fs from 'node:fs'
import path from 'node:path'

// Version-specific compatibility rules applied to a local instance before it is handed to eml-lib.
// Each rule only fires when the jar it needs already exists in `<gameDir>/libraries`, so a launcher
// never downloads something silently: it either fixes the launch or reports what is missing.

const GUAVA_PREFERENCE = [
  'com.google.guava:guava:17.0',
  'com.google.guava:guava:21.0',
  'com.google.guava:guava:25.1-jre',
  'com.google.guava:guava:31.1-jre',
  'com.google.guava:guava:33.3.1-jre'
]

/**
 * Forge 1.7.10 ships `serverreq: true` copies of guava 17.0, launchwrapper, lzma, asm-all and the
 * Forge universal jar without `downloads`. eml-lib drops `serverreq`-only entries that have no
 * `downloads` (and anything filtered out of the download list), so Forge used to crash before the
 * game window appeared: `NoSuchMethodError: CharSource.readLines` (guava 15.0) followed by
 * `ClassNotFoundException: net.minecraft.launchwrapper.Launch`.
 *
 * @returns {{ changed: boolean, notes: string[], added: string[] }}
 */
export function applyInstanceCompatibility(json, gameDir, { javaMajor } = {}) {
  const notes = []
  const added = []
  let changed = false
  if (!json || !Array.isArray(json.libraries)) return { changed, notes, added }

  const librariesRoot = path.join(gameDir, 'libraries')
  const describe = (library) => {
    const [group, artifact, version, classifier] = String(library.name).split(':')
    const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`
    const relativePath = path.join(...group.split('.'), artifact, version, fileName)
    return { fileName, relativePath, absolutePath: path.join(librariesRoot, relativePath) }
  }

  const guavaEntries = json.libraries.filter((library) => /^com\.google\.guava:guava:/.test(library.name))
  const modernNames = new Set(
    guavaEntries.filter((library) => isModernGuava(library.name)).map((library) => library.name)
  )
  const newestModern = pickNewest([...modernNames])
  // Forge 1.7.10 ships guava 17.0 as a `serverreq` library that shadows the official 15.0 entry.
  const cutGuava = newestModern
    ? guavaEntries.filter((library) => library.name !== newestModern)
    : guavaEntries

  if (!newestModern && cutGuava.length) {
    // Forge 1.7.10 / LiteLoader need guava's LineProcessor overloads (added in 17.0); guava 15.0
    // and older crash with NoSuchMethodError. Replace every older copy with the first one that
    // exists locally, without adding a duplicate guava to the classpath.
    let replacement = null
    for (const candidate of GUAVA_PREFERENCE) {
      const library = findOrCreateLibrary(json, candidate)
      const info = describe(library)
      if (fs.existsSync(info.absolutePath)) {
        replacement = { library, info, coordinate: candidate }
        break
      }
    }
    if (replacement) {
      json.libraries = json.libraries.filter((library) => !cutGuava.includes(library))
      if (!json.libraries.includes(replacement.library)) json.libraries.push(replacement.library)
      decorateWithLocalArtifact(replacement.library, replacement.info)
      notes.push(`guava 已从 ${cutGuava.map((l) => l.name.split(':')[2]).join('/')} 升级为 ${replacement.coordinate.split(':')[2]}`)
      added.push(`${replacement.coordinate} -> ${replacement.info.relativePath}`)
      changed = true
    } else {
      notes.push('缺少 guava 17.0（Forge 1.7.10 必需），请先在 PCL 里补全该版本')
    }
  } else if (newestModern && cutGuava.length) {
    // Keep only the newest guava: eml-lib drops one of two copies with the same directory, and
    // Forge 1.7.10 must not end up with the 15.0 jar.
    json.libraries = json.libraries.filter((library) => !cutGuava.includes(library))
    notes.push(`guava 已统一为 ${newestModern.split(':')[2]}（移除 ${cutGuava.map((l) => l.name.split(':')[2]).join('/')}）`)
    changed = true
  }

  // launchwrapper / lzma / asm-all / Forge universal: PCL stores them locally (often without
  // `downloads`) but no Maven URL, so eml-lib cannot resolve them.
  for (const library of json.libraries) {
    if (!library || typeof library.name !== 'string') continue
    if (!needsLocalArtifact(library)) continue
    const info = describe(library)
    if (!fs.existsSync(info.absolutePath)) {
      notes.push(`本地缺少 ${library.name}`)
      continue
    }
    const before = Boolean(library.downloads?.artifact?.path)
    decorateWithLocalArtifact(library, info)
    if (!before) added.push(library.name)
    changed = true
  }

  if (javaMajor && Number(javaMajor) > 8 && /launchwrapper/i.test(String(json.mainClass || ''))) {
    notes.push(`当前 Java ${javaMajor} 无法运行 LaunchWrapper 版本，请将 Java 切换到 8`)
  }

  return { changed, notes, added }
}

function isModernGuava(coordinate) {
  return /^com\.google\.guava:guava:(17|18|19|2[0-9]|3[0-9])[.:]/.test(coordinate)
}

function pickNewest(coordinates) {
  const parse = (coordinate) =>
    coordinate
      .split(':')[2]
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10) || 0)
  return [...coordinates].sort((a, b) => {
    const left = parse(a)
    const right = parse(b)
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const delta = (left[i] || 0) - (right[i] || 0)
      if (delta !== 0) return delta
    }
    return 0
  }).at(-1)
}

function needsLocalArtifact(library) {
  if (library.natives || library.rules) return false
  if (library.downloads?.artifact?.path) return false
  const name = library.name
  if (/^net\.minecraft:launchwrapper:/.test(name)) return true
  if (/^lzma:lzma:/.test(name)) return true
  if (/^org\.ow2\.asm:asm-all:/.test(name)) return true
  if (/^net\.minecraftforge:forge:/.test(name)) return true
  if (/^net\.minecraftforge:fml:/.test(name)) return true
  return Boolean(library.serverreq || library.clientreq)
}

function decorateWithLocalArtifact(library, info) {
  library.downloads = {
    ...(library.downloads || {}),
    artifact: {
      path: info.relativePath.replaceAll('\\', '/'),
      size: fs.statSync(info.absolutePath).size,
      sha1: '',
      url: ''
    }
  }
}

function findOrCreateLibrary(json, coordinate) {
  const existing = json.libraries.find((library) => library.name === coordinate)
  if (existing) return existing
  // Reserve the slot first; the caller filters out the older guava copies afterwards.
  const created = { name: coordinate }
  json.libraries.push(created)
  return created
}
