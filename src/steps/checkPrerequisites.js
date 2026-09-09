const prompts = require('prompts');
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
];

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

async function checkPrerequisites(config) {
  const platform = getPlatform();
  const missing = [];

  for (const tool of REQUIRED_TOOLS) {
    if (tool.cmd === 'docker' && !config.requiresDocker) continue;
    if (!commandExists(tool.cmd)) {
      missing.push(tool);
    }
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

module.exports = { checkPrerequisites };
