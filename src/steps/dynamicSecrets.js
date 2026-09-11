const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const prompts = require('prompts');
const { isDryRun } = require('../dryRunState');
const { isOpAvailable, isOpSignedIn } = require('./secrets');
const { installOp } = require('./checkPrerequisites');

// Interactive fallback for when a project has no static secretManager
// configured in config/projects.json — see setupEnv() in setupProject.js,
// which calls this right before its old "just plain-copy .env.example"
// behavior. Offers three ways to fill in a project's real .env: pull values
// from 1Password, copy from a working local checkout, or skip (today's
// existing plain-copy behavior). Returns true if it wrote `.env` itself
// (caller should do nothing further), false if the caller should fall back
// to its own plain-copy of the example file (the "skip" choice, a cancelled
// prompt, or dry-run).

// Same one-time-per-machine authorization dance as secrets.js's
// ensureOpReady, but triggered here just-in-time (this path only learns a
// project needs 1Password interactively, after any up-front prerequisite
// check already ran) and with an inline install offer since checkPrerequisites
// never got a chance to install `op` for a project it didn't know needed it.
async function ensureOpReadyInteractive() {
  if (!isOpAvailable()) {
    const { install } = await prompts({
      type: 'confirm',
      name: 'install',
      message: '1Password CLI (op) is not installed. Install it now?',
      initial: true,
    });
    if (!install) return false;
    const installed = await installOp();
    if (!installed) {
      console.log('⚠️  Could not install the 1Password CLI automatically.');
      return false;
    }
  }

  if (isOpSignedIn()) return true;

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
    console.log('✅ 1Password CLI is authorized.\n');
    return true;
  }
  console.log('⚠️  Still not authorized.\n');
  return false;
}

function parseCommaList(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Fetches an item's FIELD NAMES only (never values) so the generated
// template can tell which .env.example keys actually have something to pull.
// Also used for auto-discovery below, so it returns the whole parsed item.
function fetchItem(vault, item) {
  const args = vault ? ['item', 'get', item, '--vault', vault, '--format=json'] : ['item', 'get', item, '--format=json'];
  const raw = execFileSync('op', args, { encoding: 'utf8' });
  return JSON.parse(raw);
}

function fieldNamesOf(parsedItem) {
  return new Set(parsedItem.fields.map((f) => f.label));
}

// Looks for an item titled "[dev-setup-cli] <repoName>" — the convention
// documented in README.md's Secret Management section — searching across
// every vault the user has access to (`op item get` resolves by title alone
// just fine, no --vault needed, as long as the title is unique). Lets a
// project that already has a pre-configured item skip the vault/item
// prompts entirely; returns null if no such item exists yet.
function findPreConfiguredItem(repoName) {
  try {
    return fetchItem(null, `[dev-setup-cli] ${repoName}`);
  } catch {
    return null;
  }
}

async function tryOnePassword(examplePath, envPath, projectDir) {
  const ready = await ensureOpReadyInteractive();
  if (!ready) return false;

  const repoName = path.basename(projectDir);
  const preConfigured = findPreConfiguredItem(repoName);

  let vault;
  let item;
  let fieldNames;

  if (preConfigured) {
    vault = preConfigured.vault.id;
    item = preConfigured.id;
    fieldNames = fieldNamesOf(preConfigured);
    console.log(`✅ Found a pre-configured 1Password item for "${repoName}" — using it automatically.`);
  } else {
    console.log(`ℹ️  No "[dev-setup-cli] ${repoName}" item found in any vault you have access to.`);
    const { vault: enteredVault } = await prompts({ type: 'text', name: 'vault', message: '1Password vault name or ID:' });
    if (!enteredVault) return false;
    const { item: enteredItem } = await prompts({ type: 'text', name: 'item', message: '1Password item name or ID:' });
    if (!enteredItem) return false;
    vault = enteredVault;
    item = enteredItem;

    try {
      fieldNames = fieldNamesOf(fetchItem(vault, item));
    } catch (err) {
      console.log(`⚠️  Could not read item "${item}" from vault "${vault}": ${err.message}`);
      return false;
    }
  }

  // Build the env template IN MEMORY, swapping in an op:// reference only
  // for keys that actually have a matching field on the item — anything
  // else is left as the example file's own original default. `op inject`
  // fails the WHOLE file on a single bad reference, so guessing wrong here
  // for even one key would break every other key too.
  const exampleContent = fs.readFileSync(examplePath, 'utf8');
  let matchedCount = 0;
  const templateLines = exampleContent.split('\n').map((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!m) return line;
    const key = m[1];
    if (!fieldNames.has(key)) return line;
    matchedCount++;
    return `${key}="op://${vault}/${item}/${key}"`;
  });

  const tmpFile = path.join(os.tmpdir(), `dev-setup-cli-env-${Date.now()}.tpl`);
  fs.writeFileSync(tmpFile, templateLines.join('\n'));
  try {
    execFileSync('op', ['inject', '-i', tmpFile, '-o', envPath], { stdio: 'inherit' });
  } catch (err) {
    console.log(`⚠️  1Password injection failed: ${err.message}`);
    return false;
  } finally {
    fs.unlinkSync(tmpFile);
  }
  console.log(
    `✅ .env created — ${matchedCount} value(s) pulled from 1Password, the rest left as the project's example defaults.`
  );

  // Extra (non-.env) files are auto-detected from the item's own fields —
  // no prompt needed. Every "file__<name>" field is restored automatically;
  // the destination filename is reconstructed by dropping the "file__"
  // prefix and turning underscores back into dots (the exact inverse of how
  // the convention encodes a filename — see README.md's Secret Management
  // section). This is a best-effort reversal: a real filename that itself
  // contains an underscore would round-trip as a dot instead. Rare enough
  // in practice (cert/key/config filenames are almost always dot-separated)
  // that asking the user to type filenames from memory every single run —
  // the actual friction this replaces — is a worse trade-off.
  const fileFieldPrefix = 'file__';
  const fileFields = [...fieldNames].filter((name) => name.startsWith(fileFieldPrefix));
  for (const fieldName of fileFields) {
    const filename = fieldName.slice(fileFieldPrefix.length).replace(/_/g, '.');
    const destPath = path.join(projectDir, filename);
    if (fs.existsSync(destPath)) {
      console.log(`ℹ️  ${filename} already exists, left untouched.`);
      continue;
    }
    try {
      // `op read -o` prompts interactively to confirm an overwrite if the
      // destination already exists; since that can't be answered in a
      // non-TTY context it just fails ("cannot prompt for confirmation") —
      // moot here since the existsSync check above already skips that case,
      // but -f makes this robust regardless.
      execFileSync('op', ['read', `op://${vault}/${item}/${fieldName}`, '-o', destPath, '-f'], {
        stdio: 'inherit',
      });
      console.log(`✅ Restored ${filename} from 1Password.`);
    } catch (err) {
      console.log(`⚠️  Could not restore ${filename}: ${err.message}`);
    }
  }

  return true;
}

async function tryLocalCopy(envPath, projectDir, envFileBasename) {
  const { sourcePath } = await prompts({
    type: 'text',
    name: 'sourcePath',
    message: 'Path to a working local checkout (or directly to its env file):',
  });
  if (!sourcePath) return false;

  if (!fs.existsSync(sourcePath)) {
    console.log(`⚠️  "${sourcePath}" doesn't exist.`);
    return false;
  }
  const resolved = fs.statSync(sourcePath).isDirectory() ? path.join(sourcePath, envFileBasename) : sourcePath;
  if (!fs.existsSync(resolved)) {
    console.log(`⚠️  "${resolved}" doesn't exist.`);
    return false;
  }

  fs.copyFileSync(resolved, envPath);
  console.log(`✅ .env copied from ${resolved}.`);

  const sourceDir = path.dirname(resolved);
  const { extraFiles } = await prompts({
    type: 'text',
    name: 'extraFiles',
    message: 'Extra files to copy too (e.g. a cert/key) — comma-separated filenames, or leave blank:',
  });
  for (const filename of parseCommaList(extraFiles)) {
    const src = path.join(sourceDir, filename);
    if (!fs.existsSync(src)) {
      console.log(`⚠️  "${src}" doesn't exist, skipping.`);
      continue;
    }
    fs.copyFileSync(src, path.join(projectDir, filename));
    console.log(`✅ Copied ${filename}.`);
  }

  return true;
}

async function resolveSecretsInteractively(examplePath, envPath, projectDir, envFileBasename) {
  if (isDryRun()) {
    console.log('🧪 [dry-run] would ask how to fill in .env (local copy / 1Password / skip).');
    return false;
  }

  const { choice } = await prompts({
    type: 'select',
    name: 'choice',
    message: 'How do you want to fill in this project\'s .env?',
    // "local" is first/default (plain Enter picks it) — it's the fastest
    // path when you already have a working checkout, and needs nothing set
    // up in 1Password first. 1Password is second: reach for it deliberately
    // once a project has an item worth auto-discovering.
    initial: 0,
    choices: [
      { title: 'Copy from a working local checkout', value: 'local' },
      { title: 'Pull values from 1Password', value: '1password' },
      { title: "I don't know / skip for now (use example defaults)", value: 'skip' },
    ],
  });

  if (choice === '1password') return tryOnePassword(examplePath, envPath, projectDir);
  if (choice === 'local') return tryLocalCopy(envPath, projectDir, envFileBasename);
  return false;
}

module.exports = { resolveSecretsInteractively };
