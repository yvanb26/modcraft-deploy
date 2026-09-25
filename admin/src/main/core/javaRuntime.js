// Telecharge un JRE Eclipse Temurin (Adoptium) quand aucun Java compatible n'est installe,
// pour que la preinstallation du loader marche "cle en main". Installe uniquement dans un
// dossier de l'appli (jamais dans le systeme : aucun droit administrateur, rien a desinstaller).
// L'archive est verifiee avec la somme SHA-256 publiee par Adoptium avant extraction.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFileSync } = require('child_process');

const API = 'https://api.adoptium.net/v3';
// Versions LTS proposees par Adoptium : ce sont les seules qu'on telecharge.
const LTS = [8, 11, 17, 21, 25];

function adoptiumOs() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
}

function adoptiumArch() {
  return process.arch === 'arm64' ? 'aarch64' : 'x64';
}

// Plus petite version LTS comprise dans [min, max], ou null.
function pickMajor(min, max) {
  return LTS.find((v) => v >= min && v <= max) || null;
}

function javaExeName() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

// Le dossier racine de l'archive porte un nom qui depend de la version exacte : on cherche
// l'executable (dans un dossier bin/) au lieu de deviner ce nom.
function findJavaBinary(rootDir) {
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === javaExeName() && path.basename(dir) === 'bin') return full;
    }
  }
  return null;
}

// Runtimes deja telecharges (jre-<major>), pour que findJava les retrouve.
function installedRuntimes(baseDir) {
  let entries;
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && /^jre-\d+$/.test(e.name))
    .map((e) => findJavaBinary(path.join(baseDir, e.name)))
    .filter(Boolean);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'ModCraft-Deploy-Admin' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function downloadToFile(url, dest, expectedSize, onLog) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'ModCraft-Deploy-Admin' } });
  if (!res.ok || !res.body) throw new Error(`telechargement impossible (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || expectedSize || 0;
  let done = 0;
  let lastPct = -10;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    if (!total) return;
    const pct = Math.floor((done / total) * 100);
    if (pct >= lastPct + 10) { lastPct = pct; onLog(`  ${pct} % (${(done / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} Mo)\n`); }
  });
  await pipeline(body, fs.createWriteStream(dest));
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// Telecharge et installe le JRE `major` dans baseDir/jre-<major>. Retourne { exe, major }.
async function downloadJre(major, baseDir, onLog = () => {}) {
  const query = `architecture=${adoptiumArch()}&image_type=jre&os=${adoptiumOs()}&vendor=eclipse&jvm_impl=hotspot`;
  let pkg;
  try {
    const assets = await fetchJson(`${API}/assets/latest/${major}/hotspot?${query}`);
    pkg = assets?.[0]?.binary?.package;
  } catch (err) {
    throw new Error(`impossible de joindre Adoptium (${err.message}). Verifiez la connexion Internet, ou installez Java ${major} depuis https://adoptium.net`);
  }
  if (!pkg?.link) throw new Error(`Adoptium ne propose pas de Java ${major} pour ${adoptiumOs()}/${adoptiumArch()}. Installez-le depuis https://adoptium.net`);

  await fsp.mkdir(baseDir, { recursive: true });
  const archive = path.join(baseDir, `jre-${major}-download${process.platform === 'win32' ? '.zip' : '.tar.gz'}`);
  const partial = path.join(baseDir, `jre-${major}.partial`);
  const target = path.join(baseDir, `jre-${major}`);

  try {
    onLog(`Java ${major} introuvable sur cette machine : telechargement de Temurin ${major} (une seule fois, dans le dossier de l'application)...\n`);
    await downloadToFile(pkg.link, archive, pkg.size, onLog);

    if (pkg.checksum) {
      const actual = await sha256Of(archive);
      if (actual.toLowerCase() !== String(pkg.checksum).toLowerCase()) {
        throw new Error('somme de controle (SHA-256) incorrecte : le fichier telecharge est corrompu ou altere, il a ete ecarte.');
      }
      onLog('Somme de controle SHA-256 verifiee.\n');
    }

    // Extraction dans un dossier temporaire, renomme a la fin : un telechargement interrompu
    // ne laisse jamais un Java a moitie extrait que findJava pourrait retenir.
    await fsp.rm(partial, { recursive: true, force: true });
    await fsp.mkdir(partial, { recursive: true });
    if (process.platform === 'win32') {
      const AdmZip = require('adm-zip');
      new AdmZip(archive).extractAllTo(partial, true);
    } else {
      execFileSync('tar', ['-xzf', archive, '-C', partial]);
    }
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(partial, target);
  } finally {
    await fsp.rm(archive, { force: true }).catch(() => {});
    await fsp.rm(partial, { recursive: true, force: true }).catch(() => {});
  }

  const exe = findJavaBinary(target);
  if (!exe) throw new Error(`Java ${major} telecharge, mais executable introuvable dans l'archive.`);
  if (process.platform !== 'win32') await fsp.chmod(exe, 0o755).catch(() => {});
  onLog(`Java ${major} pret : ${exe}\n`);
  return { exe, major };
}

module.exports = { pickMajor, downloadJre, installedRuntimes, findJavaBinary };
