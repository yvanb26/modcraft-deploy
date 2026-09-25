const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('admin', {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowState: (callback) => ipcRenderer.on('window:state', (_event, state) => callback(state)),

  getApiDir: () => ipcRenderer.invoke('apidir:get'),
  canScaffoldApiDir: () => ipcRenderer.invoke('apidir:can-scaffold'),
  scaffoldApiDir: () => ipcRenderer.invoke('apidir:scaffold'),

  serverStatus: () => ipcRenderer.invoke('server:status'),
  startServer: () => ipcRenderer.invoke('server:start'),
  startServerFromBackup: () => ipcRenderer.invoke('server:start-backup'),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  getLocalLauncherConfig: () => ipcRenderer.invoke('server:local-launcher-config'),

  getLauncherKey: () => ipcRenderer.invoke('launcherkey:get'),
  generateLauncherKey: () => ipcRenderer.invoke('launcherkey:generate'),
  setLauncherKey: (key) => ipcRenderer.invoke('launcherkey:set', key),
  onServerLog: (callback) => ipcRenderer.on('server:log-data', (_event, chunk) => callback(chunk)),

  getBackupStatus: () => ipcRenderer.invoke('backup:status'),
  createBackup: () => ipcRenderer.invoke('backup:create'),
  onBackupLog: (callback) => ipcRenderer.on('backup:log', (_event, chunk) => callback(chunk)),

  listServers: () => ipcRenderer.invoke('servers:list'),
  saveServer: (server) => ipcRenderer.invoke('servers:save', server),
  removeServer: (id) => ipcRenderer.invoke('servers:remove', id),

  getBranding: () => ipcRenderer.invoke('branding:get'),
  saveBranding: (branding) => ipcRenderer.invoke('branding:save', branding),

  listNews: () => ipcRenderer.invoke('news:list'),
  saveNews: (news) => ipcRenderer.invoke('news:save', news),

  listModpacks: () => ipcRenderer.invoke('modpacks:list'),
  pickModpackFolder: () => ipcRenderer.invoke('modpack:pick-folder'),
  importModpack: (modpackId, sourceDir) => ipcRenderer.invoke('modpack:import', { modpackId, sourceDir }),
  generateManifest: (modpackId) => ipcRenderer.invoke('modpack:generate-manifest', modpackId),

  listMinecraftVersions: () => ipcRenderer.invoke('catalog:mcversions'),
  listLoaderVersions: (type, mcVersion) => ipcRenderer.invoke('catalog:loaderversions', { type, mcVersion }),

  getSftpConfig: () => ipcRenderer.invoke('deploy:sftp-config-get'),
  setSftpConfig: (config) => ipcRenderer.invoke('deploy:sftp-config-set', config),
  diffSftpConfig: (config) => ipcRenderer.invoke('deploy:sftp-diff', config),
  listSftpRemote: (config) => ipcRenderer.invoke('deploy:sftp-list', config),
  runSftpCodeDeploy: (config) => ipcRenderer.invoke('deploy:sftp-code-run', config),
  runSftpConfigDeploy: (config, mirror) => ipcRenderer.invoke('deploy:sftp-config-run', { config, mirror }),
  runSftpFileDeploy: (config, fileName) => ipcRenderer.invoke('deploy:sftp-file-run', { config, fileName }),
  runSftpServersDeploy: (config, mirror) => ipcRenderer.invoke('deploy:sftp-servers-run', { config, mirror }),
  onSftpLog: (callback) => ipcRenderer.on('deploy:sftp-log', (_event, chunk) => callback(chunk)),

  mcGetSettings: (serverId) => ipcRenderer.invoke('mc:get-settings', serverId),
  mcSetSettings: (serverId, settings) => ipcRenderer.invoke('mc:set-settings', { serverId, settings }),
  mcListMods: (serverId) => ipcRenderer.invoke('mc:list-mods', serverId),
  mcSetSide: (serverId, relPath, side) => ipcRenderer.invoke('mc:set-side', { serverId, relPath, side }),
  mcGenerate: (serverId, settings) => ipcRenderer.invoke('mc:generate', { serverId, settings }),
  mcPush: (serverId, settings, mode) => ipcRenderer.invoke('mc:push', { serverId, settings, mode }),
  mcTestSftp: (settings) => ipcRenderer.invoke('mc:test-sftp', settings),
  mcOpenFolder: (targetPath) => ipcRenderer.invoke('mc:open-folder', targetPath),
  onMcLog: (callback) => ipcRenderer.on('mc:log', (_event, chunk) => callback(chunk))
});
