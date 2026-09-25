// URL de mise a jour de l'APPLICATION elle-meme (le code/l'UI du launcher),
// volontairement codee en dur ici plutot que lue depuis launcher.config.json
// (qui, lui, reste une simple donnee de configuration : apiBaseUrl/
// launcherKey : remplacable par n'importe quel operateur qui deploie ce
// launcher pour sa propre communaute).
//
// Distinction importante : launcher.config.json determine QUEL serveur/
// QUELLE communaute cette installation affiche (branding, liste de
// serveurs...). UPDATE_FEED_URL determine QUI peut publier une mise a jour
// du LOGICIEL lui-meme : puisque c'est en dur dans le code source compile,
// seule la personne qui compile l'app (VicTeams) peut la changer. Une autre
// communaute qui deploie ce launcher pour son propre serveur (son propre
// api/, son propre branding, via l'outil admin) recoit donc toujours ses
// mises a jour applicatives depuis CE domaine : exactement comme n'importe
// quelle appli desktop tierce (Discord, VLC...) que tout le monde installe
// pareil mais que chacun configure ensuite a sa facon.
const UPDATE_FEED_URL = 'https://modcraft-deploy.com/updates/launcher';

// Cle PUBLIQUE qui verifie la signature des mises a jour (Ed25519). La cle privee correspondante reste sur le PC de
// l'editeur (scripts/generate-update-key.js, scripts/sign-update.js) : quiconque prend le controle du serveur des mises a jour
// ne peut donc pas publier de mise a jour acceptee par l'application.
const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAsc4PfjtLNLWDroO+nr1GoXD2TnMwgPTtL/nMWuVgDp0=
-----END PUBLIC KEY-----
`;

module.exports = { UPDATE_FEED_URL, UPDATE_PUBLIC_KEY };
