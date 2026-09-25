// Lecture/ecriture de fichiers chiffres au repos via l'API OS (DPAPI sur
// Windows, Keychain sur macOS, libsecret sur Linux) grace a safeStorage
// d'Electron : protege les tokens de compte (refresh token Ely.by, cache
// MSAL) contre une simple copie du fichier vers une autre machine/session
// utilisateur, contrairement a du JSON en clair. Bascule silencieusement
// vers du texte brut si le chiffrement OS est indisponible (rare), et migre
// automatiquement un fichier en clair preexistant (versions precedentes de
// l'app) vers le chiffre a la prochaine ecriture : jamais de perte de
// comptes enregistres lors de la mise a jour.
const fs = require('fs');
const { safeStorage } = require('electron');

function readSecureText(filePath) {
  const raw = fs.readFileSync(filePath);
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(raw);
    } catch {
      // Pas (encore) chiffre : ancien fichier en clair d'avant cette
      // fonctionnalite. Sera re-ecrit chiffre au prochain writeSecureText.
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
