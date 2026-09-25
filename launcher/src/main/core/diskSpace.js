const { execFileSync } = require('child_process');
const path = require('path');

// Espace libre (en octets) sur le disque contenant `targetPath`. Best-effort :
// retourne null si la detection echoue, plutot que de bloquer quoi que ce
// soit : un avertissement manque, ce n'est jamais bloquant en soi.
//
// Sur Windows, `fsutil volume diskfree` (l'approche la plus evidente)
// necessite en fait des droits administrateur : on utilise donc PowerShell
// `Get-PSDrive`, qui fonctionne sans elevation.
function getFreeBytes(targetPath) {
  try {
    if (process.platform === 'win32') {
      const driveLetter = path.parse(path.resolve(targetPath)).root.replace(/[\\:]/g, '');
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-PSDrive ${driveLetter}).Free`],
        { encoding: 'utf8' }
      );
      const value = Number(out.trim());
      return Number.isFinite(value) ? value : null;
    }

    const out = execFileSync('df', ['-k', targetPath], { encoding: 'utf8' });
    const lines = out.trim().split('\n');
    const cols = lines[lines.length - 1].trim().split(/\s+/);
    const availableKb = Number(cols[3]);
    return Number.isFinite(availableKb) ? availableKb * 1024 : null;
  } catch {
    return null;
  }
}

module.exports = { getFreeBytes };
