// Jumeau de admin/src/main/core/fileAllowlist.js et
// launcher/src/main/core/fileAllowlist.js : garder les trois synchronises.
// Voir ce fichier pour le detail du raisonnement.
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
