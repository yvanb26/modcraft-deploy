const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('./env');

const JWT_ALGORITHM = 'HS256';

// Comparaison en temps constant : une comparaison "!==" classique sur des
// chaines revele (en theorie, via des mesures de latence tres precises)
// combien de caracteres de prefixe correspondent deja, ce qui facilite une
// recherche incrementale de la cle. timingSafeEqual l'evite : necessite des
// buffers de meme longueur, d'ou le check de longueur avant (une longueur
// differente suffit deja a rejeter, pas besoin de la comparaison constante
// dans ce cas).
function safeEquals(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Limite basique de tentatives par IP sur /api/auth/token : le launcherKey
// est un secret unique partage (pas un mot de passe par utilisateur avec
// verrouillage de compte possible), donc sans ca rien n'empeche de le
// bruteforcer en boucle. En memoire (pas de dependance ajoutee) : suffisant
// pour une API auto-hebergee mono-process, se reinitialise a un redemarrage.
// Fabrique un limiteur : `max` requetes par fenetre de `windowMs` et par IP. Les entrees expirees sont purgees
// pour que la table ne grossisse pas indefiniment (une IP = une entree).
function createRateLimiter(max, windowMs) {
  const byIp = new Map();
  return function isRateLimited(ip) {
    const now = Date.now();
    if (byIp.size > 5000) {
      for (const [key, entry] of byIp) if (now - entry.windowStart > windowMs) byIp.delete(key);
    }
    const entry = byIp.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      byIp.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  };
}

const isTokenRateLimited = createRateLimiter(10, 60_000);

// Middleware : meme limite, pour les routes qui declenchent un travail cote serveur (RCON, SFTP/FTP...).
function rateLimit(max, windowMs) {
  const isLimited = createRateLimiter(max, windowMs);
  return (req, res, next) => (isLimited(req.ip) ? res.status(429).json({ error: 'too_many_requests' }) : next());
}

// Le "launcherKey" est une cle partagee compilee dans le build du launcher.
// Elle ne protege pas contre un attaquant qui decompile l'app Electron (aucun secret
// cote client n'est jamais totalement inviolable), mais elle bloque l'usage
// occasionnel/non autorise de l'API et permet de revoquer/roter facilement une cle
// si un build fuite, sans devoir changer le JWT_SECRET serveur.
function issueToken(req, res) {
  if (isTokenRateLimited(req.ip)) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  const { launcherKey } = req.body || {};

  if (!launcherKey || !safeEquals(String(launcherKey), env.LAUNCHER_KEY)) {
    return res.status(401).json({ error: 'invalid_launcher_key' });
  }

  const token = jwt.sign({ scope: 'launcher' }, env.JWT_SECRET, {
    expiresIn: env.TOKEN_TTL,
    algorithm: JWT_ALGORITHM
  });

  res.json({ token, expiresIn: env.TOKEN_TTL });
}

function requireToken(req, res, next) {
  const header = req.headers.authorization || '';
  const [, token] = header.split(' ');

  if (!token) {
    return res.status(401).json({ error: 'missing_token' });
  }

  try {
    // `algorithms` restreint explicitement l'algorithme accepte (defense en
    // profondeur contre une confusion d'algorithme), plutot que de se fier
    // uniquement au comportement par defaut de la librairie.
    req.tokenPayload = jwt.verify(token, env.JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
    next();
  } catch (err) {
    res.status(401).json({ error: 'invalid_or_expired_token' });
  }
}

module.exports = { issueToken, requireToken, rateLimit };
