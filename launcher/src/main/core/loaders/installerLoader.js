// Forge : deux familles d'installeurs bien differentes a gerer.
//
// - Forge "moderne" (grosso modo 1.13+, y compris les builds recents de
//   1.12.2) : l'installeur contient un `version.json` pret a l'emploi.
//   minecraft-launcher-core (mclc) sait le lire nativement et gerer les
//   etapes de patch binaire via ForgeWrapper : on lui passe simplement le
//   chemin du jar via l'option `forge:`.
//
// - Forge "legacy" (jusqu'a ~1.12.2, dont 1.7.10) : l'installeur n'a JAMAIS
//   de `version.json` separe, seulement un `install_profile.json` avec le
//   JSON de version embarque dans son champ "versionInfo". Deux pieges :
//     1) Passer quand meme ce jar a mclc via `forge:` echoue silencieusement
//        (mclc s'attend a `version.json`, catch l'erreur, retombe en pur
//        vanilla : aucune erreur visible, juste le mauvais jeu qui se lance).
//     2) Meme en contournant ca, mclc ajoute TOUJOURS le jar de l'installeur
//        sur le classpath quand `forge:` est utilise (pense pour le cas
//        ForgeWrapper moderne). Pour du Forge legacy ce jar n'est pas
//        necessaire au runtime et pollue le classpath avec ses propres
//        classes internes (dont son propre jopt-simple, incompatible avec
//        celui attendu par LaunchWrapper) -> `NoSuchMethodError`.
//   On construit donc nous-memes le JSON de version fusionne (vanilla +
//   versionInfo, meme mecanisme que pour Fabric/Quilt via mergeVersionJson)
//   et on le fait tourner via `version.custom`, sans jamais toucher a
//   l'option `forge:` : exactement comme le font les launchers tiers.
//
// NeoForge n'est pas concerne par tout ca (fork recent, mainClass et
// structure differents de Forge) : on garde pour lui l'execution silencieuse
// de l'installeur officiel (--installClient), qui fonctionne car les
// installeurs NeoForge sont tous "modernes" (post-1.20, CLI supportee).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');

const { gameRoot, versionsDir, instanceDir } = require('../paths');
const { fetchVanillaVersionJson } = require('../mojangVersions');
const { mergeVersionJson } = require('../mergeVersionJson');

async function downloadToFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Impossible de telecharger l'installeur (${url}) : HTTP ${res.status}`);
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
}

// Le maven officiel de Forge nomme certaines vieilles versions (dont la
// plupart des builds 1.7.10) avec un suffixe de branche qui repete la version
// MC (ex: "1.7.10-10.13.4.1614-1.7.10"), en plus de la forme "simple". On
// teste les candidats les plus probables et on prend le premier qui existe.
async function resolveInstallerUrl(candidates) {
  const failures = [];
  for (const url of candidates) {
    const res = await fetch(url, { method: 'HEAD' });
    if (res.ok) return url;
    failures.push(`${url} (HTTP ${res.status})`);
  }
  throw new Error(`Installeur introuvable. URLs testees:\n${failures.join('\n')}`);
}

async function downloadCached(url, cacheFileName) {
  const destPath = path.join(gameRoot(), 'installers', cacheFileName);
  if (!fs.existsSync(destPath)) {
    await downloadToFile(url, destPath);
  }
  return destPath;
}

// "groupId:artifactId:version[:classifier]" -> chemin maven standard.
function mavenCoordToPath(coord) {
  const [group, artifact, version, classifier] = coord.split(':');
  const dir = `${group.replace(/\./g, '/')}/${artifact}/${version}`;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${dir}/${file}`;
}

// Les libraries des vieux installeurs Forge n'ont pas le format moderne
// `downloads.artifact.{path,url}` : juste un `name` et, parfois, un `url`
// explicite ou des flags serverreq/clientreq indiquant qu'elle est
// necessaire et telechargeable depuis le mirroir officiel de Mojang.
function resolveLegacyLibraryUrl(lib) {
  if (lib.url) return lib.url;
  if (lib.serverreq || lib.clientreq) return 'https://libraries.minecraft.net/';
  return null;
}

// Convertit une library au format legacy en format moderne exploitable par
// mclc. `coordOverride` sert pour le jar Forge lui-meme, dont le nom reel sur
// le maven inclut un classifier ":universal" absent du `name` original.
function toModernLibrary(lib, coordOverride) {
  const url = resolveLegacyLibraryUrl(lib);
  if (!url) return null;
  const coord = coordOverride || lib.name;
  const libPath = mavenCoordToPath(coord);
  return { name: coord, downloads: { artifact: { path: libPath, url: `${url}${libPath}` } } };
}

// OptiFine (pour les vieilles versions type 1.7.10) ne se charge pas comme
// un mod FML normal, mais comme un second tweakClass de LaunchWrapper :
// exactement le mecanisme que TLauncher utilise pour ses versions
// "ForgeOptiFine" (verifie directement dans un de ses profils "1.7.10 HD U
// E7" reels). C'est pour ca qu'OptiFine n'apparait jamais dans la liste des
// mods FML au crash : il n'est pas charge par ce mecanisme.
//
// Le jar OptiFine lui-meme ne peut pas etre telecharge depuis une URL
// publique (licence + protection anti-lien-direct d'optifine.net) : on
// s'attend a ce qu'il soit deja fourni comme un fichier normal du modpack :
// une seule fois par l'operateur, ensuite entierement automatique pour tous
// les joueurs. On le retrouve tout seul dans optifine/ (`modsFile` reste
// possible pour lever toute ambiguite si plusieurs fichiers correspondent)
// et on le recopie au bon endroit dans libraries/.
//
// IMPORTANT : le jar doit vivre dans optifine/, PAS dans mods/. S'il reste
// dans mods/ en plus d'etre fusionne ici, FML le charge une deuxieme fois
// comme un mod normal (en plus du tweakClass ci-dessous) : c'est ce double
// chargement qui produit le crash "OptiFine is installed. This is NOT
// supported." au lancement, meme avec une config par ailleurs identique a un
// profil TLauncher qui fonctionne (lui ne l'a jamais dans mods/, seulement
// dans libraries/, cf. ses propres profils "ForgeOptiFine").
function findOptifineFile(optifineDir, version) {
  if (!fs.existsSync(optifineDir)) return null;
  const needle = version.toLowerCase();
  const match = fs.readdirSync(optifineDir).find((name) => {
    const lower = name.toLowerCase();
    return lower.includes('optifine') && lower.includes(needle);
  });
  return match || null;
}

function mergeOptifine(merged, server) {
  const optifine = server?.optifine;
  if (!optifine?.version) return;

  const base = instanceDir(server.id);
  const optifineDir = path.join(base, 'optifine');
  const modsFile = optifine.modsFile || findOptifineFile(optifineDir, optifine.version);
  if (!modsFile) {
    throw new Error(
      `OptiFine (${optifine.version}) configure pour ce serveur mais aucun fichier correspondant trouve dans optifine/ : ` +
      `verifiez qu'il a bien ete depose dans le modpack (dossier optifine/, PAS mods/) et synchronise.`
    );
  }

  const sourcePath = path.join(optifineDir, modsFile);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `OptiFine configure pour ce serveur (${modsFile}) mais introuvable dans le modpack synchronise : ` +
      `verifiez qu'il est bien present dans optifine/ et dans le manifest.`
    );
  }

  // Garde-fou : si le meme jar traine aussi dans mods/ (config TLauncher/
  // ancien modpack copiee telle quelle, ou operateur qui l'a mis au mauvais
  // endroit par habitude), FML le chargerait en double : crash garanti et
  // difficile a diagnostiquer pour le joueur. Autant le refuser tout de
  // suite avec un message clair plutot que de laisser planter en jeu.
  const modsDir = path.join(base, 'mods');
  if (fs.existsSync(modsDir)) {
    const duplicate = fs.readdirSync(modsDir).find((name) => name.toLowerCase() === modsFile.toLowerCase());
    if (duplicate) {
      throw new Error(
        `OptiFine (${modsFile}) est present a la fois dans optifine/ et dans mods/ : retirez-le de mods/ ` +
        `(il ne doit exister que dans optifine/, sinon FML le charge deux fois et le jeu plante).`
      );
    }
  }

  const libCoord = `optifine:OptiFine:${optifine.version}`;
  const libPath = mavenCoordToPath(libCoord);
  const destPath = path.join(gameRoot(), 'libraries', libPath);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);

  merged.libraries.push({ name: libCoord });
  merged.minecraftArguments = `${merged.minecraftArguments} --tweakClass optifine.OptiFineForgeTweaker`;
}

// Construit et ecrit le JSON de version fusionne (vanilla + Forge legacy,
// + OptiFine si configure pour ce serveur) et retourne son identifiant, pret
// a etre utilise via mclc `version.custom`.
async function prepareLegacyForgeVersion(mcVersion, versionInfo, customId, server) {
  const targetDir = path.join(versionsDir(), customId);
  const targetJsonPath = path.join(targetDir, `${customId}.json`);

  if (fs.existsSync(targetJsonPath)) {
    return customId; // deja prepare lors d'un lancement precedent
  }

  const vanillaJson = await fetchVanillaVersionJson(mcVersion);

  const libraries = versionInfo.libraries
    .map((lib, i) => {
      const isForgeJarItself = i === 0 && lib.name.includes('minecraftforge:forge') && !lib.name.includes('universal');
      return toModernLibrary(lib, isForgeJarItself ? `${lib.name}:universal` : undefined);
    })
    .filter(Boolean);

  const merged = mergeVersionJson(vanillaJson, { ...versionInfo, id: customId, libraries });
  mergeOptifine(merged, server);

  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(targetJsonPath, JSON.stringify(merged, null, 2));
  return customId;
}

// Retourne { version, forge? } : pour du Forge moderne, `forge` pointe vers
// l'installeur telecharge (mclc gere tout nativement) ; pour du Forge
// legacy, `version.custom` pointe vers notre JSON fusionne maison.
// `server` (optionnel) porte `server.optifine` pour fusionner OptiFine.
async function prepareForge(mcVersion, forgeVersion, server) {
  const candidates = [`${mcVersion}-${forgeVersion}`, `${mcVersion}-${forgeVersion}-${mcVersion}`].map((full) => ({
    full,
    url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`
  }));

  const resolvedUrl = await resolveInstallerUrl(candidates.map((c) => c.url));
  const resolved = candidates.find((c) => c.url === resolvedUrl);
  const installerPath = await downloadCached(resolved.url, `forge-${resolved.full}-installer.jar`);

  const zip = new AdmZip(installerPath);
  if (zip.getEntry('version.json')) {
    return { version: { number: mcVersion, type: 'release' }, forge: installerPath };
  }

  const profileEntry = zip.getEntry('install_profile.json');
  if (!profileEntry) {
    throw new Error("Installeur Forge invalide : ni version.json ni install_profile.json trouve dans le jar.");
  }
  const profile = JSON.parse(zip.readAsText(profileEntry));
  if (!profile.versionInfo) {
    throw new Error("Installeur Forge d'un format inattendu : install_profile.json ne contient pas de champ versionInfo.");
  }

  // Le suffixe OptiFine distingue ce profil fusionne de la version "Forge
  // seul" deja mise en cache lors d'un lancement precedent (sinon on
  // risquerait de reutiliser un JSON fige sans OptiFine si la config a
  // change depuis).
  const baseId = profile.versionInfo.id || `forge-${resolved.full}`;
  const customId = server?.optifine?.version ? `${baseId}-OptiFine_${server.optifine.version}` : baseId;
  await prepareLegacyForgeVersion(mcVersion, profile.versionInfo, customId, server);
  return { version: { number: mcVersion, type: 'release', custom: customId } };
}

function listVersionFolders() {
  try {
    return fs.readdirSync(versionsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function runInstallerHeadless(installerPath, javaPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaPath, ['-jar', installerPath, '--installClient', gameRoot()], {
      cwd: path.dirname(installerPath)
    });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`L'installeur a echoue (code ${code}). ${stderr.slice(-500)}`));
    });
  });
}

async function prepareNeoForge(neoforgeVersion, javaPath = 'java') {
  const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoforgeVersion}/neoforge-${neoforgeVersion}-installer.jar`;
  const installerPath = await downloadCached(url, `neoforge-${neoforgeVersion}-installer.jar`);

  const before = new Set(listVersionFolders());
  await runInstallerHeadless(installerPath, javaPath);
  const after = listVersionFolders();
  const created = after.filter((name) => !before.has(name));

  if (created.length === 0) {
    throw new Error("L'installeur s'est termine mais aucune nouvelle version n'a ete detectee dans versions/.");
  }
  // En cas d'ambiguite, on prend la plus recente (mtime).
  created.sort((a, b) => {
    const statA = fs.statSync(path.join(versionsDir(), a)).mtimeMs;
    const statB = fs.statSync(path.join(versionsDir(), b)).mtimeMs;
    return statB - statA;
  });
  return created[0];
}

module.exports = { prepareForge, prepareNeoForge };
