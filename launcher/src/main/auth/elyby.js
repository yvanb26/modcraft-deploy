// Authentification via le serveur Yggdrasil compatible expose par Ely.by pour
// les launchers tiers (meme protocole que l'ancien authserver.mojang.com).
// Doc : https://docs.ely.by/en/minecraft-auth.html
//
// Pourquoi pas OAuth2 ? On a d'abord implemente OAuth2+PKCE (bouton unique,
// pas de mot de passe dans le launcher), mais leur page web d'autorisation a
// un bug confirme cote Ely.by : elle ne transmet jamais le parametre
// `code_challenge` a leur propre API de validation, ce qui bloque
// systematiquement le flux pour tout client "public" (comme le notre, sans
// client_secret) : verifie en comparant des appels directs a
// https://account.ely.by/api/oauth2/v1/validate avec et sans ce parametre.
// En attendant qu'ils le corrigent, on repasse sur ce flux historique :
// identifiant+mot de passe transmis directement a Ely.by (jamais a notre
// propre API), avec prise en charge de la double authentification (2FA).
const crypto = require('crypto');

const ELYBY_AUTH_SERVER = 'https://authserver.ely.by';

function toMclcAccount(data) {
  const profile = data.selectedProfile;
  if (!profile) {
    throw new Error('Aucun profil Minecraft associe a ce compte Ely.by.');
  }
  return {
    access_token: data.accessToken,
    client_token: data.clientToken,
    uuid: profile.id,
    name: profile.name,
    user_properties: '{}',
    meta: { type: 'mojang', demo: false, provider: 'elyby' }
  };
}

// clientToken : identifiant stable de CETTE installation du launcher, a
// generer une fois puis reutiliser pour toutes les authentifications et
// rafraichissements suivants (comportement Yggdrasil standard : en changer
// invaliderait inutilement les sessions precedentes).
function generateClientToken() {
  return crypto.randomUUID();
}

async function authenticateElyBy(username, password, totpToken, clientToken = generateClientToken()) {
  if (!username || !password) {
    throw new Error('Identifiant et mot de passe Ely.by requis.');
  }

  // Si la double authentification Ely.by est activee, le token TOTP doit etre
  // concatene au mot de passe avec ":" (comportement Yggdrasil standard).
  const finalPassword = totpToken ? `${password}:${totpToken}` : password;

  const res = await fetch(`${ELYBY_AUTH_SERVER}/auth/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent: { name: 'Minecraft', version: 1 },
      username,
      password: finalPassword,
      clientToken,
      requestUser: false
    })
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (!totpToken && /two ?factor/i.test(data.errorMessage || '')) {
      throw new Error('Ce compte Ely.by a la double authentification activee : entrez aussi le code (champ "Code 2FA").');
    }
    throw new Error(data.errorMessage || data.error || `Echec de l'authentification Ely.by (${res.status}).`);
  }

  return toMclcAccount(data);
}

// Reutilise une session Ely.by deja obtenue (bouton "changer de compte") sans
// redemander le mot de passe : tant que le token n'a pas ete invalide
// (deconnexion explicite, mot de passe change, ou reconnexion ailleurs avec
// le meme clientToken).
async function refreshElyBySession(accessToken, clientToken) {
  const res = await fetch(`${ELYBY_AUTH_SERVER}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, clientToken, requestUser: false })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.errorMessage || data.error || 'Session Ely.by expiree, reconnexion necessaire.');
  }

  return toMclcAccount({ ...data, clientToken: data.clientToken || clientToken });
}

module.exports = { authenticateElyBy, refreshElyBySession, generateClientToken };
