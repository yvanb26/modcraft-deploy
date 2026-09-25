// Lecture/ecriture des fichiers de configuration de l'API (servers.json,
// branding.json, news.json) + gestion des dossiers de modpacks : reutilise
// directement generate-manifest.js existant (aucune logique dupliquee) via
// un simple appel du script tel quel.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { isAllowedModpackFile } = require('./fileAllowlist');
const { nodeRuntime } = require('./nodeRuntime');

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --- servers.json ----------------------------------------------------------
function listServers(apiDir) {
  return readJsonSafe(path.join(apiDir, 'data', 'servers.json'), []);
}

function saveServer(apiDir, server) {
  const servers = listServers(apiDir);
  const idx = servers.findIndex((s) => s.id === server.id);
  if (idx >= 0) servers[idx] = server;
  else servers.push(server);
  writeJson(path.join(apiDir, 'data', 'servers.json'), servers);
  return servers;
}

function removeServer(apiDir, id) {
  const servers = listServers(apiDir).filter((s) => s.id !== id);
  writeJson(path.join(apiDir, 'data', 'servers.json'), servers);
  return servers;
}

// --- branding.json -----------------------------------------------------
function getBranding(apiDir) {
  return readJsonSafe(path.join(apiDir, 'data', 'branding.json'), {});
}

function saveBranding(apiDir, branding) {
  writeJson(path.join(apiDir, 'data', 'branding.json'), branding);
  return branding;
}

// --- news.json -----------------------------------------------------------
function listNews(apiDir) {
  return readJsonSafe(path.join(apiDir, 'data', 'news.json'), []);
}

function saveNews(apiDir, news) {
  writeJson(path.join(apiDir, 'data', 'news.json'), news);
  return news;
}

// --- Modpacks ----------------------------------------------------------
function modpackDir(apiDir, modpackId) {
  return path.join(apiDir, 'modpacks', modpackId);
}

function listModpacks(apiDir) {
  const dir = path.join(apiDir, 'modpacks');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// Copie recursivement, en ne retenant que les fichiers dont l'extension est
// dans la liste blanche (cf. fileAllowlist.js) : tout le reste (executables
// notamment) est ignore et remonte dans `rejected` plutot que copie, meme si
// rien ne l'empechait techniquement d'etre dans le dossier source.
function copyAllowedFiles(sourceDir, targetDir, baseSourceDir, rejected) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const srcPath = path.join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      copyAllowedFiles(srcPath, path.join(targetDir, entry.name), baseSourceDir, rejected);
      continue;
    }
    if (!entry.isFile()) continue;
    if (sourceDir === baseSourceDir && entry.name === 'manifest.json') continue;

    const relPath = path.relative(baseSourceDir, srcPath).split(path.sep).join('/');
    if (!isAllowedModpackFile(relPath)) {
      rejected.push(relPath);
      continue;
    }
    fs.copyFileSync(srcPath, path.join(targetDir, entry.name));
  }
}

// Copie le CONTENU du dossier source directement dans modpacks/<id>/ (pas de
// sous-dossier "files/", cf. la structure simplifiee du reste du projet).
// N'ecrase jamais manifest.json au passage si le dossier source en contenait
// un par erreur : on genere toujours le notre nous-memes juste apres.
function importModpackFolder(apiDir, modpackId, sourceDir) {
  const target = modpackDir(apiDir, modpackId);
  const rejected = [];
  copyAllowedFiles(sourceDir, target, sourceDir, rejected);
  return { target, rejected };
}

// Reutilise le script existant tel quel (source unique de verite, pas de
// logique de hachage dupliquee ici).
function generateManifest(apiDir, modpackId) {
  const runtime = nodeRuntime();
  const output = execFileSync(runtime.command, ['scripts/generate-manifest.js', modpackId], { cwd: apiDir, env: runtime.env, encoding: 'utf8', windowsHide: true });
  return output;
}

// Lit LAUNCHER_KEY/PORT dans api/.env (parsing minimal, pas besoin de
// `dotenv` juste pour ca) pour generer directement le launcher.config.json
// pret a coller, sans avoir a croiser les deux fichiers a la main.
function parseEnvValue(envContent, key) {
  const match = envContent.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

function getLocalLauncherConfig(apiDir) {
  let envContent = '';
  try {
    envContent = fs.readFileSync(path.join(apiDir, '.env'), 'utf8');
  } catch {
    throw new Error("api/.env introuvable : copiez d'abord .env.example vers .env et renseignez LAUNCHER_KEY.");
  }

  const launcherKey = parseEnvValue(envContent, 'LAUNCHER_KEY');
  const port = parseEnvValue(envContent, 'PORT') || '8787';
  if (!launcherKey) throw new Error('LAUNCHER_KEY absent de api/.env.');

  return { apiBaseUrl: `http://localhost:${port}`, launcherKey };
}

// LAUNCHER_KEY est la cle partagee que CHAQUE launcher doit presenter pour
// obtenir un token (cf. api/src/auth.js) : elle n'avait jusqu'ici aucune
// interface pour la consulter/changer depuis l'admin, seulement une lecture
// (getLocalLauncherConfig ci-dessus) pour generer launcher.config.json.
// L'operateur devait editer api/.env a la main pour la faire tourner.
function getLauncherKey(apiDir) {
  let envContent = '';
  try {
    envContent = fs.readFileSync(path.join(apiDir, '.env'), 'utf8');
  } catch {
    throw new Error("api/.env introuvable : copiez d'abord .env.example vers .env.");
  }
  return parseEnvValue(envContent, 'LAUNCHER_KEY') || '';
}

// Genere une cle aleatoire suffisamment longue (192 bits, hex) : largement
// assez pour un secret partage compare en temps constant (cf. safeEquals
// cote API), pas besoin d'une entropie de mot de passe memorisable puisque
// personne ne la tape jamais a la main.
function generateLauncherKey() {
  return crypto.randomBytes(24).toString('hex');
}

// Remplace LAUNCHER_KEY dans api/.env en preservant tout le reste du fichier
// (commentaires, autres variables, ordre) : jamais un fs.writeFileSync
// aveugle qui ecraserait JWT_SECRET/PORT/etc. Cree la ligne si elle manque
// (ex: .env edite a la main sans elle).
function setLauncherKey(apiDir, newKey) {
  if (!newKey || !newKey.trim()) throw new Error('La cle ne peut pas etre vide.');
  const envPath = path.join(apiDir, '.env');
  let envContent = '';
  try {
    envContent = fs.readFileSync(envPath, 'utf8');
  } catch {
    throw new Error("api/.env introuvable : copiez d'abord .env.example vers .env.");
  }

  const line = `LAUNCHER_KEY=${newKey.trim()}`;
  const pattern = /^LAUNCHER_KEY=.*$/m;
  envContent = pattern.test(envContent)
    ? envContent.replace(pattern, line)
    : `${envContent.replace(/\n?$/, '\n')}${line}\n`;

  fs.writeFileSync(envPath, envContent);
  return newKey.trim();
}

module.exports = {
  listServers,
  saveServer,
  removeServer,
  getBranding,
  saveBranding,
  listNews,
  saveNews,
  listModpacks,
  importModpackFolder,
  generateManifest,
  getLocalLauncherConfig,
  getLauncherKey,
  generateLauncherKey,
  setLauncherKey
};
