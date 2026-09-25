// Connexion a un hebergeur en SFTP (SSH), FTP ou FTPS, derriere UNE seule interface.
//
// Tout le code d'envoi (sftpTransfer.js, deploy.js, mcServer.js) a ete ecrit
// pour l'API de `ssh2-sftp-client`. Plutot que de le reecrire pour le FTP, on
// donne au FTP un adaptateur qui expose les MEMES methodes (connect, list,
// exists, mkdir, fastPut, get, delete, end) : SFTP et FTP sont deux protocoles
// differents (changer le port ne suffit pas), mais du point de vue de l'appelant
// ils se ressemblent : la synchronisation, le "diff", la protection des
// reglages distants, etc. fonctionnent donc identiquement sur les deux.
const SftpClient = require('ssh2-sftp-client');
const ftp = require('basic-ftp');
const { Writable } = require('stream');

const PROTOCOLS = ['sftp', 'ftp', 'ftps'];
const DEFAULT_PORTS = { sftp: 22, ftp: 21, ftps: 21 };

function normalizeProtocol(protocol) {
  return PROTOCOLS.includes(protocol) ? protocol : 'sftp';
}

function defaultPort(protocol) {
  return DEFAULT_PORTS[normalizeProtocol(protocol)];
}

// Adaptateur : expose l'API "SFTP" au-dessus d'un client FTP/FTPS.
class FtpSession {
  constructor(config) {
    this.config = config;
    this.client = new ftp.Client(30000);
  }

  async connect() {
    const { protocol, host, username, password } = this.config;
    const port = Number(this.config.port) || defaultPort(protocol);
    await this.client.access({
      host,
      port,
      user: username,
      password: password || '',
      // FTPS : TLS explicite (AUTH TLS) par defaut, implicite sur le port 990.
      // Le certificat est verifie : un hebergeur au certificat auto-signe sera refuse.
      secure: protocol === 'ftps' ? (port === 990 ? 'implicit' : true) : false
    });
  }

  // mkdir(chemin, true) : cree tous les dossiers manquants, sans erreur s'ils existent.
  async mkdir(remotePath) {
    await this.client.ensureDir(remotePath);
    await this.client.cd('/'); // ensureDir change de dossier courant ; tous nos chemins sont absolus
  }

  async list(remotePath) {
    const items = await this.client.list(remotePath);
    return items.map((item) => ({
      name: item.name,
      type: item.type === ftp.FileType.Directory ? 'd' : '-',
      size: item.size,
      modifyTime: item.modifiedAt ? item.modifiedAt.getTime() : 0
    }));
  }

  // Comme ssh2-sftp-client : 'd' (dossier), '-' (fichier) ou false (absent).
  async exists(remotePath) {
    const cwd = await this.client.pwd();
    try {
      await this.client.cd(remotePath);
      await this.client.cd(cwd);
      return 'd';
    } catch { /* pas un dossier */ }
    try {
      await this.client.size(remotePath);
      return '-';
    } catch { /* absent */ }
    return false;
  }

  async fastPut(localPath, remotePath, options = {}) {
    if (options.step) this.client.trackProgress((info) => options.step(info.bytes));
    try {
      await this.client.uploadFrom(localPath, remotePath);
    } finally {
      this.client.trackProgress();
    }
  }

  async get(remotePath) {
    const chunks = [];
    const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    await this.client.downloadTo(sink, remotePath);
    return Buffer.concat(chunks);
  }

  async delete(remotePath) {
    await this.client.remove(remotePath);
  }

  async end() {
    this.client.close();
  }
}

// Ouvre la connexion, execute `fn(client)`, referme toujours proprement.
async function withRemote(config, fn) {
  const protocol = normalizeProtocol(config.protocol);

  if (protocol === 'sftp') {
    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: config.host,
        port: Number(config.port) || DEFAULT_PORTS.sftp,
        username: config.username,
        password: config.password
      });
      return await fn(sftp);
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  const session = new FtpSession({ ...config, protocol });
  try {
    await session.connect();
    return await fn(session);
  } finally {
    await session.end();
  }
}

module.exports = { withRemote, FtpSession, normalizeProtocol, defaultPort, PROTOCOLS };
