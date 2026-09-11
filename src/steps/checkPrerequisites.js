const prompts = require('prompts');
const { execFileSync } = require('child_process');
const {
  commandExists,
  getPlatform,
  checkWsl2Status,
  isDockerDaemonRunning,
  isDockerComposeAvailable,
  fixDockerComposePlugin,
  run,
} = require('../platform');
const { isDryRun } = require('../dryRunState');

// installHint is also the REAL, executable install command — if automatic
// install is confirmed, this exact string is run directly via execSync.
const REQUIRED_TOOLS = [
  {
    cmd: 'git',
    kind: 'install',
    installHint: { macos: 'brew install git', windows: 'winget install --id Git.Git' },
  },
  {
    cmd: 'node',
    kind: 'install',
    installHint: { macos: 'brew install node', windows: 'winget install OpenJS.NodeJS' },
  },
  {
    cmd: 'gh',
    kind: 'install',
    installHint: { macos: 'brew install gh', windows: 'winget install --id GitHub.cli' },
  },
  {
    cmd: 'docker',
    kind: 'install',
    installHint: { macos: 'brew install --cask docker', windows: 'winget install Docker.DockerDesktop' },
  },
  {
    cmd: 'op',
    kind: 'install',
    installHint: { macos: 'brew install 1password-cli', windows: 'winget install AgileBits.1Password-CLI' },
  },
  {
    // Binary name is "git-lfs"; it's invoked as a git subcommand ("git
    // lfs ..."), but the thing that needs to be ON PATH is this binary.
    cmd: 'git-lfs',
    kind: 'install',
    installHint: { macos: 'brew install git-lfs', windows: 'winget install GitHub.GitLFS' },
  },
];

function isXcodeFullyInstalled() {
  try {
    execFileSync('xcodebuild', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Xcode's real App Store listing ID (confirmed via `mas info 497799835` ->
// "App: Xcode"), used with the Mac App Store CLI (`mas`) below.
const XCODE_APP_STORE_ID = '497799835';

// Auto-installs Xcode via `mas` (the Mac App Store CLI) if the machine is
// already signed in to the App Store — confirmed directly this works
// end-to-end: `mas` itself is brew-installable, and once signed in,
// `mas install <id>` downloads and installs an app with no further
// credential entry. It's a large download (~2.35GB for Xcode) and can take
// a while; `mas install` may also prompt for the account's sudo password
// partway through (observed directly) — that's fine when this tool is run
// in a real interactive terminal (the whole point of "may ask for your
// admin password" in the confirm prompt above), just not from a
// non-interactive context with no TTY to answer it.
//
// A 2.35GB download over `mas`'s own networking also genuinely times out
// sometimes partway through, unrelated to being signed in or not (observed
// directly: `mas install` got as far as "==> Downloading Xcode (26.6)" then
// failed with NSURLErrorDomain Code=-1001 "The request timed out." — no
// exposed `mas` flag raises that timeout, so retrying is the only real
// mitigation). Retried a few times before giving up.
async function installXcodeViaMas({ retries = 2 } = {}) {
  if (getPlatform() !== 'macos') return false;

  if (!commandExists('mas')) {
    console.log('\n📦 Installing mas (Mac App Store CLI): brew install mas');
    try {
      run('brew install mas');
    } catch (err) {
      console.log(`⚠️  Could not install mas: ${err.message}`);
      return false;
    }
  }

  console.log('\n📦 Installing Xcode via the Mac App Store (mas install) — ~2.35GB, this will take a while...');
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      run(`mas install ${XCODE_APP_STORE_ID}`);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt <= retries) {
        console.log(`\n⚠️  Attempt ${attempt} failed (often just a network timeout on a download this large) — retrying...`);
      }
    }
  }
  if (lastErr) {
    console.log(`\n⚠️  \`mas install\` failed after ${retries + 1} attempts: ${lastErr.message}`);
    console.log('   Could be a network issue (this is a ~2.35GB download) or the Mac not being signed in to the App Store yet — check the error above, or install from the App Store app directly.');
    return false;
  }

  // A fresh Xcode install still needs its license accepted before
  // xcodebuild will run at all; -license accept does that non-interactively
  // (needs sudo, but the credential prompt from the mas install above is
  // still cached for a few minutes in a real terminal, so this usually
  // doesn't prompt again). Non-fatal if it fails — the first manual launch
  // of Xcode.app accepts the license too.
  try {
    run('sudo xcodebuild -license accept', { stdio: 'ignore' });
  } catch {
    console.log('ℹ️  Could not auto-accept the Xcode license — open Xcode.app once by hand to accept it.');
  }

  return isXcodeFullyInstalled();
}

// If Docker Desktop is installed but not running, "open and wait" handles
// it — this is not the same as "install" (it doesn't put anything on the
// system, it just starts an already-installed app), hence the separate
// "start-daemon" kind.
async function startDockerDaemonAndWait(platform, { timeoutMs = 90000, intervalMs = 3000 } = {}) {
  try {
    if (platform === 'macos') {
      run('open -a Docker', { stdio: 'ignore' });
    } else if (platform === 'windows') {
      // Docker Desktop's default install path — if it's installed somewhere
      // else, this fails and falls back to the manual-open instructions
      // (untested: not yet verified on a real Windows machine).
      run('start "" "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"', { stdio: 'ignore' });
    } else {
      return false;
    }
  } catch {
    return false;
  }

  process.stdout.write('⏳ Starting Docker Desktop, waiting for it to be ready');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isDockerDaemonRunning()) {
      console.log(' ✅');
      return true;
    }
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.log(' ⏱️');
  return false;
}

async function attemptAutoFix(tool, platform) {
  if (tool.kind === 'start-daemon') {
    return startDockerDaemonAndWait(platform);
  }
  if (tool.kind === 'fix-compose-plugin') {
    return fixDockerComposePlugin();
  }
  if (tool.kind === 'manual') {
    return false; // never auto-fixable — falls straight to the "handle it yourself" list
  }
  if (tool.kind === 'xcode-install') {
    return installXcodeViaMas();
  }

  const cmd = tool.installHint[platform] || tool.installHint.macos;
  console.log(`\n📦 Installing ${tool.cmd}: ${cmd}`);
  try {
    run(cmd);
    return commandExists(tool.cmd);
  } catch (err) {
    console.log(`⚠️  Failed to install ${tool.cmd}: ${err.message}`);
    return false;
  }
}

// Installs just the 1Password CLI on its own, outside the normal
// checkPrerequisites flow — used by the dynamic secret-resolution prompt
// (src/steps/dynamicSecrets.js), which only learns a project needs 1Password
// interactively, after the usual up-front prerequisite check already ran.
// Reuses the same install command as the REQUIRED_TOOLS entry above so
// there's one source of truth for it.
async function installOp() {
  const platform = getPlatform();
  const opTool = REQUIRED_TOOLS.find((t) => t.cmd === 'op');
  return attemptAutoFix(opTool, platform);
}

async function checkPrerequisites(config) {
  const platform = getPlatform();
  const missing = [];

  for (const tool of REQUIRED_TOOLS) {
    if (tool.cmd === 'docker' && !config.requiresDocker) continue;
    if (tool.cmd === 'op' && config.secretManager !== '1password') continue;
    if (tool.cmd === 'git-lfs' && !config.requiresXcode) continue;
    if (!commandExists(tool.cmd)) {
      missing.push(tool);
    }
  }

  // xcodebuild is ON PATH via the Command Line Tools even with no full
  // Xcode.app installed at all — commandExists() alone would wrongly call
  // that "installed" (confirmed directly: `command -v xcodebuild` succeeds,
  // `xcodebuild -version` fails with "requires Xcode" when only CLT is
  // active). Auto-fixable IF the Mac is already signed in to the App Store
  // (via `mas`, see installXcodeViaMas) — falls back to the manual
  // instructions below when it isn't, same idea as the docker-daemon check
  // further down.
  if (config.requiresXcode && !isXcodeFullyInstalled()) {
    missing.push({
      cmd: 'Xcode (full app)',
      kind: 'xcode-install',
      installHint: {
        macos: 'Install Xcode from the App Store, open it once to accept the license, then re-run this tool',
        windows: 'Xcode is macOS-only — this project can only be built on a Mac',
      },
    });
  }

  // Even if the docker CLI is on PATH, if Docker Desktop is off, every docker
  // command (including docker compose up) fails — if we don't catch this
  // here, the script crashes later with a raw, cryptic error.
  const dockerBinaryMissing = missing.some((t) => t.cmd === 'docker');
  if (config.requiresDocker && !dockerBinaryMissing && !isDockerDaemonRunning()) {
    missing.push({
      cmd: 'docker (daemon)',
      kind: 'start-daemon',
      installHint: {
        macos: 'Open the Docker Desktop app (Applications > Docker) and wait until the whale icon shows "running"',
        windows: 'Start Docker Desktop and wait until the whale icon in the system tray shows "running"',
      },
    });
  }

  // Even if the "docker" CLI is installed and the daemon is running,
  // "docker compose" resolves as a separate CLI plugin that's only searched
  // for in certain directories. Homebrew's macOS docker-desktop cask can put
  // the symlink pointing at the real plugin into a directory the Docker CLI
  // never looks at (/usr/local/cli-plugins/) — observed on a real macOS VM
  // as a "docker: unknown command: docker compose" error (even with the
  // daemon running). This check is independent of the daemon (compose
  // version doesn't require it).
  if (config.requiresDocker && !dockerBinaryMissing && !isDockerComposeAvailable()) {
    missing.push({
      cmd: 'docker compose (plugin)',
      kind: 'fix-compose-plugin',
      installHint: {
        macos: 'Docker CLI cannot find the compose plugin — create a symlink in ~/.docker/cli-plugins/ pointing at the real plugin bundled inside Docker.app',
        windows: 'Docker CLI cannot find the compose plugin — try repairing/reinstalling Docker Desktop',
      },
    });
  }

  const warnings = [];
  if (config.requiresDocker && platform === 'windows') {
    const wsl = checkWsl2Status();
    if (!wsl.ok) {
      warnings.push(
        wsl.reason === 'wsl-not-found'
          ? 'WSL not found. Docker Desktop\'s WSL2 backend requires WSL to be installed: run "wsl --install" and restart the computer.'
          : 'No WSL2-based distro seems to be found. "Use the WSL 2 based engine" must be enabled in Docker Desktop settings and at least one distro must use WSL2 ("wsl --set-version <distro> 2").'
      );
    }
  }

  if (missing.length === 0) {
    console.log('\n✅ All required tools are already installed.');
    if (warnings.length) {
      console.log('\n⚠️  Warnings:\n');
      warnings.forEach((w) => console.log(`  - ${w}`));
    }
    return { ok: true, warnings };
  }

  console.log('\n⚠️  Missing tools / missing prerequisites found:\n');
  for (const tool of missing) {
    const hint = tool.installHint[platform] || tool.installHint.macos;
    console.log(`  - ${tool.cmd}: ${hint}`);
  }
  if (warnings.length) {
    console.log('\n⚠️  Warnings:\n');
    warnings.forEach((w) => console.log(`  - ${w}`));
  }

  if (isDryRun()) {
    console.log('\n🧪 [dry-run] Automatic install/start will not be attempted.\n');
    return { ok: false, missing, warnings };
  }

  const { autoFix } = await prompts({
    type: 'confirm',
    name: 'autoFix',
    message: 'Try to automatically install/start the missing ones now? (may take a while to download/install, may ask for your admin password)',
    initial: true,
  });

  if (!autoFix) {
    console.log('\nRe-run the script once you have taken care of these.\n');
    return { ok: false, missing, warnings };
  }

  const stillMissing = [];
  for (const tool of missing) {
    const fixed = await attemptAutoFix(tool, platform);
    if (!fixed) stillMissing.push(tool);
  }

  if (stillMissing.length > 0) {
    console.log('\n⚠️  The following could not be fixed automatically, you need to handle them manually:\n');
    for (const tool of stillMissing) {
      const hint = tool.installHint[platform] || tool.installHint.macos;
      console.log(`  - ${tool.cmd}: ${hint}`);
    }
    console.log('\nRe-run the script once you have taken care of these.\n');
    return { ok: false, missing: stillMissing, warnings };
  }

  console.log('\n✅ Everything missing has been taken care of, continuing.\n');
  return { ok: true, warnings };
}

module.exports = { checkPrerequisites, installOp, isXcodeFullyInstalled };
