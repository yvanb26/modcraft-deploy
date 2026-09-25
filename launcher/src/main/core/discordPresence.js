// Discord Rich Presence ("Joue sur <serveur>") : entierement best-effort :
// si Discord n'est pas installe/lance, ou si `discord-rpc` echoue pour
// n'importe quelle raison, on avale l'erreur silencieusement. Ce n'est
// qu'un gadget cosmetique, ca ne doit jamais empecher de jouer.
let RPC = null;
try {
  RPC = require('discord-rpc');
} catch {
  RPC = null; // dependance absente : desactive silencieusement la fonctionnalite
}

let client = null;
let connectedClientId = null;

async function disconnect() {
  if (client) {
    try {
      await client.destroy();
    } catch {
      // rien a faire
    }
  }
  client = null;
  connectedClientId = null;
}

async function ensureConnected(clientId) {
  if (!RPC || !clientId) return null;
  if (client && connectedClientId === clientId) return client;

  await disconnect();
  try {
    const newClient = new RPC.Client({ transport: 'ipc' });
    await newClient.login({ clientId });
    client = newClient;
    connectedClientId = clientId;
    return client;
  } catch {
    client = null;
    connectedClientId = null;
    return null;
  }
}

async function setPresence(clientId, { details, state, startTimestamp } = {}) {
  const c = await ensureConnected(clientId);
  if (!c) return;
  try {
    await c.setActivity({ details, state, startTimestamp, instance: false });
  } catch {
    // best-effort
  }
}

async function clearPresence() {
  if (!client) return;
  try {
    await client.clearActivity();
  } catch {
    // best-effort
  }
}

module.exports = { setPresence, clearPresence, disconnect };
