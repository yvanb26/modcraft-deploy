const { getLauncherConfig } = require('./core/launcherConfig');
const log = require('./core/logger');
const { offlineUuid } = require('./auth/offline');
const { proveOwnership } = require('./auth/mojangSession');

let cachedToken = null;

async function fetchToken() {
  // Lecture paresseuse (et non au chargement du module) : un fichier de
  // configuration absent/corrompu doit remonter comme une erreur de
  // connexion affichable dans l'UI, pas comme un crash du process principal
  // au demarrage : cf. core/launcherConfig.js.
  const { apiBaseUrl, launcherKey } = getLauncherConfig();
  const res = await fetch(`${apiBaseUrl}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ launcherKey })
  });

  if (!res.ok) {
    throw new Error(`Authentification aupres du serveur refusee (${res.status}). Le launcher est peut-etre desactive ou obsolete.`);
  }

  const data = await res.json();
  cachedToken = data.token;
  return cachedToken;
}

async function authorizedFetch(pathname, options = {}) {
  const { apiBaseUrl } = getLauncherConfig();

  if (!cachedToken) {
    await fetchToken();
  }

  const doFetch = () =>
    fetch(`${apiBaseUrl}${pathname}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${cachedToken}`
      }
    });

  let res = await doFetch();
  if (res.status === 401) {
    // token expire ou invalide : on en redemande un et on retente une fois
    await fetchToken();
    res = await doFetch();
  }
  return res;
}

// ETag de la derniere configuration recue : permet de demander "seulement si elle a change" (fetchConfigIfChanged).
let configEtag = null;

async function fetchConfig() {
  const res = await authorizedFetch('/api/config');
  if (!res.ok) {
    throw new Error(`Impossible de recuperer la configuration (${res.status}).`);
  }
  configEtag = res.headers.get('etag');
  return res.json();
}

// Requete conditionnelle : retourne null (rien n'est telecharge) si la configuration n'a pas change depuis la derniere.
async function fetchConfigIfChanged() {
  // cache: 'no-cache' : sans cela, fetch ajoute "Cache-Control: no-cache" des qu'on envoie If-None-Match, et le serveur
  // (Express) ne repond alors jamais 304. Avec ce mode il envoie "max-age=0", ce que le serveur accepte.
  const res = await authorizedFetch('/api/config', { cache: 'no-cache', headers: configEtag ? { 'If-None-Match': configEtag } : {} });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`Impossible de recuperer la configuration (${res.status}).`);
  configEtag = res.headers.get('etag');
  return res.json();
}

async function fetchManifest(modpackId) {
  const res = await authorizedFetch(`/api/modpacks/${encodeURIComponent(modpackId)}/manifest`);
  if (!res.ok) {
    throw new Error(`Manifest introuvable pour le modpack "${modpackId}" (${res.status}).`);
  }
  return res.json();
}

// Demande au serveur d'ajouter ce joueur a la whitelist Minecraft (via RCON,
// cote API) avant de lancer le jeu. Best-effort : si l'API ne repond pas ou
// si le serveur cible n'a pas de RCON configure, on n'empeche pas le
// lancement : le serveur Minecraft refusera lui-meme la connexion si le
// joueur n'est finalement pas autorise.
// Le profil Microsoft renvoie l'UUID sans tirets : on le remet au format habituel pour pouvoir le comparer.
function dashed(uuid) {
  const hex = String(uuid || '').replace(/-/g, '');
  return hex.length === 32 ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : (uuid || 'inconnu');
}

async function authorizeJoin(serverId, username, accountUuid, onlineMode, account) {
  // Les deux UUID en jeu, pour comprendre un refus "not white-listed" : celui du compte (Mojang, ou fictif
  // pour un compte gratuit) et celui qu'un serveur online-mode=false calcule a partir du pseudo exact.
  log.info(
    `[whitelist] ${serverId} / ${username} | serveur ${onlineMode === false ? 'HORS LIGNE (online-mode=false)' : 'EN LIGNE (online-mode=true)'}` +
    ` | UUID du compte : ${dashed(accountUuid)} | UUID hors ligne du pseudo : ${offlineUuid(username)}` +
    ` -> le serveur utilisera ${onlineMode === false ? 'l\'UUID hors ligne' : 'l\'UUID du compte'} a la connexion`
  );
  // Tout est ecrit dans main.log (et pas seulement dans la console) : c'est la premiere chose a lire
  // quand un joueur est refuse par la whitelist. `response` est la reponse brute du serveur
  // Minecraft a `whitelist add` (ex: "Added VicTeams to the whitelist").
  try {
    // Serveur en ligne : l'API exige la preuve que ce compte Microsoft nous appartient (defi a usage unique declare a
    // Mojang). Le jeton d'acces ne quitte pas le launcher. Un echec ici n'empeche pas le lancement : le serveur
    // Minecraft refusera simplement le joueur non whiteliste.
    let challenge;
    if (onlineMode === true && account?.meta?.provider === 'microsoft') {
      try {
        const cres = await authorizedFetch(`/api/servers/${encodeURIComponent(serverId)}/join-challenge`, { method: 'POST' });
        if (cres.ok) {
          challenge = (await cres.json()).challenge;
          await proveOwnership(account, challenge);
        } else {
          log.warn(`[whitelist] ${serverId} / ${username} : defi de possession refuse par l'API (HTTP ${cres.status}).`);
        }
      } catch (err) {
        challenge = undefined;
        log.warn(`[whitelist] ${serverId} / ${username} : preuve de possession du compte impossible (${err.message}).`);
      }
    }
    const res = await authorizedFetch(`/api/servers/${encodeURIComponent(serverId)}/authorize-join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, challenge })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.warn(`[whitelist] ${serverId} / ${username} : echec (HTTP ${res.status}) ${body.message || body.error || ''}`.trim());
    } else if (body.skipped) {
      log.info(`[whitelist] ${serverId} / ${username} : ignoree (${body.reason}).`);
    } else {
      log.info(`[whitelist] ${serverId} / ${username} : reponse du serveur Minecraft : ${JSON.stringify(body.response)}`);
    }
  } catch (err) {
    log.warn(`[whitelist] ${serverId} / ${username} : API injoignable (${err.message}).`);
  }
}

async function downloadProtectedFile(url) {
  return authorizedFetch(url.replace(getLauncherConfig().apiBaseUrl, ''));
}

module.exports = {
  fetchToken,
  fetchConfig,
  fetchConfigIfChanged,
  fetchManifest,
  downloadProtectedFile,
  authorizeJoin
};
