// Liste blanche des extensions de fichiers acceptees dans un modpack :
// bloque categoriquement les formats executables (.exe/.bat/.cmd/.ps1/...),
// meme si le dossier source de l'admin en contenait par erreur (ou pire) :
// aucun fichier hors de cette liste n'est jamais copie vers api/modpacks/.
// Couvre les formats reellement utilises par Minecraft (mods, config,
// resourcepacks/shaderpacks, textures, sons, structures) : a completer ici
// (et dans le fichier jumeau du launcher, cf. commentaire plus bas) si un
// format legitime venait a manquer.
const ALLOWED_SUFFIXES = [
  '.jar', '.jar.disabled',
  '.cfg', '.toml', '.json', '.json5', '.properties', '.txt', '.yaml', '.yml', '.xml',
  '.nbt', '.dat', '.dat_old', '.lang', '.ini', '.mrot',
  '.zip',
  '.litematic', '.schematic', '.schem',
  '.png', '.jpg', '.jpeg', '.mcmeta', '.ogg', '.ttf'
];

function isAllowedModpackFile(relPath) {
  const lower = relPath.toLowerCase();
  return ALLOWED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

module.exports = { ALLOWED_SUFFIXES, isAllowedModpackFile };
