const { execFileSync } = require('child_process');
const { commandExists } = require('../platform');
const { isDryRun } = require('../dryRunState');

function isOpAvailable() {
  return commandExists('op');
}

function isOpSignedIn() {
  try {
    execFileSync('op', ['whoami'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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

  if (!isOpAvailable()) {
    console.log(
      '⚠️  1Password CLI (op) not found. Install: "brew install 1password-cli" (macOS) / "winget install AgileBits.1Password-CLI" (Windows)'
    );
    return { ok: false, reason: 'op-not-found' };
  }

  if (!isOpSignedIn()) {
    console.log(
      '⚠️  1Password CLI does not appear to be signed in. Enable "Integrate with 1Password CLI" in the 1Password desktop app, or run `op signin`.'
    );
    return { ok: false, reason: 'not-signed-in' };
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

module.exports = { injectWith1Password, isOpAvailable, isOpSignedIn };
