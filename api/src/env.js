require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Variable d'environnement manquante: ${name}`);
  }
  return value;
}

const DEFAULT_LAUNCHER_KEY = 'change-moi-en-production';
const DEFAULT_JWT_SECRET = 'change-moi-aussi';

const config = {
  PORT: Number(process.env.PORT || 8787),
  LAUNCHER_KEY: required('LAUNCHER_KEY', DEFAULT_LAUNCHER_KEY),
  JWT_SECRET: required('JWT_SECRET', DEFAULT_JWT_SECRET),
  TOKEN_TTL: process.env.TOKEN_TTL || '1h',
  // Nombre de reverse proxys devant l'API (ex. 1). Vide = pas de proxy (connexion directe).
  TRUST_PROXY: process.env.TRUST_PROXY || '',
  // Origines web autorisees par CORS, separees par des virgules. Vide (recommande) = aucune.
  CORS_ORIGINS: process.env.CORS_ORIGINS || '',
  // Serveur de sessions Mojang (verification de possession du compte Microsoft, cf. ownership.js). Ne changez pas.
  MOJANG_SESSION_URL: process.env.MOJANG_SESSION_URL || 'https://sessionserver.mojang.com',
  // Verification de possession du compte Microsoft sur les serveurs en ligne. Mettre OWNERSHIP_CHECK=off pour la
  // couper (interrupteur de secours si Mojang se comportait autrement que prevu).
  OWNERSHIP_CHECK: (process.env.OWNERSHIP_CHECK || 'on').toLowerCase() !== 'off',

  // Formulaire de contact du site (POST /contact) : SMTP de la boite mail qui envoie les messages recus.
  // Facultatif : sans SMTP_HOST/SMTP_USER/SMTP_PASS, la route repond juste "formulaire indisponible" (le
  // reste de l'API fonctionne normalement).
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: Number(process.env.SMTP_PORT || 587),
  SMTP_SECURE: (process.env.SMTP_SECURE || '').toLowerCase() === 'true',
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  // Adresse qui recoit les messages du formulaire (vous). Par defaut, la meme que SMTP_USER.
  CONTACT_TO: process.env.CONTACT_TO || process.env.SMTP_USER || ''
};

// Avertissement impossible a manquer dans les logs si .env n'a jamais ete
// personnalise : ces valeurs par defaut sont publiques (documentees dans ce
// depot), donc un serveur qui tourne encore avec est accessible a n'importe
// qui connaissant juste l'URL.
if (config.LAUNCHER_KEY === DEFAULT_LAUNCHER_KEY || config.JWT_SECRET === DEFAULT_JWT_SECRET) {
  console.warn(
    '\n!!! ATTENTION : LAUNCHER_KEY et/ou JWT_SECRET sont encore les valeurs par defaut de .env.example. !!!\n' +
    '!!! N\'importe qui connaissant ces valeurs (publiques, documentees) peut utiliser cette API.       !!!\n' +
    '!!! Definissez de vraies valeurs dans api/.env avant toute mise en production.                     !!!\n'
  );
}

module.exports = config;
