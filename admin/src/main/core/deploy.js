// Deploiement SFTP : deux operations bien separees pour ne jamais risquer de
// perdre une config live differente de la copie locale :
//   - deploySftpCode : met a jour le CODE de l'API (src/, scripts/,
//     package.json...) sur le serveur, sans jamais toucher a son data/ ni
//     son modpacks/ actuels. Sans danger, a lancer a chaque fois que le code
//     local evolue (ex: nouvelle route, comme /api/config qui inclut
//     desormais "news").
//   - deploySftpConfig : ecrase data/ et modpacks/ du serveur avec la copie
//     locale : action deliberee uniquement, cf. diffSftpConfig pour voir ce
//     qui changerait avant de confirmer.
// Les deux envoient fichier par fichier (sftpTransfer.uploadTree) pour
// remonter une progression detaillee (fichier + % + position), au lieu
// d'attendre en silence comme le uploadDir() en boite noire de la librairie.
const fs = require('fs');
const path = require('path');
const { withRemote } = require('./remoteClient');
const { uploadTree, uploadFile, posixJoin, posixNormalize } = require('./sftpTransfer');
const { generateManifest } = require('./dataFiles');

const CODE_EXCLUDES = new Set(['data', 'modpacks', 'node_modules', '.env', '.git']);

// Filtre "top-level uniquement" : n'exclut que data/, modpacks/, etc. quand
// ils sont des ENTREES DIRECTES du dossier api/ (pas des dossiers de meme
// nom plus bas dans l'arborescence, ex: src/data/ s'il existait).
function makeCodeFilter(apiDir) {
  return (fullPath) => {
    const rel = path.relative(apiDir, fullPath).split(path.sep)[0];
    return !CODE_EXCLUDES.has(rel);
  };
}

function assertSftpConfig({ host, username, remotePath }) {
  if (!host || !username || !remotePath) {
    throw new Error('Host, utilisateur et chemin distant sont obligatoires.');
  }
}

// Normalise remotePath (style POSIX, un seul "/" jamais en double, jamais de
// "/" final) une bonne fois pour toutes : evite le bug "//data/..." quand
// le champ vaut juste "/" ou se termine deja par "/".
function normalizeSftpConfig(config) {
  return { ...config, remotePath: posixNormalize(config.remotePath) };
}

// Historiquement SFTP uniquement ; `config.protocol` ('sftp' par defaut, 'ftp' ou
// 'ftps') choisit desormais le protocole (cf. remoteClient.js) : le nom est garde
// pour ne rien changer aux appelants.
async function withSftp(config, fn) {
  return withRemote(config, fn);
}

function formatProgress({ file, index, total, filePercent, overallPercent, skipped, deleted }) {
  if (deleted) return `[${index}/${total}] SUPPRIME (absent en local)  ${file}\n`;
  if (skipped) return `[${index}/${total}] inchange, ignore  ${file}\n`;
  return `[${index}/${total}] ${filePercent}% (total ${overallPercent}%)  ${file}\n`;
}

async function deploySftpCode(apiDir, config, onLog = () => {}) {
  assertSftpConfig(config);
  config = normalizeSftpConfig(config);
  const { host, port, remotePath } = config;

  await withSftp(config, async (sftp) => {
    onLog(`Connexion a ${config.username}@${host}:${port || 22}...\n`);
    onLog(`Mise a jour du code de l'API vers ${remotePath} (data/ et modpacks/ ignores) ...\n`);
    await uploadTree(sftp, apiDir, remotePath, (p) => onLog(formatProgress(p)), makeCodeFilter(apiDir));
    onLog('Code de l\'API mis a jour. Pensez a lancer "npm install" sur le serveur si package.json a change, puis a le redemarrer.\n');
  });
}

// `mirror: true` supprime aussi, cote distant, les fichiers de data/ et
// modpacks/ qui n'existent plus en local (mod retire, ancien fichier de
// config nettoye...) : desactive par defaut (l'UI ne le passe qu'apres
// case a cocher + confirmation explicite), sinon un modpack distant ne fait
// qu'accumuler des fichiers orphelins au fil des deploiements.
async function deploySftpConfig(apiDir, config, onLog = () => {}, { mirror = false } = {}) {
  assertSftpConfig(config);
  config = normalizeSftpConfig(config);
  const { host, port, remotePath } = config;

  await withSftp(config, async (sftp) => {
    onLog(`Connexion a ${config.username}@${host}:${port || 22}...\n`);

    onLog(`Envoi de data/ vers ${posixJoin(remotePath, 'data')} ...\n`);
    await uploadTree(sftp, path.join(apiDir, 'data'), posixJoin(remotePath, 'data'), (p) => onLog(formatProgress(p)), undefined, { mirror });

    onLog(`Envoi de modpacks/ vers ${posixJoin(remotePath, 'modpacks')} (fichiers inchanges ignores) ...\n`);
    await uploadTree(sftp, path.join(apiDir, 'modpacks'), posixJoin(remotePath, 'modpacks'), (p) => onLog(formatProgress(p)), undefined, { skipUnchanged: true, mirror });

    onLog('Deploiement de la config termine.\n');
  });
}

const DATA_FILES = new Set(['branding.json', 'servers.json', 'news.json']);

// Envoie UN SEUL fichier de data/ (branding.json, servers.json ou
// news.json), independamment du reste : pour des petites mises a jour
// rapides sans re-envoyer/re-comparer toute la config.
async function deploySftpDataFile(apiDir, config, fileName, onLog = () => {}) {
  assertSftpConfig(config);
  config = normalizeSftpConfig(config);
  if (!DATA_FILES.has(fileName)) throw new Error(`Fichier de config inconnu : ${fileName}`);

  const localPath = path.join(apiDir, 'data', fileName);
  if (!fs.existsSync(localPath)) throw new Error(`${localPath} introuvable.`);

  const remoteFilePath = posixJoin(config.remotePath, 'data', fileName);
  await withSftp(config, async (sftp) => {
    onLog(`Connexion a ${config.username}@${config.host}:${config.port || 22}...\n`);
    onLog(`Envoi de data/${fileName} vers ${remoteFilePath} ...\n`);
    await uploadFile(sftp, localPath, remoteFilePath);
    onLog(`${fileName} envoye.\n`);
  });
}

// Envoie servers.json ET, pour chaque modpack qu'il reference, regenere son
// manifest.json puis synchronise le dossier du modpack en ne renvoyant que
// les fichiers absents/differents cote serveur (skipUnchanged) : evite de
// re-uploader des Go de mods identiques a chaque petite modification de
// servers.json.
async function deploySftpServersWithModpacks(apiDir, config, onLog = () => {}, { mirror = false } = {}) {
  assertSftpConfig(config);
  config = normalizeSftpConfig(config);

  const serversPath = path.join(apiDir, 'data', 'servers.json');
  if (!fs.existsSync(serversPath)) throw new Error(`${serversPath} introuvable.`);
  const servers = JSON.parse(fs.readFileSync(serversPath, 'utf8'));
  const modpackIds = [...new Set(servers.map((s) => s.modpackId).filter(Boolean))];

  for (const modpackId of modpackIds) {
    if (!fs.existsSync(path.join(apiDir, 'modpacks', modpackId))) continue;
    onLog(`Regeneration du manifest de "${modpackId}"...\n`);
    onLog(generateManifest(apiDir, modpackId) + '\n');
  }

  await withSftp(config, async (sftp) => {
    onLog(`Connexion a ${config.username}@${config.host}:${config.port || 22}...\n`);

    const remoteServersPath = posixJoin(config.remotePath, 'data', 'servers.json');
    onLog(`Envoi de data/servers.json vers ${remoteServersPath} ...\n`);
    await uploadFile(sftp, serversPath, remoteServersPath);

    for (const modpackId of modpackIds) {
      const localModpackDir = path.join(apiDir, 'modpacks', modpackId);
      if (!fs.existsSync(localModpackDir)) {
        onLog(`Modpack "${modpackId}" introuvable localement, ignore.\n`);
        continue;
      }
      const remoteModpackDir = posixJoin(config.remotePath, 'modpacks', modpackId);
      onLog(`Synchronisation de modpacks/${modpackId}/ (fichiers inchanges ignores${mirror ? ', suppression des fichiers distants orphelins' : ''}) ...\n`);
      await uploadTree(sftp, localModpackDir, remoteModpackDir, (p) => onLog(formatProgress(p)), undefined, { skipUnchanged: true, mirror });
    }

    onLog('servers.json + modpacks references envoyes.\n');
  });
}

// Compare les data/*.json locaux a ceux du serveur distant, pour decider en
// connaissance de cause avant d'ecraser une config live potentiellement
// differente (cf. deploySftpConfig).
async function diffSftpConfig(apiDir, config) {
  assertSftpConfig(config);
  config = normalizeSftpConfig(config);
  const files = ['branding.json', 'servers.json', 'news.json'];

  return withSftp(config, async (sftp) => {
    const result = [];
    for (const file of files) {
      const localPath = path.join(apiDir, 'data', file);
      const remotePath = posixJoin(config.remotePath, 'data', file);

      const localExists = fs.existsSync(localPath);
      const remoteStatus = await sftp.exists(remotePath);

      if (!remoteStatus) {
        result.push({ file, status: localExists ? 'nouveau (absent du serveur)' : 'absent des deux' });
        continue;
      }
      if (!localExists) {
        result.push({ file, status: 'sera supprime cote local (absent ici)' });
        continue;
      }

      const localContent = fs.readFileSync(localPath, 'utf8');
      const remoteContent = (await sftp.get(remotePath)).toString('utf8');
      result.push({ file, status: localContent === remoteContent ? 'identique' : 'DIFFERENT' });
    }
    return result;
  });
}

// Liste ce qu'il y a VRAIMENT dans remotePath (et remotePath/data) :
// diagnostic direct pour verifier que le chemin distant configure est bien
// celui que le process Node du serveur lit reellement (le champ "modifie le"
// permet de voir si un fichier vient effectivement d'etre touche par un
// deploiement recent, ou s'il s'agit d'un dossier oublie/inutilise).
async function listSftpRemote(config) {
  assertSftpConfig(config);
  config = normalizeSftpConfig(config);

  return withSftp(config, async (sftp) => {
    const rootStatus = await sftp.exists(config.remotePath);
    if (!rootStatus) {
      return { remotePath: config.remotePath, exists: false, root: [], data: [] };
    }

    const root = await sftp.list(config.remotePath);
    const dataPath = posixJoin(config.remotePath, 'data');
    const dataExists = await sftp.exists(dataPath);
    const data = dataExists ? await sftp.list(dataPath) : [];

    const toEntry = (e) => ({ name: e.name, type: e.type, size: e.size, modifyTime: e.modifyTime });
    return {
      remotePath: config.remotePath,
      exists: true,
      root: root.map(toEntry),
      data: data.map(toEntry)
    };
  });
}

module.exports = {
  deploySftpCode, deploySftpConfig, diffSftpConfig, listSftpRemote,
  deploySftpDataFile, deploySftpServersWithModpacks,
  // Reutilises par mcServer.js (envoi du serveur Minecraft genere)
  withSftp, formatProgress
};
