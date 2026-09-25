const path = require('path');
const { app, BrowserWindow, shell, Notification } = require('electron');

const { registerIpcHandlers } = require('./ipc');
const { getApiDir, canScaffoldApiDir, scaffoldApiDir } = require('./core/apiConfig');
const { stopServer } = require('./core/serverProcess');
const { UPDATE_FEED_URL, UPDATE_PUBLIC_KEY } = require('./core/updateConfig');
const { verifySignedUpdate } = require('./core/updateVerify');

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    // Pas de barre de titre native : le renderer dessine ses propres boutons
    // reduire/agrandir/fermer (zone deplacable = <header>, cf. styles.css).
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Liens externes (ex: Ko-fi) : navigateur / client mail par defaut, https et mailto
  // uniquement ; l'app ne
  // navigue jamais ailleurs que vers sa propre page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https:\/\/|mailto:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });

  const sendWindowState = () => {
    if (!win.isDestroyed()) win.webContents.send('window:state', { maximized: win.isMaximized() });
  };
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// Mise a jour automatique de l'outil (electron-updater, flux "generic" : un simple dossier web).
// Au demarrage, l'app lit latest.yml ; si une version plus recente existe, elle telecharge
// l'installateur, verifie son empreinte et propose de l'installer a la fermeture.
// Entierement best-effort : hors ligne, pas de mise a jour publiee ou app non empaquetee (dev)
// -> ignore silencieusement, l'outil demarre normalement.
function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URL });
    // Telechargement manuel : on ne telecharge que si latest.yml est SIGNE par l'editeur (cf. core/updateVerify.js).
    autoUpdater.autoDownload = false;
    autoUpdater.on('error', (err) => console.warn('[updater] verification/mise a jour impossible :', err?.message || err));
    autoUpdater.on('update-available', async (info) => {
      console.log('[updater] mise a jour disponible :', info.version);
      const check = await verifySignedUpdate({ feedUrl: UPDATE_FEED_URL, publicKey: UPDATE_PUBLIC_KEY, info });
      if (!check.ok) {
        console.error(`[updater] mise a jour ${info.version} REFUSEE : ${check.reason}`);
        return;
      }
      console.log(`[updater] signature valide (${check.version}) : telechargement.`);
      autoUpdater.downloadUpdate().catch((err) => console.warn('[updater] telechargement impossible :', err?.message || err));
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log('[updater] mise a jour telechargee, installee a la fermeture :', info.version);
      new Notification({ title: 'Mise a jour prete', body: `La version ${info.version} sera installee quand vous fermerez l'outil admin.` }).show();
    });
    autoUpdater.checkForUpdates().catch((err) => console.warn('[updater] echec :', err?.message || err));
  } catch (err) {
    console.warn('[updater] electron-updater indisponible :', err.message);
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  // Premier lancement d'une version installee : on cree tout de suite le dossier de donnees
  // (api/ a partir du modele embarque) pour que l'outil soit utilisable sans aucune etape.
  if (app.isPackaged && !getApiDir() && canScaffoldApiDir()) {
    try { scaffoldApiDir(); } catch (err) { console.warn('[api] creation automatique impossible :', err.message); }
  }
  createWindow();
  checkForUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopServer(); // ne laisse jamais un serveur de test tourner orphelin en arriere-plan
  if (process.platform !== 'darwin') app.quit();
});
