// Envoi SFTP fichier par fichier (au lieu du uploadDir() en boite noire de
// ssh2-sftp-client) pour pouvoir remonter une progression detaillee :
// fichier en cours + % de ce fichier + position dans la liste : comme un
// vrai client FTP, plutot que d'attendre en silence.
const fs = require('fs');
const path = require('path');

// Les chemins DISTANTS (SFTP) sont toujours en style POSIX ("/"), quel que
// soit l'OS de la machine qui fait tourner l'admin : `path` (sans suffixe)
// est specifique a l'OS local (sur Windows, un "//" en tete est interprete
// comme un prefixe UNC et n'est jamais "nettoye", cf. bug reel rencontre : un
// "Chemin distant" configure a "/" produisait "//data/news.json" que
// path.dirname() renvoyait tel quel, inchange, faisant echouer le mkdir
// distant). `path.posix` regle exactement ca : les memes fonctions, mais
// toujours en style POSIX, independamment de l'OS qui execute le code.
function posixNormalize(p) {
  if (!p) return '';
  const n = path.posix.normalize(p);
  return n === '/' ? '/' : n.replace(/\/+$/, '');
}

const posixJoin = path.posix.join;
const posixDirname = path.posix.dirname;

function listLocalFiles(localDir, filter) {
  const files = [];

  function walk(dir, relDir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const localPath = path.join(dir, entry.name);
      if (filter && !filter(localPath, entry.isDirectory())) continue;

      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(localPath, relPath);
      } else {
        files.push({ localPath, relPath, size: fs.statSync(localPath).size });
      }
    }
  }

  if (fs.existsSync(localDir)) walk(localDir, '');
  return files;
}

// Liste recursivement un dossier distant en { "chemin/relatif": tailleEnOctets }
// : sert de base a la comparaison "diff" ci-dessous (uploadTree avec
// skipUnchanged). Base sur la taille des fichiers, pas un hash : suffisant
// pour un outil d'admin perso (evite de re-uploader des Go de mods
// identiques a chaque deploiement), mais deux fichiers de meme taille et de
// contenu different ne seraient pas detectes : acceptable ici, pas pour une
// sauvegarde/sync critique.
async function listRemoteFiles(sftp, remoteDir) {
  const sizes = {};

  async function walk(dir, relDir) {
    let entries;
    try {
      entries = await sftp.list(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.type === 'd') {
        await walk(posixJoin(dir, entry.name), relPath);
      } else {
        sizes[relPath] = entry.size;
      }
    }
  }

  await walk(posixNormalize(remoteDir), '');
  return sizes;
}

// onProgress({ file, index, total, filePercent, overallPercent, skipped?, deleted? })
// `mirror: true` supprime cote distant les fichiers absents localement
// (l'inverse n'est jamais fait automatiquement : cf. deploy.js) : a n'utiliser
// que quand l'appelant l'a explicitement demande (case a cocher + confirmation
// cote UI), jamais par defaut, une suppression distante n'etant pas
// reversible depuis l'admin.
async function uploadTree(sftp, localDir, remoteDir, onProgress = () => {}, filter, { skipUnchanged = false, mirror = false } = {}) {
  remoteDir = posixNormalize(remoteDir);
  const files = listLocalFiles(localDir, filter);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  let sentBytes = 0;

  const remoteDirs = new Set();
  for (const f of files) {
    const dir = path.posix.dirname(f.relPath);
    if (dir !== '.') remoteDirs.add(dir);
  }
  for (const dir of [...remoteDirs].sort((a, b) => a.length - b.length)) {
    await sftp.mkdir(posixJoin(remoteDir, dir), true);
  }
  if (files.length > 0) await sftp.mkdir(remoteDir, true);

  const remoteSizes = (skipUnchanged || mirror) ? await listRemoteFiles(sftp, remoteDir) : {};

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const remotePath = posixJoin(remoteDir, f.relPath);
    const baseSent = sentBytes;

    if (skipUnchanged && remoteSizes[f.relPath] === f.size) {
      onProgress({
        file: f.relPath, index: i + 1, total: files.length, filePercent: 100,
        overallPercent: totalBytes ? Math.round(((baseSent + f.size) / totalBytes) * 100) : 100,
        skipped: true
      });
      sentBytes += f.size;
      continue;
    }

    onProgress({
      file: f.relPath, index: i + 1, total: files.length, filePercent: 0,
      overallPercent: totalBytes ? Math.round((baseSent / totalBytes) * 100) : 0
    });

    // "step" peut se declencher des centaines de fois pour un gros fichier
    // (un chunk a la fois) : on ne remonte qu'un changement de palier de 10%
    // (ou l'arrivee a 100%) pour eviter de noyer le log de centaines de
    // lignes pour un seul fichier.
    let lastReported = 0;
    await sftp.fastPut(f.localPath, remotePath, {
      step: (transferred) => {
        const filePercent = f.size > 0 ? Math.round((transferred / f.size) * 100) : 100;
        if (filePercent < 100 && filePercent - lastReported < 10) return;
        lastReported = filePercent;
        onProgress({
          file: f.relPath, index: i + 1, total: files.length, filePercent,
          overallPercent: totalBytes ? Math.round(((baseSent + transferred) / totalBytes) * 100) : 100
        });
      }
    });

    sentBytes += f.size;
  }

  if (mirror) {
    const localPaths = new Set(files.map((f) => f.relPath));
    const extraneous = Object.keys(remoteSizes).filter((p) => !localPaths.has(p));
    for (const relPath of extraneous) {
      await sftp.delete(posixJoin(remoteDir, relPath)).catch(() => {});
      onProgress({ file: relPath, index: files.length, total: files.length, filePercent: 100, overallPercent: 100, deleted: true });
    }
  }
}

// Envoie un fichier local unique, en creant le dossier distant si besoin.
async function uploadFile(sftp, localPath, remotePath) {
  remotePath = posixNormalize(remotePath);
  await sftp.mkdir(posixDirname(remotePath), true);
  await sftp.fastPut(localPath, remotePath);
}

module.exports = { uploadTree, uploadFile, listLocalFiles, listRemoteFiles, posixJoin, posixNormalize };
