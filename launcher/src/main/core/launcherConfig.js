const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Configuration "d'installation" du launcher (quelle API / quelle communaute
// cette copie sert) : apiBaseUrl + launcherKey. Volontairement lue EN DEHORS
// du code compile (asar) : c'est la seule chose qu'un operateur doit pouvoir
// avoir sans recompiler ni reinstaller le launcher.
//
// Emplacements, dans l'ordre :
//  1. `LAUNCHER_CONFIG_PATH` (variable d'environnement) : chemin arbitraire,
//     pratique pour tester plusieurs configs ou garder la sienne hors du
//     dossier d'installation ;
//  2. build packagé : `<userData>/launcher.config.json` : ecrit par
//     l'installateur NSIS (cf. build/installer.nsh) lors de la PREMIERE
//     installation, jamais touche ensuite. Deliberement PAS dans
//     `resources/` (contrairement a l'ancienne implementation) : ce dossier
//     est regenere a partir du depot a chaque build, donc ecrase a chaque
//     mise a jour automatique : userData, lui, n'est jamais touche par
//     electron-updater, exactement comme preferences.json/settings.json ;
//  3. build de dev (`npm start`) : `launcher/launcher.config.json` a la
//     racine du projet, pour ne pas avoir a passer par l'installateur juste
//     pour tester en local.
const CONFIG_FILENAME = 'launcher.config.json';

function launcherConfigPath() {
  if (process.env.LAUNCHER_CONFIG_PATH) {
    return path.resolve(process.env.LAUNCHER_CONFIG_PATH);
  }
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), CONFIG_FILENAME);
  }
  return path.join(__dirname, '..', '..', '..', CONFIG_FILENAME);
}

// Lu une seule fois par session (le fichier ne change pas pendant que le
// launcher tourne) : `null` tant que la premiere lecture n'a pas eu lieu.
let cached = null;

function readConfigFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Message volontairement explicite (chemin complet + quoi mettre dedans) :
    // pour un build packagé, ce fichier est normalement cree par
    // l'installateur (cf. build/installer.nsh) : ne devrait manquer que si
    // le joueur l'a supprime a la main, ou pour un build de dev sans
    // launcher.config.json copie depuis l'exemple.
    throw new Error(
      `Fichier de configuration introuvable :\n${file}\n\n` +
      `Reinstallez le launcher pour le regenerer, ou creez-le manuellement avec ` +
      `"apiBaseUrl" (adresse de l'API) et "launcherKey" (fournis par l'administrateur ` +
      `de votre communaute : cf. launcher.config.example.json).`
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Fichier de configuration JSON invalide :\n${file}\n\n${err.message}`);
  }
}

function validate(config, file) {
  if (!config.apiBaseUrl) throw new Error(`"apiBaseUrl" manquant dans ${file}.`);
  if (!config.launcherKey) throw new Error(`"launcherKey" manquant dans ${file}.`);
  return {
    ...config,
    // Les URLs sont assemblees par concatenation (`${apiBaseUrl}/api/...`) :
    // un slash final saisi par l'operateur produirait "//api/..." et des 404
    // difficiles a diagnostiquer. On le retire ici, une bonne fois.
    apiBaseUrl: String(config.apiBaseUrl).trim().replace(/\/+$/, '')
  };
}

function getLauncherConfig() {
  if (!cached) {
    const file = launcherConfigPath();
    cached = validate(readConfigFile(file), file);
  }
  return cached;
}

module.exports = { getLauncherConfig, launcherConfigPath, CONFIG_FILENAME };
