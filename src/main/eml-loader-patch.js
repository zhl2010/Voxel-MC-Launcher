// This module loads inside eml-lib (see eml-runtime.js), so bare specifiers resolve against
// eml-lib's own folder and share the same class instances.

/**
 * Make eml-lib honour `minecraft.loader.manifestUrl` for vanilla entries.
 *
 * eml-lib 2.7.4 resolves the Minecraft manifest with:
 *
 * - `manifests.getMinecraftManifestUrl()`: returns `loader.manifestUrl` only when the loader type
 *   is `vanilla`, otherwise it looks the *game* version up in Mojang's manifest;
 * - `loader.updateMinecraftConfig()` (called by `Launcher.launch()`): returns only
 *   `{ loader, version }` for a vanilla loader, dropping `manifestUrl`.
 *
 * `Launcher.setMinecraft()` also drops `manifestUrl` for vanilla entries. As a result, a local
 * instance id such as `1.12.2-Forge_14.23.5` was always looked up in Mojang's manifest and failed
 * with "not found in manifest", and the loader JSON fetched from `manifestUrl` was never used.
 *
 * The patch keeps every other behaviour intact:
 *
 * 1. `updateMinecraftConfig()` keeps `manifestUrl` (vanilla only);
 * 2. `getMinecraftManifestUrl()` returns `manifestUrl` for any loader type when it is present, and
 *    otherwise falls back to the original Mojang lookup;
 * 3. `getLoaderManifests()` fetches `manifestUrl` for any loader type. For a local instance the
 *    JSON already contains the vanilla + loader libraries, so the manifest is returned directly
 *    instead of trying to open a Forge/NeoForge installer that does not exist locally.
 */
export function patchEmlLoader(loader, utils, manifests) {
  if (!loader || loader.__voxelPatched) return loader

  const originalUpdate = loader.updateMinecraftConfig.bind(loader)
  const originalGetManifestUrl = manifests.getMinecraftManifestUrl.bind(manifests)
  const originalGetLoaderManifests = manifests.getLoaderManifests.bind(manifests)

  loader.updateMinecraftConfig = async (config) => {
    const updated = await originalUpdate(config)
    const manifestUrl = config.minecraft?.loader?.manifestUrl
    if (updated?.loader?.loader === 'vanilla' && manifestUrl) {
      updated.loader.manifestUrl = manifestUrl
    }
    return updated
  }

  manifests.getMinecraftManifestUrl = async (config, ...rest) => {
    if (config?.minecraft?.loader?.manifestUrl) return config.minecraft.loader.manifestUrl
    return originalGetManifestUrl(config, ...rest)
  }

  manifests.getLoaderManifests = async (config, installProfile, installer) => {
    const manifestUrl = config?.minecraft?.loader?.manifestUrl
    if (
      manifestUrl &&
      (config.minecraft.loader.loader === 'forge' || config.minecraft.loader.loader === 'neoforge')
    ) {
      // A local instance JSON is self-contained: it already lists the vanilla and loader
      // libraries, so no installer/install_profile is needed.
      if (!installer || !installProfile) return fetchManifestJson(manifestUrl)
    }
    return originalGetLoaderManifests(config, installProfile, installer)
  }

  Object.defineProperty(loader, '__voxelPatched', { value: true, enumerable: false })
  return loader
}

async function fetchManifestJson(url) {
  const request = await fetch(url)
  if (!request.ok) {
    throw new Error(`Failed to fetch loader manifest: HTTP ${request.status}`)
  }
  const data = await request.json()
  // Mirror eml-lib's own guard so a malformed loader manifest fails loudly.
  if (!data || typeof data !== 'object') throw new Error('Loader manifest is invalid')
  return data
}
