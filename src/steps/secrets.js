const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const prompts = require('prompts');
const { commandExists } = require('../platform');
const { isDryRun } = require('../dryRunState');

function isOpAvailable() {
  return commandExists('op');
}

// `op whoami` only succeeds for a classic `op signin` CLI session. When the
// user instead enabled "Integrate with 1Password CLI" in the desktop app
// (the path this tool's README recommends, and the more common one), the CLI
// is fully functional via the app's biometric-unlock bridge but `op whoami`
// still reports "account is not signed in" (observed directly: `op vault
// list` and `op item create` both worked right after that failed). `op vault
// list` succeeds under both integration styles, so it's the reliable check.
function isOpSignedIn() {
  try {
    execFileSync('op', ['vault', 'list'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Gets 1Password CLI ready for a project with secretManager: "1password",
// with as little manual work as possible. Installing the `op` binary itself
// is fully automatable (see checkPrerequisites.js, run before this) — but
// authorizing it against the user's account is a one-time, per-machine,
// human-in-the-loop step BY DESIGN (1Password deliberately has no CLI/API
// way to flip this on remotely, so malware can't silently grant itself vault
// access). Rather than silently degrading to a blank .env the way the
// individual injectWith1Password/restoreSecretFiles fallbacks do, this pauses
// once with the exact instruction and gives the user a chance to unblock
// every project's secrets in one go — worth it since it only ever happens
// once per developer machine, not once per project.
async function ensureOpReady(config) {
  if (config.secretManager !== '1password') return { ready: true };
  if (isDryRun()) return { ready: true, simulated: true };
  if (!isOpAvailable()) return { ready: false, reason: 'op-not-found' };
  if (isOpSignedIn()) return { ready: true };

  console.log(
    '\n🔐 1Password CLI is installed but not authorized yet on this machine. ' +
      "This is a one-time step (1Password itself requires a human click here, it can't be scripted):\n" +
      '   1. Open the 1Password desktop app\n' +
      '   2. Settings → Developer → turn on "Integrate with 1Password CLI"\n' +
      '   (No desktop app / prefer a CLI-only sign-in? Run `op signin` in another terminal instead.)\n'
  );

  const { done } = await prompts({
    type: 'confirm',
    name: 'done',
    message: 'Done? (continues automatically once authorized)',
    initial: true,
  });

  if (done && isOpSignedIn()) {
    console.log('✅ 1Password CLI is authorized — this will not be asked again on this machine.\n');
    return { ready: true };
  }

  console.log('⚠️  Still not authorized — secrets will be left as plain placeholders for this run, fill them in by hand.\n');
  return { ready: false, reason: 'not-signed-in' };
}

// Fills in op://vault/item/field references inside .env.example with the
// real values from 1Password and writes them to the .env file (see `op
// inject`). The user's 1Password CLI must be installed and signed in;
// secret values never touch this script's memory/stdout, they're written
// to the file directly by the op CLI.
function injectWith1Password(examplePath, envPath) {
  if (isDryRun()) {
    console.log(`🧪 [dry-run] op inject -i ${examplePath} -o ${envPath} would have been run.`);
    return { ok: true, simulated: true };
  }

  // Installation and authorization are both handled upstream (checkPrerequisites
  // + ensureOpReady, called once before any per-project step); these are just
  // defensive re-checks in case this function is ever called on its own.
  if (!isOpAvailable() || !isOpSignedIn()) {
    console.log('⚠️  1Password CLI not ready, falling back to a plain copy.');
    return { ok: false, reason: !isOpAvailable() ? 'op-not-found' : 'not-signed-in' };
  }

  try {
    execFileSync('op', ['inject', '-i', examplePath, '-o', envPath], { stdio: 'inherit' });
    console.log('✅ .env created with real secret values from 1Password.');
    return { ok: true };
  } catch (err) {
    console.log(`⚠️  Secret injection via 1Password failed: ${err.message}`);
    return { ok: false, reason: 'inject-failed' };
  }
}

// Restores non-.env files a project needs (e.g. a dev HTTPS cert/key pair)
// from 1Password. config.secretFiles is [{ ref: "op://vault/item/field",
// dest: "relative/path" }, ...] — see the "file__" field-naming convention
// documented in README.md's Secret Management section.
function restoreSecretFiles(config, projectDir) {
  const files = config.secretFiles || [];
  if (!files.length) return { ok: true, failed: [] };

  if (isDryRun()) {
    files.forEach((f) => console.log(`🧪 [dry-run] op read ${f.ref} -o ${f.dest} would have been run.`));
    return { ok: true, failed: [] };
  }

  // Installation and authorization are both handled upstream (checkPrerequisites
  // + ensureOpReady, called once before any per-project step); this is just a
  // defensive re-check in case this function is ever called on its own.
  if (!isOpAvailable() || !isOpSignedIn()) {
    console.log(`⚠️  1Password CLI not ready, can't restore: ${files.map((f) => f.dest).join(', ')}. Fetch these manually.`);
    return { ok: false, failed: files.map((f) => f.dest) };
  }

  const failed = [];
  for (const f of files) {
    const destPath = path.join(projectDir, f.dest);
    if (fs.existsSync(destPath)) {
      console.log(`ℹ️  ${f.dest} already exists, left untouched.`);
      continue;
    }
    try {
      execFileSync('op', ['read', f.ref, '-o', destPath], { stdio: 'inherit' });
      console.log(`✅ Restored ${f.dest} from 1Password.`);
    } catch (err) {
      console.log(`⚠️  Could not restore ${f.dest}: ${err.message}`);
      failed.push(f.dest);
    }
  }
  return { ok: failed.length === 0, failed };
}

module.exports = { ensureOpReady, injectWith1Password, restoreSecretFiles, isOpAvailable, isOpSignedIn };
