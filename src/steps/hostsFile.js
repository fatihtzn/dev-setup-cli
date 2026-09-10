const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { execSync } = require('child_process');
const prompts = require('prompts');
const { getPlatform } = require('../platform');
const { isDryRun } = require('../dryRunState');

const WINDOWS_HOSTS_PATH = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
const POSIX_HOSTS_PATH = '/etc/hosts';
const LOCAL_NAMES = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];

function hostsFilePath() {
  return getPlatform() === 'windows' ? WINDOWS_HOSTS_PATH : POSIX_HOSTS_PATH;
}

// Some dev servers bind to a specific hostname from HOST= in .env (rather
// than 0.0.0.0/127.0.0.1) — usually because the project needs HTTPS with a
// fixed cookie/CORS domain. That hostname only resolves at all if it's
// either a real DNS record or a manual /etc/hosts entry pointing it at
// 127.0.0.1; without either, the dev server's own listen() call fails with
// "getaddrinfo ENOTFOUND <host>" before it even gets to print an error
// about a missing cert or anything else — confirmed directly: a plain
// net.Server.listen() on an unresolvable hostname throws exactly that.
function readEnvHost(projectDir) {
  const envPath = path.join(projectDir, '.env');
  if (!fs.existsSync(envPath)) return null;
  const content = fs.readFileSync(envPath, 'utf-8');
  const match = content.match(/^HOST=["']?([^"'\n]+)["']?/m);
  return match ? match[1].trim() : null;
}

function resolvesToLoopback(host) {
  return new Promise((resolve) => {
    dns.lookup(host, (err, address) => {
      if (err) return resolve(false);
      resolve(address === '127.0.0.1' || address === '::1');
    });
  });
}

// Checks the hosts file directly (rather than just trusting a successful
// dns.lookup) so re-runs don't append a duplicate line if the entry is
// there but, for whatever local resolver-caching reason, dns.lookup missed it.
function alreadyInHostsFile(host) {
  try {
    const content = fs.readFileSync(hostsFilePath(), 'utf-8');
    return new RegExp(`^\\s*\\S+\\s+.*\\b${host.replace(/\./g, '\\.')}\\b`, 'm').test(content);
  } catch {
    return false;
  }
}

// Only ever appends a single "127.0.0.1 <host>" line for the exact
// hostname this specific project declared in its own .env — never touches
// or removes any existing entry, and only after explicit per-run
// confirmation (this edits a system file, so it's never done silently).
async function ensureHostsEntry(projectDir) {
  if (isDryRun()) return;

  const host = readEnvHost(projectDir);
  if (!host || LOCAL_NAMES.includes(host)) return;

  if ((await resolvesToLoopback(host)) || alreadyInHostsFile(host)) return;

  console.log(
    `\n🌐 This project's dev server binds to "${host}" specifically, but that hostname doesn't currently resolve to your own machine — it needs a hosts file entry (${hostsFilePath()}) or the dev server will fail to start.`
  );
  const { addEntry } = await prompts({
    type: 'confirm',
    name: 'addEntry',
    message: `Add "127.0.0.1 ${host}" to your hosts file now? (${
      getPlatform() === 'windows' ? 'requires this terminal to be running as Administrator' : 'will ask for your password'
    })`,
    initial: true,
  });
  if (!addEntry) {
    console.log(`ℹ️  Skipped — add "127.0.0.1 ${host}" to ${hostsFilePath()} manually if the dev server fails to start.`);
    return;
  }

  try {
    if (getPlatform() === 'windows') {
      execSync(`powershell -Command "Add-Content -Path '${WINDOWS_HOSTS_PATH}' -Value '127.0.0.1 ${host}'"`, {
        stdio: 'inherit',
      });
    } else {
      // grep -qxF guard makes this idempotent even if dns.lookup's cache
      // made the check above miss an entry that's actually already there.
      execSync(`sudo sh -c 'grep -qxF "127.0.0.1 ${host}" ${POSIX_HOSTS_PATH} || echo "127.0.0.1 ${host}" >> ${POSIX_HOSTS_PATH}'`, {
        stdio: 'inherit',
      });
    }
    console.log(`✅ Added "127.0.0.1 ${host}" to your hosts file.`);
  } catch (err) {
    console.log(`⚠️  Could not update the hosts file automatically: ${err.message}`);
    console.log(`   Add this line to ${hostsFilePath()} manually: 127.0.0.1 ${host}`);
  }
}

module.exports = { ensureHostsEntry };
