const net = require('net');

// Implementation du protocole "Server List Ping" (1.7+) : c'est le meme
// mecanisme que celui utilise par le menu multijoueur du launcher officiel
// pour afficher le statut/nombre de joueurs d'un serveur : fonctionne sur
// n'importe quel serveur vanilla/Forge/Fabric/NeoForge des lors qu'il tourne
// sur une version >= 1.7, sans configuration particuliere cote serveur.

function writeVarInt(value) {
  const bytes = [];
  let v = value;
  do {
    let temp = v & 0b01111111;
    v >>>= 7;
    if (v !== 0) temp |= 0b10000000;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function writeString(str) {
  const strBuf = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(strBuf.length), strBuf]);
}

function writeUShort(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value, 0);
  return buf;
}

function packPacket(...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([writeVarInt(body.length), body]);
}

// Lit un VarInt dans `buffer` a partir de `offset`. Retourne null si le
// buffer ne contient pas encore assez d'octets (on attend la suite).
function readVarInt(buffer, offset) {
  let value = 0;
  let position = 0;
  let i = offset;
  while (true) {
    if (i >= buffer.length) return null;
    const currentByte = buffer[i];
    value |= (currentByte & 0x7f) << position;
    i++;
    if ((currentByte & 0x80) === 0) break;
    position += 7;
    if (position >= 32) throw new Error('VarInt trop long');
  }
  return { value, length: i - offset };
}

// Interroge un serveur Minecraft et retourne { online, players: {online, max} }
// (ou { online: false } si injoignable/timeout/erreur de protocole).
function pingServer(host, port = 25565, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish({ online: false }));
    socket.on('error', () => finish({ online: false }));

    socket.connect(port, host, () => {
      const handshake = packPacket(
        writeVarInt(0x00),
        writeVarInt(47), // version de protocole : ignoree par le serveur pour une requete de statut
        writeString(host),
        writeUShort(port),
        writeVarInt(1) // next state: status
      );
      const statusRequest = packPacket(writeVarInt(0x00));
      socket.write(Buffer.concat([handshake, statusRequest]));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      const lenInfo = readVarInt(buffer, 0);
      if (!lenInfo) return;
      const totalPacketLength = lenInfo.length + lenInfo.value;
      if (buffer.length < totalPacketLength) return; // paquet incomplet, on attend la suite

      try {
        let offset = lenInfo.length;
        const idInfo = readVarInt(buffer, offset);
        offset += idInfo.length;
        const strLenInfo = readVarInt(buffer, offset);
        offset += strLenInfo.length;
        const jsonStr = buffer.toString('utf8', offset, offset + strLenInfo.value);

        const status = JSON.parse(jsonStr);
        finish({
          online: true,
          players: {
            online: status.players?.online ?? 0,
            max: status.players?.max ?? 0
          }
        });
      } catch {
        finish({ online: false });
      }
    });
  });
}

module.exports = { pingServer };
