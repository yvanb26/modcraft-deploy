// Lecture/ecriture de fichiers chiffres au repos via l'API OS (DPAPI sur
// Windows, Keychain sur macOS, libsecret sur Linux) grace a safeStorage
// d'Electron : protege le mot de passe SFTP enregistre (admin-config.json)
// contre une simple copie du fichier vers une autre machine/session
// utilisateur, contrairement a du JSON en clair. Bascule silencieusement
// vers du texte brut si le chiffrement OS est indisponible (rare), et migre
// automatiquement un fichier en clair preexistant vers le chiffre a la
// prochaine ecriture.
const fs = require('fs');
const { safeStorage } = require('electron');

function readSecureText(filePath) {
  const raw = fs.readFileSync(filePath);
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(raw);
    } catch {
      return raw.toString('utf8');
    }
  }
  return raw.toString('utf8');
}

function writeSecureText(filePath, text) {
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text)
    : Buffer.from(text, 'utf8');
  fs.writeFileSync(filePath, data);
}

module.exports = { readSecureText, writeSecureText };
