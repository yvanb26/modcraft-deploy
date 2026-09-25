// Resume lisible d'un crash a partir de logs/latest.log, pour eviter
// d'afficher au joueur un mur de texte technique (stacktrace Java complet,
// souvent 5-10k lignes sur un gros modpack) quand le jeu se ferme avec un
// code de sortie non-nul. Best-effort : le format des rapports de crash
// n'est pas contractuel (juste du texte imprime par Forge/FML), donc on
// reste tolerant et on retombe sur un message generique si le parsing
// echoue plutot que de faire planter le diagnostic lui-meme.
const fs = require('fs');
const path = require('path');

// Les tres gros modpacks peuvent produire des logs de plusieurs Mo (on en a
// vu un a 1.5 Mo) : inutile de tout charger en memoire, le dernier rapport
// de crash (celui qui a vraiment fait fermer le process) est forcement vers
// la fin du fichier.
const TAIL_BYTES = 400_000;

async function readLogTail(logPath) {
  const stat = await fs.promises.stat(logPath);
  const start = Math.max(0, stat.size - TAIL_BYTES);
  return new Promise((resolve, reject) => {
    const chunks = [];
    fs.createReadStream(logPath, { start })
      .on('data', (c) => chunks.push(c))
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', reject);
  });
}

// Frames a ignorer pour deviner quel mod/composant est en cause : le coeur
// du jeu, Forge/FML et les libs standard ne sont jamais eux-memes "la
// cause", juste le chemin d'appel jusqu'au vrai coupable.
const NOISE_PACKAGE_PREFIXES = [
  'net.minecraft.', 'net.minecraftforge.', 'cpw.mods.', 'com.google.',
  'sun.', 'java.', 'javax.', 'jdk.', 'io.netty.'
];

function guessCulprit(stackLines) {
  for (const line of stackLines) {
    const m = line.match(/^\s*at (\S+)\(/);
    if (!m) continue;
    const frame = m[1];
    if (NOISE_PACKAGE_PREFIXES.some((p) => frame.startsWith(p))) continue;
    // Coupe a l'avant-derniere partie (garde le package, retire juste la
    // methode) : ex: "net.spellcraftgaming.interfaceplus.event.Foo.bar" ->
    // "net.spellcraftgaming.interfaceplus".
    const parts = frame.split('.');
    return parts.slice(0, Math.max(1, parts.length - 2)).join('.');
  }
  return null;
}

// Quelques causes tres frequentes valent un message directement actionnable
// plutot que de juste recracher le nom de l'exception Java.
function knownPatternMessage(text) {
  if (/java\.lang\.OutOfMemoryError/.test(text)) {
    return "Mémoire insuffisante allouée à Java (OutOfMemoryError) : augmentez la RAM dans les réglages de cette installation.";
  }
  if (/Pixel format not accelerated|LWJGL exception.*Pixel Format/i.test(text)) {
    return "Le pilote graphique ne supporte pas l'accélération requise : mettez à jour vos pilotes GPU.";
  }
  if (/UnsupportedClassVersionError/.test(text)) {
    return "Version de Java incompatible avec ce jeu : le launcher aurait dû en installer une compatible automatiquement, contactez le support si ça persiste.";
  }
  return null;
}

// Retourne un resume court (une ou deux phrases) du dernier rapport de crash
// trouve dans logs/latest.log de cette instance, ou null si rien
// d'exploitable n'a ete trouve (log absent, pas de rapport de crash dedans :
// ex: le process a ete tue par un signal sans jamais ecrire de rapport).
async function diagnoseCrash(instanceDir) {
  const logPath = path.join(instanceDir, 'logs', 'latest.log');
  let text;
  try {
    text = await readLogTail(logPath);
  } catch {
    return null;
  }

  const known = knownPatternMessage(text);
  if (known) return known;

  // On prend le DERNIER rapport de crash du fichier (celui qui a vraiment
  // fait fermer le process), pas le premier : un gros modpack peut en
  // logger plusieurs non-fatals avant le vrai (cf. mods qui appellent une
  // API morte et recuperent, comme vu avec les fetch pastebin de JurassiCraft).
  const reportStarts = [...text.matchAll(/---- Minecraft Crash Report ----/g)];
  if (reportStarts.length === 0) return null;
  const lastStart = reportStarts[reportStarts.length - 1].index;
  const report = text.slice(lastStart);

  const descMatch = report.match(/^Description:\s*(.+)$/m);
  const description = descMatch ? descMatch[1].trim() : null;

  const stackLines = report.split('\n').filter((l) => /^\s*at \S+\(/.test(l));
  const culprit = guessCulprit(stackLines);

  const excMatch = report.match(/^([\w.$]+(?:Exception|Error)):?(.*)$/m);
  const exceptionLine = excMatch ? `${excMatch[1]}${excMatch[2] ? ':' + excMatch[2] : ''}`.trim() : null;

  const parts = [];
  if (description && description !== 'Unexpected error') parts.push(description);
  if (exceptionLine) parts.push(exceptionLine);
  if (culprit) parts.push(`probablement lié à : ${culprit}`);

  if (parts.length === 0) return null;
  return parts.join(' | ');
}

module.exports = { diagnoseCrash };
