// Demarre/arrete l'API Node en local (utile pour tester une config avant de
// la pousser sur le vrai serveur PufferPanel) : un simple `node src/index.js`
// (execute par le Node embarque) lance dans le dossier api/ selectionne, avec ses logs captures pour
// affichage dans l'app.
const { spawn } = require('child_process');
const { nodeRuntime } = require('./nodeRuntime');

let proc = null;
let logBuffer = [];
let runningSource = null; // 'live' | 'backup' | null
const MAX_LOG_LINES = 500;

function appendLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
}

function isRunning() {
  return proc !== null;
}

function getLog() {
  return logBuffer.join('');
}

function getSource() {
  return runningSource;
}

// `source` ('live' ou 'backup') identifie juste d'ou vient `dir` pour
// l'affichage cote UI (badge) : le process lui-meme tourne pareil, un seul
// a la fois (meme port) quelle que soit son origine.
function startServer(dir, source, onLog = () => {}) {
  if (proc) throw new Error('Le serveur tourne deja.');

  logBuffer = [];
  runningSource = source;
  // Node embarque dans Electron : aucun Node.js a installer sur la machine.
  const runtime = nodeRuntime();
  proc = spawn(runtime.command, ['src/index.js'], { cwd: dir, env: runtime.env, windowsHide: true });

  const handle = (data) => {
    const text = data.toString();
    appendLog(text);
    onLog(text);
  };
  proc.stdout.on('data', handle);
  proc.stderr.on('data', handle);

  proc.on('exit', (code) => {
    appendLog(`\n[process arrete, code ${code}]\n`);
    onLog(`\n[process arrete, code ${code}]\n`);
    proc = null;
    runningSource = null;
  });

  proc.on('error', (err) => {
    appendLog(`\n[erreur au demarrage: ${err.message}]\n`);
    onLog(`\n[erreur au demarrage: ${err.message}]\n`);
    proc = null;
    runningSource = null;
  });
}

function stopServer() {
  if (!proc) return;
  proc.kill();
  proc = null;
  runningSource = null;
}

module.exports = { startServer, stopServer, isRunning, getLog, getSource };
