// Preuve qu'un joueur POSSEDE le compte Microsoft dont il donne le pseudo, sans jamais recevoir son jeton.
//
// Meme mecanisme que celui d'un serveur Minecraft en online-mode=true :
//   1. l'API donne au launcher un "defi" aleatoire a usage unique (issueChallenge) ;
//   2. le launcher declare a Mojang « ce compte rejoint le serveur <defi> » (session/minecraft/join), avec son jeton ;
//   3. l'API demande a Mojang « le pseudo X a-t-il rejoint <defi> ? » (session/minecraft/hasJoined) : Mojang ne repond
//      oui que pour le vrai proprietaire du pseudo.
// Une personne qui connait seulement la cle du launcher ne peut donc plus faire whitelister le pseudo d'un autre. Aucune
// inscription d'application Azure n'est necessaire : ce sont les memes appels que ceux du client Minecraft.
const crypto = require('crypto');
const env = require('./env');

const CHALLENGE_TTL_MS = 60_000;
const challenges = new Map(); // defi -> date d'expiration

function purge(now) {
  for (const [challenge, expiresAt] of challenges) if (expiresAt <= now) challenges.delete(challenge);
}

function issueChallenge() {
  const now = Date.now();
  if (challenges.size > 5000) purge(now);
  const challenge = crypto.randomBytes(20).toString('hex');
  challenges.set(challenge, now + CHALLENGE_TTL_MS);
  return { challenge, expiresInSeconds: CHALLENGE_TTL_MS / 1000 };
}

// Le defi n'est valable qu'une fois : il est consomme avant meme d'interroger Mojang (pas de rejeu).
async function verifyOwnership(username, challenge) {
  const now = Date.now();
  const expiresAt = typeof challenge === 'string' ? challenges.get(challenge) : undefined;
  if (typeof challenge === 'string') challenges.delete(challenge);
  if (!expiresAt || expiresAt <= now) return { ok: false, reason: 'challenge_invalid_or_expired' };

  let res;
  try {
    const url = `${env.MOJANG_SESSION_URL.replace(/\/+$/, '')}/session/minecraft/hasJoined?username=${encodeURIComponent(username)}&serverId=${encodeURIComponent(challenge)}`;
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    return { ok: false, reason: 'mojang_unreachable' };
  }
  if (res.status === 204) return { ok: false, reason: 'not_owner' };
  if (!res.ok) return { ok: false, reason: `mojang_http_${res.status}` };
  const profile = await res.json().catch(() => null);
  // Mojang retrouve le profil sans tenir compte de la casse : on exige le pseudo EXACT, celui qui sera whitelist.
  if (!profile || profile.name !== username) return { ok: false, reason: 'not_owner' };
  return { ok: true, uuid: profile.id };
}

module.exports = { issueChallenge, verifyOwnership };
