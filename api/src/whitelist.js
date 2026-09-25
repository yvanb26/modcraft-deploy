const crypto = require('crypto');
const { Rcon } = require('rcon-client');
const { withRemoteFile } = require('./remoteFile');

// Ajoute un joueur a la whitelist du serveur Minecraft via RCON, pour que
// seuls les joueurs passes par ce launcher (donc par l'echange de token)
// puissent rejoindre : fonctionne sur un serveur vanilla, Forge, Fabric ou
// NeoForge, quelle que soit la version, puisque RCON et /whitelist sont des
// fonctionnalites du serveur Minecraft de base, pas d'un plugin.
// `server.rcon` est optionnel : si absent, la whitelist automatique est
// simplement desactivee pour ce serveur (pas d'erreur).
//
// SERVEUR HORS LIGNE (online-mode=false) : `whitelist add <pseudo>` resout le pseudo aupres de Mojang et
// inscrit le VRAI UUID du compte premium s'il existe, alors qu'a la connexion un serveur hors ligne
// calcule l'UUID hors ligne du pseudo (cf. offlineUuid), et le fait pour le pseudo en minuscules quand
// c'est lui qui cree l'entree. Aucune commande RCON ne permet de choisir l'UUID inscrit. Pour ces
// serveurs, si `server.whitelistAccess` (acces SFTP/FTP au serveur Minecraft, recopie par l'outil admin)
// est renseigne, on ecrit donc DIRECTEMENT dans whitelist.json les deux UUID hors ligne du pseudo :
// casse exacte et minuscules : puis on fait `whitelist reload` en RCON. Sans cet acces : RCON seul, qui
// ne marche que pour un pseudo inexistant chez Mojang. Voir le README.
async function authorizeJoin(server, username) {
  if (server.onlineMode === false && server.whitelistAccess) {
    return authorizeOfflineViaFile(server, username);
  }

  if (!server.rcon) {
    return { skipped: true, reason: 'rcon_not_configured' };
  }

  const { host, port, password } = server.rcon;
  let rcon;
  try {
    rcon = await Rcon.connect({ host, port: port || 25575, password });
  } catch (err) {
    if (err.message === 'Authentication failed') {
      throw new Error(
        `Mot de passe RCON incorrect pour "${server.id}" : verifiez que le champ "rcon.password" de servers.json ` +
        `correspond EXACTEMENT a "rcon.password" dans le server.properties de ce serveur (espace/caractere special ` +
        `en trop, ou serveur pas redemarre depuis la modification : RCON ne recharge pas a chaud).`
      );
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      throw new Error(
        `Impossible de joindre RCON pour "${server.id}" (${host}:${port || 25575}) : verifiez que enable-rcon=true, ` +
        `que le port est bien ouvert/expose (pare-feu, allocation de port PufferPanel), et que le serveur est demarre.`
      );
    }
    throw err;
  }

  try {
    // "remove" avant "add" (pas juste "add" seul) : si ce pseudo a deja une
    // entree dans whitelist.json avec un UUID "hors-ligne" (ex: le serveur a
    // deja tourne en online-mode=false a un moment, meme brievement, pour
    // des tests), whitelist.json se retrouve avec un UUID different de celui
    // du VRAI compte Microsoft/Mojang : le serveur refuse alors la
    // connexion en online-mode=true malgre la whitelist "a jour" en
    // apparence. Retirer puis rajouter force le serveur a re-resoudre le
    // profil (et donc le bon UUID) a chaque lancement, quel que soit
    // l'historique online/offline-mode de ce pseudo sur ce serveur.
    await rcon.send(`whitelist remove ${username}`);
    const response = await rcon.send(`whitelist add ${username}`);
    return { skipped: false, response };
  } finally {
    await rcon.end();
  }
}

// Fusionne, dans le contenu de whitelist.json, les deux identites hors ligne d'un pseudo : celle de la casse
// exacte (ce que calcule le serveur pour un client qui se connecte avec ce pseudo : launcher officiel,
// TLauncher, ce launcher) et celle en minuscules (ce que `whitelist add` fabrique lui-meme). Les entrees
// existantes de ce pseudo, quelle que soit leur casse (typiquement le vrai UUID premium, inutile sur un
// serveur hors ligne), sont remplacees ; les autres joueurs ne sont pas touches.
function mergeOfflineEntries(entries, username) {
  const lower = username.toLowerCase();
  const kept = entries.filter((e) => String(e?.name ?? '').toLowerCase() !== lower);
  const added = [{ uuid: offlineUuid(username), name: username }];
  if (lower !== username) added.push({ uuid: offlineUuid(lower), name: lower });
  return { entries: [...kept, ...added], added, replaced: entries.length - kept.length };
}

function parseWhitelist(text) {
  const raw = String(text ?? '').trim();
  const entries = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(entries)) throw new Error("whitelist.json n'est pas une liste JSON");
  return entries;
}

// Lecture-modification-ecriture de whitelist.json : deux joueurs qui cliquent sur Jouer en meme temps liraient
// le meme contenu et le dernier a ecrire effacerait l'ajout de l'autre. Les operations d'un meme serveur
// sont donc executees l'une apres l'autre (file d'attente en memoire, par serveur).
const queues = new Map();
function serialized(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

async function authorizeOfflineViaFile(server, username) {
  const access = server.whitelistAccess;
  let merged;
  try {
    merged = await serialized(server.id, () => withRemoteFile(access, 'whitelist.json', async ({ read, write }) => {
      const result = mergeOfflineEntries(parseWhitelist(await read()), username);
      await write(`${JSON.stringify(result.entries, null, 2)}\n`);
      return result;
    }));
  } catch (err) {
    // Detail complet dans la console de l'API ; le message renvoye au launcher reste court (pas d'hote, jamais de mot de passe).
    console.error(`[whitelist] ${server.id} : acces ${access.protocol}://${access.host} impossible :`, err.message);
    throw new Error(`Impossible de mettre a jour whitelist.json de "${server.id}" par ${String(access.protocol).toUpperCase()} : ${err.message}`);
  }

  const summary = merged.added.map((e) => `${e.name} -> ${e.uuid}`).join(' ; ');
  if (!server.rcon) {
    return { skipped: false, mode: 'offline_file', response: `whitelist.json mis a jour (${summary}) ; sans RCON, le serveur ne le relira qu'a son prochain demarrage.` };
  }
  const { host, port, password } = server.rcon;
  const rcon = await Rcon.connect({ host, port: port || 25575, password }).catch((err) => {
    throw new Error(`whitelist.json mis a jour (${summary}) mais RCON injoignable pour "whitelist reload" : ${err.message}`);
  });
  try {
    const reply = await rcon.send('whitelist reload');
    return { skipped: false, mode: 'offline_file', response: `${summary} inscrit dans whitelist.json (${reply || 'whitelist reload envoye'})` };
  } finally {
    await rcon.end();
  }
}

// UUID "hors ligne" d'un pseudo : celui que CALCULE un serveur en online-mode=false a partir du
// pseudo exact (md5 de "OfflinePlayer:<pseudo>", version 3), pour n'importe quel client, compte
// Microsoft compris. Identique a launcher/src/main/auth/offline.js. Sert a l'affichage en console.
function offlineUuid(username) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// UUID Mojang (compte premium) d'un pseudo, uniquement pour l'AFFICHAGE dans la console : sert a
// comparer avec celui que la whitelist / le serveur utilisent. Best-effort, jamais bloquant.
async function lookupMojangUuid(username) {
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`, {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return null;
    const { id } = await res.json();
    return id ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : null;
  } catch {
    return null;
  }
}

module.exports = { authorizeJoin, offlineUuid, mergeOfflineEntries, lookupMojangUuid };
