// Jumeau de admin/src/main/core/fileAllowlist.js et
// api/scripts/fileAllowlist.js : garder les trois synchronises. Deuxieme
// ligne de defense (la premiere est cote admin, a l'import du modpack) :
// meme si un manifest distant en venait a referencer un fichier hors liste
// (manifest altere, ancien manifest genere avant ce filtre...), le launcher
// refuse de l'ecrire sur le disque du joueur.
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
