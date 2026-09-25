const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  memoryMinGb: 2,
  memoryMaxGb: 4,
  gpu: 'auto', // 'auto' | 'integrated' | 'dedicated'
  javaPath: 'java'
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(all) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(all, null, 2));
}

// Reglages par serveur (memoire allouee, preference GPU, chemin java) :
// permet a chaque communaute/joueur d'ajuster ca par instance plutot que
// d'avoir des valeurs figees dans le code.
function getServerSettings(serverId) {
  const all = readAll();
  return { ...DEFAULTS, ...(all[serverId] || {}) };
}

function setServerSettings(serverId, patch) {
  const all = readAll();
  all[serverId] = { ...DEFAULTS, ...(all[serverId] || {}), ...patch };
  writeAll(all);
  return all[serverId];
}

module.exports = { getServerSettings, setServerSettings, DEFAULTS };
