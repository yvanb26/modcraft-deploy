// Authentification Microsoft complete : code d'autorisation (MSAL, un seul
// bouton : navigateur systeme + petit serveur local qui recupere le retour,
// meme principe que la connexion Ely.by) -> Xbox Live -> XSTS -> Minecraft
// Services -> profil. Necessite un clientId Azure AD (application publique,
// plateforme "Mobile and desktop applications", redirect URI
// "http://localhost/callback") fourni via branding.microsoftAuth.clientId.
//
// Pourquoi pas le "device code" (code a recopier a la main) utilise avant ?
// Fonctionnellement equivalent, mais moins simple pour le joueur : ce flux-ci
// n'affiche jamais de code, le navigateur s'ouvre directement sur la vraie
// page de connexion Microsoft. C'est aussi ce que fait turikhay/Legacy
// Launcher (verifie directement dans son bytecode, cf. conversation).
//
// Reference du flux (stable depuis plusieurs annees, utilise par la plupart des
// launchers tiers open-source) :
// https://minecraft.wiki/w/Microsoft_authentication
//
// Le cache MSAL est persiste sur disque (cachePlugin) pour permettre de
// changer de compte rapidement plus tard (bouton "gestionnaire de comptes")
// via acquireTokenSilent, sans rouvrir le navigateur : tant que le refresh
// token Microsoft sous-jacent (valable plusieurs mois) est toujours valide.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, shell } = require('electron');
const { PublicClientApplication } = require('@azure/msal-node');
const { readSecureText, writeSecureText } = require('../core/secureStore');

const XBOX_AUTH_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTH_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore';

const SCOPES = ['XboxLive.signin', 'offline_access'];

// Port arbitraire, doit correspondre au chemin ("/callback") enregistre dans
// Azure : le port lui-meme est ignore par Microsoft pour les redirect URI
// "localhost" (cf. RFC 8252 / doc Microsoft), donc libre de choix ici.
const REDIRECT_PORT = 43291;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

function cacheFilePath() {
  return path.join(app.getPath('userData'), 'msal-cache.json');
}

const cachePlugin = {
  beforeCacheAccess: async (cacheContext) => {
    try {
      cacheContext.tokenCache.deserialize(readSecureText(cacheFilePath()));
    } catch {
      // pas de cache existant : normal au tout premier lancement
    }
  },
  afterCacheAccess: async (cacheContext) => {
    if (cacheContext.cacheHasChanged) {
      fs.mkdirSync(path.dirname(cacheFilePath()), { recursive: true });
      writeSecureText(cacheFilePath(), cacheContext.tokenCache.serialize());
    }
  }
};

function createPca(clientId) {
  return new PublicClientApplication({
    auth: { clientId, authority: 'https://login.microsoftonline.com/consumers' },
    cache: { cachePlugin }
  });
}

// Serveur HTTP local ephemere qui recupere le "code" du retour de connexion,
// exactement le meme principe que l'ancienne connexion Ely.by OAuth.
function waitForCallback(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        error
          ? '<html><body>Connexion annulee ou refusee. Vous pouvez fermer cette fenetre.</body></html>'
          : '<html><body>Connexion reussie ! Vous pouvez fermer cette fenetre et revenir au launcher.</body></html>'
      );

      server.close();
      if (error) reject(new Error(`Connexion Microsoft refusee (${error}).`));
      else if (!code) reject(new Error('Reponse Microsoft invalide (code manquant).'));
      else resolve(code);
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1');

    // Evite d'attendre indefiniment si l'utilisateur ferme l'onglet sans agir.
    setTimeout(() => {
      server.close();
      reject(new Error('Delai de connexion Microsoft depasse (5 minutes).'));
    }, 5 * 60 * 1000);
  });
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.errorMessage || `Requete echouee vers ${url} (${res.status})`);
  }
  return data;
}

// Chaine Xbox Live -> XSTS -> Minecraft Services, commune a la premiere
// connexion et au changement de compte silencieux : seul le jeton Microsoft
// initial differe, tout le reste doit etre refait a chaque fois (jetons
// Xbox/Minecraft courte duree, non caches).
async function finishMinecraftLogin(msAccessToken) {
  const xbl = await postJson(XBOX_AUTH_URL, {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  });

  const xsts = await postJson(XSTS_AUTH_URL, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  });

  const userHash = xsts.DisplayClaims.xui[0].uhs;

  const mcLogin = await postJson(MC_LOGIN_URL, {
    identityToken: `XBL3.0 x=${userHash};${xsts.Token}`
  });

  const entitlementsRes = await fetch(MC_ENTITLEMENTS_URL, {
    headers: { Authorization: `Bearer ${mcLogin.access_token}` }
  });
  const entitlements = await entitlementsRes.json().catch(() => ({ items: [] }));
  if (!entitlements.items || entitlements.items.length === 0) {
    throw new Error("Ce compte Microsoft ne possede pas de licence Minecraft: Java Edition.");
  }

  const profileRes = await fetch(MC_PROFILE_URL, {
    headers: { Authorization: `Bearer ${mcLogin.access_token}` }
  });
  const profile = await profileRes.json().catch(() => ({}));
  if (!profileRes.ok || !profile.id) {
    throw new Error("Impossible de recuperer le profil Minecraft (compte sans pseudo choisi ?).");
  }

  return {
    access_token: mcLogin.access_token,
    client_token: '',
    uuid: profile.id,
    name: profile.name,
    user_properties: '{}',
    meta: { type: 'msa', demo: false, provider: 'microsoft' }
  };
}

async function authenticateMicrosoft(clientId) {
  if (!clientId) {
    throw new Error(
      "La connexion Microsoft n'est pas configuree sur ce launcher (clientId Azure manquant)."
    );
  }

  const pca = createPca(clientId);
  const authCodeUrl = await pca.getAuthCodeUrl({ scopes: SCOPES, redirectUri: REDIRECT_URI });

  const callbackPromise = waitForCallback(REDIRECT_PORT);
  await shell.openExternal(authCodeUrl);
  const code = await callbackPromise;

  const result = await pca.acquireTokenByCode({ code, scopes: SCOPES, redirectUri: REDIRECT_URI });

  const account = await finishMinecraftLogin(result.accessToken);
  account.homeAccountId = result.account.homeAccountId;
  return account;
}

// Reutilise un compte Microsoft deja connecte precedemment (bouton "changer
// de compte") : recupere un jeton frais via le cache MSAL persiste, sans
// rouvrir le navigateur : tant que le refresh token Microsoft (valable
// plusieurs mois) est toujours valide. Sinon, l'appelant doit retomber sur
// `authenticateMicrosoft` (nouvelle connexion complete).
async function reacquireMicrosoft(clientId, homeAccountId) {
  const pca = createPca(clientId);
  const accounts = await pca.getTokenCache().getAllAccounts();
  const account = accounts.find((a) => a.homeAccountId === homeAccountId);
  if (!account) {
    throw new Error('Session Microsoft introuvable dans le cache local : reconnexion complete necessaire.');
  }

  const result = await pca.acquireTokenSilent({ account, scopes: SCOPES });
  const mcAccount = await finishMinecraftLogin(result.accessToken);
  mcAccount.homeAccountId = homeAccountId;
  return mcAccount;
}

module.exports = { authenticateMicrosoft, reacquireMicrosoft };
