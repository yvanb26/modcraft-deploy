// Tri des fichiers d'un modpack entre "client uniquement" (exclus du serveur
// Minecraft genere) et "les deux" (inclus).
//
// Pourquoi c'est necessaire : un modpack distribue aux joueurs contient des
// mods purement cote client (OptiFine, JourneyMap, Dynamic Lights, BetterFps...)
// qui, sur un serveur dedie, sont inutiles voire font planter le demarrage
// (classes client absentes). Les vieux mods (1.7.10) ne declarent nulle part
// leur "cote" dans le jar : on ne peut donc PAS tout detecter automatiquement.
// On combine :
//   1. une liste de noms de mods clients connus (heuristique) ;
//   2. les metadonnees fiables quand elles existent (Fabric/Quilt declarent
//      `environment: client` dans fabric.mod.json / quilt.mod.json) ;
//   3. les corrections manuelles de l'operateur, qui l'emportent toujours et
//      sont stockees dans api/data/server-sides.json.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// Noms (fichier) de mods connus pour etre uniquement cote client. Volontairement
// prudent : un mod absent de cette liste est considere "les deux" (donc copie
// sur le serveur) : c'est a l'operateur d'exclure ce que la liste ne connait pas.
const CLIENT_NAME_PATTERNS = [
  /optifine/i, /journeymap/i, /voxelmap/i, /xaero/i,
  /dynamic[\s._-]?lights?/i, /lambdynlights/i,
  /better[\s._-]?fps/i, /fps[\s._-]?reducer/i, /fps[\s._-]?plus/i,
  /\bsodium\b/i, /\biris\b/i, /rubidium/i, /embeddium/i, /oculus/i,
  /mouse[\s._-]?tweaks/i, /inventory[\s._-]?tweaks/i, /controlling/i,
  /not[\s._-]?enough[\s._-]?animations/i, /better[\s._-]?f3/i, /mod[\s._-]?menu/i,
  /entity[\s._-]?culling/i, /immediately[\s._-]?fast/i, /zoomify|ok[\s._-]?zoomer/i,
  /presence[\s._-]?footsteps/i, /sound[\s._-]?physics/i, /item[\s._-]?physic/i,
  /damage[\s._-]?indicators/i, /interface[\s._-]?plus/i, /craft[\s._-]?presence/i,
  /armor[\s._-]?status[\s._-]?hud/i, /shaders?[\s._-]?mod/i, /smooth[\s._-]?font/i
];

const SIDE_VALUES = ['client', 'both'];

function sidesFile(apiDir) {
  return path.join(apiDir, 'data', 'server-sides.json');
}

function readAllOverrides(apiDir) {
  try {
    return JSON.parse(fs.readFileSync(sidesFile(apiDir), 'utf8'));
  } catch {
    return {};
  }
}

function getOverrides(apiDir, modpackId) {
  return readAllOverrides(apiDir)[modpackId] || {};
}

// side === null : retire la correction (retour a la detection automatique).
function setOverride(apiDir, modpackId, relPath, side) {
  if (side !== null && !SIDE_VALUES.includes(side)) throw new Error(`Valeur inconnue: ${side}`);
  const all = readAllOverrides(apiDir);
  const forPack = { ...(all[modpackId] || {}) };
  if (side === null) delete forPack[relPath];
  else forPack[relPath] = side;

  if (Object.keys(forPack).length) all[modpackId] = forPack;
  else delete all[modpackId];

  fs.mkdirSync(path.dirname(sidesFile(apiDir)), { recursive: true });
  fs.writeFileSync(sidesFile(apiDir), JSON.stringify(all, null, 2));
}

// Lit l'entree `name` d'un jar/zip sans tout decompresser (adm-zip ne
// decompresse que l'entree demandee). Retourne null si absente/illisible.
function readZipEntry(filePath, entryName) {
  try {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry(entryName);
    return entry ? zip.readAsText(entry) : null;
  } catch {
    return null;
  }
}

const MAX_INSPECT_BYTES = 150 * 1024 * 1024; // au-dela, on n'ouvre pas le jar (memoire)
const inspectCache = new Map(); // "chemin|taille|mtime" -> resultat

// Detection "fiable" par metadonnees (Fabric/Quilt uniquement) : retourne
// 'client' si le mod se declare client-only, sinon null (= on ne sait pas).
function inspectJarSide(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (stat.size > MAX_INSPECT_BYTES) return null;

  const key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
  if (inspectCache.has(key)) return inspectCache.get(key);

  let result = null;
  const fabric = readZipEntry(filePath, 'fabric.mod.json');
  if (fabric) {
    try {
      if (JSON.parse(fabric).environment === 'client') result = 'client';
    } catch { /* JSON invalide : on ignore */ }
  } else {
    const quilt = readZipEntry(filePath, 'quilt.mod.json');
    if (quilt) {
      try {
        if (JSON.parse(quilt)?.minecraft?.environment === 'client') result = 'client';
      } catch { /* idem */ }
    }
  }
  inspectCache.set(key, result);
  return result;
}

// Retourne { side: 'client'|'both', reason }.
function detectSide(filePath) {
  const name = path.basename(filePath);
  if (CLIENT_NAME_PATTERNS.some((re) => re.test(name))) {
    return { side: 'client', reason: 'nom connu (mod client)' };
  }
  if (/\.jar$/i.test(name) && inspectJarSide(filePath) === 'client') {
    return { side: 'client', reason: 'metadonnees du mod (environment: client)' };
  }
  return { side: 'both', reason: '' };
}

const MOD_EXTENSIONS = /\.(jar|zip)$/i;

// Liste les fichiers de mods d'un modpack (mods/ et sous-dossiers, ex:
// mods/1.7.10/) avec leur cote detecte, la correction eventuelle de
// l'operateur, et le cote effectif retenu pour le serveur.
function listMods(apiDir, modpackId) {
  const modsDir = path.join(apiDir, 'modpacks', modpackId, 'mods');
  const overrides = getOverrides(apiDir, modpackId);
  const out = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !MOD_EXTENSIONS.test(entry.name)) continue; // ignore aussi *.jar.disabled

      const relPath = path.relative(path.join(apiDir, 'modpacks', modpackId), full).split(path.sep).join('/');
      const detected = detectSide(full);
      const override = overrides[relPath] || null;
      out.push({
        path: relPath,
        name: entry.name,
        size: fs.statSync(full).size,
        detected: detected.side,
        reason: detected.reason,
        override,
        side: override || detected.side
      });
    }
  }
  walk(modsDir);
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

module.exports = { listMods, setOverride, getOverrides, detectSide, CLIENT_NAME_PATTERNS };
