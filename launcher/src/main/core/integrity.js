const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const { downloadProtectedFile } = require('../apiClient');
const { isAllowedModpackFile } = require('./fileAllowlist');

const STATE_FILENAME = '.legacy-launcher-manifest.json';

// Distingue une annulation volontaire (bouton "Annuler") d'un vrai echec :
// permet aux appelants de nettoyer silencieusement plutot que d'afficher un
// message d'erreur.
class SyncCancelledError extends Error {
  constructor() {
    super('Synchronisation annulee.');
    this.name = 'SyncCancelledError';
  }
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function readPreviousState(instanceDir) {
  try {
    const raw = await fsp.readFile(path.join(instanceDir, STATE_FILENAME), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { files: {} };
  }
}

async function writeState(instanceDir, manifest) {
  const files = {};
  for (const f of manifest.files) files[f.path] = f.sha256;
  await fsp.writeFile(
    path.join(instanceDir, STATE_FILENAME),
    JSON.stringify({ modpackId: manifest.modpackId, generatedAt: manifest.generatedAt, files }, null, 2)
  );
}

// Compare le manifest distant avec l'etat local et retourne les fichiers a
// telecharger (absents ou dont le hash local ne correspond plus) ainsi que
// les fichiers geres precedemment qui ont disparu du modpack (a nettoyer).
// `force: true` (bouton "Reparer les fichiers") ignore l'etat local et
// retelecharge tout, meme ce qui semble deja a jour.
// Chemin d'un fichier du modpack DANS le dossier du jeu, ou erreur. La liste blanche (fileAllowlist.js) ne controle que
// l'extension : sans ce controle, un manifest falsifie pourrait viser "../../..." et ecrire (ou supprimer) un fichier
// n'importe ou sur le disque du joueur (ex. un .jar dans le dossier de demarrage de Windows).
function safeInstancePath(instanceDir, relPath) {
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\0')) {
    throw new Error(`Chemin de fichier invalide dans le manifest : ${JSON.stringify(relPath)}`);
  }
  const base = path.resolve(instanceDir);
  const full = path.resolve(base, relPath);
  const rel = path.relative(base, full);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Chemin hors du dossier du jeu refuse (manifest suspect) : ${relPath}`);
  }
  return full;
}

async function diffManifest(instanceDir, manifest, { force = false } = {}) {
  // Tout le manifest est verifie AVANT le moindre telechargement : un seul chemin suspect l'invalide entierement.
  for (const file of manifest.files) safeInstancePath(instanceDir, file.path);
  const previous = await readPreviousState(instanceDir);
  const toDownload = [];

  for (const file of manifest.files) {
    if (force) {
      toDownload.push(file);
      continue;
    }

    const localPath = safeInstancePath(instanceDir, file.path);
    let needsDownload = true;
    try {
      const stat = await fsp.stat(localPath);
      if (stat.isFile() && previous.files[file.path] === file.sha256) {
        // Meme hash connu au dernier sync : on verifie quand meme que le
        // fichier local n'a pas ete altere entre-temps.
        const localHash = await sha256OfFile(localPath);
        needsDownload = localHash !== file.sha256;
      }
    } catch {
      needsDownload = true;
    }
    if (needsDownload) toDownload.push(file);
  }

  const newPaths = new Set(manifest.files.map((f) => f.path));
  const toRemove = Object.keys(previous.files).filter((p) => !newPaths.has(p));

  return { toDownload, toRemove };
}

async function downloadFileOnce(file, instanceDir) {
  const localPath = safeInstancePath(instanceDir, file.path);
  await fsp.mkdir(path.dirname(localPath), { recursive: true });

  const res = await downloadProtectedFile(file.url);
  if (!res.ok) {
    throw new Error(`Echec du telechargement de ${file.path} (${res.status})`);
  }

  const tmpPath = `${localPath}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpPath));

  const actualHash = await sha256OfFile(tmpPath);
  if (actualHash !== file.sha256) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw new Error(
      `Integrite invalide pour ${file.path} (hash attendu ${file.sha256}, obtenu ${actualHash}). Telechargement abandonne.`
    );
  }

  await fsp.rename(tmpPath, localPath);
}

const DOWNLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Un modpack peut peser plusieurs centaines de Mo repartis sur des centaines
// de petits fichiers : sur une connexion moyenne/instable, un seul hoquet
// reseau (coupure wifi d'une fraction de seconde, timeout...) sur UN fichier
// forçait jusqu'ici a tout relancer depuis "Reparer les fichiers", alors
// qu'un simple retry aurait suffi. On ne retente que les echecs plausiblement
// transitoires (reseau/hash) : jamais un fichier refuse par la liste
// blanche, qui echouera exactement pareil a chaque tentative.
async function downloadFile(file, instanceDir, { cancelToken } = {}) {
  // Deuxieme ligne de defense (cf. fileAllowlist.js) : meme si un manifest
  // distant referencait un fichier hors liste blanche, on refuse de
  // l'ecrire sur le disque du joueur plutot que de faire confiance au
  // serveur/manifest aveuglement.
  if (!isAllowedModpackFile(file.path)) {
    throw new Error(`Format de fichier non autorise refuse : ${file.path}`);
  }

  let lastErr;
  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    if (cancelToken?.cancelled) throw new SyncCancelledError();
    try {
      await downloadFileOnce(file, instanceDir);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < DOWNLOAD_MAX_ATTEMPTS) await sleep(DOWNLOAD_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

// Synchronise le dossier d'instance avec le manifest distant : telecharge les
// fichiers manquants/modifies (avec verification sha256), supprime les fichiers
// obsoletes geres par un manifest precedent, puis enregistre le nouvel etat.
async function syncModpack(instanceDir, manifest, onProgress = () => {}, options = {}) {
  await fsp.mkdir(instanceDir, { recursive: true });
  const { toDownload, toRemove } = await diffManifest(instanceDir, manifest, options);

  let done = 0;
  const total = toDownload.length;
  onProgress({ phase: 'start', total });

  for (const file of toDownload) {
    // Verifie a chaque fichier (pas seulement au debut) : un clic sur
    // "Annuler" en cours de telechargement doit prendre effet des le
    // fichier courant termine, pas seulement au tout prochain appel.
    if (options.cancelToken?.cancelled) throw new SyncCancelledError();
    onProgress({ phase: 'downloading', file: file.path, done, total });
    await downloadFile(file, instanceDir, { cancelToken: options.cancelToken });
    done += 1;
    onProgress({ phase: 'downloading', file: file.path, done, total });
  }
  if (options.cancelToken?.cancelled) throw new SyncCancelledError();

  for (const relPath of toRemove) {
    let target;
    try { target = safeInstancePath(instanceDir, relPath); } catch { continue; } // jamais de suppression hors du dossier du jeu
    await fsp.rm(target, { force: true }).catch(() => {});
  }

  await writeState(instanceDir, manifest);
  onProgress({ phase: 'done', total, removed: toRemove.length });
  return { downloaded: total };
}

module.exports = { syncModpack, sha256OfFile, diffManifest, safeInstancePath, SyncCancelledError };
