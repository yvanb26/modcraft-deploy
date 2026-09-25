const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, shell, Notification } = require('electron');

// Tout premier require : capture aussi les erreurs qui pourraient survenir
// pendant le chargement des modules suivants.
const log = require('./core/logger');

const { registerIpcHandlers } = require('./ipc');
const { fetchConfig } = require('./apiClient');
const { launcherConfigPath } = require('./core/launcherConfig');
const { UPDATE_FEED_URL, UPDATE_PUBLIC_KEY } = require('./core/updateConfig');
const { verifySignedUpdate } = require('./core/updateVerify');

// Filet de securite : sans ca, une exception non rattrapee dans le process
// principal (bug, dependance qui plante...) se contente d'un stacktrace dans
// une console que personne ne regarde en prod, puis l'app se ferme sans
// laisser de trace exploitable pour le support.
process.on('uncaughtException', (err) => log.error('[main] Exception non rattrapee:', err));
process.on('unhandledRejection', (reason) => log.error('[main] Promesse rejetee non geree:', reason));

// Sans ca, Chromium bloque la lecture audio tant que l'utilisateur n'a pas
// interagi avec la page : on veut que la musique de branding demarre toute
// seule a l'ouverture du launcher.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Icone de la fenetre (barre des taches/barre de titre) pilotee par
// `branding.windowIconUrl`, sans jamais recompiler le launcher. Note :
// l'icone du FICHIER .exe/installeur lui-meme (visible dans l'explorateur de
// fichiers avant meme de lancer l'app) reste, elle, embarquee a la
// compilation (electron-builder) : ca, ca necessite toujours un rebuild.
async function downloadWindowIcon(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const ext = path.extname(new URL(url).pathname) || '.png';
    const iconPath = path.join(app.getPath('userData'), `window-icon${ext}`);
    fs.writeFileSync(iconPath, buffer);
    return iconPath;
  } catch {
    return null; // best-effort : pas d'icone personnalisee si ca echoue
  }
}

function createWindow(iconPath) {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    // Pas de barre de titre native : le renderer dessine ses propres boutons
    // reduire/agrandir/fermer (zone deplacable = <header>, cf. styles.css).
    frame: false,
    autoHideMenuBar: true,
    icon: iconPath || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Sans ca, Chromium ralentit/coupe les timers et l'audio des qu'on
      // minimise la fenetre (ce qu'on fait au lancement du jeu) : ca coupait
      // le fondu de musique en plein milieu au lieu de le laisser descendre
      // en douceur, entendu comme un "crash" audio brutal.
      backgroundThrottling: false
    }
  });

  const sendWindowState = () => {
    if (!win.isDestroyed()) win.webContents.send('window:state', { maximized: win.isMaximized() });
  };
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    log.error('[main] Renderer termine de facon anormale:', details);
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

// Mise a jour automatique du launcher : le flux (provider "generic") pointe
// vers `<apiBaseUrl>/updates`, un simple dossier statique : publiez-y
// l'installeur genere par `npm run dist` + son `latest.yml` (voir README).
// Entierement best-effort : pas d'update publiee, pas de connexion, ou
// mauvaise config -> on ignore silencieusement, ca ne doit jamais empecher
// de lancer le launcher.
function checkForUpdates() {
  try {
    const { autoUpdater } = require('electron-updater');
    // URL fixe (cf. core/updateConfig.js), PAS l'apiBaseUrl du fichier
    // launcher.config.json : n'importe quelle communaute peut reconfigurer
    // apiBaseUrl vers son propre serveur (branding/servers/news), mais le
    // canal de mise a jour du LOGICIEL reste toujours celui code en dur :
    // seul le build officiel compile par VicTeams peut le changer.
    autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URL });
    // Telechargement manuel : on ne telecharge que si latest.yml est SIGNE par l'editeur (cf. core/updateVerify.js).
    autoUpdater.autoDownload = false;
    autoUpdater.on('error', (err) => log.warn('[updater] Echec de la verification/mise a jour:', err));
    autoUpdater.on('update-available', async (info) => {
      log.info('[updater] Mise a jour disponible:', info.version);
      const check = await verifySignedUpdate({ feedUrl: UPDATE_FEED_URL, publicKey: UPDATE_PUBLIC_KEY, info });
      if (!check.ok) {
        log.error(`[updater] Mise a jour ${info.version} REFUSEE : ${check.reason}`);
        return;
      }
      log.info(`[updater] Signature valide (${check.version}) : telechargement.`);
      autoUpdater.downloadUpdate().catch((err) => log.warn('[updater] Telechargement impossible:', err));
    });
    autoUpdater.on('update-downloaded', (info) => {
      log.info('[updater] Mise a jour telechargee, installee a la fermeture:', info.version);
      new Notification({ title: 'Mise a jour prete', body: `La version ${info.version} sera installee quand vous fermerez le launcher.` }).show();
    });
    autoUpdater.checkForUpdates().catch((err) => log.warn('[updater] checkForUpdates a echoue:', err));
  } catch (err) {
    // electron-updater absent du build (ex: execution en dev non empaquetee)
    log.debug('[updater] electron-updater indisponible (build de dev ?):', err.message);
  }
}

log.info(`[main] Demarrage : version ${app.getVersion()}, ${process.platform}/${process.arch}`);

app.whenReady().then(async () => {
  // Trace le fichier de configuration REELLEMENT utilise (un fichier externe
  // a l'application, modifiable apres installation : cf. core/launcherConfig.js) :
  // premier reflexe de support quand un launcher pointe vers la mauvaise API
  // ou refuse la connexion (launcherKey obsolete...).
  log.info(`[main] Configuration : ${launcherConfigPath()}`);

  registerIpcHandlers();

  let iconPath = null;
  try {
    const config = await fetchConfig();
    if (config?.branding?.windowIconUrl) {
      iconPath = await downloadWindowIcon(config.branding.windowIconUrl);
    }
  } catch (err) {
    // API injoignable au demarrage : pas d'icone personnalisee, le reste du
    // launcher affichera normalement l'ecran "connexion refusee".
    log.warn('[main] Impossible de recuperer la config au demarrage:', err.message);
  }

  createWindow(iconPath);
  checkForUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(iconPath);
  });
});

app.on('window-all-closed', () => {
  log.info('[main] Toutes les fenetres sont fermees, arret de l\'app.');
  if (process.platform !== 'darwin') app.quit();
});
