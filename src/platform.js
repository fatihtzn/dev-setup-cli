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

// The commands this tool generates itself (postCloneCommands, docker
// compose commands etc.) are always written in POSIX/bash syntax (`$(...)`,
// `>/dev/null 2>&1`, `VAR="value" command`, `until ... do ... done` etc.) —
// on Windows, execSync uses cmd.exe by default, and cmd.exe doesn't
// understand this syntax at all (observed on a real Windows VM, with errors
// like "'NODE_AUTH_TOKEN' is not recognized..."). Git for Windows is already
// a required dependency of ours (REQUIRED_TOOLS) and brings its own real
// POSIX bash (bash.exe/MSYS2) — by routing all these commands through that
// bash instead of cmd.exe on Windows, we can run them identically to macOS
// without changing the commands at all.
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
      // execFileSync (not execSync): cmd is passed to bash as a single
      // argument, cmd.exe never gets involved, so there's no need to escape
      // quotes/special characters — bash parses it with its own POSIX parser.
      return execFileSync(bash, ['-c', cmd], { stdio: 'inherit', ...options });
    }
  }
  return execSync(cmd, { stdio: 'inherit', ...options });
}

// A repo may require a Node version DIFFERENT from the currently active
// global one (.nvmrc, or "engines.node" in package.json). If this mismatch
// goes unnoticed, native (compiled, e.g. isolated-vm-like) dependencies get
// built against the WRONG Node version's headers and blow up at
// install/run time with cryptic errors like "exit code 1" — observed in a
// real project (ux-frontend-v1.5, .nvmrc asked for "v22.20" but the active
// Node was v26.8.1). detectRequiredNodeVersion detects this, and
// getNvmCommandPrefix produces a bash command prefix that switches to the
// right version via nvm if installed (downloading it via nvm otherwise) —
// this prefix is prepended to install/run commands so it takes effect
// within the same shell.
function detectRequiredNodeVersion(projectDir) {
  const nvmrcPath = path.join(projectDir, '.nvmrc');
  if (fs.existsSync(nvmrcPath)) {
    const version = fs.readFileSync(nvmrcPath, 'utf-8').trim();
    if (version) return version;
  }

  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.engines && pkg.engines.node) return pkg.engines.node;
    } catch {
      // package.json couldn't be read/parsed, silently give up
    }
  }

  return null;
}

// nvm-windows is a completely different tool (doesn't read .nvmrc the same
// way), so for now this is only supported on macOS/Linux (POSIX nvm.sh).
const NVM_INSTALL_VERSION = 'v0.40.7';

function getNvmCommandPrefix(projectDir) {
  if (getPlatform() === 'windows') return '';

  const version = detectRequiredNodeVersion(projectDir);
  if (!version) return '';

  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
  const nvmScript = path.join(nvmDir, 'nvm.sh');

  // bootstrap.sh/.ps1 only installs git/node/gh, it NEVER installs nvm — so
  // on a fresh machine set up by our own tool (via brew/winget), nvm.sh
  // can't be found, this function used to silently return empty, and
  // .nvmrc effectively appeared to be ignored (observed on a real project/VM
  // — the pinned .nvmrc version never kicked in because nvm wasn't installed
  // at all). If nvm isn't installed, the command itself
  // (on the machine it runs on) installs nvm first via the official install
  // script.
  //
  // On the first attempt, the install output was suppressed with
  // "> /dev/null 2>&1"; on a real VM, when curl silently failed (e.g. a
  // transient network issue), nvm.sh still didn't exist with no trace left
  // behind, "&&" short-circuited so nvm install never ran, and the script
  // silently carried on with the current (wrong) Node, repeating the same
  // native-build error. Now: (1) the install output is no longer hidden (a
  // real failure becomes visible), (2) we no longer just TRUST that the
  // file exists — we check again at runtime AFTER the install attempt and
  // print an explicit warning if it's still missing.
  const installNvmCmd = fs.existsSync(nvmScript)
    ? ''
    : `curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_INSTALL_VERSION}/install.sh" | bash; `;

  return (
    `${installNvmCmd}` +
    `if [ -f "${nvmScript}" ]; then . "${nvmScript}" && nvm install; ` +
    `else echo "⚠️  nvm not found/installed, cannot switch to the pinned Node version (${version}) — continuing with the current Node, native dependencies may fail to build/run." >&2; fi; `
  );
}

// `docker` being on PATH doesn't mean Docker Desktop is actually RUNNING
// (even if the CLI is installed, every docker command fails if the daemon
// is off). "docker info" actually attempts to connect to the daemon.
function isDockerDaemonRunning() {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Even if the `docker` CLI is installed, the "docker compose" subcommand
// resolves as a separate CLI plugin; the Docker CLI only looks for it in
// certain directories (~/.docker/cli-plugins/,
// /usr/local/lib/docker/cli-plugins/ etc.). Homebrew's macOS docker-desktop
// cask puts a symlink pointing at the real plugin binary (inside Docker.app)
// into its OWN /usr/local/cli-plugins/ directory — this is NOT one of the
// Docker CLI's search paths, so the plugin can never be found and it
// produces a "docker: unknown command: docker compose" error (observed on
// a real macOS VM: the file was correct, just in the wrong folder).
// isDockerComposeAvailable detects this, and fixDockerComposePlugin fixes it
// by finding the real plugin and creating our own symlink to it in the
// right directory.
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
      // lstatSync (not existsSync): if the target already exists but is a
      // broken symlink, existsSync returns false, yet we still need to unlink it.
      fs.lstatSync(target);
      fs.unlinkSync(target);
    } catch {
      // target didn't exist at all, that's fine
    }
    fs.symlinkSync(fs.realpathSync(source), target);
    return isDockerComposeAvailable();
  } catch {
    return false;
  }
}

// On Windows, Docker Desktop's WSL2 backend requires at least one WSL2
// distro. This is an informational, read-only check only (installs/changes nothing).
// `wsl -l -v` output is printed as UTF-16LE on some Windows versions, so
// both encodings are tried; the parsing is best-effort.
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

// Opens a URL in the user's default browser. Uses the OS's own "open a URL"
// command directly (not `run`, which routes through bash on Windows for
// POSIX script syntax — unnecessary indirection here since this is a single
// native command per OS, and Windows' "start" is a cmd.exe builtin, not
// something bash.exe would even have).
function openUrl(url) {
  const platform = getPlatform();
  try {
    if (platform === 'macos') {
      execFileSync('open', [url], { stdio: 'ignore' });
    } else if (platform === 'windows') {
      // The empty "" first argument is the window title `start` expects
      // when the target itself is quoted.
      execSync(`start "" "${url}"`, { stdio: 'ignore' });
    } else {
      execFileSync('xdg-open', [url], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getPlatform,
  commandExists,
  run,
  openUrl,
  checkWsl2Status,
  isDockerDaemonRunning,
  isDockerComposeAvailable,
  fixDockerComposePlugin,
  detectRequiredNodeVersion,
  getNvmCommandPrefix,
};
