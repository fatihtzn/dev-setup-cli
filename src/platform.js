const os = require('os');
const { execSync } = require('child_process');

function getPlatform() {
  const p = os.platform();
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux';
}

function commandExists(cmd) {
  const platform = getPlatform();
  const checkCmd = platform === 'windows' ? `where ${cmd}` : `command -v ${cmd}`;
  try {
    execSync(checkCmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, options = {}) {
  return execSync(cmd, { stdio: 'inherit', ...options });
}

// `docker` komutunun PATH'te olması, Docker Desktop'ın gerçekten AÇIK olduğu
// anlamına gelmez (CLI kurulu olsa bile daemon kapalıysa her docker komutu
// başarısız olur). "docker info" daemon'a gerçekten bağlanmayı dener.
function isDockerDaemonRunning() {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Windows'ta Docker Desktop'ın WSL2 backend'i için en az bir WSL2 dağıtımı
// gerekir. Sadece bilgi amaçlı, salt-okunur bir kontrol (hiçbir şeyi kurmaz/değiştirmez).
// `wsl -l -v` çıktısı bazı Windows sürümlerinde UTF-16LE olarak basıldığından
// iki encoding de denenir; ayrıştırma en iyi çaba (best-effort) niteliğindedir.
function checkWsl2Status() {
  if (getPlatform() !== 'windows') return { ok: true, skipped: true };
  if (!commandExists('wsl')) {
    return { ok: false, reason: 'wsl-not-found' };
  }
  try {
    let raw;
    try {
      raw = execSync('wsl -l -v', { encoding: 'utf16le' });
    } catch {
      raw = execSync('wsl -l -v', { encoding: 'utf8' });
    }
    const NUL_CHAR_RE = new RegExp(String.fromCharCode(0), 'g');
    const clean = raw.replace(NUL_CHAR_RE, '');
    const hasV2Distro = /\b2\s*$/m.test(clean);
    return { ok: hasV2Distro, reason: hasV2Distro ? null : 'no-v2-distro', raw: clean };
  } catch {
    return { ok: false, reason: 'check-failed' };
  }
}

module.exports = { getPlatform, commandExists, run, checkWsl2Status, isDockerDaemonRunning };
