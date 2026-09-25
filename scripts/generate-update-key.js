// Genere la paire de cles qui signe les mises a jour du launcher et de l'outil admin (Ed25519).
//   node scripts/generate-update-key.js [chemin-de-la-cle-privee]
// - La cle PRIVEE reste sur votre PC (par defaut : <dossier utilisateur>/.modcraft-signing/update-signing-private.pem).
//   Ne la commitez JAMAIS, ne l'envoyez jamais sur un serveur, et faites-en une sauvegarde (cle USB, gestionnaire de
//   mots de passe) : sans elle, les applications deja installees ne pourront plus recevoir de mise a jour.
// - La cle PUBLIQUE est affichee : c'est celle qui est integree aux applications (UPDATE_PUBLIC_KEY, updateConfig.js).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const target = path.resolve(process.argv[2] || path.join(os.homedir(), '.modcraft-signing', 'update-signing-private.pem'));
if (fs.existsSync(target)) {
  console.error(`Une cle existe deja : ${target}\nSupprimez-la a la main si vous voulez vraiment en generer une nouvelle\n(les applications deja installees ne reconnaitraient plus vos mises a jour).`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

console.log(`Cle privee ecrite dans : ${target}  (a sauvegarder, a ne jamais partager)\n`);
console.log('Cle publique (a coller dans UPDATE_PUBLIC_KEY, launcher/src/main/core/updateConfig.js et admin/src/main/core/updateConfig.js) :\n');
console.log(publicKey.export({ type: 'spki', format: 'pem' }));
