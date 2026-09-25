// Formulaire de contact du site : POST /contact envoie un e-mail via le SMTP de votre boite mail (SMTP_* dans
// .env). Route publique (pas de token launcher), donc deux protections simples contre le spam automatise :
//   - un captcha mathematique tres basique (GET /contact/captcha), sur le meme principe que le defi de
//     possession de compte (cf. ownership.js) : la reponse attendue reste cote serveur, jamais dans le HTML ;
//   - un champ "piege" (honeypot) : invisible pour un humain, souvent rempli automatiquement par un bot qui
//     remplit tous les champs d'un formulaire.
const crypto = require('crypto');
const env = require('./env');

const CAPTCHA_TTL_MS = 5 * 60_000;
const captchas = new Map(); // token -> { answer, expiresAt }

function purge(now) {
  for (const [token, entry] of captchas) if (entry.expiresAt <= now) captchas.delete(token);
}

function issueCaptcha(req, res) {
  const now = Date.now();
  if (captchas.size > 5000) purge(now);

  const a = 1 + Math.floor(Math.random() * 9);
  const b = 1 + Math.floor(Math.random() * 9);
  const token = crypto.randomBytes(16).toString('hex');
  captchas.set(token, { answer: a + b, expiresAt: now + CAPTCHA_TTL_MS });

  res.json({ token, question: `${a} + ${b}` });
}

function checkCaptcha(token, answer) {
  const now = Date.now();
  const entry = typeof token === 'string' ? captchas.get(token) : undefined;
  if (typeof token === 'string') captchas.delete(token); // usage unique, valide ou pas
  if (!entry || entry.expiresAt <= now) return false;
  return Number(answer) === entry.answer;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LEN = { name: 100, email: 200, message: 4000 };

let transporter = null;
function getTransporter() {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
    });
  }
  return transporter;
}

async function sendContact(req, res) {
  const mailer = getTransporter();
  if (!mailer || !env.CONTACT_TO) {
    return res.status(503).json({ error: 'contact_form_unavailable' });
  }

  const { name, email, message, website, token, answer } = req.body || {};

  // Piege a bot : un champ normalement vide/masque en CSS cote site. Reponse "ok" quand meme, pour ne pas
  // indiquer au bot que son message a ete detecte (il arreterait juste d'utiliser ce champ).
  if (website) return res.json({ ok: true });

  if (!checkCaptcha(token, answer)) {
    return res.status(400).json({ error: 'captcha_invalid' });
  }
  if (!name || !email || !message || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid_fields' });
  }
  if (name.length > MAX_LEN.name || email.length > MAX_LEN.email || message.length > MAX_LEN.message) {
    return res.status(400).json({ error: 'fields_too_long' });
  }

  try {
    await mailer.sendMail({
      from: `"Formulaire ModCraft Deploy" <${env.SMTP_USER}>`,
      to: env.CONTACT_TO,
      replyTo: email,
      subject: `[Contact ModCraft Deploy] ${name}`,
      // text uniquement (pas de HTML) : un message envoye via ce formulaire n'a aucune raison de contenir
      // du HTML a interpreter, et evite tout risque d'injection dans le corps du mail.
      text: `De : ${name} <${email}>\n\n${message}`
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[contact] Envoi echoue :', err.message);
    res.status(502).json({ error: 'send_failed' });
  }
}

module.exports = { issueCaptcha, sendContact };
