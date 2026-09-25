// Electron enveloppe systematiquement une erreur remontee par un handler
// ipcMain.handle avec un prefixe technique ("Error invoking remote method
// 'xxx': Error: <vrai message>"), illisible pour un operateur. A utiliser
// UNIQUEMENT pour les messages affiches directement (alert/status/texte
// d'erreur) : les panneaux de logs (sftpLog, backupLog, server-log...)
// gardent volontairement le detail brut, ce sont des consoles techniques.
function friendlyError(err) {
  let msg = (err && err.message) || String(err);
  msg = msg.replace(/^Error invoking remote method '[^']*':\s*/, '');
  msg = msg.replace(/^Error:\s*/, '');
  return msg.trim();
}

// Echappe le texte insere via innerHTML : utile notamment pour le contenu
// liste depuis le serveur SFTP distant (noms de fichiers), qui n'est pas
// sous notre controle.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// --- Theme clair/sombre -------------------------------------------------
document.getElementById('btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) { /* stockage indisponible : non persiste */ }
});

// --- Boutons de fenetre (la barre de titre native est desactivee) ----------
const btnWinMax = document.getElementById('win-max');
function setMaximizedUi(maximized) {
  document.body.classList.toggle('is-maximized', !!maximized);
  btnWinMax.title = maximized ? 'Restaurer' : 'Agrandir';
}
document.getElementById('win-min').addEventListener('click', () => window.admin.minimizeWindow());
btnWinMax.addEventListener('click', () => window.admin.toggleMaximizeWindow());
document.getElementById('win-close').addEventListener('click', () => window.admin.closeWindow());
window.admin.onWindowState(({ maximized }) => setMaximizedUi(maximized));
window.admin.isWindowMaximized().then(setMaximizedUi).catch(() => {});

// --- Guide integre -----------------------------------------------------
const guideModal = document.getElementById('guide-modal');
document.getElementById('btn-guide').addEventListener('click', () => guideModal.classList.add('visible'));
document.getElementById('btn-guide-close').addEventListener('click', () => guideModal.classList.remove('visible'));

function setGuideLang(lang) {
  guideModal.querySelectorAll('.guide-lang-block').forEach((block) => {
    block.hidden = block.dataset.guideLang !== lang;
  });
  guideModal.querySelectorAll('.guide-lang-switch .lang-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.guideLang === lang);
  });
  try { localStorage.setItem('guideLang', lang); } catch (e) { /* private mode, ignore */ }
}
guideModal.querySelectorAll('.guide-lang-switch .lang-btn').forEach((btn) => {
  btn.addEventListener('click', () => setGuideLang(btn.dataset.guideLang));
});
let savedGuideLang = 'fr';
try { savedGuideLang = localStorage.getItem('guideLang') || 'fr'; } catch (e) { /* private mode, ignore */ }
setGuideLang(savedGuideLang);

// --- Onglets ---------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'servers') renderServers();
    if (btn.dataset.tab === 'branding') loadBranding();
    if (btn.dataset.tab === 'news') renderNews();
    if (btn.dataset.tab === 'deploy') loadSftpConfig();
    if (btn.dataset.tab === 'mcserver') loadMcServer();
  });
});

// --- Dossier api/ (toujours au meme endroit, non configurable : cf. apiConfig.js)
const apiDirIndicator = document.getElementById('api-dir-indicator');
const btnRecreateApiDir = document.getElementById('btn-recreate-apidir');

async function refreshApiDirIndicator() {
  const dir = await window.admin.getApiDir();
  apiDirIndicator.textContent = dir || 'Dossier api/ introuvable !';
  btnRecreateApiDir.style.display = dir ? 'none' : (await window.admin.canScaffoldApiDir()) ? '' : 'none';
  return dir;
}

btnRecreateApiDir.addEventListener('click', async () => {
  if (!confirm("Recreer le dossier api/ manquant a partir du modele integre a l'application (code + config d'exemple, sans mods) ?")) return;
  try {
    await window.admin.scaffoldApiDir();
  } catch (err) {
    alert(`Impossible de recreer le dossier api/ : ${friendlyError(err)}`);
    return;
  }
  await refreshApiDirIndicator();
  renderServers();
});

// --- Tableau de bord : serveur API local ---------------------------------
const serverLog = document.getElementById('server-log');
const serverStatusBadge = document.getElementById('server-status-badge');

function appendServerLog(text) {
  serverLog.textContent += text;
  serverLog.scrollTop = serverLog.scrollHeight;
}

async function refreshServerStatus() {
  const { running, log, source } = await window.admin.serverStatus();
  serverStatusBadge.textContent = running ? `En cours (${source === 'backup' ? 'sauvegarde' : 'live'})` : 'Arrete';
  serverStatusBadge.className = `badge${running ? ' running' : ''}`;
  serverLog.textContent = log;
}

document.getElementById('btn-start-server').addEventListener('click', async () => {
  try {
    await window.admin.startServer();
  } catch (err) {
    appendServerLog(`\n[erreur] ${err.message}\n`);
  }
  refreshServerStatus();
});

document.getElementById('btn-stop-server').addEventListener('click', async () => {
  await window.admin.stopServer();
  refreshServerStatus();
});

window.admin.onServerLog((chunk) => appendServerLog(chunk));

// --- Cle du launcher (LAUNCHER_KEY) ----------------------------------------
const launcherKeyInput = document.getElementById('launcherkey-input');
const launcherKeyStatus = document.getElementById('launcherkey-status');

async function loadLauncherKey() {
  try {
    launcherKeyInput.value = await window.admin.getLauncherKey();
  } catch (err) {
    launcherKeyStatus.textContent = `Erreur : ${friendlyError(err)}`;
  }
}
loadLauncherKey();

document.getElementById('btn-launcherkey-generate').addEventListener('click', async () => {
  launcherKeyInput.value = await window.admin.generateLauncherKey();
  launcherKeyStatus.textContent = 'Nouvelle cle generee : cliquez "Enregistrer" pour l\'appliquer (pas encore ecrite dans .env).';
});

document.getElementById('btn-launcherkey-save').addEventListener('click', async () => {
  const value = launcherKeyInput.value.trim();
  if (!value) {
    launcherKeyStatus.textContent = 'La cle ne peut pas etre vide.';
    return;
  }
  if (!confirm(
    "Changer LAUNCHER_KEY va invalider l'acces de tous les launchers deja installes tant que leur launcher.config.json n'est pas mis a jour avec la nouvelle valeur, et necessite un redemarrage de l'API pour prendre effet. Continuer ?"
  )) return;

  try {
    await window.admin.setLauncherKey(value);
    launcherKeyStatus.textContent = 'Cle enregistree dans api/.env. Redemarrez l\'API pour l\'appliquer.';
  } catch (err) {
    launcherKeyStatus.textContent = `Erreur : ${friendlyError(err)}`;
  }
});

document.getElementById('btn-copy-launcher-config').addEventListener('click', async () => {
  const status = document.getElementById('launcher-config-status');
  const preview = document.getElementById('launcher-config-preview');
  try {
    const config = await window.admin.getLocalLauncherConfig();
    const json = JSON.stringify(config, null, 2);
    preview.textContent = json;
    await navigator.clipboard.writeText(json);
    status.textContent = 'Copie dans le presse-papiers !';
  } catch (err) {
    status.textContent = `Erreur : ${friendlyError(err)}`;
    preview.textContent = '';
  }
  setTimeout(() => { status.textContent = ''; }, 3000);
});

// --- Serveurs : liste ----------------------------------------------------
async function renderServers() {
  const dir = await refreshApiDirIndicator();
  const list = document.getElementById('servers-list');
  if (!dir) {
    list.innerHTML = '<div class="dim">Dossier api/ introuvable : utilisez le bouton "Recreer le dossier api/" en haut de l\'ecran.</div>';
    return;
  }

  const servers = await window.admin.listServers();
  if (servers.length === 0) {
    list.innerHTML = '<div class="dim">Aucun serveur configure pour le moment.</div>';
    return;
  }

  list.innerHTML = '';
  for (const server of servers) {
    const card = document.createElement('div');
    card.className = 'server-card';
    card.innerHTML = `
      <div class="name">${escapeHtml(server.name || server.id)}</div>
      <div class="meta">
        <span class="badge">${escapeHtml(server.minecraftVersion || '?')}</span>
        <span class="badge">${escapeHtml(server.loader?.type || '?')} ${escapeHtml(server.loader?.version || '')}</span>
        ${server.rcon ? '<span class="badge">RCON</span>' : ''}
      </div>
      <div class="dim">${escapeHtml(server.modpackId || '')}</div>
    `;
    card.addEventListener('click', () => openServerModal(server));
    list.appendChild(card);
  }
}

// --- Serveurs : popup d'edition -------------------------------------------
const serverModal = document.getElementById('server-modal');
let editingServerId = null; // null = nouveau serveur
let mcVersionsCache = null;

async function loadMcVersions() {
  if (!mcVersionsCache) mcVersionsCache = await window.admin.listMinecraftVersions();
  return mcVersionsCache;
}

async function populateMcVersionSelect(selected) {
  const select = document.getElementById('sv-mcversion');
  const versions = await loadMcVersions();
  // Uniquement les releases ici : un serveur de production tourne quasi
  // toujours sur une version stable : les snapshots restent accessibles en
  // les tapant a la main directement dans servers.json si vraiment besoin.
  const releases = versions.filter((v) => v.type === 'release');
  select.innerHTML = releases.map((v) => `<option value="${v.id}">${v.id}</option>`).join('');
  if (selected) select.value = selected;
}

async function populateLoaderVersionSelect(selected) {
  const type = document.getElementById('sv-loader-type').value;
  const field = document.getElementById('sv-loaderversion-field');
  const select = document.getElementById('sv-loaderversion');

  if (type === 'vanilla') {
    field.style.display = 'none';
    return;
  }
  field.style.display = '';
  select.innerHTML = '<option value="">Chargement...</option>';
  try {
    const versions = await window.admin.listLoaderVersions(type, document.getElementById('sv-mcversion').value);
    select.innerHTML = versions.length
      ? versions.map((v) => `<option value="${v}">${v}</option>`).join('')
      : '<option value="">Aucune version disponible</option>';
    if (selected) select.value = selected;
  } catch (err) {
    select.innerHTML = `<option value="">Erreur: ${friendlyError(err)}</option>`;
  }
}

document.getElementById('sv-loader-type').addEventListener('change', () => populateLoaderVersionSelect());
document.getElementById('sv-mcversion').addEventListener('change', () => populateLoaderVersionSelect());

async function openServerModal(server) {
  editingServerId = server?.id || null;
  document.getElementById('server-modal-title').textContent = server ? `Modifier "${server.name}"` : 'Nouveau serveur';
  document.getElementById('server-modal-error').classList.remove('visible');
  document.getElementById('modpack-status').textContent = '';
  document.getElementById('btn-server-delete').style.display = server ? '' : 'none';

  document.getElementById('sv-id').value = server?.id || '';
  document.getElementById('sv-id').disabled = !!server; // l'id ne se change pas apres coup (cle du modpack/manifest)
  document.getElementById('sv-name').value = server?.name || '';
  document.getElementById('sv-description').value = server?.description || '';
  document.getElementById('sv-iconUrl').value = server?.iconUrl || '';
  document.getElementById('sv-serverAddress').value = server?.serverAddress || '';
  document.getElementById('sv-autoconnect').checked = server?.autoConnect !== false;
  document.getElementById('sv-onlinemode').checked = server?.onlineMode !== false;
  document.getElementById('sv-modpackId').value = server?.modpackId || '';
  document.getElementById('sv-optifine').value = server?.optifine?.version || '';
  document.getElementById('sv-javaargs').value = (server?.javaArgs || []).join(' ');
  document.getElementById('sv-rcon-host').value = server?.rcon?.host || '';
  document.getElementById('sv-rcon-port').value = server?.rcon?.port || '';
  document.getElementById('sv-rcon-password').value = server?.rcon?.password || '';
  document.getElementById('sv-loader-type').value = server?.loader?.type || 'vanilla';

  await populateMcVersionSelect(server?.minecraftVersion);
  await populateLoaderVersionSelect(server?.loader?.version);

  serverModal.classList.add('visible');
}

document.getElementById('btn-new-server').addEventListener('click', () => openServerModal(null));
document.getElementById('btn-server-cancel').addEventListener('click', () => serverModal.classList.remove('visible'));

document.getElementById('btn-import-modpack').addEventListener('click', async () => {
  const modpackId = document.getElementById('sv-modpackId').value.trim();
  if (!modpackId) {
    document.getElementById('modpack-status').textContent = "Renseignez d'abord un identifiant de modpack.";
    return;
  }
  const sourceDir = await window.admin.pickModpackFolder();
  if (!sourceDir) return;

  document.getElementById('modpack-status').textContent = 'Copie en cours...';
  try {
    const { rejected } = await window.admin.importModpack(modpackId, sourceDir);
    let status = `Fichiers copies depuis ${sourceDir}. Pensez a generer le manifest.`;
    if (rejected.length > 0) {
      status += ` ⚠ ${rejected.length} fichier(s) ignore(s) (format non autorise) : ${rejected.slice(0, 5).join(', ')}${rejected.length > 5 ? '...' : ''}`;
    }
    document.getElementById('modpack-status').textContent = status;
  } catch (err) {
    document.getElementById('modpack-status').textContent = `Erreur : ${friendlyError(err)}`;
  }
});

document.getElementById('btn-generate-manifest').addEventListener('click', async () => {
  const modpackId = document.getElementById('sv-modpackId').value.trim();
  if (!modpackId) {
    document.getElementById('modpack-status').textContent = "Renseignez d'abord un identifiant de modpack.";
    return;
  }
  document.getElementById('modpack-status').textContent = 'Generation du manifest...';
  try {
    const output = await window.admin.generateManifest(modpackId);
    document.getElementById('modpack-status').textContent = output.trim();
  } catch (err) {
    document.getElementById('modpack-status').textContent = `Erreur : ${friendlyError(err)}`;
  }
});

document.getElementById('btn-server-save').addEventListener('click', async () => {
  const id = editingServerId || document.getElementById('sv-id').value.trim();
  const errorBox = document.getElementById('server-modal-error');
  errorBox.classList.remove('visible');

  if (!id) {
    errorBox.textContent = "L'identifiant est obligatoire.";
    errorBox.classList.add('visible');
    return;
  }

  const loaderType = document.getElementById('sv-loader-type').value;
  const loaderVersion = document.getElementById('sv-loaderversion').value;
  const optifineVersion = document.getElementById('sv-optifine').value.trim();
  const rconHost = document.getElementById('sv-rcon-host').value.trim();

  const server = {
    id,
    name: document.getElementById('sv-name').value.trim() || id,
    description: document.getElementById('sv-description').value.trim(),
    iconUrl: document.getElementById('sv-iconUrl').value.trim(),
    minecraftVersion: document.getElementById('sv-mcversion').value,
    loader: loaderType === 'vanilla' ? { type: 'vanilla' } : { type: loaderType, version: loaderVersion },
    modpackId: document.getElementById('sv-modpackId').value.trim() || undefined,
    javaArgs: document.getElementById('sv-javaargs').value.trim().split(/\s+/).filter(Boolean),
    serverAddress: document.getElementById('sv-serverAddress').value.trim(),
    autoConnect: document.getElementById('sv-autoconnect').checked,
    onlineMode: document.getElementById('sv-onlinemode').checked
  };
  if (optifineVersion) server.optifine = { version: optifineVersion };
  if (rconHost) {
    server.rcon = {
      host: rconHost,
      port: Number(document.getElementById('sv-rcon-port').value) || 25575,
      password: document.getElementById('sv-rcon-password').value
    };
  }

  try {
    await window.admin.saveServer(server);
    serverModal.classList.remove('visible');
    renderServers();
  } catch (err) {
    errorBox.textContent = friendlyError(err);
    errorBox.classList.add('visible');
  }
});

document.getElementById('btn-server-delete').addEventListener('click', async () => {
  if (!editingServerId) return;
  if (!confirm(`Supprimer le serveur "${editingServerId}" de servers.json ? (les fichiers du modpack ne sont pas touches)`)) return;
  await window.admin.removeServer(editingServerId);
  serverModal.classList.remove('visible');
  renderServers();
});

// --- Branding --------------------------------------------------------------
async function loadBranding() {
  const dir = await refreshApiDirIndicator();
  if (!dir) return;
  const b = await window.admin.getBranding();

  document.getElementById('br-launcherName').value = b.launcherName || '';
  document.getElementById('br-language').value = b.language || 'fr';
  document.getElementById('br-accentColor').value = b.accentColor || '#5ca8ff';
  document.getElementById('br-logoUrl').value = b.logoUrl || '';
  document.getElementById('br-backgroundUrl').value = b.backgroundUrl || '';
  document.getElementById('br-windowIconUrl').value = b.windowIconUrl || '';
  document.getElementById('br-musicUrl').value = b.musicUrl || '';
  document.getElementById('br-websiteUrl').value = b.websiteUrl || '';
  document.getElementById('br-discordUrl').value = b.discordUrl || '';

  const theme = b.theme || {};
  for (const key of ['bg', 'panel', 'panelLight', 'text', 'textDim', 'danger', 'success']) {
    const el = document.getElementById(`br-theme-${key}`);
    if (el && theme[key]) el.value = theme[key];
  }

  document.getElementById('br-offline-enabled').checked = !!b.offlineAuth?.enabled;
  document.getElementById('br-elyby-enabled').checked = !!b.elybyAuth?.enabled;
  document.getElementById('br-ms-enabled').checked = !!b.microsoftAuth?.enabled;
  document.getElementById('br-ms-clientId').value = b.microsoftAuth?.clientId || '';
  document.getElementById('br-custom-enabled').checked = !!b.customInstances?.enabled;
  document.getElementById('br-custom-bannerUrl').value = b.customInstances?.bannerUrl || '';
  document.getElementById('br-discordrpc-enabled').checked = !!b.discordRpc?.enabled;
  document.getElementById('br-discordrpc-clientId').value = b.discordRpc?.clientId || '';

  easterEggEntries = Array.isArray(b.easterEgg) ? b.easterEgg : [];
  renderEasterEggList();
}

// --- Easter egg (liste libre, +/- a volonte) --------------------------
let easterEggEntries = [];

// Doit rester synchronise avec les elements [data-easteregg-zone] du
// launcher (launcher/src/renderer/index.html).
const EASTEREGG_ZONES = [
  { id: 'corner-tl', label: 'Coin haut-gauche' },
  { id: 'corner-tr', label: 'Coin haut-droit' },
  { id: 'corner-bl', label: 'Coin bas-gauche' },
  { id: 'corner-br', label: 'Coin bas-droit' },
  { id: 'footer-copyright', label: 'Texte de copyright (bas de page)' }
];

function renderEasterEggList() {
  const container = document.getElementById('easteregg-list');
  container.innerHTML = '';
  easterEggEntries.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'easteregg-row';
    row.innerHTML = `
      <label class="field medium"><span>Zone</span>
        <select class="ee-zone">
          ${EASTEREGG_ZONES.map((z) => `<option value="${z.id}"${entry.zone === z.id ? ' selected' : ''}>${escapeHtml(z.label)}</option>`).join('')}
        </select>
      </label>
      <label class="field medium"><span>Type</span>
        <select class="ee-type">
          <option value="sound"${entry.type !== 'gif' ? ' selected' : ''}>🔊 Son</option>
          <option value="gif"${entry.type === 'gif' ? ' selected' : ''}>🖼 Gif</option>
        </select>
      </label>
      <label class="field grow"><span>URL</span><input class="ee-url" placeholder="https://..." value="${escapeHtml(entry.url || '')}" /></label>
      <button class="btn-settings" title="Supprimer cette zone">🗑</button>
    `;
    row.querySelector('button').addEventListener('click', () => {
      easterEggEntries.splice(index, 1);
      renderEasterEggList();
    });
    container.appendChild(row);
  });
}

function readEasterEggEntries() {
  return [...document.querySelectorAll('.easteregg-row')]
    .map((row) => ({
      zone: row.querySelector('.ee-zone').value,
      type: row.querySelector('.ee-type').value,
      url: row.querySelector('.ee-url').value.trim()
    }))
    .filter((entry) => entry.url);
}

document.getElementById('btn-easteregg-add').addEventListener('click', () => {
  easterEggEntries.push({ zone: EASTEREGG_ZONES[0].id, type: 'sound', url: '' });
  renderEasterEggList();
});

document.getElementById('btn-save-branding').addEventListener('click', async () => {
  const status = document.getElementById('branding-save-status');
  const current = await window.admin.getBranding();

  const branding = {
    ...current,
    launcherName: document.getElementById('br-launcherName').value.trim(),
    language: document.getElementById('br-language').value,
    accentColor: document.getElementById('br-accentColor').value,
    logoUrl: document.getElementById('br-logoUrl').value.trim(),
    backgroundUrl: document.getElementById('br-backgroundUrl').value.trim(),
    windowIconUrl: document.getElementById('br-windowIconUrl').value.trim(),
    musicUrl: document.getElementById('br-musicUrl').value.trim(),
    websiteUrl: document.getElementById('br-websiteUrl').value.trim(),
    discordUrl: document.getElementById('br-discordUrl').value.trim(),
    theme: {
      bg: document.getElementById('br-theme-bg').value,
      panel: document.getElementById('br-theme-panel').value,
      panelLight: document.getElementById('br-theme-panelLight').value,
      text: document.getElementById('br-theme-text').value,
      textDim: document.getElementById('br-theme-textDim').value,
      danger: document.getElementById('br-theme-danger').value,
      success: document.getElementById('br-theme-success').value
    },
    offlineAuth: { enabled: document.getElementById('br-offline-enabled').checked },
    elybyAuth: { ...current.elybyAuth, enabled: document.getElementById('br-elyby-enabled').checked },
    microsoftAuth: {
      enabled: document.getElementById('br-ms-enabled').checked,
      clientId: document.getElementById('br-ms-clientId').value.trim()
    },
    customInstances: {
      enabled: document.getElementById('br-custom-enabled').checked,
      bannerUrl: document.getElementById('br-custom-bannerUrl').value.trim()
    },
    discordRpc: {
      enabled: document.getElementById('br-discordrpc-enabled').checked,
      clientId: document.getElementById('br-discordrpc-clientId').value.trim()
    },
    easterEgg: readEasterEggEntries()
  };

  try {
    await window.admin.saveBranding(branding);
    status.textContent = 'Enregistre.';
    setTimeout(() => { status.textContent = ''; }, 2500);
  } catch (err) {
    status.textContent = `Erreur : ${friendlyError(err)}`;
  }
});

// --- Annonces --------------------------------------------------------------
const newsModal = document.getElementById('news-modal');
let editingNewsIndex = null;
let newsCache = [];

async function renderNews() {
  const dir = await refreshApiDirIndicator();
  const list = document.getElementById('news-list');
  if (!dir) {
    list.innerHTML = '<div class="dim">Dossier api/ introuvable : utilisez le bouton "Recreer le dossier api/" en haut de l\'ecran.</div>';
    return;
  }

  newsCache = await window.admin.listNews();
  if (newsCache.length === 0) {
    list.innerHTML = '<div class="dim">Aucune annonce pour le moment.</div>';
    return;
  }

  list.innerHTML = '';
  newsCache.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = 'news-item';
    item.innerHTML = `
      <div>
        <div class="title">${escapeHtml(entry.title)}</div>
        <div class="date">${escapeHtml(entry.date || '')}</div>
      </div>
    `;
    item.addEventListener('click', () => openNewsModal(index));
    list.appendChild(item);
  });
}

function openNewsModal(index) {
  editingNewsIndex = index ?? null;
  const entry = index != null ? newsCache[index] : null;
  document.getElementById('news-title').value = entry?.title || '';
  document.getElementById('news-date').value = entry?.date || new Date().toISOString().slice(0, 10);
  document.getElementById('news-body').value = entry?.body || '';
  document.getElementById('btn-news-delete').style.display = entry ? '' : 'none';
  newsModal.classList.add('visible');
}

document.getElementById('btn-new-news').addEventListener('click', () => openNewsModal(null));
document.getElementById('btn-news-cancel').addEventListener('click', () => newsModal.classList.remove('visible'));

document.getElementById('btn-news-save').addEventListener('click', async () => {
  const entry = {
    id: editingNewsIndex != null ? newsCache[editingNewsIndex].id : `news-${Date.now()}`,
    title: document.getElementById('news-title').value.trim(),
    date: document.getElementById('news-date').value,
    body: document.getElementById('news-body').value
  };
  if (!entry.title) return;

  const updated = [...newsCache];
  if (editingNewsIndex != null) updated[editingNewsIndex] = entry;
  else updated.unshift(entry); // la plus recente en premier

  await window.admin.saveNews(updated);
  newsModal.classList.remove('visible');
  renderNews();
});

document.getElementById('btn-news-delete').addEventListener('click', async () => {
  if (editingNewsIndex == null) return;
  const updated = newsCache.filter((_, i) => i !== editingNewsIndex);
  await window.admin.saveNews(updated);
  newsModal.classList.remove('visible');
  renderNews();
});

// --- Deploiement : SFTP --------------------------------------------------
async function loadSftpConfig() {
  const dir = await refreshApiDirIndicator();
  if (!dir) return;
  const config = await window.admin.getSftpConfig();
  document.getElementById('sftp-protocol').value = config.protocol || 'sftp';
  document.getElementById('sftp-host').value = config.host || '';
  document.getElementById('sftp-port').value = config.port || 22;
  document.getElementById('sftp-username').value = config.username || '';
  document.getElementById('sftp-password').value = config.password || '';
  document.getElementById('sftp-remotepath').value = config.remotePath || '';
}

function readSftpFormConfig() {
  return {
    protocol: document.getElementById('sftp-protocol').value,
    host: document.getElementById('sftp-host').value.trim(),
    port: Number(document.getElementById('sftp-port').value) || (document.getElementById('sftp-protocol').value === 'sftp' ? 22 : 21),
    username: document.getElementById('sftp-username').value.trim(),
    password: document.getElementById('sftp-password').value,
    remotePath: document.getElementById('sftp-remotepath').value.trim()
  };
}

document.getElementById('btn-sftp-save').addEventListener('click', async () => {
  await window.admin.setSftpConfig(readSftpFormConfig());
});

const sftpLog = document.getElementById('sftp-log');
window.admin.onSftpLog((chunk) => {
  sftpLog.textContent += chunk;
  sftpLog.scrollTop = sftpLog.scrollHeight;
});

function renderDiffResult(container, diff) {
  container.innerHTML = '';
  for (const { file, status } of diff) {
    const row = document.createElement('div');
    row.className = 'diff-row' + (status === 'DIFFERENT' ? ' diff-changed' : '');
    row.innerHTML = `<span>${file}</span><span class="diff-status">${status}</span>`;
    container.appendChild(row);
  }
}

document.getElementById('btn-sftp-diff').addEventListener('click', async () => {
  const config = readSftpFormConfig();
  const result = document.getElementById('sftp-diff-result');
  result.textContent = 'Comparaison en cours...';
  try {
    const diff = await window.admin.diffSftpConfig(config);
    renderDiffResult(result, diff);
  } catch (err) {
    result.textContent = `Erreur : ${friendlyError(err)}`;
  }
});

function formatEntry(e) {
  const when = e.modifyTime ? new Date(e.modifyTime).toLocaleString() : '?';
  const kind = e.type === 'd' ? 'dossier' : `${e.size} octets`;
  return `<div class="diff-row"><span>${e.type === 'd' ? '📁' : '📄'} ${escapeHtml(e.name)}</span><span class="diff-status">${escapeHtml(kind)} : modifie le ${escapeHtml(when)}</span></div>`;
}

document.getElementById('btn-sftp-list').addEventListener('click', async () => {
  const config = readSftpFormConfig();
  const result = document.getElementById('sftp-remote-listing');
  result.textContent = 'Connexion en cours...';
  try {
    const listing = await window.admin.listSftpRemote(config);
    if (!listing.exists) {
      result.innerHTML = `<div class="dim">Le chemin distant "${listing.remotePath}" n'existe pas sur ce serveur.</div>`;
      return;
    }
    let html = `<p class="dim">Contenu de ${listing.remotePath} :</p>`;
    html += listing.root.map(formatEntry).join('');
    if (listing.data.length > 0) {
      html += `<p class="dim">Contenu de ${listing.remotePath}/data :</p>`;
      html += listing.data.map(formatEntry).join('');
    } else {
      html += `<p class="dim">Pas de sous-dossier data/ a cet emplacement.</p>`;
    }
    result.innerHTML = html;
  } catch (err) {
    result.textContent = `Erreur : ${friendlyError(err)}`;
  }
});

document.getElementById('btn-sftp-deploy-code').addEventListener('click', async () => {
  const config = readSftpFormConfig();
  if (!confirm(`Mettre a jour le code de l'API sur ${config.username}@${config.host}:${config.remotePath} ? data/ et modpacks/ ne seront pas touches.`)) return;

  sftpLog.textContent = '';
  try {
    await window.admin.runSftpCodeDeploy(config);
  } catch (err) {
    sftpLog.textContent += `\n[erreur] ${err.message}\n`;
  }
});

document.getElementById('btn-sftp-deploy-config').addEventListener('click', async () => {
  const config = readSftpFormConfig();
  const mirror = document.getElementById('sftp-mirror-config').checked;
  if (!confirm(`Envoyer data/ et modpacks/ vers ${config.username}@${config.host}:${config.remotePath} ? Ceci ECRASE la config existante sur le serveur distant : verifiez d'abord les differences.`)) return;
  if (mirror && !confirm('"Supprimer les fichiers distants absents en local" est coche : les fichiers de data/ et modpacks/ qui n\'existent plus en local seront DEFINITIVEMENT supprimes du serveur distant. Confirmer ?')) return;

  await window.admin.setSftpConfig(config); // enregistre au passage
  sftpLog.textContent = '';
  try {
    await window.admin.runSftpConfigDeploy(config, mirror);
  } catch (err) {
    sftpLog.textContent += `\n[erreur] ${err.message}\n`;
  }
});

function wireSftpFileButton(id, fileName) {
  document.getElementById(id).addEventListener('click', async () => {
    const config = readSftpFormConfig();
    sftpLog.textContent = '';
    try {
      await window.admin.runSftpFileDeploy(config, fileName);
    } catch (err) {
      sftpLog.textContent += `\n[erreur] ${err.message}\n`;
    }
  });
}
wireSftpFileButton('btn-sftp-file-branding', 'branding.json');
wireSftpFileButton('btn-sftp-file-news', 'news.json');
wireSftpFileButton('btn-sftp-file-servers-only', 'servers.json');

document.getElementById('btn-sftp-file-servers').addEventListener('click', async () => {
  const config = readSftpFormConfig();
  const mirror = document.getElementById('sftp-mirror-servers').checked;
  if (mirror && !confirm('"Supprimer les fichiers distants absents en local" est coche pour cette synchro : les fichiers des modpacks references par servers.json qui n\'existent plus en local seront DEFINITIVEMENT supprimes du serveur distant. Confirmer ?')) return;

  sftpLog.textContent = '';
  try {
    await window.admin.runSftpServersDeploy(config, mirror);
  } catch (err) {
    sftpLog.textContent += `\n[erreur] ${err.message}\n`;
  }
});

// --- Sauvegarde locale ----------------------------------------------------
const backupLog = document.getElementById('backup-log');
const backupStatusIndicator = document.getElementById('backup-status-indicator');
const btnStartServerBackup = document.getElementById('btn-start-server-backup');

window.admin.onBackupLog((chunk) => {
  backupLog.textContent += chunk;
  backupLog.scrollTop = backupLog.scrollHeight;
});

async function refreshBackupStatus() {
  const info = await window.admin.getBackupStatus();
  backupStatusIndicator.textContent = info.exists
    ? `Derniere sauvegarde : ${new Date(info.createdAt).toLocaleString()} (${info.fileCount} fichiers)`
    : 'Aucune sauvegarde';
  btnStartServerBackup.disabled = !info.exists;
  return info;
}

document.getElementById('btn-create-backup').addEventListener('click', async () => {
  backupLog.textContent = '';
  try {
    await window.admin.createBackup();
  } catch (err) {
    backupLog.textContent += `\n[erreur] ${err.message}\n`;
  }
  await refreshBackupStatus();
});

btnStartServerBackup.addEventListener('click', async () => {
  try {
    await window.admin.startServerFromBackup();
  } catch (err) {
    appendServerLog(`\n[erreur] ${err.message}\n`);
  }
  refreshServerStatus();
});

// --- Demarrage ---------------------------------------------------------
refreshApiDirIndicator();
refreshServerStatus();
refreshBackupStatus();


// --- Serveur Minecraft pret a l'emploi -----------------------------------------
// Voir admin/src/main/core/mcServer.js (generation) et mcSides.js (tri des mods).
const mcEl = (id) => document.getElementById(id);
const mcServerSelect = mcEl('mc-server');
const mcLog = mcEl('mc-log');
let mcServers = [];
let mcMods = [];
let mcLastRoot = null;
let mcSaveTimer = null;

window.admin.onMcLog((chunk) => {
  mcLog.textContent += chunk;
  mcLog.scrollTop = mcLog.scrollHeight;
});

function mcCurrentId() {
  return mcServerSelect.value;
}

function mcReadSettings() {
  return {
    port: Number(mcEl('mc-port').value) || 25565,
    memoryGb: Number(mcEl('mc-memory').value) || 4,
    motd: mcEl('mc-motd').value,
    maxPlayers: Number(mcEl('mc-maxplayers').value) || 20,
    difficulty: mcEl('mc-difficulty').value,
    gamemode: mcEl('mc-gamemode').value,
    outDir: mcEl('mc-outdir').value.trim(),
    extrasDir: mcEl('mc-extras').value.trim(),
    eula: mcEl('mc-eula').checked,
    preinstall: mcEl('mc-preinstall').checked,
    makeZip: mcEl('mc-zip').checked,
    sftp: {
      protocol: mcEl('mc-sftp-proto').value,
      host: mcEl('mc-sftp-host').value.trim(),
      port: Number(mcEl('mc-sftp-port').value) || (mcEl('mc-sftp-proto').value === 'sftp' ? 22 : 21),
      username: mcEl('mc-sftp-user').value.trim(),
      password: mcEl('mc-sftp-pass').value
    },
    remotePath: mcEl('mc-remotepath').value.trim(),
    keepRemoteConfig: mcEl('mc-keepconfig').checked,
    mirrorMods: mcEl('mc-mirrormods').checked
  };
}

function mcFillSettings(settings) {
  mcEl('mc-port').value = settings.port;
  mcEl('mc-memory').value = settings.memoryGb;
  mcEl('mc-motd').value = settings.motd;
  mcEl('mc-maxplayers').value = settings.maxPlayers;
  mcEl('mc-difficulty').value = settings.difficulty;
  mcEl('mc-gamemode').value = settings.gamemode;
  mcEl('mc-outdir').value = settings.outDir || '';
  mcEl('mc-extras').value = settings.extrasDir || '';
  mcEl('mc-eula').checked = !!settings.eula;
  mcEl('mc-preinstall').checked = !!settings.preinstall;
  mcEl('mc-zip').checked = !!settings.makeZip;
  mcEl('mc-sftp-proto').value = settings.sftp?.protocol || 'sftp';
  mcEl('mc-sftp-host').value = settings.sftp?.host || '';
  mcEl('mc-sftp-port').value = settings.sftp?.port || 22;
  mcEl('mc-sftp-user').value = settings.sftp?.username || '';
  mcEl('mc-sftp-pass').value = settings.sftp?.password || '';
  mcEl('mc-sftp-status').textContent = '';
  mcEl('mc-remotepath').value = settings.remotePath || '';
  mcEl('mc-keepconfig').checked = settings.keepRemoteConfig !== false;
  mcEl('mc-mirrormods').checked = !!settings.mirrorMods;
}

// Enregistre les reglages du serveur selectionne (leger delai pour ne pas
// ecrire a chaque frappe).
function mcScheduleSave() {
  clearTimeout(mcSaveTimer);
  mcSaveTimer = setTimeout(() => {
    const id = mcCurrentId();
    if (id) window.admin.mcSetSettings(id, mcReadSettings());
  }, 400);
}

['mc-port', 'mc-memory', 'mc-motd', 'mc-maxplayers', 'mc-difficulty', 'mc-gamemode', 'mc-outdir', 'mc-extras',
 'mc-eula', 'mc-preinstall', 'mc-zip', 'mc-sftp-proto', 'mc-sftp-host', 'mc-sftp-port', 'mc-sftp-user', 'mc-sftp-pass', 'mc-remotepath',
 'mc-keepconfig', 'mc-mirrormods'].forEach((id) => {
  mcEl(id).addEventListener('input', mcScheduleSave);
  mcEl(id).addEventListener('change', mcScheduleSave);
});

async function loadMcServer() {
  const dir = await refreshApiDirIndicator();
  const previous = mcCurrentId();
  if (!dir) {
    mcServerSelect.innerHTML = '';
    mcEl('mc-server-info').textContent = 'Dossier api/ introuvable.';
    return;
  }

  mcServers = await window.admin.listServers();
  mcServerSelect.innerHTML = mcServers
    .map((sv) => `<option value="${escapeHtml(sv.id)}">${escapeHtml(sv.name || sv.id)}</option>`)
    .join('');
  if (mcServers.length === 0) {
    mcEl('mc-server-info').textContent = "Aucun serveur configuré : crée-en un dans l'onglet Serveurs.";
    mcEl('mc-mods-list').innerHTML = '';
    return;
  }
  if (previous && mcServers.some((sv) => sv.id === previous)) mcServerSelect.value = previous;
  await mcLoadCurrentServer();
}

function mcDescribeServer(server) {
  const loader = server.loader?.type && server.loader.type !== 'vanilla'
    ? `${server.loader.type} ${server.loader.version || ''}`.trim()
    : 'vanilla';
  return [
    `Minecraft ${server.minecraftVersion}`,
    loader,
    server.modpackId ? `modpack « ${server.modpackId} »` : 'sans modpack',
    server.onlineMode === false ? 'comptes Ely.by + gratuits' : 'comptes Microsoft uniquement',
    server.rcon ? 'RCON (whitelist automatique)' : 'sans RCON'
  ].join(' · ');
}

async function mcLoadCurrentServer() {
  const id = mcCurrentId();
  const server = mcServers.find((sv) => sv.id === id);
  if (!server) return;

  mcEl('mc-server-info').textContent = mcDescribeServer(server);
  mcLastRoot = null;
  mcEl('btn-mc-open').disabled = true;
  mcEl('mc-result').innerHTML = '';

  const { settings } = await window.admin.mcGetSettings(id);
  mcFillSettings(settings);
  await mcLoadMods();
}

mcServerSelect.addEventListener('change', mcLoadCurrentServer);

// --- Liste des mods (client / serveur) ---------------------------------------
const MC_SIDE_LABELS = { client: 'Client uniquement', both: 'Serveur + client' };

function mcRenderMods() {
  const filter = mcEl('mc-mods-filter').value.trim().toLowerCase();
  const list = mcEl('mc-mods-list');
  const excluded = mcMods.filter((m) => m.side === 'client').length;
  mcEl('mc-mods-summary').textContent = mcMods.length
    ? `${mcMods.length} mods · ${mcMods.length - excluded} sur le serveur · ${excluded} exclus (client)`
    : '';

  if (mcMods.length === 0) {
    list.innerHTML = '<div class="dim" style="padding:10px;">Aucun mod trouvé pour ce serveur (pas de modpack, ou dossier api/modpacks/&lt;id&gt;/mods vide).</div>';
    return;
  }

  list.innerHTML = '';
  for (const mod of mcMods) {
    if (filter && !mod.name.toLowerCase().includes(filter)) continue;
    const row = document.createElement('div');
    row.className = `mc-mod-row${mod.side === 'client' ? ' is-client' : ''}`;
    const detectedText = mod.override
      ? 'choix manuel'
      : mod.reason ? `détecté : ${mod.reason}` : 'auto';
    row.innerHTML = `
      <span class="mc-mod-name" title="${escapeHtml(mod.path)}">${escapeHtml(mod.name)}</span>
      <span class="mc-mod-hint">${escapeHtml(detectedText)}</span>
      <select>
        <option value="">Auto (${mod.detected === 'client' ? 'client uniquement' : 'serveur + client'})</option>
        <option value="both">${MC_SIDE_LABELS.both}</option>
        <option value="client">${MC_SIDE_LABELS.client}</option>
      </select>`;
    const select = row.querySelector('select');
    select.value = mod.override || '';
    select.addEventListener('change', async () => {
      const side = select.value || null;
      try {
        await window.admin.mcSetSide(mcCurrentId(), mod.path, side);
      } catch (err) {
        alert(`Impossible d'enregistrer : ${friendlyError(err)}`);
        select.value = mod.override || '';
        return;
      }
      mod.override = side;
      mod.side = side || mod.detected;
      mcRenderMods();
    });
    list.appendChild(row);
  }
}

async function mcLoadMods() {
  mcMods = await window.admin.mcListMods(mcCurrentId());
  mcRenderMods();
}
mcEl('mc-mods-filter').addEventListener('input', mcRenderMods);

// --- Actions ----------------------------------------------------------------------
async function mcPickFolder(inputId) {
  const picked = await window.admin.pickModpackFolder();
  if (picked) {
    mcEl(inputId).value = picked;
    mcScheduleSave();
  }
}
mcEl('btn-mc-pick-out').addEventListener('click', () => mcPickFolder('mc-outdir'));
mcEl('btn-mc-pick-extras').addEventListener('click', () => mcPickFolder('mc-extras'));

function mcSetBusy(busy) {
  ['btn-mc-generate', 'btn-mc-push-files', 'btn-mc-push-zip'].forEach((id) => { mcEl(id).disabled = busy; });
}

function mcShowResult(result) {
  const box = mcEl('mc-result');
  const warnings = result.warnings.map((w) => `<div class="guide-warn">${escapeHtml(w)}</div>`).join('');
  box.innerHTML = `
    ${warnings}
    <div class="field-hint">Dossier : <code>${escapeHtml(result.root)}</code>${result.zipPath ? `<br>Zip : <code>${escapeHtml(result.zipPath)}</code>` : ''}</div>
    <div class="field-hint">${result.excludedCount} fichier(s) exclu(s) (côté client)${result.preinstalled ? ' · loader déjà installé' : ''}</div>
    <div class="field-hint">Java requis : <strong>${escapeHtml(result.javaText)}</strong></div>
    <div class="field-hint">Commande de démarrage pour un panel : <code>${escapeHtml(result.launchCommand)}</code></div>`;
}

mcEl('btn-mc-generate').addEventListener('click', async () => {
  const id = mcCurrentId();
  if (!id) return;
  mcLog.textContent = '';
  mcEl('mc-result').innerHTML = '';
  mcSetBusy(true);
  try {
    const settings = mcReadSettings();
    await window.admin.mcSetSettings(id, settings);
    const result = await window.admin.mcGenerate(id, settings);
    mcLastRoot = result.root;
    mcEl('btn-mc-open').disabled = false;
    mcShowResult(result);
  } catch (err) {
    mcLog.textContent += `\n[erreur] ${friendlyError(err)}\n`;
  } finally {
    mcSetBusy(false);
  }
});

mcEl('btn-mc-open').addEventListener('click', async () => {
  if (!mcLastRoot) return;
  try { await window.admin.mcOpenFolder(mcLastRoot); } catch (err) { alert(friendlyError(err)); }
});

async function mcPush(mode) {
  const id = mcCurrentId();
  if (!id) return;
  const settings = mcReadSettings();
  if (mode === 'files' && settings.mirrorMods && !confirm(
    'Les mods présents sur le serveur mais absents du dossier généré seront SUPPRIMÉS (mods/ uniquement). Continuer ?'
  )) return;

  mcLog.textContent = '';
  mcSetBusy(true);
  try {
    await window.admin.mcSetSettings(id, settings);
    await window.admin.mcPush(id, settings, mode);
  } catch (err) {
    mcLog.textContent += `\n[erreur] ${friendlyError(err)}\n`;
  } finally {
    mcSetBusy(false);
  }
}
mcEl('btn-mc-test-sftp').addEventListener('click', async () => {
  const status = mcEl('mc-sftp-status');
  status.textContent = 'Connexion…';
  try {
    const res = await window.admin.mcTestSftp(mcReadSettings());
    status.textContent = res.message;
  } catch (err) {
    status.textContent = `Échec : ${friendlyError(err)}`;
  }
});
mcEl('btn-mc-push-files').addEventListener('click', () => mcPush('files'));
mcEl('btn-mc-push-zip').addEventListener('click', () => mcPush('zip'));


// --- Protocole SFTP / FTP / FTPS : bascule du port par defaut ------------------
// Changer le PORT ne suffit pas a passer de SFTP (SSH) a FTP : ce sont deux protocoles
// differents. On ne touche au port que s'il vaut encore un port par defaut (21/22).
function bindProtocolPort(protoId, portId) {
  const proto = document.getElementById(protoId);
  const port = document.getElementById(portId);
  proto.addEventListener('change', () => {
    // Un port personnalise (2222, 5657...) est conserve ; 21/22/vide suivent le protocole.
    if (!port.value || port.value === '22' || port.value === '21') port.value = proto.value === 'sftp' ? '22' : '21';
  });
}
bindProtocolPort('sftp-protocol', 'sftp-port');
bindProtocolPort('mc-sftp-proto', 'mc-sftp-port');

// --- Consoles : bouton masquer / afficher --------------------------------------------------
// Chaque console (journal de l'API locale, de la sauvegarde, du SFTP, du serveur Minecraft) peut etre masquee pour
// gagner de la place ; le choix est memorise. Le contenu continue d'etre ecrit pendant qu'elle est masquee.
(function setupConsoleToggles() {
  const KEY = 'adminHiddenConsoles';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const write = (state) => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* stockage indisponible : le choix n'est simplement pas memorise */ } };

  for (const id of ['server-log', 'backup-log', 'sftp-log', 'mc-log']) {
    const log = document.getElementById(id);
    if (!log) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary console-toggle';
    const apply = (hidden) => {
      log.hidden = hidden;
      button.textContent = hidden ? '▸ Afficher la console' : '▾ Masquer la console';
      button.setAttribute('aria-expanded', String(!hidden));
    };
    apply(!!read()[id]);
    button.addEventListener('click', () => {
      const hidden = !log.hidden;
      apply(hidden);
      write({ ...read(), [id]: hidden });
    });
    log.before(button);
  }
})();

// --- Apparence : couleur de l'outil ---------------------------------------------------------------------
// Le choix est applique par theme-init.js (window.adminAccent) des le chargement, et memorise sur cet ordinateur.
(function setupAppearance() {
  const PRESETS = [
    ['#f20251', 'Rouge (couleur d\'origine)'], ['#ff3d78', 'Rose'], ['#ff9f43', 'Orange'], ['#f6c945', 'Jaune'],
    ['#3ecf8e', 'Vert'], ['#22c1c3', 'Turquoise'], ['#5c8dff', 'Bleu'], ['#8b6cff', 'Violet']
  ];
  const modal = document.getElementById('appearance-modal');
  const picker = document.getElementById('appearance-color');
  const swatches = document.getElementById('appearance-swatches');
  if (!modal || !window.adminAccent) return;

  const originalColor = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

  function sync() {
    const chosen = window.adminAccent.current();
    // Le selecteur natif exige "#rrggbb" : sans choix, on y met la couleur d'origine du theme courant.
    const shown = chosen || (window.adminAccent.HEX.test(originalColor()) ? originalColor() : PRESETS[0][0]);
    picker.value = shown;
    swatches.querySelectorAll('.accent-swatch').forEach((el) => {
      el.classList.toggle('selected', !!chosen && el.dataset.color === chosen);
    });
  }

  for (const [color, name] of PRESETS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'accent-swatch';
    swatch.dataset.color = color;
    swatch.style.background = color;
    swatch.title = name;
    swatch.setAttribute('aria-label', name);
    swatch.addEventListener('click', () => { window.adminAccent.set(color); sync(); });
    swatches.appendChild(swatch);
  }

  // Apercu en direct pendant le glissement dans le selecteur ; enregistre au relachement.
  picker.addEventListener('input', () => { window.adminAccent.set(picker.value); sync(); });
  document.getElementById('btn-appearance-reset').addEventListener('click', () => { window.adminAccent.set(null); sync(); });
  document.getElementById('btn-appearance').addEventListener('click', () => { sync(); modal.classList.add('visible'); });
  document.getElementById('btn-appearance-close').addEventListener('click', () => modal.classList.remove('visible'));
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.classList.remove('visible'); });
})();
