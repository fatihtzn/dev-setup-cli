#!/usr/bin/env node
// Migrates a project's real local .env (+ any extra files, e.g. a dev HTTPS
// cert/key pair) into a 1Password item, following the convention documented
// in README.md's "Secret Management (1Password)" section:
//
//   - vault: a shared team vault everyone using this tool already has access
//     to (never a personal vault — those won't work for teammates)
//   - item: "[dev-setup-cli] <repo-name>", one field per env var (field
//     id/label = exact env var name), extra files as "file__<name>" fields
//
// Running this alone is often ENOUGH: the tool's dynamic secret-resolution
// flow (src/steps/dynamicSecrets.js) auto-discovers an item titled exactly
// "[dev-setup-cli] <repo-name>" across every vault the user has access to,
// with no config/projects.json entry needed. Only bother writing a static
// config/env-templates/<repo>.env.tpl + projects.json entry (see README.md's
// Secret Management section) if you specifically want the fully
// pre-configured, zero-prompt path instead of the one-question dynamic flow.
//
// Usage:
//   node scripts/migrate-env-to-1password.js \
//     --vault <vault-name-or-id> \
//     --repo <repo-name> \
//     --env-dir /path/to/a/working/local/checkout \
//     [--source-env-file .env.development.local] \
//     [--file some.cert --file some.key ...]
// --source-env-file defaults to ".env" -- set it when the project's real,
// currently-working values live in a different file (e.g. a Vite project
// where .env.<mode>.local is what's actually loaded for local dev).
//
// Safety notes (all learned the hard way, see the inline comments below for
// what actually broke and why):
//   - Real values never touch stdout/stderr/CLI args (no shell history/process
//     list exposure) -- they're written to a 0600 temp file, fed to `op` via
//     a real file descriptor, then deleted.
//   - Requires 1Password CLI installed + authorized (this tool's own
//     checkPrerequisites/ensureOpReady handle that during a normal `dev-setup-cli`
//     run; run those first, or just `op vault list` to check manually).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function parseArgs(argv) {
  const args = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault') args.vault = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--env-dir') args.envDir = argv[++i];
    // NOT named "--env-file" -- that collides with Node's own native
    // --env-file flag (added in Node 20.6+), which node's CLI parser
    // intercepts itself no matter where it appears in argv, even after the
    // script path. It silently swallows the value and tries (and fails) to
    // load it as a dotenv file relative to cwd, and this script never even
    // sees the flag (confirmed directly: "node: .env.development.local: not
    // found", exit code 9 -- that error is Node's own, not this script's).
    else if (a === '--source-env-file') args.envFile = argv[++i];
    else if (a === '--file') args.files.push(argv[++i]);
  }
  return args;
}

// Strips a trailing ` # comment` after a closing quote. A naive
// `value.slice(eq+1).trim()` swallows the comment into the value itself --
// hit this exactly once, on a line like `KEY="1.0" # note`, and it silently
// stored `"1.0" # note` as the field's actual value in 1Password.
function parseEnvLine(rawValue) {
  let value = rawValue.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const closingIdx = value.indexOf(quote, 1);
    if (closingIdx !== -1) return value.slice(1, closingIdx);
  }
  return value;
}

function parseEnv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const map = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    map.set(key, parseEnvLine(trimmed.slice(eq + 1)));
  }
  return map;
}

function findItemIdByTitle(vault, title) {
  const out = execFileSync('op', ['item', 'list', '--vault', vault, '--format=json'], { encoding: 'utf8' });
  const items = JSON.parse(out);
  const match = items.find((i) => i.title === title);
  return match ? match.id : null;
}

// Feeds JSON to `op` via a real file descriptor rather than spawnSync's
// `input:` option. With `input:`, a large multi-field template was accepted
// silently (exit 0, item version incremented) but the fields never actually
// landed -- confirmed by re-fetching the item afterward. The exact same JSON
// piped from a file via a plain shell (`cat file | op ...`) worked every
// time, so whatever's broken is specific to spawnSync's `input:` handling
// for this binary, not the content. Used for `op item edit`, whose stdin
// handling works correctly with this approach.
function runOpWithJsonStdin(args, jsonBody) {
  const tmpFile = path.join(os.tmpdir(), `op-item-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(jsonBody), { mode: 0o600 });
  try {
    const fd = fs.openSync(tmpFile, 'r');
    try {
      return spawnSync('op', args, { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8' });
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

// `op item create`'s stdin/piped-template handling is broken in this CLI
// version -- confirmed directly, in plain bash with no Node involved at
// all: `op item create --vault <v> --category "Secure Note" - < file.json`
// (and the same with `<` swapped for `|`, and with/without the trailing
// `-`) always produces a blank "Untitled SecureNote" item with none of the
// template's title/fields applied, silently (exit 0). The exact same
// template via `--template=<path>` instead works correctly every time. So
// CREATE uses --template (only the file PATH becomes a CLI arg -- the
// secret values inside it never do), while EDIT above keeps using stdin,
// which works fine there.
function runOpWithTemplateFile(args, jsonBody) {
  const tmpFile = path.join(os.tmpdir(), `op-item-${Date.now()}-${process.pid}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(jsonBody), { mode: 0o600 });
  try {
    return spawnSync('op', [...args, `--template=${tmpFile}`], { encoding: 'utf8' });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function main() {
  const { vault, repo, envDir, envFile, files } = parseArgs(process.argv.slice(2));
  if (!vault || !repo || !envDir) {
    console.error(
      'Usage: node migrate-env-to-1password.js --vault <vault-name-or-id> --repo <name> --env-dir <path> [--file <name> ...]'
    );
    process.exit(1);
  }

  const title = `[dev-setup-cli] ${repo}`;
  const envMap = parseEnv(path.join(envDir, envFile || '.env'));

  const fields = [];
  for (const [k, v] of envMap.entries()) {
    fields.push({ id: k, type: 'CONCEALED', label: k, value: v, section: { id: 'env' } });
  }
  for (const filename of files) {
    const content = fs.readFileSync(path.join(envDir, filename), 'utf8');
    const fieldName = `file__${filename.replace(/\./g, '_')}`;
    fields.push({ id: fieldName, type: 'CONCEALED', label: fieldName, value: content, section: { id: 'files' } });
  }

  const sections = [{ id: 'env', label: 'Env vars' }];
  if (files.length) sections.push({ id: 'files', label: 'Files (dev-setup-cli file__ convention)' });

  const existingId = findItemIdByTitle(vault, title);

  let result;
  if (existingId) {
    // No "category" key in the body, and no trailing '-' argument -- both
    // silently break `op item edit`'s piped-template handling (see
    // README.md's Secret Management section for the two failure modes this
    // avoids: category-in-body-plus-flag conflicts and the '-' arg being
    // parsed as a no-op assignment instead of "read stdin").
    result = runOpWithJsonStdin(['item', 'edit', existingId, '--vault', vault], { title, sections, fields });
  } else {
    // See runOpWithTemplateFile's comment -- `item create` needs
    // --template=<file>, not stdin. category must still be given ONLY via
    // --category, never also in the JSON body, or the whole template
    // silently gets dropped (the earlier, separate bug this avoided before
    // the stdin one was found).
    result = runOpWithTemplateFile(
      ['item', 'create', '--vault', vault, '--category', 'Secure Note'],
      { title, sections, fields }
    );
  }

  if (result.status !== 0) {
    console.error('FAILED:', result.stderr);
    process.exit(1);
  }

  const itemId = existingId || findItemIdByTitle(vault, title);
  console.log(`OK: ${existingId ? 'updated' : 'created'} item ${itemId} ("${title}") in vault ${vault}`);
  console.log(`Env fields: ${[...envMap.keys()].join(', ')}`);
  if (files.length) console.log(`File fields: ${files.map((f) => `file__${f.replace(/\./g, '_')}`).join(', ')}`);
  console.log(
    `\nDone — the dynamic secret flow will now auto-discover this item for "${repo}" with no further setup. ` +
      `(Optional: write config/env-templates/${repo}.env.tpl with op://${vault}/${itemId}/<FIELD> refs + a projects.json entry for the fully pre-configured path instead — see README.md.)`
  );
}

main();
