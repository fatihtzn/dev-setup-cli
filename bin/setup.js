#!/usr/bin/env node

const path = require('path');
const { selectProject } = require('../src/prompts');
const { checkPrerequisites } = require('../src/steps/checkPrerequisites');
const { githubAuth } = require('../src/steps/githubAuth');
const { ensureOpReady } = require('../src/steps/secrets');
const {
  cloneRepo,
  setupEnv,
  restoreSecretFiles,
  runPostCloneCommands,
  dockerUp,
  autoDetect,
} = require('../src/steps/setupProject');
const { runProject } = require('../src/steps/runProject');
const { ensureHostsEntry } = require('../src/steps/hostsFile');
const { detectXcodeProject, setupXcodeProject } = require('../src/steps/iosSetup');
const { setDryRun, isDryRun } = require('../src/dryRunState');

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run') || argv.includes('-n'),
  };
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  setDryRun(dryRun);

  console.log('👋 Welcome to the Company Dev Environment Setup Tool!\n');
  if (isDryRun()) {
    console.log(
      '🧪 DRY RUN mode active: the gh CLI will not be called, nothing will be written to disk/cloned — the flow will only be simulated.\n'
    );
  }

  // GitHub/Okta sign-in is required first, so the repo list can be fetched.
  const prereq = await checkPrerequisites({ requiresDocker: false });
  if (!prereq.ok) process.exit(1);
  await githubAuth();

  const { projectKey, config: initialConfig } = await selectProject();
  console.log(`\n➡️  Selected: ${initialConfig.displayName}\n`);

  const targetDir = path.join(process.cwd(), projectKey);
  cloneRepo(initialConfig, targetDir);

  // A native Xcode project (iOS/macOS app) builds and runs entirely through
  // Xcode's own GUI — none of the .env/dev-server machinery below applies,
  // so it gets its own short, separate flow instead.
  if (!isDryRun() && detectXcodeProject(targetDir)) {
    const config = { ...initialConfig, requiresXcode: true };
    const prereqCheck = await checkPrerequisites(config);
    const xcodeStillMissing = (prereqCheck.missing || []).some((t) => t.cmd === 'Xcode (full app)');
    // Everything else here (Keychain, LFS, hooks) is independently useful
    // even without Xcode installed yet — running it now means the project
    // is ready to build the moment Xcode is — but the final message must
    // NOT say "complete" in that case, or it reads as a false all-clear
    // (observed directly: it printed "🎉 Setup complete" right after
    // warning Xcode itself was still missing, which is exactly backwards).
    await setupXcodeProject(targetDir);
    if (xcodeStillMissing) {
      console.log(
        '\n⚠️  Everything else is ready, but Xcode itself still needs to be installed before this project can actually be built — install it from the App Store, open it once to accept the license, then open the project.\n'
      );
    } else {
      console.log(`\n🎉 ${initialConfig.readyMessage || 'Setup complete — open the project in Xcode to start coding!'}\n`);
    }
    return;
  }

  // Once the repo is cloned, docker-compose / package manager are auto-detected
  // (if config/projects.json defines a special setting for this project, that takes priority).
  const config = autoDetect(initialConfig, targetDir);

  if (config.requiresDocker || config.secretManager === '1password') {
    // Installs whatever's missing (docker, op, ...) automatically. Docker is
    // a hard requirement — nothing else can run without it, so its failure
    // stops the whole setup. A missing/unauthorized 1Password CLI only
    // degrades secret-filling gracefully (plain-copy fallback below), so it
    // alone shouldn't block everything else from proceeding.
    const prereqCheck = await checkPrerequisites(config);
    const dockerStillMissing = (prereqCheck.missing || []).some(
      (t) => t.cmd === 'docker' || t.kind === 'start-daemon' || t.kind === 'fix-compose-plugin'
    );
    if (config.requiresDocker && dockerStillMissing) process.exit(1);
  }

  // One-time-per-machine nudge if `op` is installed but not yet authorized
  // against the user's 1Password account — see ensureOpReady's own comment
  // for why this can't be fully automated.
  await ensureOpReady(config);

  await setupEnv(config, targetDir);
  const { failed: failedSecretFiles } = restoreSecretFiles(config, targetDir);
  const { failed: failedCommands } = runPostCloneCommands(config, targetDir);
  const { ok: dockerOk } = await dockerUp(config, targetDir);
  // A project whose dev server binds to a specific HOST= (not
  // localhost/0.0.0.0) needs that hostname to actually resolve to this
  // machine — offers to add it to the hosts file if it doesn't yet.
  await ensureHostsEntry(targetDir);
  // For projects that don't require Docker (frontend or backend, doesn't matter), starts the
  // dev server in the background and detects its port; a no-op for Docker-based projects.
  const { ok: projectOk } = await runProject(config, targetDir);

  // If dockerUp OR the dev server failed, the project-specific readyMessage
  // ("... is running!" etc.) would be misleading — so it's not shown in
  // that case, only a warning is printed.
  if (dockerOk && projectOk) {
    console.log(`\n🎉 ${config.readyMessage || 'Setup complete, you are ready to start coding!'}\n`);
  } else if (!dockerOk) {
    console.log('\n⚠️  Setup finished but Docker Compose failed to start — check the error above.\n');
  } else {
    console.log('\n⚠️  Setup finished but the dev server could not be confirmed running — check the warning above.\n');
  }
  if (failedCommands.length) {
    console.log('⚠️  The following setup commands failed, you may need to check them manually:');
    failedCommands.forEach((cmd) => console.log(`  - ${cmd}`));
    console.log();
  }
  if (failedSecretFiles.length) {
    console.log('⚠️  The following files could not be restored from 1Password, you may need to fetch them manually:');
    failedSecretFiles.forEach((f) => console.log(`  - ${f}`));
    console.log();
  }
}

main().catch((err) => {
  console.error('\n❌ An error occurred:', err.message);
  process.exit(1);
});
