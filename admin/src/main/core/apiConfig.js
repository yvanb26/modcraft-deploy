// Le dossier api/ n'est plus choisi manuellement : il est TOUJOURS au meme endroit, donc
// rien a configurer ni a pouvoir casser en choisissant le mauvais dossier.
//  - Installe : <dossier utilisateur>/ModCraft Deploy Admin/api. Volontairement HORS du
//    dossier d'installation (efface et recree a chaque mise a jour automatique) et hors de
//    "Documents" (souvent synchronise par OneDrive, ce qui enverrait des modpacks de
//    plusieurs centaines de Mo dans le cloud). Les serveurs Minecraft generes vont dans le
//    dossier frere "serveurs-minecraft" (cf. mcServer.defaultOutDir).
//  - Dev (npm start depuis admin/) : le dossier api/ du depot, frere de admin/.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function dataRoot() {
  return path.join(app.getPath('home'), 'ModCraft Deploy Admin');
}

function resolveApiDir() {
  if (app.isPackaged) return path.join(dataRoot(), 'api');
  // Dev : admin/ et api/ sont des dossiers freres a la racine du depot.
  return path.resolve(__dirname, '..', '..', '..', '..', 'api');
}

function isValidApiDir(dir) {
  return !!dir && fs.existsSync(path.join(dir, 'data')) && fs.existsSync(path.join(dir, 'scripts', 'generate-manifest.js'));
}

function getApiDir() {
  const dir = resolveApiDir();
  return isValidApiDir(dir) ? dir : null;
}

// Modele utilise pour (re)creer le dossier api/ s'il est absent : dans un
// build packagee, c'est un instantane de api/ embarque dans l'app au moment
// du build (cf. "extraResources" dans package.json), sans node_modules/ (livres a part dans api-modules/ ; le
// runtime les trouve via NODE_PATH, cf. nodeRuntime.js), sans .env (secret) ni
// contenu reel de modpacks (juste le code + une config
// d'exemple). En dev, il n'existe pas de copie separee : le modele EST le
// dossier api/ du depot, donc rien a recreer si vous le supprimez vous-meme.
function templateDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'api-template');
  return path.resolve(__dirname, '..', '..', '..', '..', 'api');
}

function canScaffoldApiDir() {
  return fs.existsSync(templateDir()) && path.resolve(templateDir()) !== path.resolve(resolveApiDir());
}

function scaffoldApiDir() {
  const target = resolveApiDir();
  const template = templateDir();

  if (!fs.existsSync(template)) {
    throw new Error("Modele introuvable dans cette installation : impossible de recreer le dossier api/.");
  }
  if (path.resolve(template) === path.resolve(target)) {
    throw new Error('Rien a recreer : vous etes en mode developpement (le modele est le dossier api/ du depot lui-meme).');
  }

  fs.mkdirSync(target, { recursive: true });
  // node_modules/ n'est pas recopie : les modules de l'API restent dans l'appli et sont
  // exposes au runtime via NODE_PATH (cf. nodeRuntime.js).
  fs.cpSync(template, target, { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' });
  fs.mkdirSync(path.join(target, 'modpacks'), { recursive: true });
  fs.mkdirSync(path.join(target, 'data'), { recursive: true });
  // servers.json n'est PAS embarque dans le modele (il contient les mots de passe RCON / SFTP du serveur de
  // l'operateur, cf. build.extraResources dans package.json) : on demarre avec une liste vide.
  const serversPath = path.join(target, 'data', 'servers.json');
  if (!fs.existsSync(serversPath)) fs.writeFileSync(serversPath, '[]\n');

  // .env n'est jamais embarque dans le modele (secret) : on part du
  // .env.example fourni pour que le serveur de test local demarre tout de
  // suite (memes valeurs par defaut que celles utilisees si .env est
  // carrement absent, cf. api/src/env.js), a personnaliser avant une vraie
  // mise en production.
  const envPath = path.join(target, '.env');
  const envExamplePath = path.join(target, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
  }

  return target;
}

module.exports = { getApiDir, resolveApiDir, isValidApiDir, canScaffoldApiDir, scaffoldApiDir };
