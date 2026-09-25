// Fichier de config unique de l'app admin (dossier api/ selectionne,
// identifiants SFTP...) : un seul point de lecture/ecriture partage par
// apiConfig.js et ipc.js pour eviter que l'un n'ecrase les cles de l'autre
// en sauvegardant.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { readSecureText, writeSecureText } = require('./secureStore');

function configPath() {
  return path.join(app.getPath('userData'), 'admin-config.json');
}

function readAll() {
  try {
    return JSON.parse(readSecureText(configPath()));
  } catch {
    return {};
  }
}

// Fusionne avec le contenu existant plutot que d'ecraser tout le fichier.
function patch(partial) {
  const merged = { ...readAll(), ...partial };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  writeSecureText(configPath(), JSON.stringify(merged, null, 2));
  return merged;
}

// Parametres de connexion SFTP (deploiement des fichiers de modpacks vers le
// vrai serveur), stockes sous la cle "sftp" du meme fichier. Chiffres au
// repos via safeStorage (cf. secureStore.js), donc lies a cette session
// Windows : pas un coffre-fort a toute epreuve, mais bien mieux qu'un
// fichier JSON en clair copiable tel quel.
function getSftpConfig() {
  const { sftp } = readAll();
  return sftp || { host: '', port: 22, username: '', password: '', remotePath: '' };
}

function setSftpConfig(sftp) {
  patch({ sftp });
  return sftp;
}

module.exports = { readAll, patch, getSftpConfig, setSftpConfig };
