// Installations "libres" : le joueur choisit lui-meme une version Minecraft
// et un loader (comme le TLauncher), independamment des serveurs/modpacks
// configures par l'operateur. Persistees dans un fichier JSON (meme
// principe que preferences.js/settings.js) plutot qu'en base de donnees :
// pas besoin de plus pour une poignee d'installations par joueur.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const { customInstanceDir } = require('./paths');

function storePath() {
  return path.join(app.getPath('userData'), 'custom-instances.json');
}

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return { instances: data.instances || [] };
  } catch {
    return { instances: [] };
  }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2));
}

function listCustomInstances() {
  return readAll().instances;
}

function getCustomInstance(id) {
  const instance = listCustomInstances().find((i) => i.id === id);
  if (!instance) throw new Error(`Installation introuvable: ${id}`);
  return instance;
}

// `loader` : { type: 'vanilla'|'forge'|'fabric'|'quilt'|'neoforge', version?: string }
// (`version` absent/ignore pour vanilla).
function createCustomInstance({ name, mcVersion, mcVersionType, loader }) {
  if (!mcVersion) throw new Error('Version Minecraft manquante.');
  if (!loader?.type) throw new Error('Loader manquant.');
  if (loader.type !== 'vanilla' && !loader.version) {
    throw new Error(`Version de loader manquante pour ${loader.type}.`);
  }

  const data = readAll();
  const instance = {
    id: crypto.randomUUID(),
    name: (name || '').trim() || `${mcVersion} ${loader.type}`,
    mcVersion,
    mcVersionType,
    loader,
    createdAt: Date.now()
  };
  data.instances.push(instance);
  writeAll(data);
  return instance;
}

function removeCustomInstance(id) {
  const data = readAll();
  data.instances = data.instances.filter((i) => i.id !== id);
  writeAll(data);
  fs.rmSync(customInstanceDir(id), { recursive: true, force: true });
}

// Renomme uniquement (le dossier/monde sauvegarde, lui, reste identifie par
// l'id, jamais par le nom : renommer ne touche donc a aucun fichier de jeu).
function renameCustomInstance(id, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Le nom ne peut pas etre vide.');

  const data = readAll();
  const instance = data.instances.find((i) => i.id === id);
  if (!instance) throw new Error(`Installation introuvable: ${id}`);

  instance.name = trimmed;
  writeAll(data);
  return instance;
}

module.exports = {
  listCustomInstances,
  getCustomInstance,
  createCustomInstance,
  removeCustomInstance,
  renameCustomInstance
};
