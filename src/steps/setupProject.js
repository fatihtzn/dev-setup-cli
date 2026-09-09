const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { run, commandExists, getNvmCommandPrefix } = require('../platform');
const { isDryRun } = require('../dryRunState');
const { injectWith1Password } = require('./secrets');
const { waitForPort } = require('./healthCheck');

function cloneRepo(config, targetDir) {
  if (isDryRun()) {
    console.log(`🧪 [dry-run] gh repo clone ${config.repo} ${targetDir}`);
    return;
  }
  if (fs.existsSync(targetDir)) {
    console.log(`ℹ️  "${targetDir}" already exists, skipping clone.`);
    return;
  }
  console.log(`\n📥 Cloning repo: ${config.repo}`);
  // A raw "git clone" SSH URL (git@github.com:...) requires an SSH key; on
  // a fresh setup with no SSH key registered on GitHub, it blows up with
  // "Permission denied (publickey)" (observed in a real VM test).
  // "gh repo clone" uses gh's own already-completed https token sign-in —
  // no SSH key requirement. execFileSync doesn't concatenate arguments into
  // a shell string, so spaces in the path aren't a problem either.
  execFileSync('gh', ['repo', 'clone', config.repo, targetDir], { stdio: 'inherit' });
}

function setupEnv(config, projectDir) {
  const examplePath = path.join(projectDir, config.envExampleFile || '.env.example');
  const envPath = path.join(projectDir, '.env');

  if (!isDryRun() && fs.existsSync(envPath)) {
    console.log('ℹ️  .env already exists, left untouched.');
    return;
  }

  // In dry-run the repo isn't actually cloned, so .env.example doesn't
  // exist on disk; we proceed as if it did, so the flow can still be shown.
  const exampleExists = isDryRun() || fs.existsSync(examplePath);
  if (!exampleExists) {
    console.log('⚠️  .env.example not found, .env needs to be created manually.');
    return;
  }

  if (config.secretManager === '1password') {
    const result = injectWith1Password(examplePath, envPath);
    if (result.ok) return;
    console.log('ℹ️  Falling back to a plain copy of .env.example — you will need to fill in the real values manually.');
  }

  if (isDryRun()) {
    console.log(`🧪 [dry-run] ${examplePath} -> ${envPath} would have been copied.`);
    return;
  }

  fs.copyFileSync(examplePath, envPath);
  console.log('✅ .env created from .env.example. Remember to fill in the real values.');
}

// A postCloneCommand (e.g. composer install) can fail because of the repo's
// own configuration problem. One command failing shouldn't stop everything
// else (other postCloneCommands, or the docker/runProject steps if .env is
// already done) — the goal is for the script to get as far as possible
// without outside intervention. Failed commands are listed as warnings.
function runPostCloneCommands(config, projectDir) {
  const failed = [];
  for (const cmd of config.postCloneCommands || []) {
    if (isDryRun()) {
      console.log(`🧪 [dry-run] ${cmd}`);
      continue;
    }
    console.log(`\n▶️  ${cmd}`);
    try {
      run(cmd, { cwd: projectDir });
    } catch (err) {
      console.log(`⚠️  "${cmd}" failed, continuing: ${err.message}`);
      failed.push(cmd);
    }
  }
  return { failed };
}

// Reads the first published host port in the docker-compose file, so the
// "is the service up?" health-check knows which port to try.
// "3000:3000", "127.0.0.1:3000:3000", and the long format ({ published: 3000 }) are supported.
//
// Services with a `profiles` field are SKIPPED: the plain `docker compose
// up -d` we run doesn't select any profile, so a service behind a profile
// like profiles: ["app"] never starts with that command — picking such a
// service's port as the health-check target would wrongly report an app
// that never actually came up as "ready" (observed on a real Airalo repo:
// backend/frontend was hidden behind the `app` profile, only started via
// `make prod-local`).
function detectComposeHostPort(projectDir, composeFile) {
  if (!composeFile) return null;
  try {
    const raw = fs.readFileSync(path.join(projectDir, composeFile), 'utf-8');
    const doc = yaml.load(raw);
    const services = (doc && doc.services) || {};
    for (const service of Object.values(services)) {
      if (service.profiles && service.profiles.length) continue;
      for (const p of service.ports || []) {
        if (typeof p === 'string') {
          const parts = p.split(':');
          const hostPort = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
          const port = parseInt(hostPort, 10);
          if (!Number.isNaN(port)) return port;
        } else if (p && typeof p === 'object' && p.published) {
          const port = parseInt(p.published, 10);
          if (!Number.isNaN(port)) return port;
        }
      }
    }
  } catch {
    // docker-compose.yml couldn't be read/parsed, silently give up — the health-check is skipped.
  }
  return null;
}

// A repo may come with yarn.lock/pnpm-lock.yaml but that package manager
// might not be installed on the machine at all (e.g. bootstrap.sh only
// installs git/node/gh) — observed on a real VM test as "yarn: command not
// found". corepack, which is supposed to ship inside Node, is missing
// entirely on some distributions (e.g. Homebrew's node formula); a fallback
// like "npm install -g yarn" installs a generic/classic yarn that ignores
// the version pinned in the project's package.json (e.g. "packageManager":
// "yarn@4.13.0") and blows up with a "Corepack must be enabled" error
// (observed on a real VM test). That's why we never trust the "yarn"/"pnpm"
// command on PATH — if corepack is missing we install it via npm, and
// always run the install command as "corepack <pm> install"; this
// correctly downloads and uses the project's pinned version regardless of
// what's on PATH.
function ensureCorepackAvailable(commands) {
  if (!commandExists('corepack')) {
    // The corepack package also tries to install its own "yarn"/"pnpm"
    // bins; if the machine already has a bare global yarn/pnpm installed
    // via npm (e.g. from a previous, unfixed version of this tool, or from
    // somewhere else), npm refuses to overwrite those files and blows up
    // with "EEXIST: file already exists" (observed on a real VM test). We
    // remove them first; if they don't exist, uninstall is already a
    // silent no-op.
    commands.push('npm uninstall -g yarn pnpm >/dev/null 2>&1 || true');
    commands.push('npm install -g corepack');
  }
}

// If the override config has no info, inspects the cloned repo and
// auto-detects the docker-compose file and package manager.
function autoDetect(config, projectDir) {
  const detected = { ...config };

  if (isDryRun()) {
    if (detected.requiresDocker === undefined) detected.requiresDocker = false;
    if (!detected.postCloneCommands) detected.postCloneCommands = [];
    console.log(
      '🧪 [dry-run] Docker Compose/package manager detection skipped since the repo was not actually cloned (an override, if defined, is used instead).'
    );
    return detected;
  }

  const composeCandidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  if (detected.requiresDocker === undefined) {
    const found = composeCandidates.find((f) => fs.existsSync(path.join(projectDir, f)));
    detected.requiresDocker = Boolean(found);
    detected.dockerComposeFile = found;
  } else if (detected.requiresDocker && detected.dockerComposeFile === undefined) {
    // requiresDocker was explicitly set to true in the override but
    // dockerComposeFile wasn't given — since the branch above never ran,
    // the filename is still unknown. If we don't also search here,
    // detectComposeHostPort gets called without a composeFile and the
    // health-check is silently skipped (observed on a real Airalo repo that
    // had a requiresDocker:true override but no dockerComposeFile).
    detected.dockerComposeFile = composeCandidates.find((f) => fs.existsSync(path.join(projectDir, f)));
  }

  if (detected.requiresDocker && detected.healthCheckPort === undefined) {
    detected.healthCheckPort = detectComposeHostPort(projectDir, detected.dockerComposeFile);
  }

  // A repo can have both composer.json (PHP/Laravel) and package.json (e.g.
  // an embedded frontend); if both exist, the install command for both is added.
  if (!detected.postCloneCommands) {
    const commands = [];

    if (fs.existsSync(path.join(projectDir, 'composer.json'))) {
      commands.push('composer install');
    }

    // Some Airalo JS repos pull package.json dependencies from GitHub
    // Packages (npm.pkg.github.com); these private scopes require
    // authentication. The NODE_AUTH_TOKEN convention popularized by
    // actions/setup-node (e.g. "npmAuthToken: ${NODE_AUTH_TOKEN}" in
    // .yarnrc.yml) was observed on a real Airalo repo
    // (airalo-partner-panel-frontend) — an anonymous request blew up with
    // "Invalid authentication". Since gh is already signed in, we supply
    // the token from there; harmless if the repo never uses this variable,
    // and works automatically if it does.
    const NODE_AUTH_TOKEN_PREFIX = 'NODE_AUTH_TOKEN="$(gh auth token 2>/dev/null)" ';
    // The repo may require a version different from the currently active
    // global Node version (.nvmrc / engines.node) — see the
    // getNvmCommandPrefix comment. Native (compiled) dependencies installed
    // with the wrong version get silently built broken, so we switch to the
    // right version BEFORE the install command (and before NODE_AUTH_TOKEN too).
    const nvmPrefix = getNvmCommandPrefix(projectDir);

    if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) {
      ensureCorepackAvailable(commands);
      commands.push(`${nvmPrefix}${NODE_AUTH_TOKEN_PREFIX}corepack pnpm install`);
    } else if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) {
      ensureCorepackAvailable(commands);
      commands.push(`${nvmPrefix}${NODE_AUTH_TOKEN_PREFIX}corepack yarn install`);
    } else if (fs.existsSync(path.join(projectDir, 'package.json'))) {
      commands.push(`${nvmPrefix}${NODE_AUTH_TOKEN_PREFIX}npm install`);
    }

    detected.postCloneCommands = commands;
  }

  return detected;
}

async function dockerUp(config, projectDir) {
  if (!config.requiresDocker) return { ok: true };
  const composeFile = config.dockerComposeFile || 'docker-compose.yml';

  if (isDryRun()) {
    console.log(`🧪 [dry-run] docker compose -f ${composeFile} up -d`);
    if (config.healthCheckPort) {
      console.log(`🧪 [dry-run] would have waited for localhost:${config.healthCheckPort} to be ready.`);
    }
    return { ok: true };
  }

  console.log(`\n🐳 Starting Docker Compose (${composeFile})...`);
  try {
    run(`docker compose -f ${composeFile} up -d`, { cwd: projectDir });
  } catch (err) {
    // Can fail because of a port conflict (e.g. a leftover container from
    // another project), an image build error, etc. — the real docker error
    // is already visible on screen via stdio:'inherit'. If we don't catch
    // it here, the script stops all remaining steps (including the closing
    // message) and crashes with a top-level error.
    console.log(`⚠️  docker compose up failed: ${err.message}`);
    console.log(`   Check the containers: docker compose -f ${composeFile} ps`);
    return { ok: false };
  }

  if (!config.healthCheckPort) {
    console.log('ℹ️  No published port found in the docker-compose file, skipping health-check.');
    return { ok: true };
  }

  console.log(`\n⏳ Waiting for localhost:${config.healthCheckPort} to come up...`);
  const result = await waitForPort(config.healthCheckPort, { timeoutMs: 90000 });
  if (result.ok) {
    console.log(
      `✅ Service is up: http://localhost:${config.healthCheckPort} (in ${Math.round(result.elapsedMs / 1000)}s)`
    );
  } else {
    console.log(
      `⚠️  Could not connect to localhost:${config.healthCheckPort} after waiting ${Math.round(result.elapsedMs / 1000)}s. Check whether the container is up: docker compose -f ${composeFile} logs`
    );
  }
  // ok:true because the "up -d" command succeeded — a health-check timeout
  // is a separate, softer warning already shown above.
  return { ok: true };
}

module.exports = { cloneRepo, setupEnv, runPostCloneCommands, dockerUp, autoDetect };
