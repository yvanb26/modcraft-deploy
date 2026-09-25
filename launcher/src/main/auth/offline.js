const crypto = require('crypto');

// Genere un UUID "offline" identique a celui du launcher officiel Mojang en mode
// hors-ligne : UUID v3 (namespace vide) sur la chaine "OfflinePlayer:<pseudo>".
function offlineUuid(username) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Note connue (pas bloquante) : la commande vanilla "whitelist add <pseudo>"
// (utilisee par la whitelist automatique, voir api/src/whitelist.js)
// interroge Mojang pour resoudre le pseudo en UUID, meme sur un serveur
// online-mode=false : si ce pseudo est un vrai compte Mojang existant, la
// whitelist automatique echouera pour ce joueur (RCON, pas un probleme de ce
// module). On ne bloque volontairement pas la connexion hors-ligne pour
// autant : la simplicite et la rapidite priment ici (meme logique que
// l'ancien systeme SKCraft du studio, qui n'a jamais fait cette verification
// et fonctionnait tres bien pour la communaute).
async function createOfflineProfile(username) {
  if (!username || !/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    throw new Error('Pseudo invalide (3 a 16 caracteres, lettres/chiffres/underscore).');
  }

  // La casse est CONSERVEE telle que tapee : pour Minecraft, "VicTeams" et "victeams" sont deux
  // joueurs differents. Un serveur en online-mode=false calcule l'UUID a partir du pseudo exact
  // (md5 de "OfflinePlayer:<pseudo>", cf. offlineUuid), et la whitelist (`whitelist add <pseudo>`
  // via RCON) fait pareil. Mettre le pseudo en minuscules donnait un UUID different de celui du
  // meme pseudo joue depuis le launcher officiel (ou un compte Microsoft) : le serveur repondait
  // "vous n'etes pas sur la whitelist" alors que le pseudo semblait identique.
  const uuid = offlineUuid(username);
  return {
    access_token: uuid,
    client_token: uuid,
    uuid,
    name: username,
    user_properties: '{}',
    meta: { type: 'mojang', demo: false, offline: true }
  };
}

module.exports = { createOfflineProfile, offlineUuid };
