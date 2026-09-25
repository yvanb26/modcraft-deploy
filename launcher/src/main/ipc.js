const { ipcMain, BrowserWindow, shell, app, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('./core/logger');
const { fetchConfig, fetchConfigIfChanged } = require('./apiClient');
const { createOfflineProfile } = require('./auth/offline');
const { authenticateElyBy, refreshElyBySession } = require('./auth/elyby');
const { authenticateMicrosoft, reacquireMicrosoft } = require('./auth/microsoft');
const {
  syncAndLaunch, repairInstance, launchCustomInstance, checkInstanceInstalled, checkCustomInstanceInstalled,
  killActiveGame
} = require('./core/launch');
const { SyncCancelledError } = require('./core/integrity');
const { getServerSettings, setServerSettings } = require('./core/settings');
const { getPreferences, setPreferences, upsertAccount, removeAccount } = require('./core/preferences');
const { pingServer } = require('./core/serverPing');
const { listGpus } = require('./core/gpu');
const { instanceDir, customInstanceDir } = require('./core/paths');
const { setPresence, clearPresence } = require('./core/discordPresence');
const {
  listCustomInstances, getCustomInstance, createCustomInstance, removeCustomInstance, renameCustomInstance
} = require('./core/customInstances');
const { listMinecraftVersions, listLoaderVersions } = require('./core/versionCatalog');
const { clearSharedCache } = require('./core/cache');

let cachedConfig = null;
let selectedAccount = null;
// Un seul lancement possible a la fois (cf. blocage cote renderer des
// boutons "Jouer" pendant qu'un autre tourne) : un seul jeton d'annulation
// "actif" suffit donc, pas besoin de le indexer par serveur.
let activeCancelToken = null;

// --- Journalisation automatique de tout appel IPC (= a peu pres "toute
// action de l'utilisateur dans l'app", puisque chaque bouton/action passe
// par un de ces canaux) -------------------------------------------------
// Plutot que d'ajouter un log.info(...) a la main dans chacun des ~30
// handlers (facile a oublier sur les prochains ajouts), on enveloppe
// ipcMain.handle lui-meme : chaque appel est trace en entree/sortie avec sa
// duree, sans exception possible. Les champs sensibles (mots de passe,
// jetons de session...) sont masques avant ecriture : jamais en clair dans
// le fichier de log.
const SENSITIVE_KEYS = new Set([
  'password', 'totpToken', 'accessToken', 'clientToken', 'refreshToken',
  'access_token', 'client_token', 'homeAccountId', 'launcherKey'
]);

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.has(key) ? '[masque]' : redact(val, depth + 1);
  }
  return out;
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    const startedAt = Date.now();
    log.info(`[ipc] -> ${channel}`, ...redact(args));
    try {
      const result = await handler(event, ...args);
      log.info(`[ipc] <- ${channel} (${Date.now() - startedAt}ms)`, redact(result));
      return result;
    } catch (err) {
      log.error(`[ipc] x  ${channel} (${Date.now() - startedAt}ms):`, err.message);
      throw err;
    }
  });
}

// Les reglages/dossier d'une installation libre (page "Versions libres") sont
// identifies avec un prefixe "custom:<id>" cote renderer : ca permet de
// reutiliser tel quel le meme modal de reglages (memoire/GPU) et le meme
// stockage `settings.js` (deja indexe par un id de chaine arbitraire) que
// pour les serveurs, sans dupliquer ce composant.
function resolveInstanceDir(id) {
  return id.startsWith('custom:') ? customInstanceDir(id.slice('custom:'.length)) : instanceDir(id);
}

// Certains mods (bugues ou juste tres verbeux) peuvent spammer la console du
// jeu en continu, des centaines/milliers de lignes par seconde, sans jamais
// s'arreter : vu en vrai. Sans regroupement, CHAQUE ligne devient un
// message IPC separe + une mise a jour du DOM cote renderer (concatenation +
// scroll, couteux), ce qui sature la file de messages Electron. Comme cette
// file est strictement ordonnee, l'evenement 'close' (envoye des la vraie
// fermeture du process java) se retrouve coince derriere des milliers de
// lignes de log deja obsoletes en attente de traitement : le joueur voit le
// launcher mettre plusieurs MINUTES a "detecter" une fermeture pourtant deja
// arrivee. On regroupe donc 'data'/'debug' (traites identiquement par
// appendLog cote renderer) en lots envoyes au plus toutes les 120ms, tout en
// laissant les autres evenements (progress, close...) passer immediatement.
const LOG_FLUSH_INTERVAL_MS = 120;
const LOG_BUFFER_MAX_LINES = 2000; // garde-fou si meme les flushes prennent du retard

// Callbacks de progression/evenements partages entre le lancement d'un
// serveur et celui d'une installation libre : reduction de la fenetre +
// Discord RPC au demarrage du jeu, restauration a sa fermeture.
function wireLaunchCallbacks(event, win, discordRpc, presenceDetails) {
  let logBuffer = [];
  let flushTimer = null;

  function flushLogBuffer() {
    if (logBuffer.length === 0) return;
    const chunk = logBuffer.join('\n');
    logBuffer = [];
    event.sender.send('launch:game-event', 'data', chunk);
  }

  function stopFlushing() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    flushLogBuffer();
  }

  return {
    onProgress: (p) => {
      event.sender.send('launch:progress', p);
      if (p.phase === 'launched') {
        if (win && !win.isDestroyed()) win.minimize();
        if (discordRpc?.enabled && discordRpc.clientId) {
          setPresence(discordRpc.clientId, {
            details: presenceDetails,
            state: cachedConfig.branding.launcherName,
            startTimestamp: Date.now()
          });
        }
      }
    },
    onGameEvent: (evt, payload) => {
      if (evt === 'data' || evt === 'debug') {
        logBuffer.push(String(payload));
        if (logBuffer.length > LOG_BUFFER_MAX_LINES) logBuffer = logBuffer.slice(-LOG_BUFFER_MAX_LINES);
        if (!flushTimer) flushTimer = setInterval(flushLogBuffer, LOG_FLUSH_INTERVAL_MS);
        return;
      }

      // Tout evenement non-log (et en particulier 'close') doit d'abord
      // vider le buffer en attente, pour que l'ordre d'affichage reste
      // correct : sans quoi les toutes dernieres lignes de log arriveraient
      // APRES le message "le jeu a plante"/"ferme".
      if (evt === 'close') stopFlushing();
      event.sender.send('launch:game-event', evt, payload);
      if (evt === 'close') {
        if (win && !win.isDestroyed()) win.restore();
        clearPresence();
      }
    }
  };
}

// --- Fenetre sans cadre natif : boutons reduire/agrandir/fermer dessines par
// le renderer (cf. .window-controls), donc pilotes via IPC. Volontairement
// hors de `handle()` : ces appels sont triviaux et frequents, pas utiles a
// tracer dans les logs.
const windowFit = new WeakMap(); // win -> { base, grown } (hauteur avant/apres agrandissement auto)

function senderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function registerWindowHandlers() {
  ipcMain.handle('window:minimize', (event) => { senderWindow(event)?.minimize(); });
  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = senderWindow(event);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', (event) => { senderWindow(event)?.close(); });
  ipcMain.handle('window:is-maximized', (event) => !!senderWindow(event)?.isMaximized());

  // Agrandit la fenetre (jamais au-dela de l'ecran) quand le contenu ne tient
  // plus : ex: le panneau console qui apparait : plutot que d'afficher un
  // ascenseur. `height` = hauteur de contenu necessaire, en pixels.
  ipcMain.handle('window:fit-height', (event, { height }) => {
    const win = senderWindow(event);
    if (!win || win.isMaximized() || win.isFullScreen() || !Number.isFinite(height)) return { ok: false };

    const [width, current] = win.getContentSize();
    const frameHeight = win.getSize()[1] - current;
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    const target = Math.min(Math.ceil(height), workArea.height - frameHeight);
    if (target <= current) return { ok: true, resized: false };

    const state = windowFit.get(win);
    windowFit.set(win, { base: state ? state.base : current, grown: target });
    win.setContentSize(width, target);

    // Garde la fenetre entierement a l'ecran (elle grandit vers le bas).
    const bounds = win.getBounds();
    const overflow = bounds.y + bounds.height - (workArea.y + workArea.height);
    if (overflow > 0) win.setPosition(bounds.x, Math.max(workArea.y, bounds.y - overflow));
    return { ok: true, resized: true };
  });

  // Reviens a la taille d'origine une fois le contenu additionnel disparu :
  // sauf si l'utilisateur a redimensionne la fenetre entre-temps.
  ipcMain.handle('window:restore-height', (event) => {
    const win = senderWindow(event);
    const state = win && windowFit.get(win);
    if (!state) return { ok: false };
    windowFit.delete(win);
    const [width, current] = win.getContentSize();
    if (win.isMaximized() || current !== state.grown) return { ok: false };
    win.setContentSize(width, state.base);
    return { ok: true };
  });
}

function registerIpcHandlers() {
  registerWindowHandlers();

  // Journal de la page (cf. preload.js) : niveau et taille bornes, la page ne choisit rien d'autre.
  ipcMain.on('renderer:log', (_event, level, args) => {
    if (!['info', 'warn', 'error', 'debug'].includes(level) || !Array.isArray(args)) return;
    log[level]('[renderer]', ...args.slice(0, 10).map((a) => String(a).slice(0, 2000)));
  });

  // Rafraichissement en direct (annonces, serveurs) : requete conditionnelle (ETag), rien n'est telecharge si la
  // configuration n'a pas change. Volontairement hors de handle() : appele chaque minute, sans bruit dans main.log.
  ipcMain.handle('config:refresh', async () => {
    try {
      const fresh = await fetchConfigIfChanged();
      if (!fresh) return { changed: false };
      cachedConfig = fresh;
      log.info('[config] configuration mise a jour a chaud (annonces / serveurs)');
      return { changed: true, config: fresh };
    } catch (err) {
      return { changed: false, error: err.message };
    }
  });

  handle('config:load', async () => {
    cachedConfig = await fetchConfig();
    return cachedConfig;
  });

  handle('app:version', () => app.getVersion());

  handle('account:offline', async (_event, { username }) => {
    selectedAccount = await createOfflineProfile(username);
    // Comme les autres providers (Ely.by/Microsoft) et comme le volume de la
    // musique : toujours memorise, pas de case a cocher a part.
    upsertAccount({ id: `offline:${selectedAccount.name}`, provider: 'offline', name: selectedAccount.name });
    return { name: selectedAccount.name, uuid: selectedAccount.uuid, provider: 'offline' };
  });

  handle('account:elyby', async (_event, { username, password, totpToken }) => {
    selectedAccount = await authenticateElyBy(username, password, totpToken);
    upsertAccount({
      id: `elyby:${selectedAccount.uuid}`,
      provider: 'elyby',
      name: selectedAccount.name,
      uuid: selectedAccount.uuid,
      accessToken: selectedAccount.access_token,
      clientToken: selectedAccount.client_token
    });
    return { name: selectedAccount.name, uuid: selectedAccount.uuid, provider: 'elyby' };
  });

  handle('account:microsoft', async () => {
    if (!cachedConfig) cachedConfig = await fetchConfig();
    const clientId = cachedConfig?.branding?.microsoftAuth?.clientId;

    selectedAccount = await authenticateMicrosoft(clientId);
    upsertAccount({
      id: `microsoft:${selectedAccount.uuid}`,
      provider: 'microsoft',
      name: selectedAccount.name,
      uuid: selectedAccount.uuid,
      homeAccountId: selectedAccount.homeAccountId
    });
    return { name: selectedAccount.name, uuid: selectedAccount.uuid, provider: 'microsoft' };
  });

  handle('account:logout', () => {
    selectedAccount = null;
    // Revient a l'ecran de connexion, mais garde le compte dans le
    // gestionnaire pour un changement rapide plus tard (accounts:remove pour
    // l'oublier completement).
    setPreferences({ activeAccountId: null });
    return { ok: true };
  });

  // --- Gestionnaire de comptes (switch rapide, comme TLauncher) -----------
  handle('accounts:list', () => {
    const prefs = getPreferences();
    return { accounts: prefs.accounts, activeAccountId: prefs.activeAccountId };
  });

  handle('accounts:switch', async (_event, id) => {
    const prefs = getPreferences();
    const account = prefs.accounts.find((a) => a.id === id);
    if (!account) throw new Error('Compte introuvable.');

    if (account.provider === 'offline') {
      selectedAccount = await createOfflineProfile(account.name);
      setPreferences({ activeAccountId: id });
      return { name: selectedAccount.name, uuid: selectedAccount.uuid, provider: 'offline' };
    }

    if (account.provider === 'elyby') {
      selectedAccount = await refreshElyBySession(account.accessToken, account.clientToken);
      upsertAccount({
        id,
        provider: 'elyby',
        name: selectedAccount.name,
        uuid: selectedAccount.uuid,
        accessToken: selectedAccount.access_token,
        clientToken: selectedAccount.client_token
      });
      return { name: selectedAccount.name, uuid: selectedAccount.uuid, provider: 'elyby' };
    }

    if (account.provider === 'microsoft') {
      if (!cachedConfig) cachedConfig = await fetchConfig();
      const clientId = cachedConfig?.branding?.microsoftAuth?.clientId;
      selectedAccount = await reacquireMicrosoft(clientId, account.homeAccountId);
      setPreferences({ activeAccountId: id });
      return { name: selectedAccount.name, uuid: selectedAccount.uuid, provider: 'microsoft' };
    }

    throw new Error(`Type de compte inconnu: ${account.provider}`);
  });

  handle('accounts:remove', (_event, id) => {
    removeAccount(id);
    return { ok: true };
  });

  handle('settings:get', (_event, serverId) => getServerSettings(serverId));
  handle('settings:set', (_event, { serverId, patch }) => setServerSettings(serverId, patch));

  handle('preferences:get', () => getPreferences());
  handle('preferences:set', (_event, patch) => setPreferences(patch));

  handle('server:ping', (_event, { host, port }) => pingServer(host, port));
  handle('gpu:list', () => listGpus());
  handle('cache:clear', () => clearSharedCache());

  // --- Mode debug cache (5 clics sur le logo) -----------------------------
  // Ouvre les vraies DevTools Chromium (console complete, reseau, etc.) et le
  // dossier des logs dans l'explorateur : pratique pour du support a
  // distance sans devoir livrer un build "debug" a part.
  handle('debug:open-devtools', (event) => {
    event.sender.openDevTools({ mode: 'detach' });
    return { ok: true };
  });

  handle('debug:open-logs-folder', () => {
    const logFile = log.transports.file.getFile().path;
    shell.showItemInFolder(logFile);
    return { ok: true, logFile };
  });

  // Ouvre un lien dans le navigateur systeme (ex: gestion du skin sur
  // Ely.by) : limite volontairement a http(s) pour eviter qu'un contenu
  // distant (branding, etc.) ne puisse faire ouvrir un schema arbitraire
  // (file:, etc.) via ce canal.
  handle('shell:open-external', (_event, url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('URL non autorisee.');
    return shell.openExternal(url);
  });

  handle('system:info', () => ({
    totalMemoryGb: Math.floor(os.totalmem() / 1024 ** 3)
  }));

  handle('instance:open-folder', (_event, id) => {
    const dir = resolveInstanceDir(id);
    fs.mkdirSync(dir, { recursive: true }); // au cas ou le joueur n'a jamais encore lance cette instance
    return shell.openPath(dir);
  });

  handle('instance:open-logs', (_event, id) => {
    const dir = resolveInstanceDir(id);
    const logsDir = path.join(dir, 'logs');
    const target = fs.existsSync(logsDir) ? logsDir : dir;
    fs.mkdirSync(target, { recursive: true });
    return shell.openPath(target);
  });

  // Utilise pour suggerer une RAM adaptee dans la popup de reglages : un
  // modpack avec plusieurs centaines de Mo de mods (donc generalement
  // beaucoup de mods actifs) a besoin de bien plus que les 2-4 Go par
  // defaut, mais on ne peut pas le savoir a l'avance sans regarder ce qui a
  // reellement ete synchronise sur le disque du joueur.
  handle('instance:mods-size', (_event, id) => {
    const modsDir = path.join(resolveInstanceDir(id), 'mods');
    let bytes = 0;
    function walk(dir) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          try {
            bytes += fs.statSync(full).size;
          } catch {
            // fichier supprime entre le readdir et le stat : ignore
          }
        }
      }
    }
    walk(modsDir);
    return { bytes };
  });

  handle('instance:repair', async (event, serverId) => {
    if (!cachedConfig) cachedConfig = await fetchConfig();
    const server = cachedConfig.servers.find((s) => s.id === serverId);
    if (!server) throw new Error(`Serveur inconnu: ${serverId}`);

    await repairInstance(server, (p) => event.sender.send('instance:repair-progress', p));
    return { ok: true };
  });

  handle('server:launch', async (event, { serverId }) => {
    if (!selectedAccount) {
      throw new Error('Aucun compte connecte. Connectez-vous avant de lancer le jeu.');
    }
    if (!cachedConfig) cachedConfig = await fetchConfig();

    const server = cachedConfig.servers.find((s) => s.id === serverId);
    if (!server) throw new Error(`Serveur inconnu: ${serverId}`);

    const settings = getServerSettings(serverId);
    const win = BrowserWindow.fromWebContents(event.sender);
    const discordRpc = cachedConfig.branding?.discordRpc;

    const cancelToken = { cancelled: false };
    activeCancelToken = cancelToken;
    try {
      await syncAndLaunch({
        server,
        account: selectedAccount,
        memory: { min: `${settings.memoryMinGb}G`, max: `${settings.memoryMaxGb}G` },
        javaPath: settings.javaPath,
        gpu: settings.gpu,
        cancelToken,
        ...wireLaunchCallbacks(event, win, discordRpc, `Joue sur ${server.name}`)
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof SyncCancelledError) {
        // "Annuler" supprime aussi ce qui a deja ete telecharge pour cette
        // tentative : repartir d'un dossier propre au prochain essai plutot
        // que de laisser un modpack a moitie installe (potentiellement
        // incoherent, cf. .legacy-launcher-manifest.json pas encore ecrit).
        await fs.promises.rm(instanceDir(serverId), { recursive: true, force: true }).catch(() => {});
        return { ok: true, cancelled: true };
      }
      throw err;
    } finally {
      if (activeCancelToken === cancelToken) activeCancelToken = null;
    }
  });

  handle('launch:cancel', () => {
    if (activeCancelToken) activeCancelToken.cancelled = true;
    return { ok: true };
  });

  // "Forcer l'arret" : tue le process Java du jeu en cours si jamais il se
  // bloque sans jamais se fermer proprement (le launcher ne peut sinon
  // jamais le detecter, faute d'evenement 'close' emis).
  handle('game:kill', () => ({ ok: killActiveGame() }));

  handle('server:check-installed', async (_event, serverId) => {
    if (!cachedConfig) cachedConfig = await fetchConfig();
    const server = cachedConfig.servers.find((s) => s.id === serverId);
    if (!server) return { installed: false };
    return { installed: await checkInstanceInstalled(server) };
  });

  // --- Installations libres (page "Versions libres", comme le TLauncher) ---
  // Le joueur choisit lui-meme une version Minecraft + un loader, independant
  // des serveurs/modpacks fixes par l'operateur : activable via
  // `branding.customInstances.enabled`.
  handle('catalog:mcversions', () => listMinecraftVersions());
  handle('catalog:loaderversions', (_event, { type, mcVersion }) => listLoaderVersions(type, mcVersion));

  handle('custominstances:list', () => listCustomInstances());
  handle('custominstances:create', (_event, patch) => createCustomInstance(patch));
  handle('custominstances:remove', (_event, id) => {
    removeCustomInstance(id);
    return { ok: true };
  });
  handle('custominstances:rename', (_event, { id, name }) => renameCustomInstance(id, name));

  handle('custominstance:launch', async (event, { id }) => {
    if (!selectedAccount) {
      throw new Error('Aucun compte connecte. Connectez-vous avant de lancer le jeu.');
    }
    if (!cachedConfig) cachedConfig = await fetchConfig();

    const instance = getCustomInstance(id);
    const settings = getServerSettings(`custom:${id}`);
    const win = BrowserWindow.fromWebContents(event.sender);
    const discordRpc = cachedConfig.branding?.discordRpc;

    await launchCustomInstance({
      instance,
      account: selectedAccount,
      memory: { min: `${settings.memoryMinGb}G`, max: `${settings.memoryMaxGb}G` },
      javaPath: settings.javaPath,
      gpu: settings.gpu,
      ...wireLaunchCallbacks(event, win, discordRpc, `Joue sur ${instance.name}`)
    });

    return { ok: true };
  });

  handle('custominstance:check-installed', async (_event, id) => {
    const instance = getCustomInstance(id);
    if (!instance) return { installed: false };
    return { installed: await checkCustomInstanceInstalled(instance) };
  });
}

module.exports = { registerIpcHandlers };
