// Lecture / ecriture d'UN fichier texte chez l'hebergeur du serveur Minecraft, en SFTP (SSH), FTP ou FTPS.
// Sert a la whitelist des serveurs hors ligne (cf. whitelist.js) : l'API et le serveur Minecraft sont
// souvent dans des conteneurs separes, mais tous les hebergeurs donnent un acces SFTP ou FTP : le meme
// que l'outil admin utilise deja pour envoyer le serveur.
const SftpClient = require('ssh2-sftp-client');
const ftp = require('basic-ftp');
const { Readable, Writable } = require('stream');

const DEFAULT_PORTS = { sftp: 22, ftp: 21, ftps: 21 };

function normalizeProtocol(protocol) {
  return protocol in DEFAULT_PORTS ? protocol : 'sftp';
}

// Chemins distants toujours en "/" (meme depuis Windows).
function joinRemote(dir, name) {
  return `${String(dir).replace(/\/+$/, '')}/${name}`;
}

// Ouvre la connexion, execute `fn({ read, write })`, referme toujours proprement.
// read()  -> texte du fichier, ou null s'il n'existe pas
// write() -> remplace le contenu du fichier
async function withRemoteFile(access, fileName, fn) {
  const protocol = normalizeProtocol(access.protocol);
  const port = Number(access.port) || DEFAULT_PORTS[protocol];
  const remote = joinRemote(access.remotePath, fileName);

  if (protocol === 'sftp') {
    const sftp = new SftpClient();
    try {
      await sftp.connect({ host: access.host, port, username: access.username, password: access.password, readyTimeout: 10000 });
      return await fn({
        read: async () => ((await sftp.exists(remote)) ? (await sftp.get(remote)).toString('utf8') : null),
        write: (text) => sftp.put(Buffer.from(text, 'utf8'), remote)
      });
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  const client = new ftp.Client(15000);
  try {
    await client.access({
      host: access.host,
      port,
      user: access.username,
      password: access.password || '',
      // FTPS : TLS explicite par defaut, implicite sur le port 990 (comme l'outil admin).
      secure: protocol === 'ftps' ? (port === 990 ? 'implicit' : true) : false
    });
    return await fn({
      read: async () => {
        const chunks = [];
        const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
        try {
          await client.downloadTo(sink, remote);
        } catch (err) {
          if (err.code === 550) return null; // fichier absent
          throw err;
        }
        return Buffer.concat(chunks).toString('utf8');
      },
      write: (text) => client.uploadFrom(Readable.from([Buffer.from(text, 'utf8')]), remote)
    });
  } finally {
    client.close();
  }
}

module.exports = { withRemoteFile };
