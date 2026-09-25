const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const env = require('./env');
const { issueToken, requireToken, rateLimit } = require('./auth');
const { authorizeJoin, offlineUuid, lookupMojangUuid } = require('./whitelist');
const { issueChallenge, verifyOwnership } = require('./ownership');

const app = express();
// Derriere un reverse proxy (nginx, HestiaCP...), req.ip serait celui du proxy pour TOUS les joueurs : les limites
// par IP s'appliqueraient alors a tout le monde a la fois. TRUST_PROXY=1 (nombre de proxys) restitue la vraie IP.
if (env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY);
// CORS ferme par defaut : le launcher et l'outil admin appellent l'API depuis leur processus principal (pas depuis
// une page web), donc aucun site n'a besoin d'y acceder depuis un navigateur. Un site tiers ne peut ainsi pas
// faire lire l'API par le navigateur d'un visiteur. CORS_ORIGINS=https://exemple.fr,... autorise des origines precises.
const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => callback(null, allowedOrigins.includes(origin)) }));
app.use(express.json());

const dataDir = path.join(__dirname, '..', 'data');
const modpacksDir = path.join(__dirname, '..', 'modpacks');
const publicDir = path.join(__dirname, '..', 'public');
const updatesDir = path.join(__dirname, '..', 'updates');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// --- Fichiers publics (logo, fond d'ecran, musique...) -------------------
// Pas de token requis : ce sont les memes assets qu'un logoUrl/backgroundUrl
// externe, juste heberges directement ici par commodite.
app.use('/public', express.static(publicDir));

// --- Mises a jour du launcher (electron-updater) --------------------------
// Pas de token requis non plus : electron-updater fait de simples requetes
// HTTP, sans passer par notre echange de token/Bearer : l'URL elle-meme est
// codee en dur cote launcher (cf. core/updateConfig.js), pas configurable
// par un operateur qui deploierait ce launcher pour sa propre communaute.
// Contient l'installeur genere par `electron-builder --publish` (le .exe +
// le fichier de metadonnees latest.yml), a copier ici manuellement ou via un
// script de publication : jamais commit dans le depot (cf. .gitignore).
app.use('/updates', express.static(updatesDir));

// --- Echange de token ---------------------------------------------------
app.post('/api/auth/token', issueToken);

// Tout ce qui suit necessite un token valide obtenu via /api/auth/token
app.use('/api', requireToken);

// --- Configuration (branding + liste des serveurs + annonces) -----------
app.get('/api/config', (req, res) => {
  const branding = readJson(path.join(dataDir, 'branding.json'));
  // "rcon" et "whitelistAccess" (acces SFTP/FTP au serveur Minecraft) contiennent des mots de passe : jamais
  // envoyes au launcher.
  const servers = readJson(path.join(dataDir, 'servers.json')).map(({ rcon, whitelistAccess, ...server }) => server);
  // Optionnel : absent -> pas de panneau d'annonces affiche dans le launcher.
  let news = [];
  try {
    news = readJson(path.join(dataDir, 'news.json'));
  } catch {
    news = [];
  }
  res.json({ branding, servers, news });
});

// --- Whitelist automatique (RCON) ----------------------------------------
// Appelee par le launcher juste avant de lancer le jeu : seul un joueur passe
// par ce launcher (donc possedant un token valide) peut etre ajoute a la
// whitelist du serveur Minecraft cible.
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

// 30 lancements par minute et par IP : largement assez pour un joueur, mais empeche de saturer RCON / le SFTP
// ou de remplir la whitelist en boucle avec un jeton vole.
// Defi a usage unique pour prouver la possession d'un compte Microsoft (cf. ownership.js) : le launcher le
// declare a Mojang, puis le presente a authorize-join.
app.post('/api/servers/:id/join-challenge', rateLimit(30, 60_000), (req, res) => res.json(issueChallenge()));

app.post('/api/servers/:id/authorize-join', rateLimit(30, 60_000), async (req, res) => {
  const { username, challenge } = req.body || {};
  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'invalid_username' });
  }

  const servers = readJson(path.join(dataDir, 'servers.json'));
  const server = servers.find((s) => s.id === req.params.id);
  if (!server) {
    return res.status(404).json({ error: 'server_not_found' });
  }

  // Serveur en ligne : seul le vrai proprietaire du compte Microsoft peut faire inscrire son pseudo. Sans cela, quiconque
  // connait la cle du launcher pourrait whitelister n'importe quel pseudo. (Serveur hors ligne : aucune verification possible,
  // un pseudo hors ligne n'appartient a personne.)
  if (server.onlineMode === true && env.OWNERSHIP_CHECK) {
    const proof = await verifyOwnership(username, challenge);
    if (!proof.ok) {
      console.warn(`[whitelist] ${server.id} / ${username} : possession du compte non prouvee (${proof.reason}) -> refuse.`);
      return res.status(403).json({ error: 'ownership_failed', reason: proof.reason });
    }
  }

  try {
    const result = await authorizeJoin(server, username);
    res.json({ ok: true, ...result });
    // Console de l'API : les deux UUID en jeu. Un serveur online-mode=false utilise l'UUID HORS LIGNE a la
    // connexion ; `whitelist add` (RCON) inscrit, lui, l'UUID MOJANG s'il existe. S'ils different, le joueur
    // est refuse ("not white-listed") : limite connue de la whitelist par RCON sur un serveur hors ligne.
    lookupMojangUuid(username).then((mojang) => {
      console.log(
        `[whitelist] ${server.id} / ${username} | onlineMode=${server.onlineMode !== false} | UUID Mojang : ${mojang || 'aucun compte trouve'}` +
        ` | UUID hors ligne (calcule par un serveur online-mode=false) : ${offlineUuid(username)} | ${result.response ?? result.reason ?? ''}`
      );
      if (server.onlineMode === false && !server.whitelistAccess && mojang && mojang !== offlineUuid(username)) {
        console.warn(
          `[whitelist] ATTENTION ${server.id} / ${username} : serveur hors ligne, le pseudo existe chez Mojang. \`whitelist add\` ` +
          `inscrit l'UUID Mojang (${mojang}) mais le serveur attendra ${offlineUuid(username)} a la connexion : refus "not white-listed" ` +
          'probable. Sur un serveur hors ligne, la whitelist par RCON ne fonctionne pas pour un pseudo qui existe chez Mojang : ' +
          'renseignez l\'acces SFTP/FTP du serveur dans l\'onglet "Serveur Minecraft" de l\'admin (l\'API ecrira alors whitelist.json ' +
          'elle-meme), ou desactivez la whitelist (white-list=false), ou passez le serveur en online-mode=true (cf. README).'
        );
      }
    });
  } catch (err) {
    console.error(`Echec whitelist RCON pour ${req.params.id}:`, err.message);
    res.status(502).json({ error: 'rcon_failed', message: err.message });
  }
});

// --- Manifest d'integrite d'un modpack -----------------------------------
// req.params.id part directement dans un path.join() plus bas : sans ce
// filtre, un id du style "../../../../etc" permettrait de lire un
// manifest.json n'importe ou sur le disque (traversee de repertoire).
const MODPACK_ID_RE = /^[A-Za-z0-9_-]+$/;

app.get('/api/modpacks/:id/manifest', (req, res) => {
  if (!MODPACK_ID_RE.test(req.params.id)) {
    return res.status(400).json({ error: 'invalid_modpack_id' });
  }
  const manifestPath = path.join(modpacksDir, req.params.id, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return res.status(404).json({ error: 'modpack_not_found' });
  }
  const manifest = readJson(manifestPath);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const encodedPath = (p) => p.split('/').map(encodeURIComponent).join('/');
  manifest.files = manifest.files.map((f) => ({
    ...f,
    url: `${baseUrl}/files/${encodeURIComponent(req.params.id)}/${encodedPath(f.path)}`
  }));
  res.json(manifest);
});

// --- Fichiers statiques des modpacks (proteges par le meme token) -------
app.use('/files', requireToken, express.static(modpacksDir, { fallthrough: true }));

app.listen(env.PORT, () => {
  console.log(`ModCraft Deploy API en ecoute sur http://localhost:${env.PORT}`);
});
