// Journalisation centrale de l'app (process principal) : fichier tournant
// sur disque (utile pour le support : le joueur n'a qu'a glisser le fichier
// sur Discord) + reflet dans la console/DevTools. `electron-log` gere le
// rattachement automatique du process renderer (cf. preload.js) et
// l'ecriture fichier de facon fiable/eprouvee plutot que de reinventer ca
// nous-memes.
const log = require('electron-log/main');

log.initialize();

// 5 Mo par fichier avant rotation (renomme en main.old.log) : largement
// suffisant pour une session de jeu, evite un fichier qui grossit sans fin.
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}';
log.transports.console.format = '[{h}:{i}:{s}] [{level}]{scope} {text}';

module.exports = log;
