// Scan antivirus post-synchronisation via Windows Defender (MpCmdRun.exe) :
// pas une reimplementation d'un scanner (une heuristique maison sans base de
// signatures donnerait une fausse impression de securite), mais un vrai
// declenchement du moteur deja present sur toutes les machines Windows,
// gratuit et sans accord de licence a obtenir (contrairement a la plupart
// des antivirus tiers, qui n'exposent pas d'API utilisable par un logiciel
// tiers de toute facon).
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function findMpCmdRun() {
  const candidates = [];
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  candidates.push(path.join(programFiles, 'Windows Defender', 'MpCmdRun.exe'));

  // Emplacement alternatif utilise par les mises a jour de plateforme
  // recentes : on prend la version la plus recente si presente.
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const platformDir = path.join(programData, 'Microsoft', 'Windows Defender', 'Platform');
  try {
    const versions = fs.readdirSync(platformDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
    for (const v of versions) candidates.push(path.join(platformDir, v, 'MpCmdRun.exe'));
  } catch {
    // Dossier absent : pas grave, on se rabat sur les autres candidats.
  }

  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Lance un scan personnalise Windows Defender sur `targetDir` (les fichiers
// tout juste synchronises depuis le serveur de l'operateur) avant de lancer
// le jeu. Retourne :
//  - { available: false } si Defender est absent/introuvable (autre
//    antivirus installe, Windows modifie...) : le joueur peut continuer,
//    bloquer totalement casserait le launcher pour lui.
//  - { available: true, clean: true|false } sinon.
async function scanForThreats(targetDir) {
  if (process.platform !== 'win32') return { available: false };

  const mpCmdRun = findMpCmdRun();
  if (!mpCmdRun) return { available: false };

  return new Promise((resolve) => {
    execFile(mpCmdRun, ['-Scan', '-ScanType', '3', '-File', targetDir], { timeout: 120000 }, (error) => {
      // Verifie empiriquement (fichier de test EICAR standard) : MpCmdRun.exe
      // sort avec le code 2 specifiquement quand une menace est trouvee (et
      // generalement mise en quarantaine automatiquement au passage). Tout
      // AUTRE echec (timeout sur un gros modpack, scan interrompu, erreur
      // operationnelle sans rapport...) ne doit PAS bloquer le lancement :
      // seul un vrai code 2 confirme une detection.
      if (!error) return resolve({ available: true, clean: true });
      if (error.code === 2) return resolve({ available: true, clean: false });
      resolve({ available: false });
    });
  });
}

module.exports = { scanForThreats };
