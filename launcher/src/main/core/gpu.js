const { execFileSync, spawnSync } = require('child_process');
const { app } = require('electron');

// Identifiants PCI standards des principaux fabricants : utilises pour
// deviner laquelle des cartes detectees est "integree" (Intel) vs "dediee"
// (NVIDIA/AMD), et pour proposer un nom de repli quand le pilote ne fournit
// pas de description precise.
const INTEL_VENDOR_ID = 32902; // 0x8086
const VENDOR_NAMES = {
  32902: 'Intel',
  4318: 'NVIDIA',
  4098: 'AMD'
};

// Applique une preference de GPU (carte dediee/integree/auto) pour le
// processus java qui va etre lance. Best-effort : toute erreur est avalee,
// une mauvaise config GPU ne doit jamais empecher le jeu de se lancer.
//
// - Windows : le mecanisme officiel est une cle de registre associant le
//   chemin EXACT de l'executable a une preference ("GpuPreference=1;" pour
//   economie d'energie/integree, "=2;" pour performances/dediee) : c'est ce
//   que fait le panneau "Parametres graphiques" de Windows lui-meme, et donc
//   ce que la plupart des launchers tiers utilisent. Necessite un chemin
//   absolu vers java.exe (on tente de le resoudre via `where` si besoin).
// - Linux : pas d'equivalent registre, on renvoie plutot des variables
//   d'environnement standard (offloading Prime pour laptops hybrides
//   NVIDIA/AMD) que l'appelant doit fusionner dans l'env du process lance.
// - macOS : pas de mecanisme equivalent exploitable simplement, no-op.
function resolveAbsoluteJavaPath(javaPath) {
  const path = require('path');
  if (path.isAbsolute(javaPath)) return javaPath;

  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(finder, [javaPath], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).find((line) => line.trim());
    return first ? first.trim() : null;
  } catch {
    return null; // java pas trouve dans le PATH : on laissera echouer plus loin normalement
  }
}

// Le "java" du PATH est souvent un shim (ex: Oracle
// `Common Files\Oracle\Java\java8path\javaw.exe`) qui relance en fait le vrai
// JRE installe ailleurs. Windows applique la preference GPU au chemin du
// processus REEL, pas a celui du shim : ecrire la cle uniquement sur le shim
// laisse donc le jeu tourner sur la carte integree. On demande donc a la JVM
// elle-meme ou est son `java.home`, et on applique la preference a
// l'executable reel en plus du chemin fourni.
function realJavaExecutables(javaPath) {
  const path = require('path');
  const fs = require('fs');
  const found = new Set([javaPath]);

  try {
    const result = spawnSync(javaPath, ['-XshowSettings:properties', '-version'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true
    });
    const home = `${result.stdout || ''}${result.stderr || ''}`.match(/^\s*java\.home = (.+)$/m)?.[1]?.trim();
    if (home) {
      const exeName = path.basename(javaPath);
      // JDK 8 : java.home pointe sur `<jdk>\jre`, mais le processus qui tourne
      // est `<jdk>\bin\javaw.exe` (le parent), pas `<jdk>\jre\bin\javaw.exe`.
      const dirs = path.basename(home).toLowerCase() === 'jre' ? [home, path.dirname(home)] : [home];
      for (const dir of dirs) {
        const exe = path.join(dir, 'bin', exeName);
        if (fs.existsSync(exe)) found.add(exe);
      }
    }
  } catch {
    // best-effort : on se contente du chemin fourni
  }

  return [...found];
}

function applyWindowsGpuPreference(javaPath, preference) {
  const absoluteJava = resolveAbsoluteJavaPath(javaPath);
  if (!absoluteJava) return;

  const regKey = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
  const value = preference === 'dedicated' ? 'GpuPreference=2;' : 'GpuPreference=1;';

  for (const exe of realJavaExecutables(absoluteJava)) {
    try {
      if (preference === 'auto') {
        execFileSync('reg', ['delete', regKey, '/v', exe, '/f'], { stdio: 'ignore' });
      } else {
        execFileSync('reg', ['add', regKey, '/v', exe, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore' });
      }
    } catch {
      // best-effort : on ignore (ex: valeur absente lors d'un `delete`)
    }
  }
}

function linuxGpuEnv(preference) {
  if (preference === 'dedicated') {
    return { DRI_PRIME: '1', __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia' };
  }
  if (preference === 'integrated') {
    return { DRI_PRIME: '0' };
  }
  return {};
}

// Retourne les variables d'environnement (le cas echeant) a fusionner dans
// l'env du process java qui sera lance. Applique aussi, en effet de bord,
// la preference GPU au niveau du systeme quand c'est le mecanisme utilise
// (registre Windows).
//
// Important : en "auto", on NE laisse PAS Windows decider seul. Un
// executable generique comme java.exe est tres souvent classe par defaut
// sur le GPU integre (economie d'energie) par Windows sur les machines a
// double carte graphique : sauf si l'utilisateur l'a deja associe
// manuellement aux "Performances elevees". C'est exactement ce qui cause un
// Minecraft a 2 FPS avec ce launcher alors que TLauncher (et la plupart des
// launchers tiers) tourne bien : eux forcent activement la carte dediee par
// defaut plutot que de s'en remettre au choix de Windows. Donc "auto" ici
// signifie "dediee si une carte dediee est detectee", pas "laisser Windows
// choisir".
async function applyGpuPreference(javaPath, preference = 'auto') {
  let effective = preference;
  if (effective === 'auto') {
    const { dedicated } = await listGpus();
    effective = dedicated ? 'dedicated' : 'auto';
  }

  if (process.platform === 'win32') {
    applyWindowsGpuPreference(javaPath, effective);
    return {};
  }
  if (process.platform === 'linux') {
    return linuxGpuEnv(effective);
  }
  return {};
}

// Detecte le nom des cartes graphiques presentes, pour les afficher dans le
// menu "Performances (dediee)" / "Economie d'energie (integree)" du
// launcher. Necessite `getGPUInfo('complete')` : la variante `basic` ne
// renvoie que vendorId/deviceId, sans nom lisible (cf. doc Electron).
function friendlyDeviceName(device) {
  if (device.deviceString) return device.deviceString;
  const vendor = VENDOR_NAMES[device.vendorId] || `Vendeur inconnu (${device.vendorId})`;
  return device.deviceId ? `${vendor} (peripherique ${device.deviceId})` : vendor;
}

async function listGpus() {
  try {
    const info = await app.getGPUInfo('complete');
    const devices = (info.gpuDevice || []).filter((d) => d && typeof d.vendorId === 'number');

    const integrated = devices.find((d) => d.vendorId === INTEL_VENDOR_ID);
    const dedicated = devices.find((d) => d.vendorId !== INTEL_VENDOR_ID);

    return {
      integrated: integrated ? friendlyDeviceName(integrated) : null,
      dedicated: dedicated ? friendlyDeviceName(dedicated) : null
    };
  } catch {
    return { integrated: null, dedicated: null };
  }
}

module.exports = { applyGpuPreference, listGpus };
