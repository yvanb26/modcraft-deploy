const path = require('path');
const { app } = require('electron');

// root: contient versions/, libraries/, assets/ (partages entre tous les profils,
// comme le fait le launcher officiel).
function gameRoot() {
  return path.join(app.getPath('userData'), 'gamedata');
}

// Chaque serveur a son propre dossier d'instance (mods/config/saves isoles),
// pour eviter qu'un modpack n'en pollue un autre.
function instanceDir(serverId) {
  return path.join(app.getPath('userData'), 'instances', serverId);
}

// Meme principe pour les installations "libres" (version/loader choisis par
// le joueur, sans serveur/modpack impose par l'operateur) : dossier separe
// pour ne jamais se confondre avec les instances liees a un serveur.
function customInstanceDir(id) {
  return path.join(app.getPath('userData'), 'custom-instances', id);
}

function versionsDir() {
  return path.join(gameRoot(), 'versions');
}

module.exports = { gameRoot, instanceDir, customInstanceDir, versionsDir };
