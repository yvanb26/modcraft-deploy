const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { fetchVanillaVersionJson } = require('../mojangVersions');
const { mergeVersionJson } = require('../mergeVersionJson');
const { versionsDir } = require('../paths');

const META_URLS = {
  fabric: (mc, loader) => `https://meta.fabricmc.net/v2/versions/loader/${mc}/${loader}/profile/json`,
  quilt: (mc, loader) => `https://meta.quiltmc.org/v3/versions/loader/${mc}/${loader}/profile/json`
};

// Prepare (telecharge + fusionne) une version Fabric ou Quilt et retourne
// l'identifiant de version pret a etre utilise via mclc `version.custom`.
async function prepareFabricLike(type, mcVersion, loaderVersion) {
  const buildMetaUrl = META_URLS[type];
  if (!buildMetaUrl) throw new Error(`Loader non supporte par ce module: ${type}`);

  const customId = `${type}-${mcVersion}-${loaderVersion}`;
  const targetDir = path.join(versionsDir(), customId);
  const targetJsonPath = path.join(targetDir, `${customId}.json`);

  if (fs.existsSync(targetJsonPath)) {
    return customId; // deja prepare lors d'un lancement precedent
  }

  const [vanillaJson, loaderRes] = await Promise.all([
    fetchVanillaVersionJson(mcVersion),
    fetch(buildMetaUrl(mcVersion, loaderVersion))
  ]);

  if (!loaderRes.ok) {
    throw new Error(
      `Impossible de recuperer le profil ${type} pour Minecraft ${mcVersion} / loader ${loaderVersion} (${loaderRes.status}).`
    );
  }
  const loaderJson = await loaderRes.json();

  const merged = mergeVersionJson(vanillaJson, { ...loaderJson, id: customId });

  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(targetJsonPath, JSON.stringify(merged, null, 2));

  return customId;
}

module.exports = { prepareFabricLike };
