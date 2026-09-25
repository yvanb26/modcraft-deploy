// Choisit automatiquement, parmi les Java deja installes sur la machine,
// celui compatible avec la version Minecraft ciblee : au lieu de se fier
// aveuglement a un `javaPath` generique ("java" du PATH), qui peut pointer
// vers n'importe quel JDK installe (souvent une tres vieille version chez un
// joueur qui a plusieurs JDK, ex: un JDK 8 installe pour un vieux projet).
// Lancer du Minecraft moderne (1.17+, y compris ses loaders) avec un Java 8
// echoue directement (UnsupportedClassVersionError) ; lancer du Minecraft
// tres ancien (1.7.10 et avant, y compris son Forge legacy) avec un Java
// recent (17/21) est instable/incompatible avec LWJGL2 : source probable
// des plantages et des tres mauvaises performances constates.
//
// Si aucun Java compatible n'est deja installe, on en telecharge un
// automatiquement (Eclipse Temurin/Adoptium, meme distribution que la
// plupart des launchers tiers) dans le dossier de donnees du launcher :
// comme le fait le launcher officiel Mojang, mais sans jamais toucher a une
// installation systeme (pas besoin de droits admin, rien en dehors de notre
// propre dossier).
const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const { gameRoot } = require('./paths');

const ADOPTIUM_BINARY_URL = 'https://api.adoptium.net/v3/binary/latest';

// Mojang encode la version Java requise dans le JSON de version officiel
// depuis le Minecraft 1.17 environ ("javaVersion":{"majorVersion":17,...}) ;
// absent sur les versions plus anciennes, qui tournent toutes sur Java 8.
function requiredJavaMajor(vanillaVersionJson) {
  return vanillaVersionJson?.javaVersion?.majorVersion || 8;
}

function parseJavaMajor(versionOutput) {
  // Java 8 et avant : `version "1.8.0_XXX"` : Java 9+ : `version "17.0.1"`,
  // `version "21"`, etc.
  const match = versionOutput.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const first = Number(match[1]);
  return first === 1 && match[2] ? Number(match[2]) : first;
}

// Sur une JVM 64 bits, la banniere `java -version` mentionne toujours
// explicitement "64-Bit" (ex: "Java HotSpot(TM) 64-Bit Server VM") : son
// absence (ex: "Client VM", qui n'existe plus que sur les distributions 32
// bits depuis l'abandon de la Client VM 64 bits par les fournisseurs de JDK)
// indique une JVM 32 bits.
function is64BitBanner(versionOutput) {
  return /64-Bit/.test(versionOutput);
}

// Ce launcher telecharge toujours des runtimes/natives 64 bits (cf.
// adoptiumArch, qui ne retourne x86 que si Electron lui-meme tourne en 32
// bits, cas devenu tres rare) : une JVM d'une autre "bitness" ne peut pas
// charger ces natives et plante au demarrage (typiquement "Impossible de
// lancer la VM" / "Could not create the Java Virtual Machine", souvent sans
// autre indice). On ne considere donc jamais une JVM 32 bits comme un
// candidat valable ici, meme si sa version majeure correspond.
function targetIs64Bit() {
  return process.arch !== 'ia32';
}

// `java -version` ecrit sur stderr (pas stdout), et ce quel que soit le
// systeme : spawnSync capture les deux separement peu importe le code de
// sortie, contrairement a execFileSync qui ne renvoie que stdout en cas de
// succes.
function detectJavaInfo(javaExePath) {
  try {
    const result = spawnSync(javaExePath, ['-version'], { encoding: 'utf8', timeout: 5000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    return { major: parseJavaMajor(output), is64Bit: is64BitBanner(output) };
  } catch {
    return { major: null, is64Bit: false };
  }
}

function resolveAbsolute(javaCmd) {
  if (path.isAbsolute(javaCmd)) return fs.existsSync(javaCmd) ? javaCmd : null;
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, [javaCmd], { encoding: 'utf8' });
    return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

function javaExeName() {
  return process.platform === 'win32' ? 'javaw.exe' : 'java';
}

// Emplacements d'installation standards des principaux distributeurs de JDK,
// en plus de ce que le PATH expose deja (un joueur peut avoir installe un
// JDK sans jamais l'ajouter au PATH).
function candidateInstallDirs() {
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Eclipse Foundation',
      'C:\\Program Files (x86)\\Java'
    ];
  }
  if (process.platform === 'darwin') {
    return ['/Library/Java/JavaVirtualMachines'];
  }
  return ['/usr/lib/jvm'];
}

function javaExeIn(installDir) {
  const macSuffix = process.platform === 'darwin' ? path.join('Contents', 'Home') : '';
  return path.join(installDir, macSuffix, 'bin', javaExeName());
}

function scanInstallDirs() {
  const found = [];
  for (const base of candidateInstallDirs()) {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue; // dossier absent : ce distributeur n'est simplement pas installe
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const exe = javaExeIn(path.join(base, entry.name));
      if (fs.existsSync(exe)) found.push(exe);
    }
  }
  return found;
}

// Dossier ou l'on installe nous-memes les runtimes Java telecharges (cf.
// downloadJavaRuntime) : distinct des installations systeme, jamais
// modifie/supprime en dehors de ce module.
function runtimesBaseDir() {
  return path.join(gameRoot(), 'runtimes');
}

function runtimeDirForMajor(major) {
  return path.join(runtimesBaseDir(), `jre-${major}`);
}

// Les archives Adoptium contiennent un dossier racine dont le nom exact
// depend de la version precise (ex: "jdk-17.0.9+9-jre") : on cherche
// l'executable recursivement plutot que de deviner ce nom.
function findJavaBinary(rootDir) {
  const targetName = javaExeName().toLowerCase();
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === targetName) return full;
    }
  }
  return null;
}

function scanOwnRuntimes() {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(runtimesBaseDir(), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const exe = findJavaBinary(path.join(runtimesBaseDir(), entry.name));
    if (exe) found.push(exe);
  }
  return found;
}

// Liste tous les executables Java trouvables (PATH + emplacements standards
// + runtimes deja telecharges par ce launcher), dedupliques par chemin.
function listCandidateJavaPaths() {
  const candidates = new Set();

  const fromPath = resolveAbsolute(process.platform === 'win32' ? 'javaw' : 'java');
  if (fromPath) candidates.add(fromPath);

  for (const exe of scanInstallDirs()) candidates.add(exe);
  for (const exe of scanOwnRuntimes()) candidates.add(exe);

  return [...candidates];
}

let cachedByMajor = null;

function buildJavaIndex() {
  const index = new Map();
  const want64 = targetIs64Bit();
  for (const javaPath of listCandidateJavaPaths()) {
    const { major, is64Bit } = detectJavaInfo(javaPath);
    if (!major) continue;
    // Une JVM de la mauvaise "bitness" n'est jamais un candidat valable ici
    // (cf. targetIs64Bit) : meme si sa version majeure correspond, on
    // prefere en telecharger une compatible plutot que de la retenir.
    if (is64Bit !== want64) continue;
    if (!index.has(major)) index.set(major, javaPath);
  }
  return index;
}

function adoptiumOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function adoptiumArch() {
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'ia32') return 'x86';
  return 'x64';
}

// Telecharge et installe un JRE Eclipse Temurin/Adoptium pour `major` dans
// notre propre dossier de runtimes (pas d'installation systeme, pas de
// droits admin necessaires). Retourne le chemin de l'executable pret a
// l'emploi.
async function downloadJavaRuntime(major, onProgress = () => {}) {
  const targetDir = runtimeDirForMajor(major);

  const url = `${ADOPTIUM_BINARY_URL}/${major}/ga/${adoptiumOs()}/${adoptiumArch()}/jre/hotspot/normal/eclipse`;
  onProgress({ phase: 'java', major, step: 'downloading' });

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(
      `Aucun Java ${major} pret a l'emploi trouve pour cette machine (${adoptiumOs()}/${adoptiumArch()}), ` +
      `et le telechargement automatique a echoue (HTTP ${res.status}). Installez-le manuellement (https://adoptium.net).`
    );
  }

  await fsp.mkdir(runtimesBaseDir(), { recursive: true });
  const archivePath = path.join(runtimesBaseDir(), `jre-${major}-download${process.platform === 'win32' ? '.zip' : '.tar.gz'}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archivePath));

  onProgress({ phase: 'java', major, step: 'extracting' });
  await fsp.rm(targetDir, { recursive: true, force: true });
  await fsp.mkdir(targetDir, { recursive: true });

  if (process.platform === 'win32') {
    const AdmZip = require('adm-zip');
    new AdmZip(archivePath).extractAllTo(targetDir, true);
  } else {
    // tar est present par defaut sur Linux/macOS : pas besoin d'une
    // dependance npm supplementaire juste pour ces deux plateformes.
    execFileSync('tar', ['-xzf', archivePath, '-C', targetDir]);
  }
  await fsp.unlink(archivePath).catch(() => {});

  const javaBin = findJavaBinary(targetDir);
  if (!javaBin) {
    throw new Error(`Java ${major} telecharge mais executable introuvable dans l'archive extraite.`);
  }
  return javaBin;
}

// Retourne le chemin java (javaw sur Windows) compatible avec `major` :
// utilise un Java deja installe si possible, sinon en telecharge un
// automatiquement. Lance une erreur claire et actionnable si aucune des deux
// options n'aboutit : plutot que de laisser mclc/le jeu planter plus loin
// sans explication.
async function resolveJavaForMajor(major, onProgress = () => {}) {
  if (!cachedByMajor) cachedByMajor = buildJavaIndex();

  const exact = cachedByMajor.get(major);
  if (exact) return exact;

  // A partir de Java 17, les versions ulterieures restent generalement
  // compatibles avec du Minecraft qui demande une version plus ancienne (ex:
  // 1.20.1 demande 17, tourne aussi bien sous 21) : pas vrai pour Java 8,
  // ou substituer un Java recent casse LWJGL2/le Forge legacy.
  if (major >= 17) {
    const higher = [...cachedByMajor.keys()].filter((m) => m >= major).sort((a, b) => a - b)[0];
    if (higher) return cachedByMajor.get(higher);
  }

  try {
    const javaBin = await downloadJavaRuntime(major, onProgress);
    cachedByMajor.set(major, javaBin);
    return javaBin;
  } catch (err) {
    const installed = [...cachedByMajor.keys()].sort((a, b) => a - b);
    throw new Error(
      `Cette version de Minecraft necessite Java ${major} (Java installe(s) detecte(s) sur cette machine : ` +
      `${installed.length ? installed.join(', ') : 'aucun'}). ${err.message}`
    );
  }
}

module.exports = { requiredJavaMajor, resolveJavaForMajor };
