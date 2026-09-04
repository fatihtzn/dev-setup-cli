const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

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

// Bu araç kendi ürettiği (postCloneCommands, docker compose komutları vb.)
// komutları hep POSIX/bash söz dizimiyle yazıyor (`$(...)`, `>/dev/null
// 2>&1`, `VAR="değer" komut`, `until ... do ... done` gibi) — Windows'ta
// execSync varsayılan olarak cmd.exe kullanır ve cmd.exe bu söz dizimini
// hiç anlamaz ("'NODE_AUTH_TOKEN' is not recognized..." gibi hatalarla
// gerçek bir Windows VM'de gözlemlendi). Git for Windows zaten zorunlu bir
// bağımlılığımız (REQUIRED_TOOLS) ve kendi gerçek POSIX bash'ini
// (bash.exe/MSYS2) getiriyor — Windows'ta tüm bu komutları cmd.exe yerine
// o bash'e yönlendirerek, komutları hiç değiştirmeden macOS'takiyle birebir
// aynı şekilde çalıştırabiliyoruz.
function findWindowsBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return commandExists('bash') ? 'bash' : null;
}

function run(cmd, options = {}) {
  if (getPlatform() === 'windows') {
    const bash = findWindowsBash();
    if (bash) {
      // execFileSync (execSync değil): cmd tek bir argüman olarak bash'e
      // geçer, cmd.exe hiç devreye girmez, bu yüzden tırnak/özel karakter
      // kaçışına gerek kalmaz — bash kendi POSIX parser'ıyla ayrıştırır.
      return execFileSync(bash, ['-c', cmd], { stdio: 'inherit', ...options });
    }
  }
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

// `docker` CLI kurulu olsa bile "docker compose" alt komutu ayrı bir CLI
// plugin'i olarak çözülür; Docker CLI bunu sadece belirli dizinlerde arar
// (~/.docker/cli-plugins/, /usr/local/lib/docker/cli-plugins/ vb.). Homebrew'ın
// docker-desktop cask'ı gerçek plugin binary'sine (Docker.app içinde) işaret
// eden bir symlink'i KENDİ /usr/local/cli-plugins/ dizinine koyuyor — bu,
// Docker CLI'ın arama yollarından biri DEĞİL, bu yüzden plugin hiç
// bulunamıyor ve "docker: unknown command: docker compose" hatası veriyor
// (gerçek bir macOS VM'de gözlemlendi: dosya doğruydu, sadece yanlış
// klasördeydi). isDockerComposeAvailable bunu tespit eder, fixDockerComposePlugin
// gerçek plugin'i bulup doğru dizine kendi symlink'imizi oluşturarak düzeltir.
function isDockerComposeAvailable() {
  try {
    execSync('docker compose version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function fixDockerComposePlugin() {
  if (getPlatform() !== 'macos') return false;

  const candidates = [
    '/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose',
    '/usr/local/cli-plugins/docker-compose',
    '/opt/homebrew/cli-plugins/docker-compose',
  ];
  const source = candidates.find((p) => fs.existsSync(p));
  if (!source) return false;

  const targetDir = path.join(os.homedir(), '.docker', 'cli-plugins');
  const target = path.join(targetDir, 'docker-compose');

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    try {
      // lstatSync (existsSync değil): hedef zaten var ama bozuk bir symlink'se
      // existsSync false döner, unlink yine de gerekir.
      fs.lstatSync(target);
      fs.unlinkSync(target);
    } catch {
      // target hiç yoktu, sorun değil
    }
    fs.symlinkSync(fs.realpathSync(source), target);
    return isDockerComposeAvailable();
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

module.exports = {
  getPlatform,
  commandExists,
  run,
  checkWsl2Status,
  isDockerDaemonRunning,
  isDockerComposeAvailable,
  fixDockerComposePlugin,
};
