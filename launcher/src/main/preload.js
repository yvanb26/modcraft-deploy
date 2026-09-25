const { contextBridge, ipcRenderer } = require('electron');

// Journal cote renderer : les messages partent par IPC vers le process principal, qui les ecrit dans le meme
// fichier (main.log). Un preload "sandbox" ne peut charger que le module `electron` (pas electron-log), d'ou
// ce canal simple. Seules ces 4 methodes sont exposees a la page, jamais un objet de journalisation complet.
const toText = (value) => {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};
const send = (level) => (...args) => {
  try { ipcRenderer.send('renderer:log', level, args.map(toText)); } catch { /* le journal ne doit jamais casser la page */ }
};
contextBridge.exposeInMainWorld('electronLog', {
  info: send('info'),
  warn: send('warn'),
  error: send('error'),
  debug: send('debug')
});

contextBridge.exposeInMainWorld('launcher', {
  getConfig: () => ipcRenderer.invoke('config:load'),
  refreshConfig: () => ipcRenderer.invoke('config:refresh'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),

  loginOffline: (username) => ipcRenderer.invoke('account:offline', { username }),
  loginElyBy: (username, password, totpToken) =>
    ipcRenderer.invoke('account:elyby', { username, password, totpToken }),
  loginMicrosoft: () => ipcRenderer.invoke('account:microsoft'),
  logout: () => ipcRenderer.invoke('account:logout'),

  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  switchAccount: (id) => ipcRenderer.invoke('accounts:switch', id),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),

  launchServer: (serverId) => ipcRenderer.invoke('server:launch', { serverId }),
  cancelLaunch: () => ipcRenderer.invoke('launch:cancel'),
  killGame: () => ipcRenderer.invoke('game:kill'),
  checkServerInstalled: (serverId) => ipcRenderer.invoke('server:check-installed', serverId),
  onLaunchProgress: (callback) => ipcRenderer.on('launch:progress', (_event, payload) => callback(payload)),
  onGameEvent: (callback) => ipcRenderer.on('launch:game-event', (_event, evt, payload) => callback(evt, payload)),

  getServerSettings: (serverId) => ipcRenderer.invoke('settings:get', serverId),
  getInstanceModsSize: (serverId) => ipcRenderer.invoke('instance:mods-size', serverId),
  setServerSettings: (serverId, patch) => ipcRenderer.invoke('settings:set', { serverId, patch }),

  getPreferences: () => ipcRenderer.invoke('preferences:get'),
  setPreferences: (patch) => ipcRenderer.invoke('preferences:set', patch),

  pingServer: (host, port) => ipcRenderer.invoke('server:ping', { host, port }),
  listGpus: () => ipcRenderer.invoke('gpu:list'),
  getSystemInfo: () => ipcRenderer.invoke('system:info'),

  openInstanceFolder: (serverId) => ipcRenderer.invoke('instance:open-folder', serverId),
  openInstanceLogs: (serverId) => ipcRenderer.invoke('instance:open-logs', serverId),
  repairInstance: (serverId) => ipcRenderer.invoke('instance:repair', serverId),
  onRepairProgress: (callback) => ipcRenderer.on('instance:repair-progress', (_event, payload) => callback(payload)),

  listMinecraftVersions: () => ipcRenderer.invoke('catalog:mcversions'),
  listLoaderVersions: (type, mcVersion) => ipcRenderer.invoke('catalog:loaderversions', { type, mcVersion }),

  listCustomInstances: () => ipcRenderer.invoke('custominstances:list'),
  createCustomInstance: (patch) => ipcRenderer.invoke('custominstances:create', patch),
  removeCustomInstance: (id) => ipcRenderer.invoke('custominstances:remove', id),
  renameCustomInstance: (id, name) => ipcRenderer.invoke('custominstances:rename', { id, name }),
  launchCustomInstance: (id) => ipcRenderer.invoke('custominstance:launch', { id }),
  checkCustomInstanceInstalled: (id) => ipcRenderer.invoke('custominstance:check-installed', id),

  clearCache: () => ipcRenderer.invoke('cache:clear'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowState: (callback) => ipcRenderer.on('window:state', (_event, state) => callback(state)),
  fitWindowHeight: (height) => ipcRenderer.invoke('window:fit-height', { height }),
  restoreWindowHeight: () => ipcRenderer.invoke('window:restore-height'),

  openDevTools: () => ipcRenderer.invoke('debug:open-devtools'),
  openLogsFolder: () => ipcRenderer.invoke('debug:open-logs-folder')
});
