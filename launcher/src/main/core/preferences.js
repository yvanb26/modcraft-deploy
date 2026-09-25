const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { readSecureText, writeSecureText } = require('./secureStore');

// Preferences globales (pas specifiques a un serveur, contrairement a
// settings.js) : comptes enregistres (pour changer de compte rapidement,
// comme TLauncher), volume/mute de la musique. Stockees dans un fichier JSON
// cote main process plutot que localStorage : localStorage sur une page
// chargee en file:// n'est pas fiable pour persister entre deux redemarrages
// de l'app avec Electron/Chromium.
//
// `accounts` : [{ id, provider, name, uuid, refreshToken?, homeAccountId? }]
// - offline : { id: "offline:<name>", provider: "offline", name }
// - elyby   : { id: "elyby:<uuid>", provider: "elyby", name, uuid, refreshToken }
// - microsoft: { id: "microsoft:<uuid>", provider: "microsoft", name, uuid, homeAccountId }
const DEFAULTS = {
  accounts: [],
  activeAccountId: null,
  musicVolume: 25,
  musicMuted: false,
  // Fondu automatique de la musique quand la fenetre perd/reprend le focus
  // (ex: minimisee au lancement du jeu) : desactivable par le joueur via la
  // case "Suivre le focus" a cote du controle de volume.
  musicFocusFade: true,
  // Masque les snapshots et les anciennes versions (alpha/beta) par defaut
  // dans le selecteur de version des installations libres (page "Versions
  // libres") : reserve aux joueurs qui savent ce qu'ils font, pas affiche
  // par defaut pour ne pas encombrer/perturber un joueur lambda.
  showSnapshots: false,
  showOldVersions: false,
  // Id de la derniere annonce (panneau "Annonces") vue par le joueur : sert
  // uniquement a afficher un point "non lu" sur le menu, jamais a cacher
  // le contenu.
  lastSeenNewsId: null,
  // Ouvre automatiquement la popup Annonces au demarrage s'il y a une
  // annonce non lue : desactivable par le joueur (menu > Options) pour ceux
  // qui preferent aller la consulter eux-memes depuis le menu.
  autoShowNews: true,
  // Ids des serveurs deja vus par le joueur (notification "nouveau serveur"
  // dans la cloche) : rempli au tout premier boot avec les serveurs deja
  // presents, pour ne jamais notifier retroactivement de serveurs qui
  // existaient deja avant l'ajout de cette fonctionnalite (cf. renderer.js).
  seenServerIds: null,
  // Affiche par defaut le detail technique (log qui defile) du panneau de
  // lancement : masque par defaut (peut faire peur a un joueur non
  // technique), memorise ici plutot que remis a zero a chaque redemarrage.
  showLaunchConsole: false,
  // Couleur du launcher choisie par le joueur ("#rrggbb"), null = couleur de la communaute (branding.json).
  userAccentColor: null
};

function preferencesPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function getPreferences() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readSecureText(preferencesPath())) };
  } catch {
    return { ...DEFAULTS };
  }
}

function setPreferences(patch) {
  const merged = { ...getPreferences(), ...patch };
  fs.mkdirSync(path.dirname(preferencesPath()), { recursive: true });
  writeSecureText(preferencesPath(), JSON.stringify(merged, null, 2));
  return merged;
}

// Ajoute ou met a jour (par `id`) un compte dans la liste memorisee, et le
// marque actif.
function upsertAccount(account) {
  const prefs = getPreferences();
  const accounts = prefs.accounts.filter((a) => a.id !== account.id);
  accounts.push(account);
  return setPreferences({ accounts, activeAccountId: account.id });
}

function removeAccount(id) {
  const prefs = getPreferences();
  const accounts = prefs.accounts.filter((a) => a.id !== id);
  const activeAccountId = prefs.activeAccountId === id ? null : prefs.activeAccountId;
  return setPreferences({ accounts, activeAccountId });
}

module.exports = { getPreferences, setPreferences, upsertAccount, removeAccount };
