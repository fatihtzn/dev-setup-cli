#!/usr/bin/env node

const path = require('path');
const { selectProject } = require('../src/prompts');
const { checkPrerequisites } = require('../src/steps/checkPrerequisites');
const { githubAuth } = require('../src/steps/githubAuth');
const {
  cloneRepo,
  setupEnv,
  runPostCloneCommands,
  dockerUp,
  autoDetect,
} = require('../src/steps/setupProject');
const { runProject } = require('../src/steps/runProject');
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
  githubAuth();

  const { projectKey, config: initialConfig } = await selectProject();
  console.log(`\n➡️  Selected: ${initialConfig.displayName}\n`);

  const targetDir = path.join(process.cwd(), projectKey);
  cloneRepo(initialConfig, targetDir);

  // Once the repo is cloned, docker-compose / package manager are auto-detected
  // (if config/projects.json defines a special setting for this project, that takes priority).
  const config = autoDetect(initialConfig, targetDir);

  if (config.requiresDocker) {
    const dockerCheck = await checkPrerequisites(config);
    if (!dockerCheck.ok) process.exit(1);
  }

  setupEnv(config, targetDir);
  const { failed: failedCommands } = runPostCloneCommands(config, targetDir);
  const { ok: dockerOk } = await dockerUp(config, targetDir);
  // For projects that don't require Docker (frontend or backend, doesn't matter), starts the
  // dev server in the background and detects its port; a no-op for Docker-based projects.
  await runProject(config, targetDir);

  // If dockerUp failed, the project-specific readyMessage ("... is running!" etc.)
  // would be misleading — so it's not shown in that case, only a warning is printed.
  if (dockerOk) {
    console.log(`\n🎉 ${config.readyMessage || 'Setup complete, you are ready to start coding!'}\n`);
  } else {
    console.log('\n⚠️  Setup finished but Docker Compose failed to start — check the error above.\n');
  }
  if (failedCommands.length) {
    console.log('⚠️  The following setup commands failed, you may need to check them manually:');
    failedCommands.forEach((cmd) => console.log(`  - ${cmd}`));
    console.log();
  }
}

main().catch((err) => {
  console.error('\n❌ An error occurred:', err.message);
  process.exit(1);
});
