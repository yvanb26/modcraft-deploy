// "Vider le cache" (bouton Options) : force la reinstallation complete des
// fichiers vanilla/loader PARTAGES entre toutes les instances (versions/,
// libraries/, installers/), au cas ou l'un d'eux serait corrompu : au
// contraire du bouton "Reparer les fichiers" (par instance), qui ne
// reverifie que le contenu du modpack (mods/config/...), jamais ces
// fichiers-la.
//
// Delibere : on efface tout en bloc plutot que de cibler une seule instance.
// Retrouver precisement quel dossier appartient a quelle instance
// demanderait de dupliquer la logique de nommage de chaque loader
// (forge/fabric/quilt/neoforge, chacun avec ses propres regles), pour un
// gain marginal : c'est une action manuelle de depannage rare, pas
// automatique, donc la simplicite et la fiabilite priment. Inclut aussi les
// runtimes Java telecharges automatiquement (gamedata/runtimes, cf.
// javaRuntime.js) : meme categorie de fichiers "partages et retelechargeables
// sans perte". Les assets Mojang (gamedata/assets, jamais specifiques a un
// loader, tres volumineux) ne sont volontairement pas touches.
const fs = require('fs');
const path = require('path');

const { gameRoot } = require('./paths');

const CLEARABLE_DIRS = ['versions', 'libraries', 'installers', 'runtimes'];

function clearSharedCache() {
  const cleared = [];
  for (const name of CLEARABLE_DIRS) {
    const dir = path.join(gameRoot(), name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      cleared.push(name);
    }
  }
  return { cleared };
}

module.exports = { clearSharedCache };
