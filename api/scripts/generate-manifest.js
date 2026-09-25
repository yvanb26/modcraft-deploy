#!/usr/bin/env node
// Genere modpacks/<id>/manifest.json a partir du contenu de modpacks/<id>/
// Usage: npm run manifest : survie-legacy
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { isAllowedModpackFile } = require('./fileAllowlist');

const modpackId = process.argv[2];
if (!modpackId) {
  console.error('Usage: node scripts/generate-manifest.js <modpackId>');
  process.exit(1);
}

const modpackDir = path.join(__dirname, '..', 'modpacks', modpackId);

if (!fs.existsSync(modpackDir)) {
  console.error(`Dossier introuvable: ${modpackDir}`);
  console.error("Placez les fichiers du modpack (mods/, config/, resourcepacks/, ...) dedans avant de generer le manifest.");
  process.exit(1);
}

const IGNORED_FILES = new Set(['manifest.json']);

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function walk(dir, base = dir, acc = [], rejected = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, acc, rejected);
    } else if (entry.isFile()) {
      if (dir === base && IGNORED_FILES.has(entry.name)) continue;
      const relPath = path.relative(base, full).split(path.sep).join('/');
      // Defense en profondeur : l'admin filtre deja a l'import, mais un
      // fichier a pu atterrir ici par un autre chemin (copie manuelle,
      // upload SFTP direct...). On ne le met jamais dans le manifest.
      if (!isAllowedModpackFile(relPath)) {
        rejected.push(relPath);
        continue;
      }
      acc.push({
        path: relPath,
        sha256: sha256(full),
        size: fs.statSync(full).size
      });
    }
  }
  return acc;
}

// Detecte des erreurs de curation courantes AVANT le deploiement plutot que
// de laisser un joueur les decouvrir sous forme de crash illisible : vu en
// vrai : un "fpsplus.zip" depose dans mods/ (jamais charge par Forge legacy,
// qui n'accepte que des .jar, donc silencieusement ignore) et un jar corrompu
// qui plante FML avec "Unable to read a class file correctly". Purement
// informatif (n'empeche jamais de generer le manifest) : mieux vaut avertir
// et laisser l'operateur juger que bloquer sur un faux positif.
function checkModpackHygiene(files, modpackDir) {
  const warnings = [];
  for (const file of files) {
    if (!file.path.startsWith('mods/')) continue;
    const lower = file.path.toLowerCase();

    if (lower.endsWith('.zip')) {
      warnings.push(
        `${file.path} : extension .zip dans mods/ : Forge legacy (pre-1.13) ne charge que des .jar, ` +
        `ce fichier ne sera jamais charge comme mod. Renommez-le en .jar si c'en est vraiment un, sinon retirez-le de mods/.`
      );
      continue;
    }
    if (!lower.endsWith('.jar')) continue;

    try {
      const zip = new AdmZip(path.join(modpackDir, file.path));
      zip.getEntries(); // force la lecture complete du repertoire central du zip
    } catch (err) {
      warnings.push(`${file.path} : jar illisible/corrompu (${err.message}) : ce mod fera planter FML au chargement.`);
    }
  }
  return warnings;
}

const rejectedFiles = [];
const files = walk(modpackDir, modpackDir, [], rejectedFiles);
if (rejectedFiles.length > 0) {
  console.log(`Attention : ${rejectedFiles.length} fichier(s) au format non autorise ignore(s) (jamais inclus dans le manifest) :`);
  for (const f of rejectedFiles) console.log(`  - ${f}`);
}

const hygieneWarnings = checkModpackHygiene(files, modpackDir);
if (hygieneWarnings.length > 0) {
  console.log(`Attention : ${hygieneWarnings.length} probleme(s) potentiel(s) detecte(s) dans mods/ (le manifest est quand meme genere) :`);
  for (const w of hygieneWarnings) console.log(`  - ${w}`);
}

const manifest = {
  modpackId,
  generatedAt: new Date().toISOString(),
  fileCount: files.length,
  files
};

fs.writeFileSync(path.join(modpackDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Manifest genere pour "${modpackId}": ${files.length} fichiers.`);
