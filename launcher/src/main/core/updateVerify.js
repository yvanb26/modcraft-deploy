// Verification de la signature d'une mise a jour AVANT son telechargement (electron-updater ne verifie que l'empreinte
// sha512 indiquee dans latest.yml : si le serveur des mises a jour est pirate, le pirate publie aussi son propre
// latest.yml). latest.yml est donc signe (Ed25519) avec une cle privee gardee sur le PC de l'editeur
// (scripts/sign-update.js) ; l'application n'accepte que ce qui est signe par la cle publique qu'elle embarque.
//
// Chaine de confiance : signature valide sur latest.yml -> version + sha512 de l'installateur -> electron-updater
// telecharge l'installateur et verifie sa sha512. On exige que la mise a jour proposee par electron-updater soit
// EXACTEMENT celle decrite par le fichier signe.
const crypto = require('crypto');

function field(yml, name) {
  return new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'm').exec(yml)?.[1]?.replace(/^['"]|['"]$/g, '');
}

async function verifySignedUpdate({ feedUrl, publicKey, info, fetchImpl = fetch }) {
  const base = String(feedUrl).replace(/\/+$/, '');
  let ymlRes;
  let sigRes;
  try {
    [ymlRes, sigRes] = await Promise.all([
      fetchImpl(`${base}/latest.yml`, { signal: AbortSignal.timeout(10000) }),
      fetchImpl(`${base}/latest.yml.sig`, { signal: AbortSignal.timeout(10000) })
    ]);
  } catch (err) {
    return { ok: false, reason: `serveur des mises a jour injoignable (${err.message})` };
  }
  if (!ymlRes.ok) return { ok: false, reason: `latest.yml introuvable (HTTP ${ymlRes.status})` };
  if (!sigRes.ok) return { ok: false, reason: `latest.yml.sig introuvable (HTTP ${sigRes.status}) : mise a jour non signee` };

  const yml = Buffer.from(await ymlRes.arrayBuffer());
  const signature = Buffer.from((await sigRes.text()).trim(), 'base64');
  let valid = false;
  try {
    valid = crypto.verify(null, yml, crypto.createPublicKey(publicKey), signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'signature invalide : latest.yml n\'a pas ete signe avec la cle de l\'editeur' };

  const text = yml.toString('utf8');
  const version = field(text, 'version');
  const sha512 = field(text, 'sha512');
  if (!version || !sha512) return { ok: false, reason: 'latest.yml signe mais incomplet (version ou sha512 absents)' };
  const offeredSha = info.sha512 || info.files?.[0]?.sha512;
  if (info.version !== version || offeredSha !== sha512) {
    return { ok: false, reason: `la mise a jour proposee (${info.version}) ne correspond pas au latest.yml signe (${version})` };
  }
  return { ok: true, version };
}

module.exports = { verifySignedUpdate };
