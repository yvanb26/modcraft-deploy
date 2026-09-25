// Liste les versions Minecraft et versions de loader disponibles, pour la
// page "installation libre" (choisir une version + un loader, comme le
// TLauncher) : independant des serveurs/modpacks fixes par l'operateur.
const { fetchVersionManifest } = require('./mojangVersions');

const FORGE_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const NEOFORGE_METADATA_URL = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';

// Caches en memoire (duree de vie du process) : ces metadonnees ne changent
// pas assez souvent pour justifier de les retelecharger a chaque ouverture
// du selecteur de version (meme principe que le cache du manifest Mojang).
let forgeVersionsCache = null;
let neoforgeVersionsCache = null;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchXmlVersionList(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Impossible de recuperer ${url} (${res.status}).`);
  const xml = await res.text();
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
}

// Les versions anterieures a 1.6 (alpha/beta comprises) sont masquees de la
// page "installation libre" : systeme d'assets/dossier de jeu different
// (bucket "pre-1.6"), source de plantages difficiles a garantir sur toutes
// les machines : on prefere ne pas les proposer plutot que de mal les
// supporter. On compare par date de sortie reelle (pas par numero de
// version, peu fiable a trier tel quel) par rapport a la sortie de 1.6.
const OLDEST_VISIBLE_VERSION_ID = '1.6';

async function listMinecraftVersions() {
  const manifest = await fetchVersionManifest();
  const cutoff = manifest.versions.find((v) => v.id === OLDEST_VISIBLE_VERSION_ID);
  const cutoffTime = cutoff ? new Date(cutoff.releaseTime).getTime() : 0;
  return manifest.versions
    .filter((v) => new Date(v.releaseTime).getTime() >= cutoffTime)
    .map((v) => ({ id: v.id, type: v.type }));
}

// Forge encode la version MC dans chaque entree de son maven-metadata.xml :
// "<mc>-<build>", et pour de vieilles versions (dont la plupart des builds
// 1.7.10) avec en plus un suffixe de branche qui repete la version MC
// ("<mc>-<build>-<mc>"). On isole juste le numero de build ; `prepareForge`
// (installerLoader.js) sait deja retester les deux formes au moment de
// l'installation, pas besoin de les distinguer ici.
async function listForgeVersions(mcVersion) {
  if (!forgeVersionsCache) forgeVersionsCache = await fetchXmlVersionList(FORGE_METADATA_URL);

  const prefix = `${mcVersion}-`;
  const branchSuffix = new RegExp(`-${escapeRegExp(mcVersion)}$`);
  const builds = forgeVersionsCache
    .filter((v) => v.startsWith(prefix))
    .map((v) => v.slice(prefix.length).replace(branchSuffix, ''));

  return [...new Set(builds)].reverse();
}

// NeoForge n'a pas de metadata separee par version MC : son numero de
// version encode directement la version MC cible (MC 1.20.4 -> versions
// "20.4.x", MC 1.20 -> "20.0.x"). On filtre la liste complete par prefixe.
async function listNeoForgeVersions(mcVersion) {
  const parts = mcVersion.split('.');
  if (parts[0] !== '1' || !parts[1]) return []; // NeoForge ne couvre que 1.x, versions recentes uniquement

  if (!neoforgeVersionsCache) neoforgeVersionsCache = await fetchXmlVersionList(NEOFORGE_METADATA_URL);

  const prefix = `${parts[1]}.${parts[2] || '0'}.`;
  return neoforgeVersionsCache.filter((v) => v.startsWith(prefix)).reverse();
}

async function listFabricLikeVersions(type, mcVersion) {
  const base = type === 'quilt' ? 'https://meta.quiltmc.org/v3' : 'https://meta.fabricmc.net/v2';
  const res = await fetch(`${base}/versions/loader/${encodeURIComponent(mcVersion)}`);
  if (!res.ok) throw new Error(`Impossible de recuperer les versions ${type} pour ${mcVersion} (${res.status}).`);
  const data = await res.json();
  return data.map((entry) => entry.loader.version);
}

async function listLoaderVersions(type, mcVersion) {
  switch (type) {
    case 'vanilla': return [];
    case 'forge': return listForgeVersions(mcVersion);
    case 'neoforge': return listNeoForgeVersions(mcVersion);
    case 'fabric': return listFabricLikeVersions('fabric', mcVersion);
    case 'quilt': return listFabricLikeVersions('quilt', mcVersion);
    default: throw new Error(`Loader inconnu: ${type}`);
  }
}

module.exports = { listMinecraftVersions, listLoaderVersions };
