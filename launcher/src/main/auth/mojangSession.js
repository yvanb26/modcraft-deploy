// Preuve de possession d'un compte Microsoft aupres de Mojang, pour l'API du serveur (cf. api/src/ownership.js).
// Le launcher declare a Mojang que ce compte « rejoint » le serveur <defi> : exactement l'appel que fait le jeu quand on
// se connecte a un serveur en ligne. Le jeton d'acces reste dans le launcher ; l'API ne recoit que le defi.
const SESSION_URL = (process.env.MODCRAFT_MOJANG_SESSION_URL || 'https://sessionserver.mojang.com').replace(/\/+$/, '');

async function proveOwnership(account, challenge) {
  const res = await fetch(`${SESSION_URL}/session/minecraft/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accessToken: account.access_token,
      // Mojang attend l'identifiant du profil sans tirets (celui que renvoie deja l'authentification Microsoft).
      selectedProfile: String(account.uuid).replace(/-/g, ''),
      serverId: challenge
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (res.status !== 204 && !res.ok) throw new Error(`Mojang a refuse la preuve de possession du compte (HTTP ${res.status}).`);
}

module.exports = { proveOwnership };
