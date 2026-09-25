// Sauvegarde locale unique du dossier api/ selectionne (ecrasee a chaque
// nouvelle sauvegarde, pas d'historique) : remplace l'ancien bloc
// "Deploiement local" (copie vers un AUTRE dossier choisi a la main), qui
// faisait doublon avec le Tableau de bord : celui-ci lance deja
// `node src/index.js` directement depuis le dossier api/ edite par l'admin
// (cf. serverProcess.js), donc tester la config courante ne demandait aucune
// copie. Le seul vrai besoin restant est de pouvoir figer un etat "connu bon"
// et le tester independamment des modifications en cours : d'ou cette
// sauvegarde simple, toujours au meme endroit (userData/api-backup),
// combinee au bouton "Demarrer depuis la sauvegarde" de serverProcess.js.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { listLocalFiles } = require('./sftpTransfer');

const BACKUP_INFO_FILE = '.backup-info.json';

function backupDir() {
  return path.join(app.getPath('userData'), 'api-backup');
}

// Copie fichier par fichier (comme le reste du code de deploiement) pour
// remonter une progression lisible plutot que de bloquer l'UI en silence sur
// un gros fs.cpSync : un modpack complet peut peser plusieurs centaines de
// Mo.
function createBackup(apiDir, onLog = () => {}) {
  const target = backupDir();

  // Repart d'une sauvegarde vide a chaque fois : un fichier supprime cote
  // source (mod retire, etc.) ne doit pas trainer indefiniment dans la
  // sauvegarde, qui doit refleter fidelement l'etat courant du dossier api/.
  if (fs.existsSync(target)) {
    onLog('Suppression de l\'ancienne sauvegarde...\n');
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.mkdirSync(target, { recursive: true });

  const files = listLocalFiles(apiDir);
  onLog(`Copie de ${files.length} fichier(s) vers la sauvegarde...\n`);

  let lastReportedPercent = -1;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const destPath = path.join(target, f.relPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(f.localPath, destPath);

    // Un modpack peut contenir des milliers de petits fichiers (config/,
    // resourcepacks/...) : logguer chaque fichier noierait le panneau, donc
    // on ne remonte qu'un changement de palier de 10%.
    const percent = files.length ? Math.round(((i + 1) / files.length) * 100) : 100;
    if (percent !== lastReportedPercent && (percent % 10 === 0 || i === files.length - 1)) {
      lastReportedPercent = percent;
      onLog(`[${i + 1}/${files.length}] ${percent}%\n`);
    }
  }

  const info = { createdAt: new Date().toISOString(), fileCount: files.length };
  fs.writeFileSync(path.join(target, BACKUP_INFO_FILE), JSON.stringify(info, null, 2));

  onLog('Sauvegarde terminee.\n');
  return info;
}

function getBackupInfo() {
  const target = backupDir();
  const infoPath = path.join(target, BACKUP_INFO_FILE);
  if (!fs.existsSync(infoPath)) return { exists: false };
  try {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    return { exists: true, ...info };
  } catch {
    return { exists: false };
  }
}

module.exports = { backupDir, createBackup, getBackupInfo };
