const fs = require('fs');
const { Client } = require('minecraft-launcher-core');

const { instanceDir, customInstanceDir, gameRoot } = require('./paths');
const { prepareFabricLike } = require('./loaders/fabricLike');
const { prepareForge, prepareNeoForge } = require('./loaders/installerLoader');
const { syncModpack, diffManifest, SyncCancelledError } = require('./integrity');
const { fetchManifest, authorizeJoin } = require('../apiClient');
const { applyGpuPreference } = require('./gpu');
const { getFreeBytes } = require('./diskSpace');
const { fetchVanillaVersionJson } = require('./mojangVersions');
const { requiredJavaMajor, resolveJavaForMajor } = require('./javaRuntime');
const { scanForThreats } = require('./avScan');
const { diagnoseCrash } = require('./crashDiagnostics');

const GAME_EVENTS = ['debug', 'data', 'arguments', 'close', 'package-extract', 'download', 'download-status', 'progress'];
const DISK_SPACE_MARGIN = 1.1; // +10% de marge de securite

// Beaucoup de vieux mods (1.7.10 etc.) font des appels HTTP bloquants
// directement depuis le thread de rendu/init (verif de MAJ, changelog
// pastebin, "telechargement" d'un asset au premier lancement...) vers des
// domaines aujourd'hui morts : cf. InterfacePlus qui plante en essayant de
// joindre download.spellcraftgaming.net. Sans ces reglages, la duree de
// l'echec depend entierement du DNS/reseau du joueur (peut aller jusqu'a
// plusieurs dizaines de secondes de blocage avant l'exception) ; avec un
// timeout court et fixe, l'appel echoue vite et de façon previsible, ce que
// le mod est cense deja gerer (il attrape l'exception) : ca reduit
// nettement la marge de manoeuvre pour ce genre de bug de mod tiers, meme si
// ca ne peut pas garantir qu'un mod mal ecrit ne finira jamais par planter.
const NETWORK_TIMEOUT_JVM_ARGS = [
  '-Dsun.net.client.defaultConnectTimeout=5000',
  '-Dsun.net.client.defaultReadTimeout=5000',
  // Certains vieux mods/librairies (netty legacy, etc.) gerent mal une pile
  // IPv6 mal configuree cote joueur (box/VPN qui annonce de l'IPv6 casse) :
  // force IPv4, le seul protocole que ces mods ont jamais vraiment teste.
  '-Djava.net.preferIPv4Stack=true'
];

// minecraft-launcher-core ajoute EN DUR, a chaque lancement, deux options JVM
// qui degradent la fluidite :
//  - `-XX:-UseAdaptiveSizePolicy` : desactive le dimensionnement adaptatif du
//    ramasse-miettes par defaut de Java 8 (ParallelGC) : les zones memoire
//    restent figees a leur taille de depart, ce qui provoque bien plus de
//    collectes et de "Full GC" avec un modpack lourd = micro-pauses en jeu.
//  - `-XX:-OmitStackTraceInFastThrow` : force la construction d'une pile
//    complete a CHAQUE exception, meme en boucle chaude : or les vieux mods
//    en lancent beaucoup (cf. les ArrayIndexOutOfBounds repetes dans les logs).
// Les autres launchers ne les passent pas. Les `customArgs` sont ajoutes APRES
// celles de mclc et la derniere occurrence d'une option l'emporte : on remet
// donc simplement les valeurs par defaut de la JVM. (Mesure sur charge type
// modpack lourd, Java 8, Xms2G/Xmx8G : 336 pauses > 20 ms avec les options
// mclc contre 14 avec les valeurs par defaut.)
const RESTORE_JVM_DEFAULTS_ARGS = [
  '-XX:+UseAdaptiveSizePolicy',
  '-XX:+OmitStackTraceInFastThrow'
];

// Reference vers le process Java du jeu actuellement lance (un seul a la
// fois, l'UI empeche deja d'en demarrer un second pendant qu'un premier
// tourne) : permet de le tuer de force si jamais il se bloque sans jamais
// se fermer proprement (ex: plantage interne qui laisse la JVM en vie sans
// emettre 'close', auquel cas le launcher ne peut sinon jamais le detecter).
let activeGameProcess = null;

function killActiveGame() {
  if (!activeGameProcess) return false;
  activeGameProcess.kill();
  activeGameProcess = null;
  return true;
}

// Branche les evenements mclc sur `onGameEvent`, avec un traitement special
// pour 'close' : sur un code de sortie non-nul (crash, pas une fermeture
// normale ni un "Forcer l'arret" : ce dernier tue le process donc son code
// est egalement non-nul, mais le renderer le distingue deja via son propre
// flag `forceStoppingGame`, cf. renderer.js), on essaie d'abord de lire
// logs/latest.log pour remonter un resume exploitable au joueur avant de
// transmettre l'evenement 'close' lui-meme : sinon il ne voit qu'un
// "le jeu a plante" sans aucune piste.
function wireGameEvents(launcher, dir, onGameEvent) {
  GAME_EVENTS.filter((evt) => evt !== 'close').forEach((evt) => {
    launcher.on(evt, (payload) => onGameEvent(evt, payload));
  });
  launcher.on('close', async (payload) => {
    activeGameProcess = null;
    if (payload) {
      const diagnosis = await diagnoseCrash(dir).catch(() => null);
      if (diagnosis) onGameEvent('crash-diagnosis', diagnosis);
    }
    onGameEvent('close', payload);
  });
}

function parseHostPort(serverAddress) {
  const [host, portStr] = (serverAddress || '').split(':');
  return { host, port: portStr ? Number(portStr) : 25565 };
}

// Sur Windows, prefere "javaw" (sous-systeme GUI, sans console) a "java"
// (sous-systeme console) pour le PROCESS DE JEU LUI-MEME. Ce n'est pas
// cosmetique : la bascule GPU automatique (registre par-app + heuristiques
// des pilotes Intel/NVIDIA/AMD) est associee au chemin exact de l'executable
// lance, et javaw.exe est ce que tous les launchers Minecraft serieux
// utilisent (constate sur cette machine : TLauncher n'enregistre QUE des
// javaw.exe dans le registre GPU, jamais de java.exe). Lancer via java.exe
// peut laisser la carte dediee non sollicitee meme avec la bonne preference
// enregistree. Sans impact sur la capture des logs (les flux stdout/stderr
// restent rediriges normalement par Node, console ou pas).
function preferJavaw(javaPath) {
  if (process.platform !== 'win32') return javaPath;
  if (javaPath.toLowerCase().endsWith('java.exe')) {
    return javaPath.slice(0, -('java.exe'.length)) + 'javaw.exe';
  }
  if (javaPath === 'java') return 'javaw';
  return javaPath;
}

// Si le joueur n'a pas explicitement configure un Java particulier (encore
// impossible aujourd'hui via l'UI, mais deja possible en editant
// settings.json a la main), on choisit nous-memes un Java installe
// compatible avec la version Minecraft ciblee plutot que de laisser mclc
// utiliser un "java" generique potentiellement incompatible (cf.
// javaRuntime.js : source probable de plantages/mauvaises performances sur
// des versions eloignees de celles pour lesquelles ce "java" du PATH
// convient).
async function autoResolveJavaPath(javaPath, mcVersion, onProgress = () => {}) {
  if (javaPath !== 'java') return javaPath; // override explicite : on ne touche a rien
  const vanillaJson = await fetchVanillaVersionJson(mcVersion);
  return resolveJavaForMajor(requiredJavaMajor(vanillaJson), onProgress);
}

// Retourne { version, forge? } : `version` est l'option `version` de mclc,
// `forge` (si present) est le chemin local de l'installeur Forge officiel a
// passer tel quel dans les options de mclc, qui sait le lire nativement
// (cf. installerLoader.js) sans avoir besoin d'un JSON "custom" pre-fusionne.
async function resolveVersion(server, javaPath) {
  const { minecraftVersion, loader } = server;

  switch (loader.type) {
    case 'vanilla':
      // `minecraftVersionType` (release/snapshot/old_beta/old_alpha) n'existe
      // que pour les installations libres (cf. launchCustomInstance) : les
      // serveurs configures par l'operateur sont toujours en version stable.
      return { version: { number: minecraftVersion, type: server.minecraftVersionType || 'release' } };

    case 'fabric':
    case 'quilt': {
      const customId = await prepareFabricLike(loader.type, minecraftVersion, loader.version);
      return { version: { number: minecraftVersion, type: 'release', custom: customId } };
    }

    case 'forge':
      return prepareForge(minecraftVersion, loader.version, server);

    case 'neoforge': {
      const customId = await prepareNeoForge(loader.version, javaPath);
      return { version: { number: minecraftVersion, type: 'release', custom: customId } };
    }

    default:
      throw new Error(`Loader non supporte: ${loader.type}`);
  }
}

// Verifie qu'il y a assez de place sur le disque avant de commencer a
// telecharger : evite un modpack a moitie telecharge suite a un disque
// plein en cours de route. Best-effort : si la detection de l'espace libre
// echoue, on laisse simplement passer (pas de fausse alerte bloquante).
async function ensureEnoughDiskSpace(dir, manifest) {
  const { toDownload } = await diffManifest(dir, manifest);
  const neededBytes = toDownload.reduce((sum, f) => sum + (f.size || 0), 0);
  if (neededBytes === 0) return;

  const freeBytes = getFreeBytes(dir);
  if (freeBytes === null) return;

  if (freeBytes < neededBytes * DISK_SPACE_MARGIN) {
    const toGb = (b) => (b / 1024 ** 3).toFixed(1);
    throw new Error(
      `Espace disque insuffisant : ${toGb(neededBytes)} Go necessaires, ${toGb(freeBytes)} Go disponibles. ` +
      `Liberez de l'espace avant de reessayer.`
    );
  }
}

// Orchestre l'ensemble du flux : recuperation du manifest, synchronisation du
// modpack (avec verification d'integrite), preparation du loader, puis
// lancement du jeu via minecraft-launcher-core.
async function syncAndLaunch({
  server,
  account,
  memory,
  javaPath = 'java',
  gpu = 'auto',
  onProgress = () => {},
  onGameEvent = () => {},
  // Objet partage (pas un booleen simple) : le bouton "Annuler" cote renderer
  // demande au main process de passer `cancelled` a true sur CE MEME objet
  // pendant que syncAndLaunch tourne encore : verifie avant/apres chaque
  // etape interruptible (essentiellement le telechargement du modpack, de
  // loin la partie la plus longue).
  cancelToken = { cancelled: false }
}) {
  const dir = instanceDir(server.id);

  // Le modpack est optionnel : un serveur vanilla (ou tout serveur sans
  // fichiers additionnels a distribuer) n'a pas de modpackId configure, et
  // il n'y a alors rien a synchroniser : mclc telecharge deja le client
  // vanilla/loader lui-meme plus bas via `launcher.launch(opts)`.
  if (server.modpackId) {
    if (cancelToken.cancelled) throw new SyncCancelledError();
    onProgress({ phase: 'manifest' });
    const manifest = await fetchManifest(server.modpackId);

    if (cancelToken.cancelled) throw new SyncCancelledError();
    onProgress({ phase: 'diskspace' });
    await ensureEnoughDiskSpace(dir, manifest);

    onProgress({ phase: 'sync' });
    const { downloaded } = await syncModpack(dir, manifest, (p) => onProgress({ ...p, phase: 'sync' }), { cancelToken });

    // Scan antivirus uniquement si de nouveaux fichiers ont ete telecharges
    // (pas a chaque lancement) : cf. avScan.js pour le detail du choix de
    // Windows Defender plutot qu'un scanner maison.
    if (downloaded > 0) {
      if (cancelToken.cancelled) throw new SyncCancelledError();
      onProgress({ phase: 'scan' });
      const scan = await scanForThreats(dir);
      if (scan.available && !scan.clean) {
        throw new Error(
          "Windows Defender a detecte une menace dans les fichiers recus du serveur. Lancement annule par securite : contactez l'administrateur avant de reessayer."
        );
      }
    }
  }

  if (cancelToken.cancelled) throw new SyncCancelledError();
  onProgress({ phase: 'whitelist' });
  await authorizeJoin(server.id, account.name, account.uuid, server.onlineMode, account);

  onProgress({ phase: 'loader' });
  javaPath = await autoResolveJavaPath(javaPath, server.minecraftVersion, onProgress);
  const { version, forge } = await resolveVersion(server, javaPath);
  const gameJavaPath = preferJavaw(javaPath);

  const launcher = new Client();
  wireGameEvents(launcher, dir, onGameEvent);

  // Connexion automatique au serveur au demarrage du jeu (evite au joueur de
  // devoir l'ajouter lui-meme dans le menu multijoueur) : ces arguments
  // `--server`/`--port` sont geres directement par le client Minecraft lui
  // meme depuis tres longtemps (bien avant mclc), donc valables sur toutes
  // les versions/loaders, contrairement au `quickPlay` de mclc qui ne
  // fonctionne qu'a partir de la 1.20. Reglable par serveur (case "Activer
  // l'auto-connexion" cote admin) : active par defaut (`!== false`, pas
  // `=== true`) pour ne rien casser sur les serveurs deja configures avant
  // l'ajout de ce champ, qui n'ont pas encore `autoConnect` dans servers.json.
  const { host, port } = parseHostPort(server.serverAddress);
  const customLaunchArgs = (host && server.autoConnect !== false) ? ['--server', host, '--port', String(port)] : [];

  const opts = {
    authorization: account,
    root: gameRoot(),
    version,
    forge,
    memory: { max: memory?.max || '4G', min: memory?.min || '2G' },
    javaPath: gameJavaPath,
    overrides: {
      gameDirectory: dir,
      // mclc met sinon le process java dans `root` (cache partage entre
      // instances/versions) au lieu du dossier de l'instance : inoffensif
      // sur les versions recentes (tout passe par --gameDir), mais les
      // tres vieilles versions (pre-1.6) resolvent certaines ressources
      // relativement au cwd reel du process, pas seulement via l'argument
      // --gameDir. Le vrai launcher Mojang lance toujours java depuis le
      // dossier .minecraft lui-meme : on reproduit ca ici.
      cwd: dir
    },
    customArgs: [...RESTORE_JVM_DEFAULTS_ARGS, ...NETWORK_TIMEOUT_JVM_ARGS, ...(server.javaArgs || [])],
    customLaunchArgs
  };

  // La preference GPU s'applique soit au niveau systeme (registre Windows),
  // soit via des variables d'environnement (Linux) que le process java
  // lance par mclc heritera : on les restaure juste apres le spawn.
  const gpuEnv = await applyGpuPreference(gameJavaPath, gpu);
  const previousEnv = {};
  for (const key of Object.keys(gpuEnv)) {
    previousEnv[key] = process.env[key];
    process.env[key] = gpuEnv[key];
  }

  onProgress({ phase: 'launching' });
  try {
    // mclc retourne le ChildProcess java : on le garde pour pouvoir le tuer
    // de force au besoin (cf. killActiveGame), alors qu'il etait ignore
    // jusqu'ici.
    activeGameProcess = await launcher.launch(opts);
  } finally {
    for (const key of Object.keys(gpuEnv)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
  onProgress({ phase: 'launched' });
}

// Force une reverification/retelechargement complet des fichiers du modpack
// (bouton "Reparer les fichiers"), sans lancer le jeu. Contrairement au sync
// normal, ignore l'etat local connu et retelecharge tout.
async function repairInstance(server, onProgress = () => {}) {
  if (!server.modpackId) {
    // Rien a reparer : serveur sans modpack (vanilla), seuls les fichiers
    // vanilla/loader partages sont concernes, geres par mclc lui-meme au
    // lancement (pas par la synchronisation de modpack).
    onProgress({ phase: 'done' });
    return;
  }

  onProgress({ phase: 'manifest' });
  const manifest = await fetchManifest(server.modpackId);

  const dir = instanceDir(server.id);

  onProgress({ phase: 'diskspace' });
  const { toDownload } = await diffManifest(dir, manifest, { force: true });
  const neededBytes = toDownload.reduce((sum, f) => sum + (f.size || 0), 0);
  const freeBytes = getFreeBytes(dir);
  if (freeBytes !== null && freeBytes < neededBytes * DISK_SPACE_MARGIN) {
    const toGb = (b) => (b / 1024 ** 3).toFixed(1);
    throw new Error(`Espace disque insuffisant : ${toGb(neededBytes)} Go necessaires, ${toGb(freeBytes)} Go disponibles.`);
  }

  onProgress({ phase: 'sync' });
  await syncModpack(dir, manifest, (p) => onProgress({ ...p, phase: 'sync' }), { force: true });
  onProgress({ phase: 'done' });
}

// Lance une installation "libre" (version + loader choisis par le joueur,
// page "Versions libres", comme le TLauncher) : pas de manifest/modpack, pas
// de whitelist/auto-connexion : juste vanilla + le loader demande. Reutilise
// `resolveVersion` en lui passant un objet "server" minimal, puisqu'il ne
// s'appuie que sur `minecraftVersion`/`loader` (et optionnellement
// `server.optifine`, absent ici : non pertinent hors modpack impose).
async function launchCustomInstance({
  instance,
  account,
  memory,
  javaPath = 'java',
  gpu = 'auto',
  onProgress = () => {},
  onGameEvent = () => {}
}) {
  const dir = customInstanceDir(instance.id);

  onProgress({ phase: 'loader' });
  javaPath = await autoResolveJavaPath(javaPath, instance.mcVersion, onProgress);
  const { version, forge } = await resolveVersion(
    { minecraftVersion: instance.mcVersion, minecraftVersionType: instance.mcVersionType, loader: instance.loader },
    javaPath
  );
  const gameJavaPath = preferJavaw(javaPath);

  const launcher = new Client();
  wireGameEvents(launcher, dir, onGameEvent);

  const opts = {
    authorization: account,
    root: gameRoot(),
    version,
    forge,
    memory: { max: memory?.max || '4G', min: memory?.min || '2G' },
    javaPath: gameJavaPath,
    // cf. commentaire equivalent dans syncAndLaunch : sans `cwd`, mclc lance
    // java depuis `root` (cache partage) au lieu du dossier de l'instance,
    // ce qui casse certaines tres vieilles versions (pre-1.6).
    overrides: { gameDirectory: dir, cwd: dir },
    customArgs: [...RESTORE_JVM_DEFAULTS_ARGS, ...NETWORK_TIMEOUT_JVM_ARGS]
  };

  const gpuEnv = await applyGpuPreference(gameJavaPath, gpu);
  const previousEnv = {};
  for (const key of Object.keys(gpuEnv)) {
    previousEnv[key] = process.env[key];
    process.env[key] = gpuEnv[key];
  }

  onProgress({ phase: 'launching' });
  try {
    // mclc retourne le ChildProcess java : on le garde pour pouvoir le tuer
    // de force au besoin (cf. killActiveGame), alors qu'il etait ignore
    // jusqu'ici.
    activeGameProcess = await launcher.launch(opts);
  } finally {
    for (const key of Object.keys(gpuEnv)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
  onProgress({ phase: 'launched' });
}

// Le bouton d'un serveur affiche "Installer" tant que ceci renvoie false,
// "Jouer" ensuite : verifie sans RIEN telecharger. Avec modpack : diff reel
// contre le manifest distant (aucun fichier a recuperer = installe). Sans
// modpack (vanilla) : rien a nous de propre a verifier (mclc gere son cache
// partage lui-meme au lancement), donc on se base sur la simple existence du
// dossier d'instance : cree des le premier lancement reussi.
async function checkInstanceInstalled(server) {
  const dir = instanceDir(server.id);
  if (!server.modpackId) return fs.existsSync(dir);
  try {
    const manifest = await fetchManifest(server.modpackId);
    const { toDownload } = await diffManifest(dir, manifest);
    return toDownload.length === 0;
  } catch {
    return false;
  }
}

async function checkCustomInstanceInstalled(instance) {
  return fs.existsSync(customInstanceDir(instance.id));
}

module.exports = {
  syncAndLaunch, repairInstance, launchCustomInstance,
  checkInstanceInstalled, checkCustomInstanceInstalled, killActiveGame
};
