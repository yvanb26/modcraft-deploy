// Lance les scripts Node de l'API (serveur local, generation du manifest) SANS exiger
// que Node.js / npm soient installes sur la machine de l'utilisateur : on reutilise le
// Node deja embarque dans Electron (ELECTRON_RUN_AS_NODE=1 fait se comporter l'executable
// comme un simple `node`).
//
// Les modules de l'API (express, adm-zip...) sont livres dans l'appli (cf.
// "extraResources" dans package.json, dossier api-modules) et exposes via NODE_PATH : un dossier api/ deja
// cree par une version precedente (donc sans node_modules/) fonctionne tel quel, et un
// node_modules/ local, s'il existe (dev, ou `npm install` manuel), reste prioritaire.
const path = require('path');
const { app } = require('electron');

function bundledModulesDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'api-modules') : null;
}

function nodeRuntime() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const modules = bundledModulesDir();
  if (modules) env.NODE_PATH = process.env.NODE_PATH ? `${modules}${path.delimiter}${process.env.NODE_PATH}` : modules;
  return { command: process.execPath, env };
}

module.exports = { nodeRuntime };
