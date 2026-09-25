// Signe latest.yml apres un `npm run dist` : produit latest.yml.sig, a envoyer sur le serveur des mises a jour.
//   node scripts/sign-update.js launcher/dist
//   node scripts/sign-update.js admin/dist
// Cle privee : MODCRAFT_SIGNING_KEY (chemin), sinon <dossier utilisateur>/.modcraft-signing/update-signing-private.pem
// (cf. generate-update-key.js). Les applications refusent toute mise a jour dont latest.yml n'est pas signe avec cette cle.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dist = process.argv[2];
if (!dist) {
  console.error('Usage : node scripts/sign-update.js <dossier dist>   (ex. launcher/dist)');
  process.exit(1);
}
const keyPath = process.env.MODCRAFT_SIGNING_KEY || path.join(os.homedir(), '.modcraft-signing', 'update-signing-private.pem');
const ymlPath = path.join(dist, 'latest.yml');
if (!fs.existsSync(keyPath)) { console.error(`Cle privee introuvable : ${keyPath}\nGenerez-la avec : node scripts/generate-update-key.js`); process.exit(1); }
if (!fs.existsSync(ymlPath)) { console.error(`latest.yml introuvable dans ${dist} : lancez d'abord "npm run dist".`); process.exit(1); }

const yml = fs.readFileSync(ymlPath);
const signature = crypto.sign(null, yml, crypto.createPrivateKey(fs.readFileSync(keyPath)));
fs.writeFileSync(`${ymlPath}.sig`, `${signature.toString('base64')}\n`);

const version = /^version:\s*(.+)$/m.exec(yml.toString('utf8'))?.[1]?.trim();
console.log(`latest.yml (version ${version}) signe -> ${ymlPath}.sig`);
console.log('A envoyer sur le serveur des mises a jour : l\'installateur, son .blockmap, latest.yml.sig, puis latest.yml EN DERNIER.');
