// Generation d'un serveur Minecraft "pret a l'emploi" a partir de ce que
// l'admin sait deja d'un serveur (servers.json : version, loader, modpack,
// mode de compte, RCON, arguments Java) + les fichiers de son modpack.
//
// Sortie : un dossier (et, en option, un zip) contenant le jar/installeur du
// loader, mods/ et config/ filtres (sans les mods client-only, cf. mcSides.js),
// server.properties, eula.txt, jvm-args.txt et des scripts de demarrage
// start-server.sh / start-server.bat : donc utilisable sur n'importe quel hebergeur (VPS,
// serveur dedie, PufferPanel, Pterodactyl...), pas seulement un panel precis.
//
// Rien ici ne demarre le serveur ni n'accepte l'EULA a la place de l'operateur.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { app } = require('electron');

const configStore = require('./configStore');
const { fetchVanillaVersionJson } = require('./mojangVersions');
const mcSides = require('./mcSides');
const { uploadTree, uploadFile, posixJoin, posixNormalize } = require('./sftpTransfer');
const { withSftp, formatProgress } = require('./deploy');
const { normalizeProtocol, defaultPort } = require('./remoteClient');
const javaRuntime = require('./javaRuntime');

const MARKER = '.modcraft-server.json';
// Presence d'un de ces elements = le dossier a deja servi a FAIRE TOURNER un
// serveur : on ne le supprime jamais (il contient peut-etre un monde).
const RUNTIME_SIGNS = ['world', 'world_nether', 'world_the_end', 'logs', 'crash-reports', 'usercache.json', 'banned-players.json'];

// Ce qui, dans un modpack, ne concerne que le client (jamais copie sur le serveur).
const EXCLUDED_TOP_DIRS = new Set(['resourcepacks', 'shaderpacks', 'optifine', 'screenshots', 'saves', 'logs', 'crash-reports', 'journeymap', 'texturepacks']);
const EXCLUDED_TOP_FILE = /^(options.*\.txt|servers\.dat(_old)?|optioninterfaceplus\.txt|launcher_profiles\.json|log4j2_.*\.xml)$/i;

// Fichiers de configuration qu'un envoi SFTP ne doit pas ecraser sur un
// serveur deja en service (reglages modifies a la main par l'hebergeur/l'admin).
const PROTECTED_REMOTE_FILES = ['server.properties', 'eula.txt', 'jvm-args.txt', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json'];

// --- Parametres par serveur -------------------------------------------------
function parsePort(serverAddress) {
  const m = String(serverAddress || '').match(/:(\d{2,5})$/);
  return m ? Number(m[1]) : 25565;
}

function memoryFromJavaArgs(javaArgs) {
  const m = (javaArgs || []).join(' ').match(/-Xmx(\d+)([GgMm])/);
  if (!m) return 4;
  return m[2].toLowerCase() === 'g' ? Number(m[1]) : Math.max(1, Math.round(Number(m[1]) / 1024));
}

function defaultSettings(server) {
  return {
    port: parsePort(server.serverAddress),
    memoryGb: memoryFromJavaArgs(server.javaArgs),
    motd: server.description || server.name || 'Serveur Minecraft',
    maxPlayers: 20,
    difficulty: 'normal',
    gamemode: 'survival',
    eula: false,
    preinstall: true,
    makeZip: true,
    extrasDir: '',
    outDir: '',
    // Session SFTP PROPRE a ce serveur Minecraft : ce n'est pas le meme hote/compte que
    // l'API du launcher (onglet Deploiement). Stockee chiffree avec le reste de la config.
    // `protocol` : 'sftp' (SSH), 'ftp' ou 'ftps' (TLS) : ex: certains hebergeurs gratuits n'ont que du FTP.
    sftp: { protocol: 'sftp', host: '', port: 22, username: '', password: '' },
    remotePath: '',
    keepRemoteConfig: true,
    mirrorMods: false
  };
}

function getSettings(apiDir, serverId) {
  const server = requireServer(apiDir, serverId);
  const saved = (configStore.readAll().mcServer || {})[serverId] || {};
  return { ...defaultSettings(server), ...saved };
}

function setSettings(serverId, settings) {
  const all = { ...(configStore.readAll().mcServer || {}) };
  all[serverId] = settings;
  configStore.patch({ mcServer: all });
  return settings;
}

// Serveur hors ligne (online-mode=false) : l'API doit ecrire elle-meme whitelist.json chez l'hebergeur, car
// `whitelist add` (RCON) inscrit le vrai UUID Mojang alors que le serveur en calcule un autre (cf. api/src/whitelist.js).
// On recopie donc, dans l'entree de servers.json, l'acces SFTP/FTP DEJA saisi ici pour ce serveur Minecraft
// (onglet "Serveur Minecraft") : rien a ressaisir. Serveur en ligne, ou acces incomplet -> champ retire.
// Ces identifiants ne sont jamais envoyes au launcher (l'API les retire de sa config publique).
function syncWhitelistAccess(apiDir, serverId) {
  const dataFiles = require('./dataFiles');
  const server = dataFiles.listServers(apiDir).find((s) => s.id === serverId);
  if (!server) return;
  const saved = (configStore.readAll().mcServer || {})[serverId] || {};
  const cfg = saved.sftp || {};
  const protocol = normalizeProtocol(cfg.protocol);
  const wanted = server.onlineMode === false && cfg.host && cfg.username && saved.remotePath
    ? {
        protocol,
        host: String(cfg.host).trim(),
        port: Number(cfg.port) || defaultPort(protocol),
        username: cfg.username,
        password: cfg.password || '',
        remotePath: String(saved.remotePath).trim()
      }
    : null;
  if (JSON.stringify(wanted) === JSON.stringify(server.whitelistAccess || null)) return;
  const next = { ...server };
  if (wanted) next.whitelistAccess = wanted;
  else delete next.whitelistAccess;
  dataFiles.saveServer(apiDir, next);
}

function requireServer(apiDir, serverId) {
  const dataFiles = require('./dataFiles');
  const server = dataFiles.listServers(apiDir).find((s) => s.id === serverId);
  if (!server) throw new Error(`Serveur inconnu: ${serverId}`);
  if (!/^[A-Za-z0-9._-]+$/.test(server.id)) throw new Error(`Identifiant de serveur invalide: ${server.id}`);
  if (server.modpackId && !/^[A-Za-z0-9._-]+$/.test(server.modpackId)) throw new Error(`Identifiant de modpack invalide: ${server.modpackId}`);
  return server;
}

function defaultOutDir(apiDir) {
  return path.join(path.dirname(apiDir), 'serveurs-minecraft');
}

function resolveOutDir(apiDir, settings) {
  return settings.outDir ? path.resolve(settings.outDir) : defaultOutDir(apiDir);
}

// --- Telechargements ----------------------------------------------------------
function cacheDir() {
  return path.join(app.getPath('userData'), 'mc-server-cache');
}

async function download(url, destPath, log) {
  // Cle de cache = empreinte de l'URL : le meme nom de fichier ("server.jar",
  // "fabric-server-launch.jar"...) correspond a des contenus differents selon
  // la version Minecraft / du loader.
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const cached = path.join(cacheDir(), `${key}-${path.basename(destPath)}`);
  if (!fs.existsSync(cached) || fs.statSync(cached).size === 0) {
    log(`Telechargement : ${url}\n`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Telechargement impossible (${res.status}) : ${url}`);
    await fsp.mkdir(cacheDir(), { recursive: true });
    const tmp = `${cached}.part`;
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    await fsp.rename(tmp, cached);
  } else {
    log(`En cache : ${path.basename(destPath)}\n`);
  }
  await fsp.copyFile(cached, destPath);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Requete impossible (${res.status}) : ${url}`);
  return res.json();
}

async function urlExists(url) {
  const res = await fetch(url, { method: 'HEAD' });
  return res.ok;
}

// --- Plan par loader ------------------------------------------------------------
// Retourne { type, kind, installer?, installArgs?, launchJar?, label } :
//  - kind "jar"       : le fichier telecharge se lance tel quel (vanilla, Fabric).
//  - kind "installer" : il faut lancer un installeur une fois (Forge, NeoForge,
//                       Quilt), qui produit ensuite les fichiers a demarrer.
async function prepareLoader(server, root, log) {
  const mc = server.minecraftVersion;
  const type = server.loader?.type || 'vanilla';
  const version = server.loader?.version;
  if (type !== 'vanilla' && !version) throw new Error(`Version du loader (${type}) manquante dans la configuration du serveur.`);

  switch (type) {
    case 'vanilla': {
      const json = await fetchVanillaVersionJson(mc);
      const url = json.downloads?.server?.url;
      if (!url) throw new Error(`Pas de serveur officiel telechargeable pour Minecraft ${mc}.`);
      await download(url, path.join(root, 'server.jar'), log);
      return { type, kind: 'jar', launchJar: 'server.jar', label: `Minecraft ${mc} (vanilla)` };
    }

    case 'fabric': {
      const installers = await fetchJson('https://meta.fabricmc.net/v2/versions/installer');
      const installer = (installers.find((i) => i.stable) || installers[0]).version;
      const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(version)}/${installer}/server/jar`;
      await download(url, path.join(root, 'fabric-server-launch.jar'), log);
      return { type, kind: 'jar', launchJar: 'fabric-server-launch.jar', label: `Fabric ${version} (Minecraft ${mc})` };
    }

    case 'quilt': {
      const installers = await fetchJson('https://meta.quiltmc.org/v3/versions/installer');
      await download(installers[0].url, path.join(root, 'quilt-installer.jar'), log);
      return {
        type, kind: 'installer', installer: 'quilt-installer.jar',
        installArgs: ['install', 'server', mc, version, '--download-server', '--install-dir=.'],
        launchJar: 'quilt-server-launch.jar', label: `Quilt ${version} (Minecraft ${mc})`
      };
    }

    case 'forge': {
      // Le maven de Forge nomme certaines vieilles versions (dont la plupart des
      // 1.7.10) avec un suffixe de branche qui repete la version MC : on teste
      // les deux formes (meme logique que le launcher).
      const candidates = [`${mc}-${version}`, `${mc}-${version}-${mc}`];
      let full = null;
      for (const c of candidates) {
        if (await urlExists(`https://maven.minecraftforge.net/net/minecraftforge/forge/${c}/forge-${c}-installer.jar`)) { full = c; break; }
      }
      if (!full) throw new Error(`Installeur Forge introuvable pour ${mc} / ${version}.`);
      const file = `forge-${full}-installer.jar`;
      await download(`https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/${file}`, path.join(root, file), log);
      return { type, kind: 'installer', installer: file, installArgs: ['--installServer'], label: `Forge ${version} (Minecraft ${mc})` };
    }

    case 'neoforge': {
      const file = `neoforge-${version}-installer.jar`;
      await download(`https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/${file}`, path.join(root, file), log);
      return { type, kind: 'installer', installer: file, installArgs: ['--installServer'], label: `NeoForge ${version} (Minecraft ${mc})` };
    }

    default:
      throw new Error(`Loader non supporte : ${type}`);
  }
}

// --- Java -------------------------------------------------------------------------
// Un serveur ne tourne que sur une PLAGE de versions de Java : les vieux Forge
// (Minecraft <= 1.12) exigent Java 8 exactement (LaunchWrapper caste le
// ClassLoader systeme en URLClassLoader, ce qui plante des Java 9+), alors que
// les versions recentes de Minecraft demandent Java 17/21+. Une machine en a
// souvent plusieurs : on cherche donc celui qui convient, on ne se fie pas
// au `java` du PATH.
function javaMajorOf(exe) {
  try {
    const r = spawnSync(exe, ['-version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const m = `${r.stdout || ''}${r.stderr || ''}`.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    const first = Number(m[1]);
    return first === 1 && m[2] ? Number(m[2]) : first;
  } catch {
    return null;
  }
}

function runtimesDir() {
  return path.join(app.getPath('userData'), 'runtimes');
}

function javaCandidates() {
  const win = process.platform === 'win32';
  const exeName = win ? 'java.exe' : 'java';
  const out = [];
  const add = (p) => { if (p && !out.includes(p) && fs.existsSync(p)) out.push(p); };

  // Java telecharges par l'appli elle-meme (cf. javaRuntime.js), retrouves d'une generation a l'autre.
  javaRuntime.installedRuntimes(runtimesDir()).forEach(add);
  if (process.env.JAVA_HOME) add(path.join(process.env.JAVA_HOME, 'bin', exeName));
  try {
    const r = spawnSync(win ? 'where' : 'which', ['java'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).forEach(add);
  } catch { /* pas de java dans le PATH */ }

  const env = process.env;
  const roots = win
    ? [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean)
        .flatMap((pf) => ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'Semeru'].map((d) => path.join(pf, d)))
        .concat([env.APPDATA && path.join(env.APPDATA, '.minecraft', 'runtime')].filter(Boolean))
    : ['/usr/lib/jvm', '/usr/lib64/jvm', '/Library/Java/JavaVirtualMachines', env.HOME && path.join(env.HOME, '.sdkman', 'candidates', 'java')].filter(Boolean);

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [[root, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth < 5) stack.push([full, depth + 1]);
        else if (e.isFile() && e.name === exeName && path.basename(dir) === 'bin') add(full);
      }
    }
  }
  return out;
}

// Premier Java installe dont la version majeure est dans [min, max].
function findJava(min, max) {
  for (const exe of javaCandidates()) {
    const major = javaMajorOf(exe);
    if (major && major >= min && major <= max) return { exe, major };
  }
  return null;
}

async function requiredJavaMajor(mc) {
  try {
    const json = await fetchVanillaVersionJson(mc);
    return json.javaVersion?.majorVersion || 8;
  } catch {
    return null;
  }
}

// Plage de Java acceptee par le serveur genere.
function javaRange(server, requiredMajor) {
  const min = requiredMajor || 8;
  const minor = mcMinor(server.minecraftVersion);
  let max = 99;
  if (server.loader?.type === 'forge') {
    if (minor <= 12) max = 8; // LaunchWrapper : Java 8 uniquement
    else if (minor <= 16) max = 16; // Forge 1.13-1.16 : pas de Java 17+
  }
  return { min, max: Math.max(min, max) };
}

function describeJavaRange({ min, max }) {
  if (min === max) return `Java ${min} obligatoirement (les versions plus recentes ne fonctionnent pas avec ce serveur)`;
  if (max >= 99) return `Java ${min} ou plus recent`;
  return `Java ${min} a ${max} (les versions plus recentes ne fonctionnent pas avec ce serveur)`;
}

function runInstaller(root, plan, javaExe, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaExe, ['-jar', plan.installer, ...plan.installArgs], { cwd: root, windowsHide: true });
    const forward = (chunk) => log(chunk.toString());
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`L'installeur a echoue (code ${code}).`))));
  });
}

// --- Fichiers generes ------------------------------------------------------------
function mcMinor(mc) {
  const parts = String(mc).split('.');
  return parts[0] === '1' ? Number(parts[1]) || 0 : 99;
}

function buildProperties(server, settings) {
  const minor = mcMinor(server.minecraftVersion);
  const named = minor >= 13; // avant 1.13, difficulty/gamemode etaient numeriques
  const difficulties = ['peaceful', 'easy', 'normal', 'hard'];
  const gamemodes = ['survival', 'creative', 'adventure', 'spectator'];
  const difficulty = named ? settings.difficulty : String(Math.max(0, difficulties.indexOf(settings.difficulty)));
  const gamemode = named ? settings.gamemode : String(Math.max(0, gamemodes.indexOf(settings.gamemode)));
  const rcon = server.rcon;

  const lines = [
    '# Genere par ModCraft Deploy Admin',
    `server-port=${settings.port}`,
    `motd=${String(settings.motd).replace(/[\r\n]+/g, ' ')}`,
    `max-players=${settings.maxPlayers}`,
    `online-mode=${server.onlineMode !== false}`,
    `difficulty=${difficulty}`,
    `gamemode=${gamemode}`,
    'level-name=world',
    // La whitelist est alimentee par le launcher via RCON (cf. api/src/whitelist.js).
    `white-list=${rcon ? 'true' : 'false'}`
  ];
  if (rcon && named) lines.push('enforce-whitelist=true');
  // Depuis la 1.19.3, enforce-secure-profile=true (valeur par defaut) refuse les clients sans cle de chat signee par
  // Mojang : donc tous les comptes gratuits / Ely.by. Sur un serveur hors ligne il faut le desactiver.
  if (server.onlineMode === false && minor >= 19) lines.push('enforce-secure-profile=false');
  lines.push(`enable-rcon=${rcon ? 'true' : 'false'}`);
  if (rcon) {
    lines.push(`rcon.port=${rcon.port || 25575}`);
    lines.push(`rcon.password=${rcon.password || ''}`);
  }
  return lines.join('\n') + '\n';
}

function buildJvmArgs(server, settings) {
  const mem = Math.max(1, Number(settings.memoryGb) || 4);
  const extra = (server.javaArgs || []).filter((a) => !/^-Xm[xs]/i.test(a));
  return [
    '# Arguments Java du serveur (lus par start-server.sh / start-server.bat).',
    `-Xmx${mem}G`,
    `-Xms${Math.max(1, Math.ceil(mem / 2))}G`,
    ...extra
  ].join('\n') + '\n';
}

function buildEula(accepted) {
  return [
    '# EULA de Minecraft : https://aka.ms/MinecraftEULA',
    '# En mettant eula=true, VOUS acceptez le contrat de licence de Mojang.',
    `eula=${accepted ? 'true' : 'false'}`
  ].join('\n') + '\n';
}

function shBody(plan) {
  if (plan.kind === 'jar') return `exec "$JAVA_BIN" $JVM_ARGS -jar ${plan.launchJar} nogui "$@"`;

  if (plan.type === 'quilt') {
    return [
      `if [ ! -f ${plan.launchJar} ]; then`,
      '  echo "Installation de Quilt (premier demarrage)..."',
      `  "$JAVA_BIN" -jar ${plan.installer} ${plan.installArgs.join(' ')} || { echo "Echec de l'installation."; exit 1; }`,
      'fi',
      `exec "$JAVA_BIN" $JVM_ARGS -jar ${plan.launchJar} nogui "$@"`
    ].join('\n');
  }

  // Forge / NeoForge
  return [
    'if [ ! -f .installed ]; then',
    '  INSTALLER=$(ls *-installer.jar 2>/dev/null | head -n 1)',
    '  [ -n "$INSTALLER" ] || { echo "Installeur introuvable."; exit 1; }',
    '  echo "Installation du loader (premier demarrage)..."',
    `  "$JAVA_BIN" -jar "$INSTALLER" ${plan.installArgs.join(' ')} || { echo "Echec de l'installation."; exit 1; }`,
    '  touch .installed',
    'fi',
    '# Forge/NeoForge recents (Java 17+) : fichier d\'arguments ; anciens : jar "universal".',
    'ARGS=$(ls libraries/net/minecraftforge/forge/*/unix_args.txt libraries/net/neoforged/neoforge/*/unix_args.txt libraries/net/neoforged/forge/*/unix_args.txt 2>/dev/null | head -n 1)',
    'if [ -n "$ARGS" ]; then',
    '  exec "$JAVA_BIN" @jvm-args.txt "@$ARGS" nogui "$@"',
    'else',
    '  JAR=$(ls forge-*.jar 2>/dev/null | grep -v installer | head -n 1)',
    '  [ -n "$JAR" ] || { echo "Jar du serveur Forge introuvable."; exit 1; }',
    '  exec "$JAVA_BIN" $JVM_ARGS -jar "$JAR" nogui "$@"',
    'fi'
  ].join('\n');
}

function buildStartSh(plan, range) {
  return [
    '#!/usr/bin/env sh',
    '# Demarre le serveur Minecraft (genere par ModCraft Deploy Admin).',
    'cd "$(dirname "$0")" || exit 1',
    `JAVA_MIN=${range.min}`,
    `JAVA_MAX=${range.max}`,
    '',
    '# Ce serveur ne tourne que sur certaines versions de Java : on cherche celle qui convient',
    '# (JAVA_BIN=/chemin/vers/java force un Java precis, sans verification).',
    'java_major() { "$1" -version 2>&1 | awk -F\'"\' \'/version/ { split($2, a, "."); if (a[1] == "1") print a[2]; else print a[1]; exit }\'; }',
    'find_java() {',
    '  for c in "${JAVA_HOME:+$JAVA_HOME/bin/java}" "$(command -v java 2>/dev/null)" /usr/lib/jvm/*/bin/java /usr/lib64/jvm/*/bin/java /Library/Java/JavaVirtualMachines/*/Contents/Home/bin/java "$HOME"/.sdkman/candidates/java/*/bin/java; do',
    '    [ -n "$c" ] && [ -x "$c" ] || continue',
    '    m=$(java_major "$c")',
    '    case "$m" in \'\'|*[!0-9]*) continue ;; esac',
    '    if [ "$m" -ge "$JAVA_MIN" ] && [ "$m" -le "$JAVA_MAX" ]; then echo "$c"; return 0; fi',
    '  done',
    '  return 1',
    '}',
    'if [ -z "$JAVA_BIN" ]; then',
    '  JAVA_BIN=$(find_java) || {',
    `    echo "Aucun Java compatible trouve : ce serveur demande ${describeJavaRange(range)}."`,
    '    echo "Installez-le ou definissez JAVA_BIN=/chemin/vers/java"',
    '    exit 1',
    '  }',
    'fi',
    'echo "Java utilise : $JAVA_BIN"',
    "JVM_ARGS=$(grep -v '^[[:space:]]*#' jvm-args.txt 2>/dev/null | tr '\\n' ' ')",
    '',
    shBody(plan),
    ''
  ].join('\n');
}

// Recherche de Java sous Windows : un script PowerShell (livre a cote) qui liste les
// Java installes et renvoie le premier dont la version est dans la plage.
function buildFindJavaPs1() {
  return [
    'param([int]$Min = 8, [int]$Max = 99)',
    '# Affiche le chemin du premier java.exe installe dont la version majeure est dans [Min, Max].',
    '$ErrorActionPreference = "SilentlyContinue"',
    'function Get-JavaMajor($exe) {',
    '  # Java ecrit "-version" sur stderr : on lit les deux flux via un vrai processus.',
    '  $psi = New-Object System.Diagnostics.ProcessStartInfo',
    '  $psi.FileName = $exe; $psi.Arguments = "-version"',
    '  $psi.RedirectStandardError = $true; $psi.RedirectStandardOutput = $true',
    '  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true',
    '  $p = [System.Diagnostics.Process]::Start($psi)',
    '  $out = $p.StandardError.ReadToEnd() + $p.StandardOutput.ReadToEnd()',
    '  $p.WaitForExit()',
    '  if ($out -match \'version "(\\d+)(?:\\.(\\d+))?\') {',
    '    $a = [int]$Matches[1]',
    '    if ($a -eq 1 -and $Matches[2]) { return [int]$Matches[2] }',
    '    return $a',
    '  }',
    '  return $null',
    '}',
    '$candidates = New-Object System.Collections.Generic.List[string]',
    'if ($env:JAVA_HOME) { $candidates.Add((Join-Path $env:JAVA_HOME "bin\\java.exe")) }',
    'foreach ($c in (Get-Command java.exe -All)) { $candidates.Add($c.Source) }',
    '$roots = @()',
    'foreach ($pf in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA "Programs"))) {',
    '  foreach ($d in "Java","Eclipse Adoptium","Eclipse Foundation","Microsoft","Zulu","Amazon Corretto","BellSoft","Semeru") { $roots += (Join-Path $pf $d) }',
    '}',
    '$roots += (Join-Path $env:APPDATA ".minecraft\\runtime")',
    'foreach ($r in $roots) {',
    '  if (Test-Path $r) {',
    '    foreach ($f in (Get-ChildItem $r -Recurse -Depth 5 -Filter java.exe -File)) { if ($f.Directory.Name -eq "bin") { $candidates.Add($f.FullName) } }',
    '  }',
    '}',
    '$seen = @{}',
    'foreach ($exe in $candidates) {',
    '  if (-not $exe -or $seen.ContainsKey($exe) -or -not (Test-Path $exe)) { continue }',
    '  $seen[$exe] = $true',
    '  $major = Get-JavaMajor $exe',
    '  if ($major -and $major -ge $Min -and $major -le $Max) { Write-Output $exe; exit 0 }',
    '}',
    'exit 1',
    ''
  ].join('\r\n');
}

function batBody(plan) {
  if (plan.kind === 'jar') return `"%JAVA_BIN%" !JVM_ARGS! -jar ${plan.launchJar} nogui %*`;

  if (plan.type === 'quilt') {
    return [
      `if not exist ${plan.launchJar} (`,
      '  echo Installation du loader - premier demarrage...',
      `  "%JAVA_BIN%" -jar ${plan.installer} ${plan.installArgs.join(' ')}`,
      '  if errorlevel 1 ( echo Echec de l\'installation. & pause & exit /b 1 )',
      ')',
      `"%JAVA_BIN%" !JVM_ARGS! -jar ${plan.launchJar} nogui %*`
    ].join('\r\n');
  }

  return [
    'if not exist .installed (',
    '  set "INSTALLER="',
    '  for %%f in (*-installer.jar) do set "INSTALLER=%%f"',
    '  if "!INSTALLER!"=="" ( echo Installeur introuvable. & pause & exit /b 1 )',
    '  echo Installation du loader - premier demarrage...',
    `  "%JAVA_BIN%" -jar "!INSTALLER!" ${plan.installArgs.join(' ')}`,
    '  if errorlevel 1 ( echo Echec de l\'installation. & pause & exit /b 1 )',
    '  echo.>.installed',
    ')',
    'set "ARGS="',
    'for /d %%d in (libraries\\net\\minecraftforge\\forge\\*) do if exist "%%d\\win_args.txt" set "ARGS=%%d\\win_args.txt"',
    'for /d %%d in (libraries\\net\\neoforged\\neoforge\\*) do if exist "%%d\\win_args.txt" set "ARGS=%%d\\win_args.txt"',
    'for /d %%d in (libraries\\net\\neoforged\\forge\\*) do if exist "%%d\\win_args.txt" set "ARGS=%%d\\win_args.txt"',
    'if defined ARGS (',
    '  "%JAVA_BIN%" @jvm-args.txt "@!ARGS!" nogui %*',
    '  goto :end',
    ')',
    'set "JAR="',
    'for %%f in (forge-*.jar) do echo %%f | findstr /i "installer" >nul || set "JAR=%%f"',
    'if "!JAR!"=="" ( echo Jar du serveur Forge introuvable. & pause & exit /b 1 )',
    '"%JAVA_BIN%" !JVM_ARGS! -jar "!JAR!" nogui %*'
  ].join('\r\n');
}

function buildStartBat(plan, range) {
  return [
    '@echo off',
    'setlocal enabledelayedexpansion',
    'rem Demarre le serveur Minecraft (genere par ModCraft Deploy Admin).',
    'cd /d "%~dp0"',
    'rem Ce serveur ne tourne que sur certaines versions de Java : find-java.ps1 cherche celle',
    'rem qui convient. JAVA_BIN=C:\\chemin\\java.exe force un Java precis, sans verification.',
    'if defined JAVA_BIN goto :javaok',
    'set "JAVA_FOUND="',
    `for /f "usebackq delims=" %%j in (\`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0find-java.ps1" -Min ${range.min} -Max ${range.max} 2^>nul\`) do set "JAVA_FOUND=%%j"`,
    `if not defined JAVA_FOUND ( echo Aucun Java compatible trouve : ce serveur demande ${describeJavaRange(range).replace(/[()]/g, '')}. & echo Installez-le ou definissez JAVA_BIN=C:\\chemin\\java.exe & pause & exit /b 1 )`,
    'set "JAVA_BIN=!JAVA_FOUND!"',
    ':javaok',
    'echo Java utilise : %JAVA_BIN%',
    'set "JVM_ARGS="',
    'if exist jvm-args.txt for /f "usebackq eol=# tokens=* delims=" %%a in ("jvm-args.txt") do set "JVM_ARGS=!JVM_ARGS! %%a"',
    '',
    batBody(plan),
    ':end',
    'pause',
    ''
  ].join('\r\n');
}

// Retrouve ce qu'il faut lancer, pour l'expliquer aux hebergeurs de type
// "panel" qui n'utilisent pas nos scripts (ils ont leur propre commande).
function describeLaunch(root, plan, server) {
  if (plan.kind === 'jar') return `java <arguments de jvm-args.txt> -jar ${plan.launchJar} nogui`;
  if (plan.type === 'quilt') {
    return fs.existsSync(path.join(root, plan.launchJar))
      ? `java <arguments de jvm-args.txt> -jar ${plan.launchJar} nogui`
      : `(apres installation) java -jar ${plan.installer} ${plan.installArgs.join(' ')}  puis  java <arguments> -jar ${plan.launchJar} nogui`;
  }

  const argsFile = findFirst(root, 'libraries', /^(unix|win)_args\.txt$/);
  if (argsFile) {
    const rel = path.relative(root, argsFile).split(path.sep).join('/').replace(/win_args\.txt$/, 'unix_args.txt');
    return `java @jvm-args.txt @${rel} nogui   (Java 17+ ; sous Windows : win_args.txt)`;
  }
  const universal = fs.readdirSync(root).find((f) => /^forge-.*\.jar$/i.test(f) && !/installer/i.test(f));
  if (universal) return `java <arguments de jvm-args.txt> -jar ${universal} nogui`;
  // Pas encore installe : on indique ce qu'il y aura a lancer une fois l'installeur passe.
  const version = server.loader.version;
  if (plan.type === 'neoforge' || mcMinor(server.minecraftVersion) >= 17) {
    const dir = plan.type === 'neoforge'
      ? `libraries/net/neoforged/neoforge/${version}`
      : `libraries/net/minecraftforge/forge/${server.minecraftVersion}-${version}`;
    return `(apres installation) java @jvm-args.txt @${dir}/unix_args.txt nogui   (Java 17+ ; sous Windows : win_args.txt)`;
  }
  return `(apres installation) java <arguments de jvm-args.txt> -jar <jar "forge-..." genere par l'installeur, hors "-installer"> nogui`;
}

function findFirst(dir, sub, nameRe) {
  const start = path.join(dir, sub);
  if (!fs.existsSync(start)) return null;
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (nameRe.test(e.name)) return full;
    }
  }
  return null;
}

function buildReadme({ server, settings, plan, javaRange: range, launchCommand, preinstalled, excluded }) {
  const rconPort = server.rcon ? (server.rcon.port || 25575) : null;
  return [
    `SERVEUR MINECRAFT - ${server.name || server.id}`,
    'Genere par ModCraft Deploy Admin.',
    '',
    `Minecraft : ${server.minecraftVersion}`,
    `Loader    : ${plan.label}`,
    `Java      : ${describeJavaRange(range)}`,
    `Port jeu  : ${settings.port}${rconPort ? `   |   Port RCON : ${rconPort}` : ''}`,
    `Memoire   : ${settings.memoryGb} Go maximum (voir jvm-args.txt)`,
    '',
    'AVANT DE DEMARRER',
    '  1. Acceptez l\'EULA de Minecraft (https://aka.ms/MinecraftEULA) :',
    `     ${settings.eula ? 'deja accepte a la generation (eula.txt : eula=true).' : 'ouvrez eula.txt et remplacez eula=false par eula=true.'}`,
    '  2. Ouvrez les ports ci-dessus (pare-feu / routeur / panel).',
    '',
    'DEMARRER',
    '  Linux / macOS : sh start-server.sh        (ou chmod +x start-server.sh && ./start-server.sh)',
    '  Windows       : double-clic sur start-server.bat',
    preinstalled
      ? '  Le loader est deja installe : le serveur demarre directement.'
      : plan.kind === 'installer'
        ? '  Au premier demarrage, le loader s\'installe tout seul (Internet requis, quelques minutes).'
        : '',
    '',
    'HEBERGEUR AVEC PANEL (PufferPanel, Pterodactyl, AMP...)',
    '  Envoyez le contenu de ce dossier (ou du zip, a extraire) a la racine du serveur.',
    '  Commande de demarrage a renseigner dans le panel :',
    `     ${launchCommand}`,
    `  Java a selectionner dans le panel : ${describeJavaRange(range)}.`,
    '  (les arguments -Xmx/-Xms sont ceux de jvm-args.txt ; adaptez-les a la memoire allouee).',
    '',
    'CONTENU',
    '  mods/ et config/   : fichiers du modpack, sans les mods "client uniquement".',
    `  ${excluded.length} fichier(s) exclu(s) : mods client et dossiers client (resourcepacks, shaderpacks, options...).`,
    '  server.properties  : genere a partir de la configuration de l\'admin (online-mode, RCON, whitelist).',
    '',
    'Ne demarrez pas le serveur DANS ce dossier de generation si vous comptez le regenerer :',
    'l\'admin refuse d\'ecraser un dossier qui contient un monde (world/).',
    ''
  ].filter((l, i, arr) => !(l === '' && arr[i - 1] === '')).join('\n');
}

// --- Copie du modpack ---------------------------------------------------------
function copyModpackForServer(modpackRoot, targetRoot, sideByPath, log) {
  const excluded = [];
  let copied = 0;

  function walk(dir, relDir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const src = path.join(dir, entry.name);
      const top = rel.split('/')[0];

      if (entry.isDirectory()) {
        if (!relDir && EXCLUDED_TOP_DIRS.has(top.toLowerCase())) { excluded.push(`${rel}/`); continue; }
        walk(src, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!relDir && (entry.name === 'manifest.json' || EXCLUDED_TOP_FILE.test(entry.name))) { excluded.push(rel); continue; }
      if (/\.disabled$/i.test(entry.name)) { excluded.push(rel); continue; }
      if (sideByPath.get(rel) === 'client') { excluded.push(rel); continue; }

      const dest = path.join(targetRoot, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      copied += 1;
    }
  }

  walk(modpackRoot, '');
  log(`Modpack : ${copied} fichier(s) copie(s), ${excluded.length} exclu(s) (cote client).\n`);
  return { copied, excluded };
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

// adm-zip est deja une dependance (extraction des installeurs Forge/NeoForge,
// des runtimes Java...) : pas besoin d'un deuxieme paquet zip juste pour
// creer celui-ci. Charge tout en memoire avant d'ecrire (pas de streaming
// disque comme archiver) : sans consequence pour un serveur genere (mods +
// config, pas des Go de mondes).
function zipDirectory(root, zipPath) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addLocalFolder(root);
  return zip.writeZipPromise(zipPath);
}

// --- Generation ------------------------------------------------------------------
async function generateServer(apiDir, serverId, settingsIn, log = () => {}) {
  const server = requireServer(apiDir, serverId);
  const settings = { ...defaultSettings(server), ...settingsIn };
  const warnings = [];

  const outDir = resolveOutDir(apiDir, settings);
  const root = path.join(outDir, serverId);
  const zipPath = path.join(outDir, `${serverId}-server.zip`);

  // Securite : on ne supprime jamais un dossier qu'on n'a pas genere nous-memes,
  // ni un dossier qui a deja servi a faire tourner un serveur (monde !).
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
    if (!fs.existsSync(path.join(root, MARKER))) {
      throw new Error(`Le dossier ${root} existe deja et n'a pas ete genere par cet outil : choisissez un autre dossier de sortie (ou videz-le vous-meme).`);
    }
    const used = RUNTIME_SIGNS.find((n) => fs.existsSync(path.join(root, n)));
    if (used) {
      throw new Error(`Le dossier ${root} contient "${used}" : il a deja servi a faire tourner un serveur, je ne l'ecrase pas. Choisissez un autre dossier de sortie ou supprimez-le vous-meme.`);
    }
    await fsp.rm(root, { recursive: true, force: true });
  }
  await fsp.mkdir(root, { recursive: true });

  log(`Generation du serveur "${server.name || server.id}" dans ${root}\n`);

  // 1) Loader (jar / installeur)
  const plan = await prepareLoader(server, root, log);

  // 2) Fichiers du modpack (mods client exclus)
  let excluded = [];
  if (server.modpackId) {
    const modpackRoot = path.join(apiDir, 'modpacks', server.modpackId);
    if (fs.existsSync(modpackRoot)) {
      const sideByPath = new Map(mcSides.listMods(apiDir, server.modpackId).map((m) => [m.path, m.side]));
      ({ excluded } = copyModpackForServer(modpackRoot, root, sideByPath, log));
    } else {
      warnings.push(`Le dossier du modpack "${server.modpackId}" est introuvable dans api/modpacks/ : aucun mod copie.`);
    }
  } else {
    log('Aucun modpack associe a ce serveur : pas de mods ni de configs.\n');
  }

  // 3) Ajouts propres au serveur (mods serveur-only, ops.json, whitelist.json...)
  if (settings.extrasDir) {
    if (fs.existsSync(settings.extrasDir)) {
      copyTree(settings.extrasDir, root);
      log(`Ajouts serveur copies depuis ${settings.extrasDir}\n`);
    } else {
      warnings.push(`Dossier d'ajouts introuvable : ${settings.extrasDir}`);
    }
  }

  // 4) Installation immediate du loader (si demandee et possible) : le dossier
  // devient directement utilisable sur un hebergeur qui ne sait pas lancer un
  // installeur. Sinon, les scripts l'installeront au premier demarrage.
  const range = javaRange(server, await requiredJavaMajor(server.minecraftVersion));
  const javaText = describeJavaRange(range);
  let preinstalled = false;
  if (plan.kind === 'installer' && settings.preinstall) {
    let java = findJava(range.min, range.max);
    let downloadError = null;
    if (!java) {
      // Aucun Java compatible : on en telecharge un (Temurin) plutot que d'abandonner.
      const major = javaRuntime.pickMajor(range.min, range.max);
      if (major) {
        try {
          java = await javaRuntime.downloadJre(major, runtimesDir(), log);
        } catch (err) {
          downloadError = err.message;
        }
      }
    }
    if (!java) {
      warnings.push(`Aucun Java compatible (${javaText}) sur cette machine${downloadError ? ` et le telechargement automatique a echoue : ${downloadError}` : ''} : le loader sera installe au premier demarrage du serveur.`);
    } else {
      log(`Installation du loader avec Java ${java.major} (${java.exe})...\n`);
      await runInstaller(root, plan, java.exe, log);
      await fsp.writeFile(path.join(root, '.installed'), '');
      // L'installeur laisse son propre jar : inutile une fois installe (sauf Quilt
      // dont le script le relance seulement si le jar de lancement manque).
      if (fs.existsSync(path.join(root, plan.launchJar || '')) || plan.type !== 'quilt') {
        await fsp.rm(path.join(root, plan.installer), { force: true });
      }
      // Le journal de l'installeur ("<installeur>.log") n'a plus d'interet.
      for (const f of fs.readdirSync(root)) if (/-installer\.jar\.log$/i.test(f)) await fsp.rm(path.join(root, f), { force: true });
      preinstalled = true;
    }
  }

  // 5) Fichiers de configuration (ecrits APRES l'installeur, qui peut en creer
  // de similaires et ecraserait les notres).
  await fsp.writeFile(path.join(root, 'server.properties'), buildProperties(server, settings));
  await fsp.writeFile(path.join(root, 'eula.txt'), buildEula(settings.eula));
  await fsp.writeFile(path.join(root, 'jvm-args.txt'), buildJvmArgs(server, settings));
  await fsp.writeFile(path.join(root, 'start-server.sh'), buildStartSh(plan, range), { mode: 0o755 });
  await fsp.writeFile(path.join(root, 'start-server.bat'), buildStartBat(plan, range));
  await fsp.writeFile(path.join(root, 'find-java.ps1'), buildFindJavaPs1());

  const launchCommand = describeLaunch(root, plan, server);
  await fsp.writeFile(path.join(root, 'LISEZMOI-SERVEUR.txt'), buildReadme({ server, settings, plan, javaRange: range, launchCommand, preinstalled, excluded }));
  await fsp.writeFile(path.join(root, MARKER), JSON.stringify({
    generatedAt: new Date().toISOString(),
    serverId,
    minecraftVersion: server.minecraftVersion,
    loader: server.loader || { type: 'vanilla' },
    preinstalled
  }, null, 2));

  if (!settings.eula) warnings.push("EULA non acceptee : eula.txt contient eula=false. Le serveur refusera de demarrer tant que vous n'aurez pas mis eula=true.");

  // 6) Zip
  let zip = null;
  if (settings.makeZip) {
    log('Creation du zip...\n');
    await fsp.rm(zipPath, { force: true });
    await zipDirectory(root, zipPath);
    zip = zipPath;
    log(`Zip cree : ${zipPath} (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} Mo)\n`);
  }

  log('Termine.\n');
  return { root, zipPath: zip, warnings, launchCommand, javaText, preinstalled, excludedCount: excluded.length };
}

// --- Envoi SFTP ------------------------------------------------------------------
function requireSftp(settings) {
  const cfg = settings.sftp || {};
  if (!cfg.host || !cfg.host.trim() || !cfg.username || !cfg.username.trim()) {
    throw new Error('Identifiants SFTP/FTP du serveur Minecraft manquants (hote et utilisateur).');
  }
  if (!settings.remotePath || !settings.remotePath.trim()) throw new Error('Chemin distant du serveur Minecraft manquant.');
  const protocol = normalizeProtocol(cfg.protocol);
  return {
    protocol,
    host: cfg.host.trim(),
    port: Number(cfg.port) || defaultPort(protocol),
    username: cfg.username.trim(),
    password: cfg.password || '',
    remotePath: posixNormalize(settings.remotePath.trim())
  };
}

// Verifie la connexion et l'existence du dossier distant, sans rien ecrire.
async function testSftp(settingsIn) {
  const cfg = requireSftp({ ...settingsIn });
  return withSftp(cfg, async (sftp) => {
    const exists = await sftp.exists(cfg.remotePath);
    if (!exists) return { ok: true, message: `Connexion reussie. Le dossier ${cfg.remotePath} n'existe pas encore : il sera cree a l'envoi.` };
    if (exists !== 'd') return { ok: false, message: `${cfg.remotePath} existe mais n'est pas un dossier.` };
    const entries = await sftp.list(cfg.remotePath);
    return { ok: true, message: `Connexion reussie. Dossier ${cfg.remotePath} : ${entries.length} element(s).` };
  });
}

// Ne supprime JAMAIS rien sur le serveur distant, sauf, si demande
// explicitement, les mods de mods/ absents du dossier genere (le monde et le
// reste du serveur ne sont jamais touches).
async function pushServer(apiDir, serverId, settingsIn, mode, log = () => {}) {
  const server = requireServer(apiDir, serverId);
  const settings = { ...defaultSettings(server), ...settingsIn };
  const cfg = requireSftp(settings);
  const outDir = resolveOutDir(apiDir, settings);
  const root = path.join(outDir, serverId);
  const zipPath = path.join(outDir, `${serverId}-server.zip`);

  if (!fs.existsSync(path.join(root, MARKER))) throw new Error("Generez d'abord le serveur (rien a envoyer).");

  await withSftp(cfg, async (sftp) => {
    log(`Connexion (${cfg.protocol.toUpperCase()}) a ${cfg.username}@${cfg.host}:${cfg.port}...\n`);

    if (mode === 'zip') {
      if (!fs.existsSync(zipPath)) throw new Error("Zip introuvable : regenerez le serveur avec l'option zip.");
      const remoteZip = posixJoin(cfg.remotePath, path.basename(zipPath));
      log(`Envoi de ${path.basename(zipPath)} vers ${remoteZip} ...\n`);
      await uploadFile(sftp, zipPath, remoteZip);
      log('Zip envoye. Extrayez-le depuis votre panel/hebergeur.\n');
      return;
    }

    // Fichiers de config deja presents sur le serveur : on les laisse tels quels.
    const skipRel = new Set();
    if (settings.keepRemoteConfig) {
      for (const name of PROTECTED_REMOTE_FILES) {
        if (fs.existsSync(path.join(root, name)) && await sftp.exists(posixJoin(cfg.remotePath, name))) {
          skipRel.add(name);
          log(`Conserve (deja present sur le serveur) : ${name}\n`);
        }
      }
    }

    const filter = (fullPath) => {
      const rel = path.relative(root, fullPath).split(path.sep).join('/');
      if (skipRel.has(rel)) return false;
      if (settings.mirrorMods && (rel === 'mods' || rel.startsWith('mods/'))) return false; // gere a part
      return true;
    };
    log('Synchronisation des fichiers (fichiers inchanges ignores, aucune suppression)...\n');
    await uploadTree(sftp, root, cfg.remotePath, (p) => log(formatProgress(p)), filter, { skipUnchanged: true, mirror: false });

    if (settings.mirrorMods && fs.existsSync(path.join(root, 'mods'))) {
      log('Synchronisation de mods/ (suppression des mods absents du dossier genere)...\n');
      await uploadTree(sftp, path.join(root, 'mods'), posixJoin(cfg.remotePath, 'mods'), (p) => log(formatProgress(p)), undefined, { skipUnchanged: true, mirror: true });
    }
    log('Envoi termine.\n');
  });
}

module.exports = {
  getSettings, setSettings, defaultSettings, defaultOutDir, resolveOutDir,
  generateServer, pushServer, testSftp, syncWhitelistAccess,
  listMods: mcSides.listMods, setSide: (apiDir, modpackId, relPath, side) => mcSides.setOverride(apiDir, modpackId, relPath, side)
};
