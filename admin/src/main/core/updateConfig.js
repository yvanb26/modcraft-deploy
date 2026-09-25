// Adresse du dossier web qui publie les mises a jour de l'OUTIL ADMIN lui-meme
// (latest.yml + installateur + .blockmap, generes par `npm run dist`). Volontairement en dur :
// seule la personne qui compile l'application decide de qui peut lui envoyer une mise a jour.
const UPDATE_FEED_URL = 'https://modcraft-deploy.com/updates/admin';

// Cle PUBLIQUE qui verifie la signature des mises a jour (Ed25519). La cle privee correspondante reste sur le PC de
// l'editeur (scripts/generate-update-key.js, scripts/sign-update.js) : quiconque prend le controle du serveur des mises a jour
// ne peut donc pas publier de mise a jour acceptee par l'application.
const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAsc4PfjtLNLWDroO+nr1GoXD2TnMwgPTtL/nMWuVgDp0=
-----END PUBLIC KEY-----
`;

module.exports = { UPDATE_FEED_URL, UPDATE_PUBLIC_KEY };
