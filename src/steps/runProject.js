const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isDryRun } = require('../dryRunState');
const { waitForPort } = require('./healthCheck');
const { getNvmCommandPrefix, getPlatform, openUrl } = require('../platform');

// Tried FIRST: a full URL with scheme (http/https) and any hostname — not
// just localhost/127.0.0.1/0.0.0.0. Dev servers bound to a custom host
// (e.g. HOST=my-app.local in .env, common for projects that need HTTPS or
// a specific cookie domain) print that exact hostname, not "localhost" —
// matching it here means the port gets detected AND the eventual
// success/auto-open URL uses the right scheme+host instead of guessing
// "http://localhost:<port>" and being wrong for such a project.
const URL_PATTERN = /(https?):\/\/([a-zA-Z0-9.-]+):(\d{2,5})/;
// Fallback: covers the typical bare "port" output of tools like Vite,
// Next.js, CRA, Vue CLI, Express/Nest when no full URL was printed.
const PORT_PATTERNS = [/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/i, /port[:\s]+(\d{3,5})/i];

// Most common dev server ports to try if the port can't be captured from the log.
const COMMON_DEV_PORTS = [3000, 5173, 8080, 4200, 5000, 8000, 4000];

// command.split(' ') incorrectly splits quoted arguments (e.g. --title "My
// App") and turns extra spaces into empty string tokens. This simple parser
// keeps a block inside double/single quotes as a single argument; it's not
// a full shell parser (doesn't support nested/escaped quotes) but it's
// enough for all the commands we support (npm/yarn/pnpm/npx/php run commands).
function parseCommand(command) {
  const TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const parts = [];
  let match;
  while ((match = TOKEN_RE.exec(command)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

function detectPackageManager(projectDir) {
  if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

// Looks for the dev/start/serve convention in package.json's scripts field
// (the most common "run the project" script names in the JS ecosystem).
function detectNpmRunScript(projectDir) {
  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }

  const scripts = pkg.scripts || {};
  const pm = detectPackageManager(projectDir);
  // We run yarn/pnpm through corepack instead of calling it bare from PATH —
  // see the ensureCorepackAvailable comment in setupProject.js: a globally
  // installed yarn/pnpm on PATH may not match the version the project has
  // pinned (package.json's "packageManager" field).
  const runner = pm === 'npm' ? pm : `corepack ${pm}`;
  for (const candidate of ['dev', 'start', 'serve']) {
    if (scripts[candidate]) return `${runner} run ${candidate}`;
  }
  return null;
}

const README_RUN_HEADING_RE =
  /^#+\s*(getting started|installation|install|setup|run|running|development|local development|start)/i;
// Only single-line commands that start with a known package manager command
// and run a "dev/start/serve" script are considered safe and run
// automatically. Since READMEs aren't written to be run by a machine (they
// can contain placeholders, platform-specific alternatives, sudo/rm-style
// examples), no other line is ever run automatically.
const SAFE_CMD_RE = /^(npm|yarn|pnpm|npx)\s+(run\s+)?(dev|start|serve)\b/i;

function findReadmeFile(projectDir) {
  const candidates = ['README.md', 'Readme.md', 'readme.md', 'README.MD'];
  return candidates.find((f) => fs.existsSync(path.join(projectDir, f))) || null;
}

// Scans code blocks under headings like "run/setup/installation" in
// README.md. Returns a safe command if it finds one; otherwise (but if
// there are other command lines in that section) returns "hints" for the
// user to check manually.
function detectReadmeRunCommand(projectDir) {
  const readmeFile = findReadmeFile(projectDir);
  if (!readmeFile) return { command: null, hints: [] };

  const lines = fs.readFileSync(path.join(projectDir, readmeFile), 'utf-8').split('\n');

  let inRelevantSection = false;
  let inCodeBlock = false;
  let currentHeadingLevel = 0;
  const hints = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#+)\s*(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      if (README_RUN_HEADING_RE.test(line)) {
        inRelevantSection = true;
        currentHeadingLevel = level;
      } else if (inRelevantSection && level <= currentHeadingLevel) {
        inRelevantSection = false;
      }
      continue;
    }

    if (!inRelevantSection) continue;

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (!inCodeBlock) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (SAFE_CMD_RE.test(trimmed)) {
      return { command: trimmed, hints: [] };
    }
    if (hints.length < 5) hints.push(trimmed);
  }

  return { command: null, hints };
}

// Laravel projects have an `artisan` script at their root; the mere
// presence of this single file is common, sufficient evidence that "this is
// a Laravel project". `php artisan serve` listens on http://127.0.0.1:8000
// by default and prints it to stdout, so port sniffing works without any extra effort.
function detectArtisanRunCommand(projectDir) {
  return fs.existsSync(path.join(projectDir, 'artisan')) ? 'php artisan serve' : null;
}

// Priority order: 1) explicit runCommand in config/projects.json  2)
// package.json's dev/start/serve script  3) Laravel artisan  4) a safe
// command extracted from README.md.
function detectRunCommand(config, projectDir) {
  if (config.runCommand) return { command: config.runCommand, source: 'config override' };

  const npmScript = detectNpmRunScript(projectDir);
  if (npmScript) return { command: npmScript, source: 'package.json script' };

  const artisanCommand = detectArtisanRunCommand(projectDir);
  if (artisanCommand) return { command: artisanCommand, source: 'Laravel (artisan)' };

  const readme = detectReadmeRunCommand(projectDir);
  if (readme.command) return { command: readme.command, source: 'README.md' };
  if (readme.hints.length) return { command: null, hints: readme.hints, source: 'README.md' };

  return null;
}

// child.pid is the FIRST process we spawn (bash, or yarn/corepack directly)
// — the actual dev server (vite/webpack-dev-server, nodemon etc.) is almost
// always a child/grandchild of it (chains like corepack -> yarn -> vite, or
// the nvm-prefixed "bash -c '...; nvm install; command'" chain). Since we
// use detached: true, on POSIX this top process becomes the leader of its
// own process group (pgid === pid); a plain "kill PID" ONLY kills that one
// top process, the child that actually holds the port survives, and it
// looks like "kill isn't working" (observed in a real user report). Kill
// with a negative PID kills the whole process group (the top process + all
// its children/grandchildren). On Windows "kill" isn't a native command,
// and since PID belongs to a cmd.exe wrapper because of shell: true,
// taskkill is used with "/T" (include the subtree) and "/F" (force).
function getStopCommand(pid) {
  return getPlatform() === 'windows' ? `taskkill /PID ${pid} /T /F` : `kill -- -${pid}`;
}

// Name of the small marker file dropped in a project's own directory
// (alongside .dev-setup-run.log — same convention, never committed to that
// project's repo) recording the PID of the process group runProject
// started, so `bin/stop.js` can find and stop it later without the user
// having to remember or copy a raw `kill -- -<pid>` command out of old
// terminal scrollback.
const PID_FILE_NAME = '.dev-setup-cli.pid.json';

function writePidFile(projectDir, pid, command) {
  try {
    fs.writeFileSync(
      path.join(projectDir, PID_FILE_NAME),
      JSON.stringify({ pid, command, startedAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    // Non-fatal — worst case `bin/stop.js` won't find this one, the raw
    // kill command printed below still works.
  }
}

// Returns { port, url } — url is the exact string the dev server itself
// printed (correct scheme/host) when URL_PATTERN matched, null when only a
// bare port number could be found (PORT_PATTERNS fallback).
function sniffFromLog(logPath) {
  if (!fs.existsSync(logPath)) return null;
  const content = fs.readFileSync(logPath, 'utf-8');

  const urlMatch = content.match(URL_PATTERN);
  if (urlMatch) {
    const port = parseInt(urlMatch[3], 10);
    if (!Number.isNaN(port)) return { port, url: `${urlMatch[1]}://${urlMatch[2]}:${port}` };
  }

  for (const re of PORT_PATTERNS) {
    const match = content.match(re);
    if (match) {
      const port = parseInt(match[1], 10);
      if (!Number.isNaN(port)) return { port, url: null };
    }
  }
  return null;
}

// Records which common ports are already open BEFORE spawning (unrelated to
// the process we're starting). Otherwise, the fallback that kicks in when
// the port can't be captured from the log could mistake, say, port 3000
// left open by another project the developer already has running, for our
// newly started service, and wrongly report it as "ready".
async function snapshotOpenPorts(ports) {
  const results = await Promise.all(ports.map((port) => waitForPort(port, { timeoutMs: 300, intervalMs: 300 })));
  return new Set(ports.filter((_, i) => results[i].ok));
}

// Checks config.runPort first, then the port (and, if available, the exact
// URL) captured from log output, and if that's not there either, the first
// of the most common dev server ports that was CLOSED before spawn and
// later opened (all best-effort). Always returns { port, url } (url is null
// unless a full URL was sniffed from the log) or null if nothing was found.
async function detectPort(config, logPath, preOpenPorts, { sniffTimeoutMs = 15000, sniffIntervalMs = 1000 } = {}) {
  if (config.runPort) return { port: config.runPort, url: null };

  const start = Date.now();
  while (Date.now() - start < sniffTimeoutMs) {
    const found = sniffFromLog(logPath);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, sniffIntervalMs));
  }

  for (const port of COMMON_DEV_PORTS) {
    if (preOpenPorts.has(port)) continue;
    const result = await waitForPort(port, { timeoutMs: 1500, intervalMs: 500 });
    if (result.ok) return { port, url: null };
  }

  return null;
}

// For projects that don't require Docker, once setup is finished, starts
// the dev server in the background (detached), detects its port, and waits
// until it starts listening — the goal is to reflect the running project
// (as a URL) on screen without any manual intervention beyond the tool.
// Returns { ok, skipped?, reason? } so the caller (bin/setup.js) can tell a
// genuinely confirmed-running dev server apart from "we don't know how to
// start this" or "it started but we couldn't confirm it's reachable" —
// without this, the final "🎉 Setup complete" message printed unconditionally
// even when the dev server had visibly failed to start (observed directly:
// an HTTPS project missing its cert file crashed on every start, yet the
// tool still reported success because only Docker's status was checked).
async function runProject(config, projectDir) {
  if (config.requiresDocker) return { ok: true, skipped: true }; // dockerUp already handles this case

  const detected = detectRunCommand(config, projectDir);

  if (!detected || !detected.command) {
    if (detected && detected.hints && detected.hints.length) {
      console.log(
        '\nℹ️  No safe/automatic start command found for this project. The following lines were found in README.md, you may need to run them manually:\n'
      );
      detected.hints.forEach((h) => console.log(`  ${h}`));
    } else {
      console.log(
        '\nℹ️  No automatic start command found for this project (via config override, package.json script, or README.md). You may need to check README.md.'
      );
    }
    return { ok: true, skipped: true, reason: 'no-command' };
  }

  const { command, source } = detected;

  if (isDryRun()) {
    console.log(`🧪 [dry-run] Project would have been started (${source}): ${command}`);
    return { ok: true, simulated: true };
  }

  console.log(`\n🚀 Starting project (${source}): ${command}`);

  const logPath = path.join(projectDir, '.dev-setup-run.log');
  const logFd = fs.openSync(logPath, 'w');

  // Record the port state before spawning (see detectPort/snapshotOpenPorts).
  const preOpenPorts = await snapshotOpenPorts(COMMON_DEV_PORTS);

  // Setup may have compiled native dependencies (if any) against the right
  // Node version (see setupProject.js), but if the project isn't RUN with
  // that same version, it can still blow up from a Node ABI mismatch. The
  // same .nvmrc/engines.node detection is applied here too, and the command
  // is started through bash (after nvm switches to the right version).
  const nvmPrefix = getNvmCommandPrefix(projectDir);
  let cmd;
  let args;
  if (nvmPrefix) {
    cmd = 'bash';
    args = ['-c', `${nvmPrefix}${command}`];
  } else {
    [cmd, ...args] = parseCommand(command);
  }
  const child = spawn(cmd, args, {
    cwd: projectDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    shell: process.platform === 'win32',
  });
  child.unref();

  // If the 'error' event isn't listened for (e.g. if the cmd command — like
  // yarn/pnpm/php — isn't on PATH), Node.js throws an unhandled exception
  // and crashes the script. This listener both turns the startup error
  // (ENOENT) into a clean message, and stays registered for the child's
  // whole lifetime so it also prevents a later possible error from
  // crashing the script.
  const spawnResult = await new Promise((resolve) => {
    child.once('spawn', () => resolve({ ok: true }));
    child.once('error', (err) => resolve({ ok: false, error: err }));
  });

  if (!spawnResult.ok) {
    console.log(
      `⚠️  Could not run "${cmd}" (it may not be installed): ${spawnResult.error.message}`
    );
    return { ok: false, reason: 'spawn-failed' };
  }

  writePidFile(projectDir, child.pid, command);
  const stopHint = `To stop it: node bin/stop.js ${path.basename(projectDir)}   (or manually: ${getStopCommand(child.pid)})`;

  console.log(`⏳ Waiting for the service to come up (logs: ${logPath})...`);
  const detectedPort = await detectPort(config, logPath, preOpenPorts);

  if (!detectedPort) {
    console.log(
      `⚠️  Process started in the background (PID: ${child.pid}) but could not detect which port it's listening on. Check the logs: ${logPath}`
    );
    console.log(`   ${stopHint}`);
    return { ok: false, reason: 'port-not-detected' };
  }

  const { port, url: sniffedUrl } = detectedPort;
  const result = await waitForPort(port, { timeoutMs: 60000 });
  // Prefer the exact URL the dev server itself printed (correct scheme and
  // hostname — e.g. a project bound to a custom HTTPS host) over guessing
  // "http://localhost:<port>", which would be wrong for such a project.
  const url = sniffedUrl || `http://localhost:${port}`;

  if (result.ok) {
    console.log(`✅ Project is running: ${url} (PID: ${child.pid})`);
    console.log(`   ${stopHint}   (logs: ${logPath})`);
    if (openUrl(url)) {
      console.log('🌐 Opened in your browser.');
    }
    return { ok: true };
  }

  console.log(`⚠️  Could not connect to ${url}. Process PID: ${child.pid}, logs: ${logPath}`);
  console.log(`   ${stopHint}`);
  return { ok: false, reason: 'unreachable' };
}

module.exports = {
  runProject,
  detectRunCommand,
  detectNpmRunScript,
  detectArtisanRunCommand,
  detectReadmeRunCommand,
  PID_FILE_NAME,
  getStopCommand,
};
