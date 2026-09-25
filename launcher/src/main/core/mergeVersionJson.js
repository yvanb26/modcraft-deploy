// Resout manuellement le mecanisme "inheritsFrom" des versions Minecraft
// (utilise par Fabric/Quilt) en un unique JSON de version autonome, exploitable
// tel quel par n'importe quel launcher compatible protocole Mojang.
// Regle (identique a celle du launcher officiel) : les tableaux (libraries,
// arguments.game, arguments.jvm) sont concatenes, les autres champs du parent
// sont ecrases par ceux de l'enfant quand ils sont definis.

function libraryKey(lib) {
  // "name" est de la forme groupId:artifactId:version[:classifier]
  const parts = (lib.name || '').split(':');
  return `${parts[0]}:${parts[1]}`;
}

function mergeLibraries(childLibs = [], parentLibs = []) {
  const seen = new Map();
  for (const lib of childLibs) seen.set(libraryKey(lib), lib);
  for (const lib of parentLibs) {
    const key = libraryKey(lib);
    if (!seen.has(key)) seen.set(key, lib);
  }
  return Array.from(seen.values());
}

function mergeArguments(childArgs, parentArgs) {
  if (!childArgs && !parentArgs) return undefined;
  return {
    game: [...(parentArgs?.game || []), ...(childArgs?.game || [])],
    jvm: [...(parentArgs?.jvm || []), ...(childArgs?.jvm || [])]
  };
}

function mergeVersionJson(parent, child) {
  const merged = {
    ...parent,
    ...child,
    id: child.id || parent.id,
    libraries: mergeLibraries(child.libraries, parent.libraries),
    arguments: mergeArguments(child.arguments, parent.arguments),
    // Ces champs doivent toujours venir du parent vanilla : le profil du loader
    // ne les redefinit pas et on ne veut pas perdre assetIndex/downloads.
    assetIndex: parent.assetIndex,
    assets: parent.assets,
    downloads: parent.downloads,
    javaVersion: child.javaVersion || parent.javaVersion
  };
  delete merged.inheritsFrom;
  return merged;
}

module.exports = { mergeVersionJson };
