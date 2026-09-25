const { ipcMain, dialog, BrowserWindow } = require('electron');

const { getApiDir, resolveApiDir, canScaffoldApiDir, scaffoldApiDir } = require('./core/apiConfig');
const { getSftpConfig, setSftpConfig } = require('./core/configStore');
const { startServer, stopServer, isRunning, getLog, getSource } = require('./core/serverProcess');
const { backupDir, createBackup, getBackupInfo } = require('./core/backup');
const dataFiles = require('./core/dataFiles');
const { listMinecraftVersions, listLoaderVersions } = require('./core/versionCatalog');
const {
  deploySftpCode, deploySftpConfig, diffSftpConfig, listSftpRemote,
  deploySftpDataFile, deploySftpServersWithModpacks
} = require('./core/deploy');
const mcServer = require('./core/mcServer');

function requireApiDir() {
  const dir = getApiDir();
  if (!dir) throw new Error(`Dossier "api/" introuvable (${resolveApiDir()}) : utilisez le bouton de recreation ou importez un dossier api/ existant.`);
  return dir;
}

// Fenetre sans cadre natif : boutons reduire/agrandir/fermer dessines par le
// renderer (cf. .window-controls), donc pilotes via IPC.
function registerWindowHandlers() {
  const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);
  ipcMain.handle('window:minimize', (event) => { senderWindow(event)?.minimize(); });
  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = senderWindow(event);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('window:close', (event) => { senderWindow(event)?.close(); });
  ipcMain.handle('window:is-maximized', (event) => !!senderWindow(event)?.isMaximized());
}

function registerIpcHandlers() {
  registerWindowHandlers();
  ipcMain.handle('apidir:get', () => getApiDir());
  ipcMain.handle('apidir:can-scaffold', () => canScaffoldApiDir());
  ipcMain.handle('apidir:scaffold', () => scaffoldApiDir());

  // --- Serveur API local (pour tester avant de pousser en prod) -----------
  ipcMain.handle('server:status', () => ({ running: isRunning(), log: getLog(), source: getSource() }));

  ipcMain.handle('server:start', (event) => {
    const apiDir = requireApiDir();
    startServer(apiDir, 'live', (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('server:log-data', chunk);
    });
    return { ok: true };
  });

  ipcMain.handle('server:start-backup', (event) => {
    if (!getBackupInfo().exists) throw new Error('Aucune sauvegarde disponible : faites d\'abord une sauvegarde.');
    startServer(backupDir(), 'backup', (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('server:log-data', chunk);
    });
    return { ok: true };
  });

  ipcMain.handle('server:stop', () => {
    stopServer();
    return { ok: true };
  });

  ipcMain.handle('server:local-launcher-config', () => dataFiles.getLocalLauncherConfig(requireApiDir()));

  // --- Cle du launcher (LAUNCHER_KEY, api/.env) ----------------------------
  ipcMain.handle('launcherkey:get', () => dataFiles.getLauncherKey(requireApiDir()));
  ipcMain.handle('launcherkey:generate', () => dataFiles.generateLauncherKey());
  ipcMain.handle('launcherkey:set', (_event, key) => dataFiles.setLauncherKey(requireApiDir(), key));

  // --- Sauvegarde locale (remplace l'ancien "Deploiement local") ----------
  ipcMain.handle('backup:status', () => getBackupInfo());
  ipcMain.handle('backup:create', (event) => {
    const info = createBackup(requireApiDir(), (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('backup:log', chunk);
    });
    return info;
  });

  // --- servers.json ---------------------------------------------------------
  ipcMain.handle('servers:list', () => dataFiles.listServers(requireApiDir()));
  ipcMain.handle('servers:save', (_event, server) => {
    const apiDir = requireApiDir();
    dataFiles.saveServer(apiDir, server);
    mcServer.syncWhitelistAccess(apiDir, server.id); // serveur hors ligne : acces SFTP/FTP pour la whitelist
    return dataFiles.listServers(apiDir);
  });
  ipcMain.handle('servers:remove', (_event, id) => dataFiles.removeServer(requireApiDir(), id));

  // --- branding.json ---------------------------------------------------------
  ipcMain.handle('branding:get', () => dataFiles.getBranding(requireApiDir()));
  ipcMain.handle('branding:save', (_event, branding) => dataFiles.saveBranding(requireApiDir(), branding));

  // --- news.json ---------------------------------------------------------
  ipcMain.handle('news:list', () => dataFiles.listNews(requireApiDir()));
  ipcMain.handle('news:save', (_event, news) => dataFiles.saveNews(requireApiDir(), news));

  // --- Modpacks ---------------------------------------------------------
  ipcMain.handle('modpacks:list', () => dataFiles.listModpacks(requireApiDir()));

  ipcMain.handle('modpack:pick-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('modpack:import', (_event, { modpackId, sourceDir }) => {
    if (!modpackId) throw new Error('Identifiant de modpack manquant.');
    return dataFiles.importModpackFolder(requireApiDir(), modpackId, sourceDir);
  });

  ipcMain.handle('modpack:generate-manifest', (_event, modpackId) => dataFiles.generateManifest(requireApiDir(), modpackId));

  // --- Catalogue de versions (reutilise pour le picker loader/version) ---
  ipcMain.handle('catalog:mcversions', () => listMinecraftVersions());
  ipcMain.handle('catalog:loaderversions', (_event, { type, mcVersion }) => listLoaderVersions(type, mcVersion));

  // --- Deploiement -----------------------------------------------------
  // SFTP : deux actions distinctes pour ne jamais risquer d'ecraser une
  // config live differente de la copie locale :
  //   - "code" : met a jour src/, scripts/, package.json... sans jamais
  //     toucher a data/ ni modpacks/ sur le serveur. Sans danger.
  //   - "config" : ecrase data/ + modpacks/ sur le serveur : deliberement,
  //     apres avoir vu le diff (deploy:sftp-diff).
  ipcMain.handle('deploy:sftp-config-get', () => getSftpConfig());
  ipcMain.handle('deploy:sftp-config-set', (_event, config) => setSftpConfig(config));

  ipcMain.handle('deploy:sftp-diff', (_event, config) => diffSftpConfig(requireApiDir(), config));
  ipcMain.handle('deploy:sftp-list', (_event, config) => listSftpRemote(config));

  ipcMain.handle('deploy:sftp-code-run', async (event, config) => {
    await deploySftpCode(requireApiDir(), config, (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('deploy:sftp-log', chunk);
    });
    return { ok: true };
  });

  ipcMain.handle('deploy:sftp-config-run', async (event, { config, mirror } = {}) => {
    await deploySftpConfig(requireApiDir(), config, (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('deploy:sftp-log', chunk);
    }, { mirror });
    return { ok: true };
  });

  // Fichiers individuels : pour de petites mises a jour rapides sans
  // repousser/comparer toute la config.
  ipcMain.handle('deploy:sftp-file-run', async (event, { config, fileName }) => {
    await deploySftpDataFile(requireApiDir(), config, fileName, (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('deploy:sftp-log', chunk);
    });
    return { ok: true };
  });

  ipcMain.handle('deploy:sftp-servers-run', async (event, { config, mirror } = {}) => {
    await deploySftpServersWithModpacks(requireApiDir(), config, (chunk) => {
      if (!event.sender.isDestroyed()) event.sender.send('deploy:sftp-log', chunk);
    }, { mirror });
    return { ok: true };
  });


  // --- Serveur Minecraft pret a l'emploi (onglet "Serveur Minecraft") ------
  const mcLog = (event) => (chunk) => {
    if (!event.sender.isDestroyed()) event.sender.send('mc:log', chunk);
  };

  ipcMain.handle('mc:get-settings', (_event, serverId) => {
    const settings = mcServer.getSettings(requireApiDir(), serverId);
    return { settings, defaultOutDir: mcServer.defaultOutDir(requireApiDir()) };
  });
  ipcMain.handle('mc:set-settings', (_event, { serverId, settings }) => {
    const saved = mcServer.setSettings(serverId, settings);
    mcServer.syncWhitelistAccess(requireApiDir(), serverId); // recopie l'acces SFTP/FTP dans servers.json si serveur hors ligne
    return saved;
  });

  ipcMain.handle('mc:list-mods', (_event, serverId) => {
    const apiDir = requireApiDir();
    const server = dataFiles.listServers(apiDir).find((s) => s.id === serverId);
    if (!server || !server.modpackId) return [];
    return mcServer.listMods(apiDir, server.modpackId);
  });
  ipcMain.handle('mc:set-side', (_event, { serverId, relPath, side }) => {
    const apiDir = requireApiDir();
    const server = dataFiles.listServers(apiDir).find((s) => s.id === serverId);
    if (!server || !server.modpackId) throw new Error("Ce serveur n'a pas de modpack.");
    mcServer.setSide(apiDir, server.modpackId, relPath, side);
    return { ok: true };
  });

  ipcMain.handle('mc:generate', async (event, { serverId, settings }) => {
    const result = await mcServer.generateServer(requireApiDir(), serverId, settings, mcLog(event));
    return result;
  });
  ipcMain.handle('mc:push', async (event, { serverId, settings, mode }) => {
    await mcServer.pushServer(requireApiDir(), serverId, settings, mode, mcLog(event));
    return { ok: true };
  });
  ipcMain.handle('mc:test-sftp', (_event, settings) => mcServer.testSftp(settings));
  ipcMain.handle('mc:open-folder', async (_event, targetPath) => {
    const { shell } = require('electron');
    const err = await shell.openPath(targetPath);
    if (err) throw new Error(err);
    return { ok: true };
  });
}

module.exports = { registerIpcHandlers };
