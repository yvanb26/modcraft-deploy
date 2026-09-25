const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

let manifestCache = null;

async function fetchVersionManifest() {
  if (manifestCache) return manifestCache;
  const res = await fetch(VERSION_MANIFEST_URL);
  if (!res.ok) throw new Error(`Impossible de recuperer le manifest des versions Minecraft (${res.status}).`);
  manifestCache = await res.json();
  return manifestCache;
}

async function fetchVanillaVersionJson(mcVersion) {
  const manifest = await fetchVersionManifest();
  const entry = manifest.versions.find((v) => v.id === mcVersion);
  if (!entry) {
    throw new Error(`Version Minecraft inconnue: ${mcVersion}`);
  }
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`Impossible de recuperer le JSON de la version ${mcVersion} (${res.status}).`);
  return res.json();
}

module.exports = { fetchVersionManifest, fetchVanillaVersionJson };
