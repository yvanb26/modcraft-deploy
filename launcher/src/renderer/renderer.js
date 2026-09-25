const views = {
  boot: document.getElementById('view-boot'),
  login: document.getElementById('view-login'),
  servers: document.getElementById('view-servers'),
  custom: document.getElementById('view-custom')
};

function showView(name) {
  Object.values(views).forEach((v) => v.classList.remove('active'));
  views[name].classList.add('active');
  if (typeof syncWindowHeight === 'function') syncWindowHeight();
}

let config = null;
let currentAccount = null;

// Electron enveloppe systematiquement une erreur remontee par un handler
// ipcMain.handle avec un prefixe technique ("Error invoking remote method
// 'xxx': Error: <vrai message>"), illisible pour un joueur. A utiliser
// UNIQUEMENT pour les messages affiches directement (formulaires, popups,
// statuts) : le panneau de console/logs (progressLog via appendLog) garde
// volontairement le detail brut, c'est une vue technique de debogage.
function friendlyError(err) {
  let msg = (err && err.message) || String(err);
  msg = msg.replace(/^Error invoking remote method '[^']*':\s*/, '');
  msg = msg.replace(/^Error:\s*/, '');
  return msg.trim();
}

// Echappe tout texte insere via innerHTML/template literal : necessaire des
// que le contenu vient d'ailleurs que du code lui-meme : branding/servers/
// news sont fournis par l'operateur via l'API (donc potentiellement
// compromis/mal saisis sans que ce soit un "attaquant" au sens classique), et
// les pseudos de comptes/instances passent par du texte libre. Sans ca, un
// simple `"name": "<img src=x onerror=...>"`  dans servers.json execute du
// JS dans le contexte du launcher de TOUS les joueurs qui le chargent.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Masque les images cassees (icone de serveur/skin introuvable) : attache
// en JS plutot qu'un attribut HTML `onerror="..."` inline, qu'une CSP stricte
// (script-src sans 'unsafe-inline', cf. index.html) bloquerait sinon.
function hideOnImgError(root) {
  root.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  });
}

// Dessine juste le visage (+ le calque "chapeau" par-dessus, ex: cheveux qui
// depassent) recadre depuis la texture de skin complete, plutot que d'y
// afficher la texture entiere (grille de morceaux de corps zoomee et
// illisible). Le facteur `unit` s'adapte a la taille REELLE de l'image
// recue (64x64 standard, 128x128 haute resolution...) au lieu de supposer
// une taille fixe : une texture plus grande que prevu produisait justement
// le "carre zoome n'importe ou" observe avec un decoupage CSS a offsets fixes.
function renderFaceAvatar(canvas, skinUrl) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const img = new Image();
  img.onload = () => {
    const unit = img.naturalWidth / 64;
    const size = canvas.width;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 8 * unit, 8 * unit, 8 * unit, 8 * unit, 0, 0, size, size);
    ctx.drawImage(img, 40 * unit, 8 * unit, 8 * unit, 8 * unit, 0, 0, size, size);
  };
  img.onerror = () => { canvas.style.visibility = 'hidden'; };
  img.src = skinUrl;
}

// --- Journalisation ---------------------------------------------------
// Redirige console.log/warn/error vers le fichier de log partage (cf.
// preload.js/logger.js) EN PLUS de la console habituelle : tous les
// console.log/error deja presents dans ce fichier (connexion, erreurs...)
// se retrouvent donc automatiquement dans le fichier, sans avoir a les
// reecrire un par un.
(() => {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => { original.log(...args); window.electronLog.info(...args); };
  console.warn = (...args) => { original.warn(...args); window.electronLog.warn(...args); };
  console.error = (...args) => { original.error(...args); window.electronLog.error(...args); };
})();

// --- Mode debug cache (5 clics sur le logo en moins de 3s) --------------
// Ouvre les vraies DevTools + le dossier des logs dans l'explorateur :
// pratique pour diagnostiquer a distance (le joueur suit juste "clique 5
// fois sur le logo") sans exposer un bouton visible en temps normal.
(() => {
  const logo = document.getElementById('brand-logo');
  const RESET_MS = 3000;
  const CLICKS_NEEDED = 5;
  let clicks = 0;
  let resetTimer = null;

  logo.addEventListener('click', () => {
    clicks += 1;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => { clicks = 0; }, RESET_MS);

    if (clicks >= CLICKS_NEEDED) {
      clicks = 0;
      console.log('[debug] Mode debug active (5 clics sur le logo).');
      window.launcher.openDevTools();
      window.launcher.openLogsFolder();
    }
  });
})();

// --- Easter egg (zones cachees, configure par l'operateur :
// branding.easterEgg) : chaque entree est rattachee a une zone fixe de la
// fenetre (cf. les elements [data-easteregg-zone] dans index.html : 4 coins
// + le texte de copyright), pas a un nombre de clics.
//
// Plusieurs entrees peuvent partager la MEME zone (ex: un gif + un mp3) : elles
// sont alors lancees ensemble, au meme instant, au meme endroit.
//
// Anti-spam : tant qu'un easter egg joue (et pendant un court temps de
// recuperation ensuite), tout nouveau clic est simplement ignore : rien
// n'est mis en file d'attente, donc marteler une zone ne rejoue jamais 50 fois
// le son/gif.
const EASTEREGG_GIF_MS = 6000; // duree d'affichage d'un gif quand il n'y a pas de son
const EASTEREGG_COOLDOWN_MS = 1500; // pause obligatoire entre deux easter eggs
const EASTEREGG_PRELOAD_MS = 4000; // attente max du chargement (gif/son) avant de lancer quand meme
const EASTEREGG_MAX_MS = 60000; // filet de securite : un son/flux qui ne se termine jamais

let easterEggByZone = new Map(); // zone -> [entrees]
let easterEggBusy = false;

function setupEasterEgg(entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => e?.url && e?.zone) : [];
  easterEggByZone = new Map();
  for (const entry of list) {
    if (!easterEggByZone.has(entry.zone)) easterEggByZone.set(entry.zone, []);
    easterEggByZone.get(entry.zone).push(entry);
  }
}

document.querySelectorAll('[data-easteregg-zone]').forEach((el) => {
  el.addEventListener('click', () => {
    const group = easterEggByZone.get(el.dataset.eastereggZone);
    if (group) triggerEasterEgg(group);
  });
});

function triggerEasterEgg(entries) {
  if (easterEggBusy) return; // anti-spam : on ignore, on ne met pas en file
  easterEggBusy = true;

  const sounds = entries.filter((e) => e.type !== 'gif').map((e) => {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = e.url;
    return audio;
  });
  const gifs = entries.filter((e) => e.type === 'gif').map((e) => {
    const img = document.createElement('img');
    img.className = 'easteregg-gif';
    img.alt = '';
    img.src = e.url;
    return img;
  });

  let finished = false;
  let gifTimer = null;
  let remainingSounds = sounds.length;
  const maxTimer = setTimeout(() => finish(), EASTEREGG_MAX_MS);

  // Arrete tout (son + gifs) puis libere le declencheur apres le delai de
  // recuperation.
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(maxTimer);
    clearTimeout(gifTimer);
    sounds.forEach((audio) => { audio.pause(); audio.removeAttribute('src'); });
    gifs.forEach((img) => img.remove());
    setTimeout(() => { easterEggBusy = false; }, EASTEREGG_COOLDOWN_MS);
  }

  const soundDone = () => {
    remainingSounds -= 1;
    if (remainingSounds <= 0) finish();
  };

  // Attend que le gif ET le son soient prets avant de lancer les deux d'un
  // meme coup (sinon un gif distant lent arriverait apres le son) : avec un
  // delai maximum pour ne jamais bloquer si l'un des deux ne charge pas.
  const ready = [
    ...gifs.map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    })),
    ...sounds.map((audio) => new Promise((resolve) => {
      audio.addEventListener('canplaythrough', resolve, { once: true });
      audio.addEventListener('error', resolve, { once: true });
    }))
  ];
  const timeout = new Promise((resolve) => setTimeout(resolve, EASTEREGG_PRELOAD_MS));

  Promise.race([Promise.all(ready), timeout]).then(() => {
    if (finished) return;

    gifs.forEach((img) => {
      // Un clic sur le gif interrompt tout l'easter egg (son compris).
      img.addEventListener('click', finish);
      img.addEventListener('error', () => {
        img.remove();
        // Gif introuvable et rien d'autre a jouer : on libere tout de suite.
        if (!sounds.length && gifs.every((g) => !g.isConnected)) finish();
      });
      if (img.complete && img.naturalWidth === 0) return; // deja en erreur
      document.body.appendChild(img);
    });

    sounds.forEach((audio) => {
      audio.addEventListener('ended', soundDone, { once: true });
      audio.addEventListener('error', soundDone, { once: true });
      audio.play().catch(soundDone);
    });

    // Sans son, le gif reste un temps fixe ; avec du son, il dure aussi
    // longtemps que le son (cf. soundDone).
    if (!sounds.length) gifTimer = setTimeout(finish, EASTEREGG_GIF_MS);
  });
}

// Traductions statiques immediatement (langue par defaut, francais) : elles
// seront reappliquees avec la bonne langue une fois branding.language connu.
applyStaticTranslations();

// Correspondance entre les cles de `branding.theme` et les variables CSS :
// permet a un operateur de rebrander integralement les couleurs de l'appli
// (pas seulement l'accent) sans jamais recompiler le launcher.
const THEME_CSS_VARS = {
  bg: '--bg',
  panel: '--panel',
  panelLight: '--panel-light',
  text: '--text',
  textDim: '--text-dim',
  danger: '--danger',
  success: '--success'
};

// Theme clair/sombre : le clair est la palette integree (cf. styles.css,
// [data-theme="light"]). Les couleurs `branding.theme` de l'operateur sont
// pensees pour le mode sombre, elles ne s'appliquent donc que dans celui-ci.
let brandingTheme = {};

function currentMode() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme = {}) {
  brandingTheme = theme;
  const dark = currentMode() === 'dark';
  for (const [key, cssVar] of Object.entries(THEME_CSS_VARS)) {
    if (dark && theme[key]) document.documentElement.style.setProperty(cssVar, theme[key]);
    else document.documentElement.style.removeProperty(cssVar);
  }
}

function setMode(mode) {
  document.documentElement.dataset.theme = mode;
  try { localStorage.setItem('theme', mode); } catch { /* stockage indisponible : non persiste */ }
  applyTheme(brandingTheme);
  updateThemeMenuItem();
}

document.getElementById('btn-theme').addEventListener('click', () => {
  setMode(currentMode() === 'dark' ? 'light' : 'dark');
});

// --- Boutons de fenetre (la barre de titre native est desactivee) ----------
const btnWinMax = document.getElementById('win-max');

function setMaximizedUi(maximized) {
  document.body.classList.toggle('is-maximized', !!maximized);
  btnWinMax.dataset.i18nTitle = maximized ? 'window.restore' : 'window.maximize';
  btnWinMax.title = t(btnWinMax.dataset.i18nTitle);
}

document.getElementById('win-min').addEventListener('click', () => window.launcher.minimizeWindow());
btnWinMax.addEventListener('click', () => window.launcher.toggleMaximizeWindow());
document.getElementById('win-close').addEventListener('click', () => window.launcher.closeWindow());
window.launcher.onWindowState(({ maximized }) => setMaximizedUi(maximized));
window.launcher.isWindowMaximized().then(setMaximizedUi).catch(() => {});

// --- Couleur du launcher choisie par le joueur (Options) -------------------------------------------
// Sans effet sur la communaute : ce n'est qu'un affichage local, la couleur d'origine (branding.json) reste celle de la
// communaute et un bouton y ramene. La couleur secondaire du degrade et la couleur du texte des boutons sont deduites.
const ACCENT_PRESETS = ['#5ca8ff', '#7c5cff', '#ff3d78', '#f2555a', '#ff9f43', '#f6c945', '#3ecf8e', '#22c1c3'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
let brandingAccent = '#5ca8ff';
let userAccent = null;

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function rgbToHex(rgb) {
  return `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

// Melange `hex` avec du blanc (ratio 0 = inchange, 1 = blanc).
function lighten(hex, ratio) {
  return rgbToHex(hexToRgb(hex).map((v) => v + (255 - v) * ratio));
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function applyAccent() {
  const root = document.documentElement.style;
  if (userAccent && HEX_COLOR.test(userAccent)) {
    const second = lighten(userAccent, 0.32);
    root.setProperty('--accent', userAccent);
    root.setProperty('--accent-2', second);
    // Texte sombre sur une couleur claire (jaune...), blanc sur une couleur foncee : lisible dans les deux cas.
    root.setProperty('--on-accent', (luminance(userAccent) + luminance(second)) / 2 > 0.4 ? '#08111d' : '#ffffff');
  } else {
    root.setProperty('--accent', brandingAccent);
    root.removeProperty('--accent-2');
    root.removeProperty('--on-accent');
  }
}

function applyBranding(branding) {
  setLanguage(branding.language || 'fr');
  applyStaticTranslations();
  updateThemeMenuItem();

  document.title = branding.launcherName || 'ModCraft Deploy Launcher';
  document.getElementById('brand-name').textContent = branding.launcherName || 'ModCraft Deploy Launcher';
  document.getElementById('about-app-name').textContent = branding.launcherName || 'ModCraft Deploy Launcher';
  brandingAccent = branding.accentColor || '#5ca8ff';
  applyAccent();
  applyTheme(branding.theme);

  if (branding.logoUrl) {
    document.getElementById('brand-logo').src = branding.logoUrl;
    document.getElementById('splash-logo').src = branding.logoUrl;
  }
  // JSON.stringify (pas un template literal brut) pour echapper correctement
  // guillemets/backslashes dans l'URL avant de l'inserer dans du CSS :
  // sinon une backgroundUrl malveillante pourrait injecter des regles CSS
  // arbitraires (defacement, pas d'execution de code).
  if (branding.backgroundUrl) document.body.style.backgroundImage = `url(${JSON.stringify(branding.backgroundUrl)})`;

  const website = document.getElementById('brand-website');
  const discord = document.getElementById('brand-discord');
  if (branding.websiteUrl) website.href = branding.websiteUrl; else website.style.display = 'none';
  if (branding.discordUrl) discord.href = branding.discordUrl; else discord.style.display = 'none';

  if (!branding.microsoftAuth?.enabled) {
    document.querySelector('[data-tab="microsoft"]').style.display = 'none';
  }
  if (!branding.elybyAuth?.enabled) {
    document.querySelector('[data-tab="elyby"]').style.display = 'none';
  }
  if (!branding.offlineAuth?.enabled) {
    document.querySelector('[data-tab="offline"]').style.display = 'none';
  }

  setupEasterEgg(branding.easterEgg);

  customInstancesEnabled = !!branding.customInstances?.enabled;
  customInstancesBannerUrl = branding.customInstances?.bannerUrl || '';
  document.getElementById('main-nav').style.display = customInstancesEnabled ? 'flex' : 'none';
  updateOptionsCustomSectionVisibility();

  setupMusic(branding.musicUrl);
}

// --- Navigation entre "Serveurs" et "Versions libres" ---------------------
const navServers = document.getElementById('nav-servers');
const navCustom = document.getElementById('nav-custom');
let customInstancesEnabled = false;
// Bannière générique (une seule, configurée par l'operateur) appliquée à
// TOUTES les installations libres : contrairement aux serveurs, une
// installation libre est créée par le joueur lui-même (version/loader de son
// choix), donc pas de bannière individuelle possible côté admin.
let customInstancesBannerUrl = '';

// Les reglages "afficher les snapshots/anciennes versions" ne concernent que
// la page "Versions libres" : masques dans la popup Options si cette
// fonctionnalite est desactivee par l'operateur (le reste de la popup, ex:
// "Vider le cache", reste pertinent globalement).
function updateOptionsCustomSectionVisibility() {
  document.getElementById('options-custom-section').style.display = customInstancesEnabled ? '' : 'none';
}

navServers.addEventListener('click', () => {
  navServers.classList.add('active');
  navCustom.classList.remove('active');
  showView('servers');
});

navCustom.addEventListener('click', () => {
  navCustom.classList.add('active');
  navServers.classList.remove('active');
  showView('custom');
  renderCustomInstances();
});

// --- Musique de branding (definie par l'API, volume/mute laisse au joueur) -
// Fondu enchaine sur le focus de la fenetre : quand le launcher perd le
// focus (ex: minimise au lancement du jeu), la musique descend en volume
// puis se coupe ; elle reprend en fondu quand on revient dessus.
const bgMusic = document.getElementById('bg-music');
const musicControl = document.getElementById('music-control');
const btnMute = document.getElementById('btn-mute');
const musicVolumeInput = document.getElementById('music-volume');
const musicFocusToggle = document.getElementById('music-focus-toggle');

const FADE_DURATION_MS = 700;
const FADE_STEPS = 14;
let fadeTimer = null;

// Preferences globales (pseudo memorise, volume/mute musique) stockees cote
// main process (fichier JSON dans userData) plutot que localStorage : sur une
// page chargee en file://, localStorage n'est pas fiable pour persister
// entre deux redemarrages de l'app avec Electron/Chromium.
let cachedPrefs = null;

async function loadPreferences() {
  if (!cachedPrefs) cachedPrefs = await window.launcher.getPreferences();
  return cachedPrefs;
}

async function updatePreferences(patch) {
  cachedPrefs = await window.launcher.setPreferences(patch);
  return cachedPrefs;
}

// --- Options generales du launcher ----------------------------------------
const optionsModal = document.getElementById('options-modal');
const optionShowSnapshots = document.getElementById('option-show-snapshots');
const optionShowOldVersions = document.getElementById('option-show-old-versions');
const optionAutoNews = document.getElementById('option-auto-news');
const optionShowConsole = document.getElementById('option-show-console');

const optionAccentColor = document.getElementById('option-accent-color');
const accentSwatches = document.getElementById('accent-swatches');

for (const color of ACCENT_PRESETS) {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'accent-swatch';
  swatch.dataset.color = color;
  swatch.style.background = color;
  swatch.setAttribute('aria-label', color);
  swatch.addEventListener('click', () => setUserAccent(color));
  accentSwatches.appendChild(swatch);
}

function syncAccentControls() {
  const current = userAccent && HEX_COLOR.test(userAccent) ? userAccent : (HEX_COLOR.test(brandingAccent) ? brandingAccent : '#5ca8ff');
  optionAccentColor.value = current;
  accentSwatches.querySelectorAll('.accent-swatch').forEach((el) => {
    el.classList.toggle('selected', !!userAccent && el.dataset.color.toLowerCase() === userAccent.toLowerCase());
  });
}

async function setUserAccent(color, { persist = true } = {}) {
  userAccent = color && HEX_COLOR.test(color) ? color.toLowerCase() : null;
  applyAccent();
  syncAccentControls();
  if (persist) await updatePreferences({ userAccentColor: userAccent });
}

// Pendant le glissement du selecteur : apercu en direct, sans ecrire sur le disque a chaque pixel.
optionAccentColor.addEventListener('input', () => setUserAccent(optionAccentColor.value, { persist: false }));
optionAccentColor.addEventListener('change', () => setUserAccent(optionAccentColor.value));
document.getElementById('btn-accent-reset').addEventListener('click', () => setUserAccent(null));

async function openOptionsModal() {
  const prefs = await loadPreferences();
  syncAccentControls();
  optionShowSnapshots.checked = !!prefs.showSnapshots;
  optionShowOldVersions.checked = !!prefs.showOldVersions;
  optionAutoNews.checked = prefs.autoShowNews !== false;
  optionShowConsole.checked = !!prefs.showLaunchConsole;
  optionsModal.classList.add('visible');
}

document.getElementById('btn-options-close').addEventListener('click', () => {
  optionsModal.classList.remove('visible');
});

// --- A propos ---------------------------------------------------------
const aboutModal = document.getElementById('about-modal');
let appVersion = null;

document.getElementById('btn-about').addEventListener('click', async () => {
  if (appVersion === null) appVersion = await window.launcher.getAppVersion();
  document.getElementById('about-version').textContent = `v${appVersion}`;
  aboutModal.classList.add('visible');
});

document.getElementById('btn-about-close').addEventListener('click', () => {
  aboutModal.classList.remove('visible');
});

optionShowSnapshots.addEventListener('change', () => {
  updatePreferences({ showSnapshots: optionShowSnapshots.checked });
});

optionShowOldVersions.addEventListener('change', () => {
  updatePreferences({ showOldVersions: optionShowOldVersions.checked });
});

optionAutoNews.addEventListener('change', () => {
  updatePreferences({ autoShowNews: optionAutoNews.checked });
});

optionShowConsole.addEventListener('change', () => {
  setConsoleEnabled(optionShowConsole.checked);
});

// "Vider le cache" : force la reinstallation des fichiers vanilla/loader
// partages (versions/libraries/installers, cf. cache.js cote main), pour un
// depannage manuel quand un de ces fichiers est corrompu : contrairement au
// bouton "Reparer" (par instance), qui ne revalide que le contenu du
// modpack. Affecte TOUTES les instances/serveurs, d'ou la confirmation.
document.getElementById('btn-clear-cache').addEventListener('click', async (e) => {
  if (!confirm(t('options.clearCacheConfirm'))) return;

  const btn = e.currentTarget;
  const status = document.getElementById('clear-cache-status');
  btn.disabled = true;
  status.textContent = '';
  try {
    const { cleared } = await window.launcher.clearCache();
    status.textContent = cleared.length ? t('options.clearCacheDone', cleared.join(', ')) : t('options.clearCacheEmpty');
  } catch (err) {
    status.textContent = t('progress.error', friendlyError(err));
  } finally {
    btn.disabled = false;
  }
});

// --- Annonces/actualites (configurees par l'operateur, api/data/news.json) -
// Affichees depuis le menu (voir plus bas) plutot qu'un bouton dedie dans le
// header : et ouvertes automatiquement au demarrage s'il y a du nouveau et
// que le joueur n'a pas desactive ca (menu > Options). L'indicateur "non lu"
// (dot sur le menu) a ete remplace par la cloche de notifications, voir plus
// bas : setupNews() ne fait plus que memoriser la liste.
const newsModal = document.getElementById('news-modal');
let newsEntries = [];

async function setupNews(news) {
  newsEntries = Array.isArray(news) ? news : [];
}

// Toutes les annonces plus recentes que la derniere vue (le tableau est
// trie du plus recent au plus ancien) : si `lastSeenNewsId` ne correspond a
// aucune entree connue (jamais consulte, ou entree supprimee depuis), tout
// est considere non lu.
function unreadNewsEntries(prefs) {
  if (newsEntries.length === 0) return [];
  const idx = newsEntries.findIndex((e) => e.id === prefs.lastSeenNewsId);
  return idx === -1 ? newsEntries : newsEntries.slice(0, idx);
}

async function maybeAutoShowNews() {
  const prefs = await loadPreferences();
  if (unreadNewsEntries(prefs).length > 0 && prefs.autoShowNews !== false) openNewsModal();
}

function renderNewsList() {
  const list = document.getElementById('news-list');
  list.innerHTML = '';
  if (newsEntries.length === 0) {
    list.innerHTML = `<div class="dim">${t('news.empty')}</div>`;
    return;
  }
  for (const entry of newsEntries) {
    const item = document.createElement('div');
    item.className = 'news-item';
    item.innerHTML = `
      <div class="news-item-header">
        <div class="name">${escapeHtml(entry.title)}</div>
        <div class="meta">${escapeHtml(entry.date || '')}</div>
      </div>
      <div class="news-item-body"></div>
    `;
    // textContent (pas innerHTML) pour le corps : contenu fourni par
    // l'operateur, jamais interprete comme du HTML/script.
    item.querySelector('.news-item-body').textContent = entry.body || '';
    list.appendChild(item);
  }
}

async function openNewsModal() {
  renderNewsList();
  newsModal.classList.add('visible');
  if (newsEntries[0]) {
    await updatePreferences({ lastSeenNewsId: newsEntries[0].id });
    refreshNotifications();
  }
}

document.getElementById('btn-news-close').addEventListener('click', () => {
  newsModal.classList.remove('visible');
});

async function preferredVolume() {
  const prefs = await loadPreferences();
  if (prefs.musicMuted) return 0;
  return (prefs.musicVolume ?? 25) / 100;
}

// Anime bgMusic.volume de sa valeur actuelle vers `target`. Si `playFirst`,
// relance la lecture avant de monter le volume ; si `pauseAfter`, met en
// pause une fois descendu a 0 (evite de laisser tourner pour rien).
function fadeMusicTo(target, { playFirst = false, pauseAfter = false } = {}) {
  if (!bgMusic.src) return;
  if (fadeTimer) clearInterval(fadeTimer);

  if (playFirst) bgMusic.play().catch(() => {});

  const start = bgMusic.volume;
  const delta = (target - start) / FADE_STEPS;
  let step = 0;

  fadeTimer = setInterval(() => {
    step++;
    bgMusic.volume = Math.min(1, Math.max(0, start + delta * step));
    if (step >= FADE_STEPS) {
      clearInterval(fadeTimer);
      fadeTimer = null;
      bgMusic.volume = target;
      if (pauseAfter && target === 0) bgMusic.pause();
    }
  }, FADE_DURATION_MS / FADE_STEPS);
}

async function setupMusic(musicUrl) {
  if (!musicUrl) {
    musicControl.classList.remove('visible');
    bgMusic.pause();
    bgMusic.removeAttribute('src');
    return;
  }

  const prefs = await loadPreferences();
  const volume = prefs.musicVolume ?? 25;
  const muted = prefs.musicMuted ?? false;

  bgMusic.src = musicUrl;
  bgMusic.volume = muted ? 0 : volume / 100;
  musicVolumeInput.value = volume;
  btnMute.textContent = muted ? '🔇' : '🔊';
  musicFocusToggle.checked = prefs.musicFocusFade !== false;
  musicControl.classList.add('visible');

  bgMusic.play().catch(() => {
    // lecture auto refusee par le systeme : le joueur pourra quand meme la
    // demarrer via le controle de volume/mute
  });
}

btnMute.addEventListener('click', async () => {
  const prefs = await loadPreferences();
  const nowMuted = !(prefs.musicMuted ?? false);
  btnMute.textContent = nowMuted ? '🔇' : '🔊';
  await updatePreferences({ musicVolume: Number(musicVolumeInput.value), musicMuted: nowMuted });
  fadeMusicTo(nowMuted ? 0 : Number(musicVolumeInput.value) / 100, { playFirst: !nowMuted });
});

musicVolumeInput.addEventListener('input', async () => {
  const volume = Number(musicVolumeInput.value);
  bgMusic.volume = volume / 100;
  if (volume > 0) btnMute.textContent = '🔊';
  await updatePreferences({ musicVolume: volume, musicMuted: volume === 0 });
  if (volume > 0 && bgMusic.paused) bgMusic.play().catch(() => {});
});

musicFocusToggle.addEventListener('change', () => {
  updatePreferences({ musicFocusFade: musicFocusToggle.checked });
});

window.addEventListener('blur', async () => {
  const prefs = await loadPreferences();
  if (prefs.musicFocusFade === false) return;
  fadeMusicTo(0, { pauseAfter: true });
});

window.addEventListener('focus', async () => {
  const prefs = await loadPreferences();
  if (prefs.musicFocusFade === false) return;
  const target = await preferredVolume();
  if (target > 0) fadeMusicTo(target, { playFirst: true });
});

// Badge(s) indiquant si le serveur Minecraft verifie les comptes (online-mode,
// configure par l'operateur cote admin) : premium Microsoft uniquement si
// active, Ely.by + comptes gratuits acceptes sinon. Rien affiche si
// `onlineMode` n'est pas renseigne (serveurs crees avant l'ajout de ce champ).
function authBadgesHtml(onlineMode) {
  if (onlineMode === undefined || onlineMode === null) return '';
  if (onlineMode) {
    
  }
  return `
    
  `;
}

// --- Compatibilite compte <-> serveur (online-mode) -----------------------
// La contrainte ne va que dans un sens : online-mode=true verifie les sessions
// aupres de Mojang (compte Microsoft premium uniquement), alors que
// online-mode=false ne verifie RIEN et accepte donc tous les comptes, y compris
// un compte Microsoft (le serveur ignore simplement sa session). Rejoindre un
// serveur online-mode=true avec un compte gratuit / Ely.by echoue seulement au
// moment de la connexion, une fois le modpack deja telecharge : on grise donc
// la carte en amont plutot que de laisser le joueur lancer une installation
// pour rien. Un serveur hors ligne n'est jamais grise.
const AUTH_GROUP_BY_PROVIDER = { microsoft: 'premium', offline: 'free', elyby: 'free' };

function accountAuthGroup(account) {
  return account ? (AUTH_GROUP_BY_PROVIDER[account.provider] || null) : null;
}

// 'premium' = compte Microsoft obligatoire ; null = aucune contrainte (serveur
// hors ligne, ou champ `onlineMode` absent sur les serveurs crees avant l'ajout
// de ce champ) : on ne verrouille rien dans ce cas.
function requiredAuthGroup(server) {
  return server.onlineMode === true ? 'premium' : null;
}

// Un joueur non connecte n'est jamais bloque : le clic sur "Jouer" ouvre de
// toute facon le gestionnaire de comptes (cf. launchServer).
function serverAccountMismatch(server, account) {
  const required = requiredAuthGroup(server);
  const current = accountAuthGroup(account);
  if (!required || !current) return false;
  return required !== current;
}

function lockMessage() {
  return t('servers.locked.microsoft');
}

// Applique (ou retire) le verrouillage d'une carte deja construite :
// centralise ici pour que le rendu initial et le changement de compte
// (cf. refreshAccountRestrictions) produisent exactement le meme etat.
// Retourne true si la carte est verrouillee.
function applyCardLock(card, server) {
  const locked = serverAccountMismatch(server, currentAccount);
  card.classList.toggle('incompatible', locked);

  const notice = card.querySelector('.card-notice');
  const noticeText = card.querySelector('.card-notice-text');
  if (noticeText) noticeText.textContent = locked ? lockMessage(server) : '';
  if (notice) notice.hidden = !locked;

  const btn = card.querySelector('.btn-play');
  if (btn) {
    // `data-locked` sert de garde a refreshPlayButtonLabel et
    // setAllPlayButtonsDisabled : le verrouillage compte prime sur l'etat
    // "lancement en cours", qui ne doit jamais le reactiver.
    btn.dataset.locked = locked ? '1' : '';
    btn.disabled = locked;
    btn.title = locked ? lockMessage(server) : '';
    if (locked) btn.textContent = t('servers.locked.button');
  }
  return locked;
}

function renderServers(servers) {
  const grid = document.getElementById('servers-grid');
  grid.innerHTML = '';

  if (servers.length === 0) {
    grid.innerHTML = `<div class="account-empty">${t('servers.empty')}</div>`;
    startStatusPolling(servers);
    return;
  }

  for (const server of servers) {
    const card = document.createElement('div');
    card.className = 'server-card';
    card.innerHTML = `
      <img class="banner" src="${escapeHtml(server.iconUrl || '')}" alt="" />
      <div class="card-body">
        <div class="name">${escapeHtml(server.name)}</div>
        <div class="desc">${escapeHtml(server.description || '')}</div>
        <div class="meta">
          <span class="badge">${escapeHtml(server.minecraftVersion)}</span>
          <span class="badge">${escapeHtml(server.loader.type)} ${escapeHtml(server.loader.version)}</span>
          ${authBadgesHtml(server.onlineMode)}
        </div>
        <div class="card-notice" hidden>
          <svg class="lock-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false">
            <path d="M17 9V7a5 5 0 0 0-10 0v2H5.5A1.5 1.5 0 0 0 4 10.5v8A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 18.5 9H17Zm-8 0V7a3 3 0 1 1 6 0v2H9Z" fill="currentColor"/>
          </svg>
          <span class="card-notice-text"></span>
        </div>
        <div class="status" data-status="${escapeHtml(server.id)}">
          <span class="status-dot"></span>
          <span class="status-text">${t('servers.checking')}</span>
        </div>
        <div class="actions">
          <button class="primary btn-play" data-server="${escapeHtml(server.id)}" style="flex:1;">${t('servers.install')}</button>
          <button class="secondary btn-cancel" data-server="${escapeHtml(server.id)}" hidden>${t('servers.cancel')}</button>
          <button class="btn-settings" data-server="${escapeHtml(server.id)}" title="${t('servers.settings')}">⚙</button>
        </div>
      </div>
    `;
    hideOnImgError(card);
    applyCardLock(card, server);
    grid.appendChild(card);
  }
  grid.querySelectorAll('.btn-play').forEach((btn) => {
    btn.addEventListener('click', () => launchServer(btn.dataset.server, btn));
    refreshPlayButtonLabel(btn, () => window.launcher.checkServerInstalled(btn.dataset.server));
  });
  grid.querySelectorAll('.btn-cancel').forEach((btn) => {
    btn.addEventListener('click', () => cancelActiveLaunch());
  });
  grid.querySelectorAll('.btn-settings').forEach((btn) => {
    btn.addEventListener('click', () => openSettingsModal(btn.dataset.server));
  });
  setAllPlayButtonsDisabled(launchBusy);

  startStatusPolling(servers);
}

// Re-evalue le verrouillage des cartes deja affichees apres un changement de
// compte (connexion, deconnexion, bascule depuis le gestionnaire de comptes)
// : sans reconstruire la grille, donc sans re-pinger les serveurs ni perdre
// le statut en ligne/hors ligne deja affiche.
async function refreshAccountRestrictions() {
  if (!config?.servers) return;

  const serversById = new Map(config.servers.map((server) => [server.id, server]));
  for (const card of document.querySelectorAll('#servers-grid .server-card')) {
    const btn = card.querySelector('.btn-play');
    const server = btn && serversById.get(btn.dataset.server);
    if (!server) continue;

    const wasLocked = btn.dataset.locked === '1';
    const isLocked = applyCardLock(card, server);
    // Deverrouille : le texte du bouton etait fige sur "Indisponible", il faut
    // re-interroger le disque pour savoir s'il faut afficher "Jouer" ou
    // "Installer" (best-effort, aucune erreur remontee par ce chemin).
    if (wasLocked && !isLocked) {
      await refreshPlayButtonLabel(btn, () => window.launcher.checkServerInstalled(server.id));
    }
  }
  setAllPlayButtonsDisabled(launchBusy);
}

// --- Statut en direct (en ligne/hors ligne + joueurs connectes) -----------
let statusPollTimer = null;

function parseHostPort(serverAddress) {
  const [host, portStr] = (serverAddress || '').split(':');
  return { host, port: portStr ? Number(portStr) : 25565 };
}

async function refreshServerStatuses(servers) {
  await Promise.all(servers.map(async (server) => {
    const el = document.querySelector(`[data-status="${server.id}"]`);
    if (!el) return;

    const { host, port } = parseHostPort(server.serverAddress);
    const dot = el.querySelector('.status-dot');
    const text = el.querySelector('.status-text');
    if (!host) {
      dot.className = 'status-dot offline';
      text.textContent = t('servers.invalidAddress');
      return;
    }

    const result = await window.launcher.pingServer(host, port);
    if (result.online) {
      dot.className = 'status-dot online';
      text.textContent = t('servers.players', result.players.online, result.players.max);
    } else {
      dot.className = 'status-dot offline';
      text.textContent = t('servers.offline');
    }
  }));
}

function startStatusPolling(servers) {
  if (statusPollTimer) clearInterval(statusPollTimer);
  refreshServerStatuses(servers);
  statusPollTimer = setInterval(() => refreshServerStatuses(servers), 20000);
}

// --- Reglages par instance (memoire + GPU) --------------------------------
const settingsModal = document.getElementById('settings-modal');
const settingsMemoryMin = document.getElementById('settings-memory-min');
const settingsMemoryMax = document.getElementById('settings-memory-max');
const settingsGpu = document.getElementById('settings-gpu');
let settingsServerId = null;
let gpuNamesPromise = null;
let systemInfoPromise = null;

// Detecte une seule fois par session le nom des cartes graphiques presentes,
// pour l'afficher a cote de "Performances"/"Economie d'energie" dans le menu.
function loadGpuNames() {
  if (!gpuNamesPromise) gpuNamesPromise = window.launcher.listGpus();
  return gpuNamesPromise;
}

function loadSystemInfo() {
  if (!systemInfoPromise) systemInfoPromise = window.launcher.getSystemInfo();
  return systemInfoPromise;
}

// Heuristique grossiere (taille de mods/ -> Go de RAM conseilles) : la
// taille sur disque correle raisonnablement avec le nombre de mods actifs
// (textures/classes embarquees), sans avoir besoin de vraiment compter les
// mods un par un. Retourne null en dessous du seuil ou l'on considere que
// les 2-4 Go par defaut suffisent deja (pas la peine d'afficher une
// suggestion inutile pour un petit pack).
function suggestMemoryForModsSize(bytes) {
  const mb = bytes / 1024 ** 2;
  if (mb > 500) return 8;
  if (mb > 200) return 6;
  if (mb > 50) return 4;
  return null;
}

async function openSettingsModal(serverId) {
  settingsServerId = serverId;
  const isCustomInstance = serverId.startsWith('custom:');

  // Une installation libre (id prefixe "custom:") n'a pas de modpack/manifest
  // impose par un operateur : le bouton "Reparer" (retelecharger le
  // modpack) n'a pas de sens pour elle, mclc revalide deja vanilla+loader a
  // chaque lancement. A l'inverse, le nom d'un serveur vient de servers.json
  // (fixe par l'operateur) : seule une installation libre peut etre
  // renommee par le joueur.
  document.getElementById('btn-repair').style.display = isCustomInstance ? 'none' : '';
  const nameField = document.getElementById('settings-name-field');
  nameField.style.display = isCustomInstance ? '' : 'none';
  if (isCustomInstance) {
    const instances = await window.launcher.listCustomInstances();
    const instance = instances.find((i) => `custom:${i.id}` === serverId);
    document.getElementById('settings-name').value = instance?.name || '';
  }

  const settings = await window.launcher.getServerSettings(serverId);
  settingsMemoryMin.value = settings.memoryMinGb;
  settingsMemoryMax.value = settings.memoryMaxGb;
  settingsGpu.value = settings.gpu;

  const gpus = await loadGpuNames();
  const dedicatedOpt = settingsGpu.querySelector('option[value="dedicated"]');
  const integratedOpt = settingsGpu.querySelector('option[value="integrated"]');
  dedicatedOpt.textContent = gpus.dedicated ? `${t('settings.gpu.dedicated')} : ${gpus.dedicated}` : t('settings.gpu.dedicated');
  integratedOpt.textContent = gpus.integrated
    ? `${t('settings.gpu.integrated')} : ${gpus.integrated}`
    : t('settings.gpu.integrated');
  settingsGpu.value = settings.gpu; // reappliquer apres avoir change le texte des options

  const { totalMemoryGb } = await loadSystemInfo();
  const ramHintEl = document.getElementById('settings-ram-hint');
  if (totalMemoryGb) {
    settingsMemoryMin.max = totalMemoryGb;
    settingsMemoryMax.max = totalMemoryGb;
    ramHintEl.textContent = t('settings.ramHint', totalMemoryGb);
  }

  // Suggestion informative seulement (ne modifie jamais les valeurs deja
  // choisies par le joueur) : un modpack avec plusieurs centaines de Mo de
  // mods a generalement besoin de bien plus que les 2-4 Go par defaut :
  // plutot que de laisser le joueur decouvrir ça via un OutOfMemoryError.
  try {
    const { bytes } = await window.launcher.getInstanceModsSize(serverId);
    const suggestedGb = suggestMemoryForModsSize(bytes);
    if (suggestedGb) {
      ramHintEl.textContent += ` ${t('settings.ramHintModpack', suggestedGb)}`;
    }
  } catch {
    // best-effort : pas grave si l'instance n'a pas encore ete lancee/synchronisee
  }

  settingsModal.classList.add('visible');
}

function closeSettingsModal() {
  settingsModal.classList.remove('visible');
  settingsServerId = null;
}

document.getElementById('btn-settings-cancel').addEventListener('click', closeSettingsModal);

document.getElementById('btn-open-folder').addEventListener('click', () => {
  if (settingsServerId) window.launcher.openInstanceFolder(settingsServerId);
});

document.getElementById('btn-open-logs').addEventListener('click', () => {
  if (settingsServerId) window.launcher.openInstanceLogs(settingsServerId);
});

document.getElementById('btn-repair').addEventListener('click', async () => {
  if (!settingsServerId) return;
  const serverId = settingsServerId;
  closeSettingsModal();

  progressPanel.classList.add('visible');
  progressFill.style.width = '0%';
  clearProgressLog();
  appendLog(t('progress.repairing', serverId));

  try {
    await window.launcher.repairInstance(serverId);
    progressLabel.textContent = t('progress.repairDone');
  } catch (err) {
    appendLog(t('progress.error', err.message || err));
    progressLabel.textContent = t('progress.repairFailed');
  }
});

window.launcher.onRepairProgress((p) => {
  progressLabel.textContent = t(PHASE_KEYS[p.phase] || p.phase);
  if (p.phase === 'sync' && p.total) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
    if (p.file) appendLog(`[modpack] ${p.done}/${p.total} - ${p.file}`);
  }
});

document.getElementById('btn-settings-save').addEventListener('click', async () => {
  if (!settingsServerId) return;
  const { totalMemoryGb } = await loadSystemInfo();
  const clamp = (v) => (totalMemoryGb ? Math.min(v, totalMemoryGb) : v);

  await window.launcher.setServerSettings(settingsServerId, {
    memoryMinGb: clamp(Number(settingsMemoryMin.value) || 2),
    memoryMaxGb: clamp(Number(settingsMemoryMax.value) || 4),
    gpu: settingsGpu.value
  });

  if (settingsServerId.startsWith('custom:')) {
    const id = settingsServerId.slice('custom:'.length);
    const name = document.getElementById('settings-name').value.trim();
    if (name) {
      await window.launcher.renameCustomInstance(id, name);
      renderCustomInstances();
    }
  }

  closeSettingsModal();
});

// --- Versions libres (page "Versions libres", comme le TLauncher) ---------
// Le joueur choisit lui-meme une version Minecraft + un loader, independant
// des serveurs/modpacks fixes par l'operateur (active via
// `branding.customInstances.enabled`).
const MC_TYPE_GROUP_KEYS = {
  release: 'custom.mcType.release',
  snapshot: 'custom.mcType.snapshot',
  old_beta: 'custom.mcType.oldBeta',
  old_alpha: 'custom.mcType.oldAlpha'
};

async function renderCustomInstances() {
  const grid = document.getElementById('custom-instances-grid');
  const instances = await window.launcher.listCustomInstances();

  if (instances.length === 0) {
    grid.innerHTML = `<div class="account-empty">${t('custom.empty')}</div>`;
    return;
  }

  grid.innerHTML = '';
  for (const instance of instances) {
    const card = document.createElement('div');
    card.className = 'server-card';
    const loaderLabel = instance.loader.type === 'vanilla'
      ? 'Vanilla'
      : `${instance.loader.type} ${instance.loader.version}`;
    card.innerHTML = `
      ${customInstancesBannerUrl ? `<img class="banner" src="${escapeHtml(customInstancesBannerUrl)}" alt="" />` : ''}
      <div class="card-body">
      <div class="name">${escapeHtml(instance.name)}</div>
      <div class="meta">
        <span class="badge">${escapeHtml(instance.mcVersion)}</span>
        <span class="badge">${escapeHtml(loaderLabel)}</span>
      </div>
      <div class="actions">
        <button class="primary btn-play" data-id="${escapeHtml(instance.id)}" style="flex:1;">${t('servers.install')}</button>
        <button class="btn-settings" data-id="${escapeHtml(instance.id)}" title="${t('servers.settings')}">⚙</button>
        <button class="btn-settings btn-remove-instance" data-id="${escapeHtml(instance.id)}" title="${t('custom.remove')}">🗑</button>
      </div>
      </div>
    `;
    hideOnImgError(card);
    grid.appendChild(card);
  }

  grid.querySelectorAll('.btn-play').forEach((btn) => {
    btn.addEventListener('click', () => launchCustomInstanceUI(btn.dataset.id, btn));
    refreshPlayButtonLabel(btn, () => window.launcher.checkCustomInstanceInstalled(btn.dataset.id));
  });
  setAllPlayButtonsDisabled(launchBusy);
  grid.querySelectorAll('.btn-settings:not(.btn-remove-instance)').forEach((btn) => {
    btn.addEventListener('click', () => openSettingsModal(`custom:${btn.dataset.id}`));
  });
  grid.querySelectorAll('.btn-remove-instance').forEach((btn) => {
    btn.addEventListener('click', async () => {
      // Supprime aussi le dossier de l'instance (donc ses mondes sauvegardes
      // s'il y en a) : confirmation obligatoire, contrairement a "Retirer"
      // un compte (juste une reconnexion a refaire, aucune perte de donnees).
      if (!confirm(t('custom.removeConfirm', btn.closest('.server-card').querySelector('.name').textContent))) return;
      await window.launcher.removeCustomInstance(btn.dataset.id);
      renderCustomInstances();
    });
  });
}

async function launchCustomInstanceUI(id, button) {
  if (!currentAccount) {
    await renderAccountsList();
    accountsModal.classList.add('visible');
    return;
  }
  if (launchBusy) return; // securite : les boutons devraient deja etre desactives

  beginLaunch(button, () => window.launcher.checkCustomInstanceInstalled(id));
  if (consoleEnabled) progressPanel.classList.add('visible');
  progressFill.style.width = '0%';
  clearProgressLog();

  try {
    await window.launcher.launchCustomInstance(id);
    // Le jeu tourne encore : endLaunch() sera appele par onGameEvent('close').
  } catch (err) {
    // Meme si la console est masquee par defaut, un echec doit rester
    // visible : sinon le joueur voit juste le bouton revenir a "Jouer"
    // sans aucune explication.
    progressPanel.classList.add('visible');
    appendLog(t('progress.error', err.message || err));
    progressLabel.textContent = t('progress.launchFailed');
    await endLaunch();
  }
}

// --- Creation d'une nouvelle installation libre ---------------------------
const newInstanceModal = document.getElementById('new-instance-modal');
const newInstanceMcVersion = document.getElementById('new-instance-mcversion');
const newInstanceLoader = document.getElementById('new-instance-loader');
const newInstanceLoaderVersion = document.getElementById('new-instance-loaderversion');
const newInstanceLoaderVersionField = document.getElementById('new-instance-loaderversion-field');

let mcVersionsPromise = null;
function loadMcVersions() {
  if (!mcVersionsPromise) mcVersionsPromise = window.launcher.listMinecraftVersions();
  return mcVersionsPromise;
}

function showNewInstanceError(message) {
  const box = document.getElementById('new-instance-error');
  box.textContent = message;
  box.classList.add('visible');
}

async function populateMcVersionSelect() {
  const [versions, prefs] = await Promise.all([loadMcVersions(), loadPreferences()]);
  const groups = {};
  for (const v of versions) {
    // Snapshots et anciennes versions (alpha/beta) masquees par defaut
    // (cases a cocher dans les options) : pas pertinentes pour un joueur
    // lambda, et ca allonge beaucoup la liste sans ca.
    if (v.type === 'snapshot' && !prefs.showSnapshots) continue;
    if ((v.type === 'old_beta' || v.type === 'old_alpha') && !prefs.showOldVersions) continue;
    (groups[v.type] ||= []).push(v);
  }

  newInstanceMcVersion.innerHTML = '';
  // Ordre fixe (plutot que l'ordre d'apparition dans le manifest, qui
  // entremele releases/snapshots par date) : les versions stables d'abord,
  // les plus "exotiques" en dernier.
  const typeOrder = ['release', 'snapshot', 'old_beta', 'old_alpha'];
  const orderedTypes = [...typeOrder, ...Object.keys(groups).filter((type) => !typeOrder.includes(type))];
  for (const type of orderedTypes) {
    const list = groups[type];
    if (!list) continue;
    const optgroup = document.createElement('optgroup');
    optgroup.label = t(MC_TYPE_GROUP_KEYS[type] || type);
    for (const v of list) {
      const option = document.createElement('option');
      option.value = v.id;
      option.dataset.type = v.type;
      option.textContent = v.id;
      optgroup.appendChild(option);
    }
    newInstanceMcVersion.appendChild(optgroup);
  }
}

async function populateLoaderVersionSelect() {
  const type = newInstanceLoader.value;
  if (type === 'vanilla') {
    newInstanceLoaderVersionField.style.display = 'none';
    return;
  }
  newInstanceLoaderVersionField.style.display = '';

  newInstanceLoaderVersion.innerHTML = `<option value="">${t('custom.modal.loadingVersions')}</option>`;
  try {
    const versions = await window.launcher.listLoaderVersions(type, newInstanceMcVersion.value);
    if (versions.length === 0) {
      newInstanceLoaderVersion.innerHTML = `<option value="">${t('custom.modal.noVersions')}</option>`;
      return;
    }
    newInstanceLoaderVersion.innerHTML = versions.map((v) => `<option value="${v}">${v}</option>`).join('');
  } catch (err) {
    newInstanceLoaderVersion.innerHTML = `<option value="">${t('custom.modal.noVersions')}</option>`;
    showNewInstanceError(friendlyError(err));
  }
}

newInstanceLoader.addEventListener('change', populateLoaderVersionSelect);
newInstanceMcVersion.addEventListener('change', populateLoaderVersionSelect);

document.getElementById('btn-new-instance').addEventListener('click', async () => {
  document.getElementById('new-instance-name').value = '';
  document.getElementById('new-instance-error').classList.remove('visible');
  newInstanceLoader.value = 'vanilla';
  await populateMcVersionSelect();
  await populateLoaderVersionSelect();
  newInstanceModal.classList.add('visible');
});

document.getElementById('btn-new-instance-cancel').addEventListener('click', () => {
  newInstanceModal.classList.remove('visible');
});

document.getElementById('btn-new-instance-create').addEventListener('click', async () => {
  const name = document.getElementById('new-instance-name').value.trim();
  const mcVersionOption = newInstanceMcVersion.selectedOptions[0];
  const loaderType = newInstanceLoader.value;
  const loaderVersion = loaderType === 'vanilla' ? undefined : newInstanceLoaderVersion.value;

  if (!mcVersionOption) {
    showNewInstanceError(t('custom.modal.noVersions'));
    return;
  }
  if (loaderType !== 'vanilla' && !loaderVersion) {
    showNewInstanceError(t('custom.modal.noVersions'));
    return;
  }

  try {
    await window.launcher.createCustomInstance({
      name,
      mcVersion: mcVersionOption.value,
      mcVersionType: mcVersionOption.dataset.type,
      loader: { type: loaderType, version: loaderVersion }
    });
    newInstanceModal.classList.remove('visible');
    renderCustomInstances();
  } catch (err) {
    showNewInstanceError(friendlyError(err));
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function boot() {
  showView('boot');
  document.getElementById('boot-error').classList.remove('visible');
  document.getElementById('btn-retry-boot').style.display = 'none';
  document.getElementById('splash-spinner').classList.remove('hidden');
  document.getElementById('boot-message').textContent = t('boot.connecting');

  // Duree minimale d'affichage du splash : evite un flash trop rapide/moche
  // quand l'API et la reconnexion silencieuse repondent quasi instantanement.
  const minSplash = delay(1800);

  try {
    userAccent = (await loadPreferences()).userAccentColor || null;
    config = await window.launcher.getConfig();
    applyBranding(config.branding);
    renderServers(config.servers);
    await setupNews(config.news);

    // Premier lancement (jamais initialise) : on memorise les serveurs deja
    // presents comme "vus" sans notifier : seuls ceux ajoutes APRES ce point
    // declencheront une notification "nouveau serveur".
    const prefsBoot = await loadPreferences();
    if (!Array.isArray(prefsBoot.seenServerIds)) {
      await updatePreferences({ seenServerIds: config.servers.map((s) => s.id) });
    }
    setConsoleEnabled(!!prefsBoot.showLaunchConsole, { persist: false });

    // Compte actif memorise (offline/Ely.by/Microsoft) : tentative de
    // reconnexion automatique pour eviter de tout retaper a chaque fois :
    // et donc de ne JAMAIS montrer l'ecran de connexion dans ce cas.
    const { accounts, activeAccountId } = await window.launcher.listAccounts();
    const activeAccount = accounts.find((a) => a.id === activeAccountId);
    if (activeAccount?.provider === 'offline') {
      document.getElementById('offline-username').value = activeAccount.name;
    }

    let loggedInAccount = null;
    if (activeAccountId) {
      try {
        loggedInAccount = await window.launcher.switchAccount(activeAccountId);
      } catch {
        // echec (session expiree, pseudo desormais pris chez Mojang, etc.) :
        // on retombe sur l'ecran de connexion normal.
      }
    }

    await minSplash;
    // La liste des serveurs est TOUJOURS la page d'accueil, connecte ou non
    // : se connecter n'est plus un mur de depart, seul "Jouer" l'exige (cf.
    // launchServer). L'ecran de connexion reste accessible via le bouton de
    // compte dans l'en-tete.
    if (loggedInAccount) onLoggedIn(loggedInAccount);
    else onLoggedOut();
    showView('servers');
    maybeAutoShowNews();
    refreshNotifications();
  } catch (err) {
    await minSplash;
    document.getElementById('splash-spinner').classList.add('hidden');
    document.getElementById('boot-message').textContent = t('boot.refused');
    const errBox = document.getElementById('boot-error');
    errBox.textContent = friendlyError(err);
    errBox.classList.add('visible');
    document.getElementById('btn-retry-boot').style.display = 'inline-block';
  }
}

document.getElementById('btn-retry-boot').addEventListener('click', boot);

// --- Mise a jour en direct (annonces, serveurs) --------------------------------------------------
// Chaque minute (et des que la fenetre reprend le focus), on redemande la configuration a l'API par une requete
// conditionnelle : si rien n'a change, rien n'est retelecharge. Une nouvelle annonce ou un nouveau serveur apparait
// ainsi dans la cloche sans relancer le launcher. Le branding (theme, logo, musique) reste applique au demarrage.
const LIVE_REFRESH_MS = 60000;
let liveRefreshing = false;
let pendingServersRender = false;

// La liste des serveurs n'est jamais reconstruite pendant un lancement (les boutons et la progression en dependent) :
// elle l'est des la fin du lancement.
function flushPendingLiveRender() {
  if (!pendingServersRender || launchBusy || !config) return;
  pendingServersRender = false;
  renderServers(config.servers);
}

async function liveRefreshConfig() {
  if (!config || liveRefreshing || document.hidden) return;
  liveRefreshing = true;
  try {
    const result = await window.launcher.refreshConfig();
    if (!result?.changed) return;
    const previous = config;
    config = result.config;
    if (JSON.stringify(previous.news) !== JSON.stringify(config.news)) {
      await setupNews(config.news);
      if (newsModal.classList.contains('visible')) renderNewsList();
    }
    if (JSON.stringify(previous.servers) !== JSON.stringify(config.servers)) {
      pendingServersRender = true;
      flushPendingLiveRender();
    }
    await refreshNotifications();
  } catch {
    // hors ligne ou API indisponible : on reessaiera a la prochaine minute
  } finally {
    liveRefreshing = false;
  }
}
setInterval(liveRefreshConfig, LIVE_REFRESH_MS);
window.addEventListener('focus', liveRefreshConfig);

// L'ecran de connexion n'est plus un mur de depart (cf. boot()), mais rien
// ne permettait jusqu'ici d'y renoncer une fois ouvert (ex: depuis "+
// Ajouter un compte") sans aller au bout d'une connexion : on revient
// simplement a la liste des serveurs.
document.getElementById('btn-login-close').addEventListener('click', () => {
  showView('servers');
});

// --- Onglets de connexion -------------------------------------------------
// Scope a #view-login uniquement : .tab-btn est aussi utilisee par les
// onglets de navigation principaux (#main-nav), geres separement plus haut.
document.querySelectorAll('#view-login .tab-btn').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#view-login .tab-btn').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.login-pane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`[data-pane="${tab.dataset.tab}"]`).classList.add('active');
  });
});

function showLoginError(message) {
  console.error('[login] echec :', message);
  const box = document.getElementById('login-error');
  box.textContent = message;
  box.classList.add('visible');
}

// --- Notifications (cloche : nouvelles annonces + nouveaux serveurs) ------
// Combine deux sources dans un seul badge/compteur : les annonces non lues
// (cf. unreadNewsEntries ci-dessus) et les serveurs ajoutes par l'operateur
// depuis la derniere visite (prefs.seenServerIds, initialise au premier
// lancement pour ne jamais notifier retroactivement des serveurs deja
// presents avant cette fonctionnalite, cf. boot()).
const notifWrap = document.getElementById('notif-wrap');
const btnNotifications = document.getElementById('btn-notifications');
const notifBadge = document.getElementById('notif-badge');
const notifDropdown = document.getElementById('notif-dropdown');
const notifList = document.getElementById('notif-list');

function closeNotifDropdown() {
  notifDropdown.hidden = true;
}

btnNotifications.addEventListener('click', () => {
  if (typeof closeMenu === 'function') closeMenu();
  notifDropdown.hidden = !notifDropdown.hidden;
});

document.addEventListener('click', (e) => {
  if (!notifDropdown.hidden && !notifWrap.contains(e.target) && !burgerWrap.contains(e.target)) closeNotifDropdown();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNotifDropdown();
});

function newServersList(prefs) {
  if (!Array.isArray(prefs.seenServerIds) || !config?.servers) return [];
  const seen = new Set(prefs.seenServerIds);
  return config.servers.filter((s) => !seen.has(s.id));
}

function renderNotifList(unreadNews, newServers) {
  notifList.innerHTML = '';
  if (unreadNews.length === 0 && newServers.length === 0) {
    notifList.innerHTML = `<div class="notif-empty">${t('notif.empty')}</div>`;
    return;
  }

  for (const entry of unreadNews) {
    const item = document.createElement('button');
    item.className = 'notif-item';
    item.innerHTML = `<span class="icon">📰</span><div><div class="title"></div><div class="meta">${entry.date || ''}</div></div>`;
    item.querySelector('.title').textContent = t('notif.news', entry.title);
    item.addEventListener('click', () => {
      closeNotifDropdown();
      openNewsModal();
    });
    notifList.appendChild(item);
  }

  for (const server of newServers) {
    const item = document.createElement('button');
    item.className = 'notif-item';
    item.innerHTML = `<span class="icon">🖥️</span><div><div class="title"></div></div>`;
    item.querySelector('.title').textContent = t('notif.newServer', server.name);
    item.addEventListener('click', async () => {
      closeNotifDropdown();
      navServers.click();
      const prefs = await loadPreferences();
      const seen = new Set(prefs.seenServerIds || []);
      seen.add(server.id);
      await updatePreferences({ seenServerIds: [...seen] });
      refreshNotifications();
    });
    notifList.appendChild(item);
  }
}

async function refreshNotifications() {
  const prefs = await loadPreferences();
  const unreadNews = unreadNewsEntries(prefs);
  const newServers = newServersList(prefs);

  const total = unreadNews.length + newServers.length;
  notifBadge.textContent = String(total);
  notifBadge.hidden = total === 0;
  notifWrap.style.display = 'inline-block';
  // Copie dans le menu "trois traits" (visible quand la fenetre est etroite).
  menuItemNotifications.hidden = false;
  menuNotifBadge.textContent = String(total);
  menuNotifBadge.hidden = total === 0;
  burgerDot.hidden = total === 0;

  renderNotifList(unreadNews, newServers);
}

document.getElementById('notif-mark-all-read').addEventListener('click', async () => {
  const patch = { seenServerIds: (config?.servers || []).map((s) => s.id) };
  if (newsEntries[0]) patch.lastSeenNewsId = newsEntries[0].id;
  await updatePreferences(patch);
  await refreshNotifications();
});

document.getElementById('notif-mark-all-unread').addEventListener('click', async () => {
  await updatePreferences({ lastSeenNewsId: null, seenServerIds: [] });
  await refreshNotifications();
});

// --- En-tete : compte + menu "trois traits" ---------------------------------
// Le pseudo ouvre directement le gestionnaire de comptes ; le bouton
// "trois traits" regroupe le volume de la musique, Options et Annonces.
const menuWrap = document.getElementById('menu-wrap');
const btnMenu = document.getElementById('btn-menu');
const menuLabel = document.getElementById('menu-label');
const burgerWrap = document.getElementById('burger-wrap');
const btnBurger = document.getElementById('btn-burger');
const burgerDropdown = document.getElementById('burger-dropdown');

function closeMenu() {
  burgerDropdown.hidden = true;
}

btnBurger.addEventListener('click', () => {
  closeNotifDropdown();
  burgerDropdown.hidden = !burgerDropdown.hidden;
});

// Le curseur de volume reste utilisable sans fermer le menu : seul un clic
// en dehors du bloc (bouton + menu) le referme.
document.addEventListener('click', (e) => {
  if (!burgerDropdown.hidden && !burgerWrap.contains(e.target)) closeMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});

// Fenetre etroite : la cloche et le bouton de theme quittent l'en-tete (cf.
// styles.css) et sont reranges dans ce menu. Le panneau de notifications
// suit : il s'ouvre alors sous le bouton "trois traits" au lieu de la cloche.
const menuItemNotifications = document.getElementById('menu-item-notifications');
const menuNotifBadge = document.getElementById('menu-notif-badge');
const burgerDot = document.getElementById('burger-dot');
const menuThemeLabel = document.getElementById('menu-theme-label');
const narrowHeaderQuery = window.matchMedia('(max-width: 1090px)');

function placeNotifDropdown() {
  notifDropdown.hidden = true;
  (narrowHeaderQuery.matches ? burgerWrap : notifWrap).appendChild(notifDropdown);
  closeMenu();
}
narrowHeaderQuery.addEventListener('change', placeNotifDropdown);
placeNotifDropdown();

function updateThemeMenuItem() {
  menuThemeLabel.textContent = t(currentMode() === 'dark' ? 'menu.themeToLight' : 'menu.themeToDark');
}
updateThemeMenuItem();

menuItemNotifications.addEventListener('click', () => {
  closeMenu();
  notifDropdown.hidden = false;
});

document.getElementById('menu-item-theme').addEventListener('click', () => {
  closeMenu();
  setMode(currentMode() === 'dark' ? 'light' : 'dark');
});

btnMenu.addEventListener('click', async () => {
  closeMenu();
  closeNotifDropdown();
  await renderAccountsList();
  accountsModal.classList.add('visible');
});

document.getElementById('menu-item-options').addEventListener('click', () => {
  closeMenu();
  openOptionsModal();
});

document.getElementById('menu-item-news').addEventListener('click', () => {
  closeMenu();
  openNewsModal();
});

// Petit repere visuel par type de compte (pseudo dans l'en-tete + gestionnaire
// de comptes) : pas d'icone officielle Ely.by/Microsoft disponible en local
// sans dependance externe, on reste sur des emoji comme le reste de l'appli
// (⚙, 🔊, 🗑...). 🧭 reprend le logo boussole d'Ely.by ; 🪟 evoque Windows/
// Microsoft ; 👤 represente un joueur anonyme pour le compte gratuit.
const PROVIDER_ICONS = { offline: '👤', elyby: '🧭', microsoft: '🪟' };

function onLoggedIn(account) {
  console.log(`[login] connecte : ${account.name} (${account.provider}), uuid=${account.uuid}`);
  currentAccount = account;
  const icon = PROVIDER_ICONS[account.provider] || '';
  // Le type de compte n'est plus ecrit a cote du pseudo (gain de place) :
  // l'icone et l'infobulle suffisent.
  menuLabel.textContent = `${icon} ${account.name}`;
  btnMenu.title = `${t('menu.account')} : ${t(`accounts.provider.${account.provider}`)}`;
  btnMenu.classList.add('is-connected');
  menuWrap.style.display = 'inline-block';
  burgerWrap.style.display = 'inline-block';
  showView('servers');
  // Le type de compte (Microsoft premium vs gratuit/Ely.by) conditionne les
  // serveurs jouables (cf. serverAccountMismatch) : les cartes deja affichees
  // doivent etre re-evaluees a chaque connexion/bascule de compte.
  refreshAccountRestrictions();
}

function onLoggedOut() {
  currentAccount = null;
  menuLabel.textContent = t('accounts.signIn');
  btnMenu.title = t('menu.account');
  btnMenu.classList.remove('is-connected');
  menuWrap.style.display = 'inline-block';
  burgerWrap.style.display = 'inline-block';
  refreshAccountRestrictions();
}

// --- Gestionnaire de comptes (switch rapide, comme TLauncher) -------------
const accountsModal = document.getElementById('accounts-modal');
const accountsList = document.getElementById('accounts-list');

async function renderAccountsList() {
  const { accounts, activeAccountId } = await window.launcher.listAccounts();
  accountsList.innerHTML = '';

  if (accounts.length === 0) {
    accountsList.innerHTML = `<div class="account-empty">${t('accounts.empty')}</div>`;
    return;
  }

  for (const account of accounts) {
    const row = document.createElement('div');
    row.className = `account-row${account.id === activeAccountId ? ' active' : ''}`;
    // Apercu du skin via le service public d'Ely.by (base sur le pseudo,
    // fonctionne aussi bien pour un compte hors-ligne/Ely.by/Microsoft :
    // leur systeme reprend/proxifie aussi les skins premium Mojang). Lecture
    // seule : Ely.by n'expose aucune API publique pour uploader un skin,
    // seulement leur site (cf. lien "Gerer mon skin" plus bas).
    const skinUrl = `https://skinsystem.ely.by/skins/${encodeURIComponent(account.name)}.png`;
    const canManageSkin = account.provider === 'offline' || account.provider === 'elyby';
    row.innerHTML = `
      <div class="skin-avatar">
        <canvas width="32" height="32"></canvas>
      </div>
      <div class="info">
        <div class="name">${PROVIDER_ICONS[account.provider] || ''} ${escapeHtml(account.name)}</div>
        <div class="provider">${t(`accounts.provider.${account.provider}`)}</div>
        ${canManageSkin ? `<button class="link btn-manage-skin" data-id="${escapeHtml(account.id)}">${t('accounts.manageSkin')}</button>` : ''}
      </div>
      <button class="btn-use" data-id="${escapeHtml(account.id)}">${t('accounts.use')}</button>
      <button class="btn-remove" data-id="${escapeHtml(account.id)}" title="${t('accounts.remove')}">✕</button>
    `;
    renderFaceAvatar(row.querySelector('canvas'), skinUrl);
    accountsList.appendChild(row);
  }

  accountsList.querySelectorAll('.btn-manage-skin').forEach((btn) => {
    btn.addEventListener('click', () => window.launcher.openExternal('https://ely.by/skins/add'));
  });

  accountsList.querySelectorAll('.btn-use').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = t('accounts.switching');
      try {
        const account = await window.launcher.switchAccount(btn.dataset.id);
        onLoggedIn(account);
        accountsModal.classList.remove('visible');
      } catch (err) {
        alert(t('accounts.switchFailed', friendlyError(err)));
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
  });

  accountsList.querySelectorAll('.btn-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('accounts.removeConfirm'))) return;
      await window.launcher.removeAccount(btn.dataset.id);
      renderAccountsList();
    });
  });
}

document.getElementById('btn-accounts-close').addEventListener('click', () => {
  accountsModal.classList.remove('visible');
});

document.getElementById('btn-accounts-add').addEventListener('click', () => {
  accountsModal.classList.remove('visible');
  showView('login');
});

document.getElementById('btn-accounts-disconnect').addEventListener('click', async () => {
  await window.launcher.logout();
  onLoggedOut();
  accountsModal.classList.remove('visible');
});

document.getElementById('btn-login-offline').addEventListener('click', async () => {
  const username = document.getElementById('offline-username').value.trim();
  try {
    const account = await window.launcher.loginOffline(username);
    onLoggedIn(account);
  } catch (err) {
    showLoginError(friendlyError(err));
  }
});

document.getElementById('btn-login-elyby').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const username = document.getElementById('elyby-username').value.trim();
  const password = document.getElementById('elyby-password').value;
  const totpToken = document.getElementById('elyby-totp').value.trim() || undefined;
  btn.disabled = true;
  btn.textContent = t('login.connecting');
  try {
    const account = await window.launcher.loginElyBy(username, password, totpToken);
    onLoggedIn(account);
  } catch (err) {
    showLoginError(friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = t('login.elyby.button');
  }
});

document.getElementById('btn-login-microsoft').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = t('login.connecting'); // "Connexion..." : reutilise, generique
  try {
    const account = await window.launcher.loginMicrosoft();
    onLoggedIn(account);
  } catch (err) {
    showLoginError(friendlyError(err));
  } finally {
    btn.disabled = false;
    btn.textContent = t('login.microsoft.button');
  }
});

// --- Lancement d'un serveur ------------------------------------------------
const progressPanel = document.getElementById('progress-panel');
const progressLabel = document.getElementById('progress-label');
const progressFill = document.getElementById('progress-fill');
const progressLog = document.getElementById('progress-log');
const btnKillGame = document.getElementById('btn-kill-game');
const btnHideConsole = document.getElementById('btn-hide-console');

// Masquage manuel ponctuel (croix) : ne touche pas a l'option "Afficher la
// console de lancement" (consoleEnabled/preferences), donc le panneau
// reapparaitra normalement au prochain lancement ou crash.
btnHideConsole.addEventListener('click', () => {
  progressPanel.classList.remove('visible');
});

// Quand le panneau console s'affiche et que le contenu ne tient plus, on
// agrandit la fenetre (plutot que d'afficher un ascenseur a cote des
// serveurs), puis on la ramene a sa taille d'origine quand il disparait.
let windowFitQueued = false;
function syncWindowHeight() {
  if (windowFitQueued) return;
  windowFitQueued = true;
  requestAnimationFrame(() => {
    windowFitQueued = false;
    if (!progressPanel.classList.contains('visible')) {
      window.launcher.restoreWindowHeight();
      return;
    }
    // La vue active ne tient plus dans la place restante : elle deborderait
    // (ascenseur). On demande exactement la hauteur manquante.
    const view = document.querySelector('main > .view.active');
    const overflow = view ? view.scrollHeight - view.clientHeight : 0;
    if (overflow > 0) window.launcher.fitWindowHeight(window.innerHeight + overflow + 1);
  });
}
new ResizeObserver(syncWindowHeight).observe(progressPanel);

// Distingue un arret volontaire (bouton "Forcer l'arret") d'un vrai
// plantage : le process tue declenche quand meme 'close' avec un code non-0
// (signal de kill), qui afficherait sinon a tort "le jeu a plante".
let forceStoppingGame = false;

// Rempli par l'evenement 'crash-diagnosis' (cf. crashDiagnostics.js cote
// main), juste avant 'close' quand le code de sortie est non-nul : vide
// sinon (fermeture normale, ou crash sans rapport exploitable dans le log).
let lastCrashDiagnosis = null;

btnKillGame.addEventListener('click', async () => {
  forceStoppingGame = true;
  btnKillGame.disabled = true;
  await window.launcher.killGame();
  // onGameEvent('close') s'occupe du reste (endLaunch, etc.) des que le
  // process tue declenche effectivement l'evenement : pas besoin de le
  // dupliquer ici.
});

// Le bloc entier (console/log technique sous la liste des serveurs) est
// masque par defaut : desormais que le bouton "Jouer" affiche lui-meme la
// progression (Preparation.../Telechargement X%), ce panneau ne sert plus
// qu'au debogage. Son affichage est controle uniquement par l'option "menu >
// Options > Afficher la console de lancement", memorisee dans les preferences.
let consoleEnabled = false;

function setConsoleEnabled(enabled, { persist = true } = {}) {
  consoleEnabled = enabled;
  optionShowConsole.checked = enabled;
  if (persist) updatePreferences({ showLaunchConsole: enabled });
}

const PHASE_KEYS = {
  manifest: 'progress.manifest',
  diskspace: 'progress.diskspace',
  sync: 'progress.sync',
  scan: 'progress.scan',
  whitelist: 'progress.whitelist',
  loader: 'progress.loader',
  java: 'progress.java',
  launching: 'progress.launching',
  launched: 'progress.launched',
  done: 'progress.done'
};

// Plafond defensif : si le jeu se bloque sans jamais fermer proprement (donc
// sans jamais emettre 'close') et se met a boucler sur une meme ligne
// d'erreur indefiniment, ce panneau ne doit pas grossir sans limite : ca
// degraderait l'UI elle-meme avec le temps, en plus d'etre illisible.
const LOG_MAX_LINES = 1000;
let logLineCount = 0;

function clearProgressLog() {
  progressLog.textContent = '';
  logLineCount = 0;
}

// `chunk` peut contenir plusieurs lignes d'un coup (le main process regroupe
// desormais les lignes de log du jeu par lots de 120ms, cf. wireLaunchCallbacks
// dans ipc.js, pour eviter de saturer l'IPC/le DOM si un mod spamme la
// console en continu) : on compte donc les vrais retours a la ligne plutot
// que de supposer un appel = une ligne, sinon le plafond defensif ci-dessus
// perdrait tout son sens des qu'un flush contient plus d'une ligne.
function appendLog(chunk) {
  const lineCount = (chunk.match(/\n/g)?.length ?? 0) + 1;
  if (logLineCount + lineCount > LOG_MAX_LINES) {
    const lines = `${progressLog.textContent}${chunk}`.split('\n');
    progressLog.textContent = lines.slice(-Math.floor(LOG_MAX_LINES / 2)).join('\n');
    logLineCount = Math.floor(LOG_MAX_LINES / 2);
  } else {
    progressLog.textContent += `${chunk}\n`;
    logLineCount += lineCount;
  }
  progressLog.scrollTop = progressLog.scrollHeight;
}

// --- Machine a etats des boutons "Jouer" -----------------------------------
// Un seul lancement possible a la fois (le panneau de progression/la console
// sont partages entre toutes les cartes) : tant que `launchBusy` est vrai,
// TOUS les boutons "Jouer"/"Installer" sont desactives, pas seulement celui
// sur lequel on a clique : evite de corrompre l'etat partage en demarrant un
// second lancement pendant qu'un premier tourne encore.
let launchBusy = false;
let activeLaunchButton = null;
let activeCheckFn = null;

function setAllPlayButtonsDisabled(disabled) {
  document.querySelectorAll('.btn-play').forEach((btn) => {
    if (btn === activeLaunchButton) return; // gere son propre etat/texte
    if (btn.dataset.locked === '1') return; // verrouille (compte incompatible)
    btn.disabled = disabled;
  });
}

// Interroge (sans rien telecharger) si le contenu de ce serveur/cette
// instance est deja installe, et affiche "Jouer" ou "Installer" en
// consequence : appele au rendu de chaque carte, et a nouveau apres tout
// lancement (succes/erreur/annulation) pour refleter la realite du disque.
async function refreshPlayButtonLabel(btn, checkFn) {
  if (btn === activeLaunchButton) return; // lancement en cours, ne pas ecraser son texte
  if (btn.dataset.locked === '1') return; // compte incompatible : texte fige sur "Indisponible"
  try {
    const { installed } = await checkFn();
    // Re-verifie apres l'await : un compte incompatible a pu etre selectionne
    // entre-temps (la verification est asynchrone), auquel cas le texte du
    // bouton ne doit surtout pas redevenir "Jouer".
    if (btn.dataset.locked === '1') return;
    btn.textContent = installed ? t('servers.play') : t('servers.install');
  } catch {
    // best-effort : on laisse le texte par defaut ("Installer", plus sur
    // qu'un faux "Jouer" en cas d'echec de la verification).
  }
}

function activeCancelButton() {
  if (!activeLaunchButton) return null;
  return activeLaunchButton.closest('.actions')?.querySelector('.btn-cancel') || null;
}

// Le bouton "Annuler" n'est propose que pendant les phases ou l'annulation
// est reellement prise en compte cote main process (avant/pendant le
// telechargement du modpack, cf. cancelToken dans launch.js) : le cacher
// au-dela evite de laisser croire qu'un clic aurait un effet immediat.
function setCancelable(cancelable) {
  const btn = activeCancelButton();
  if (btn) btn.hidden = !cancelable;
}

async function cancelActiveLaunch() {
  setCancelable(false);
  await window.launcher.cancelLaunch();
}

function beginLaunch(button, checkFn) {
  launchBusy = true;
  activeLaunchButton = button;
  activeCheckFn = checkFn;
  setAllPlayButtonsDisabled(true);
  button.disabled = true;
  button.textContent = t('servers.preparing');
  btnKillGame.hidden = true;
  btnKillGame.disabled = false;
}

// Remet tout a plat une fois le lancement termine, qu'il ait reussi (le jeu
// tourne puis se ferme, cf. onGameEvent 'close'), echoue, ou ete annule :
// re-interroge le vrai statut d'installation plutot que de deviner.
async function endLaunch() {
  const button = activeLaunchButton;
  const checkFn = activeCheckFn;
  launchBusy = false;
  setCancelable(false);
  activeLaunchButton = null;
  activeCheckFn = null;
  setAllPlayButtonsDisabled(false);
  if (button) {
    button.disabled = false;
    if (checkFn) await refreshPlayButtonLabel(button, checkFn);
    else button.textContent = t('servers.play');
  }
  flushPendingLiveRender();
}

window.launcher.onLaunchProgress((p) => {
  progressLabel.textContent = t(PHASE_KEYS[p.phase] || p.phase, p.major);
  setCancelable(p.phase === 'manifest' || p.phase === 'diskspace' || p.phase === 'sync');
  if (p.phase === 'sync' && p.total) {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    progressFill.style.width = `${pct}%`;
    if (activeLaunchButton) activeLaunchButton.textContent = t('servers.downloading', pct);
    if (p.file) appendLog(`[modpack] ${p.done}/${p.total} - ${p.file}`);
  } else if (p.phase === 'launched') {
    // Le jeu tourne desormais (potentiellement pendant longtemps) : ne pas
    // laisser le bouton bloque sur "Preparation...", qui redeviendrait faux
    // des cet instant et resterait affiche jusqu'a la fermeture du jeu.
    progressFill.style.width = '100%';
    if (activeLaunchButton) activeLaunchButton.textContent = t('servers.running');
    // Le process java tourne reellement a partir d'ici : "Forcer l'arret"
    // n'a de sens qu'a partir de ce moment (pas pendant le telechargement,
    // deja couvert par "Annuler").
    btnKillGame.hidden = false;
  } else {
    if (p.phase === 'launching' || p.phase === 'loader' || p.phase === 'java') {
      progressFill.style.width = '100%';
    }
    if (activeLaunchButton) activeLaunchButton.textContent = t('servers.preparing');
  }
});

window.launcher.onGameEvent((evt, payload) => {
  if (evt === 'data' || evt === 'debug') {
    appendLog(String(payload).trim());
  }
  if (evt === 'crash-diagnosis') {
    lastCrashDiagnosis = payload;
    appendLog(`\n[diagnostic] ${payload}`);
  }
  if (evt === 'close') {
    btnKillGame.hidden = true;
    btnKillGame.disabled = false;

    if (forceStoppingGame) {
      // Arret volontaire (bouton "Forcer l'arret") : pas un plantage, on ne
      // veut pas afficher "le jeu a plante" pour quelque chose que le joueur
      // vient de demander lui-meme.
      forceStoppingGame = false;
      lastCrashDiagnosis = null;
      progressPanel.classList.remove('visible');
      progressFill.style.width = '0%';
      clearProgressLog();
    } else if (payload !== 0) {
      // Code de sortie different de 0 (ou absent, ex: tue par un signal) :
      // le jeu a crashe/plante, pas juste quitte normalement : on le signale
      // clairement et on garde les logs ouverts, plutot que de tout effacer en
      // silence comme si de rien n'etait (le joueur n'aurait alors aucune
      // indication que quelque chose s'est mal passe). Quand un diagnostic a
      // pu etre extrait du log (cf. crashDiagnostics.js), on l'affiche
      // directement au lieu du code de sortie brut : bien plus parlant pour
      // un joueur qui ne sait pas ce qu'est un "exit code 1".
      progressLabel.textContent = lastCrashDiagnosis
        ? t('progress.crashedWithReason', lastCrashDiagnosis)
        : t('progress.crashed', payload);
      lastCrashDiagnosis = null;
      // Revelation temporaire (pas un changement de preference deliberee du
      // joueur, cf. setConsoleEnabled) : le panneau s'affiche pour ce crash
      // precis sans activer durablement l'option "Afficher la console".
      progressPanel.classList.add('visible');
    } else {
      // Fermeture normale : le panneau de progression/logs n'a plus de
      // raison de rester affiche, sans quoi il traine indefiniment a
      // l'ecran jusqu'au prochain lancement.
      progressPanel.classList.remove('visible');
      progressFill.style.width = '0%';
      clearProgressLog();
    }
    // Que la fermeture soit normale, un arret force ou un crash, le
    // processus n'est plus en cours : le/les boutons "Jouer" redeviennent
    // disponibles.
    endLaunch();
  }
});

async function launchServer(serverId, button) {
  // Aucun mur de connexion au demarrage, mais on ne lance rien sans compte :
  // on ouvre directement le gestionnaire de comptes pour en choisir/ajouter un.
  if (!currentAccount) {
    await renderAccountsList();
    accountsModal.classList.add('visible');
    return;
  }
  if (launchBusy) return; // securite : les boutons devraient deja etre desactives

  beginLaunch(button, () => window.launcher.checkServerInstalled(serverId));
  if (consoleEnabled) progressPanel.classList.add('visible');
  progressFill.style.width = '0%';
  clearProgressLog();

  try {
    const result = await window.launcher.launchServer(serverId);
    if (result?.cancelled) {
      progressLabel.textContent = t('progress.cancelled');
      appendLog(t('progress.cancelled'));
      await endLaunch();
    }
    // Sinon : le jeu vient de demarrer et tourne encore : endLaunch() sera
    // appele par onGameEvent('close') a sa fermeture, pas ici.
  } catch (err) {
    // Meme si la console est masquee par defaut, un echec doit rester
    // visible : sinon le joueur voit juste le bouton revenir a "Jouer"
    // sans aucune explication.
    progressPanel.classList.add('visible');
    appendLog(t('progress.error', err.message || err));
    progressLabel.textContent = t('progress.launchFailed');
    await endLaunch();
  }
}

boot();
