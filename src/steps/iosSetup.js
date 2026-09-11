const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const prompts = require('prompts');
const { getPlatform, run } = require('../platform');
const { isDryRun } = require('../dryRunState');
const { ensureScopes } = require('./githubAuth');

// A native iOS project is built/run entirely through Xcode's own GUI (pick
// a scheme, ⌘B) — there's no dev-server-style CLI command to start or
// health-check the way runProject.js does for web projects, and generally
// no .env file either. Auto-detected purely from the cloned repo's own
// files (an .xcodeproj/.xcworkspace at the root), same philosophy as the
// docker-compose/package.json auto-detection elsewhere — no config needed.
function detectXcodeProject(projectDir) {
  const entries = fs.readdirSync(projectDir);
  return entries.some((e) => e.endsWith('.xcodeproj') || e.endsWith('.xcworkspace'));
}

function findXcodeProjectEntry(projectDir) {
  const entries = fs.readdirSync(projectDir);
  // Prefer a workspace over a bare project when both exist (a workspace
  // usually wraps CocoaPods/SPM setups the bare .xcodeproj alone won't build).
  return entries.find((e) => e.endsWith('.xcworkspace')) || entries.find((e) => e.endsWith('.xcodeproj'));
}

// Xcode resolves private Swift Package Manager dependencies (hosted as
// GitHub Releases/Packages) by looking up an Internet Password Keychain
// item for api.github.com — this is the exact manual step the project's own
// README's "Keychain Configuration" section walks through by hand. Reuses
// the already-signed-in gh CLI's own token rather than asking for
// credentials again. macOS-only (Keychain is an Apple concept, and iOS
// development only happens on a Mac in the first place).
async function ensureGithubTokenInKeychain() {
  if (getPlatform() !== 'macos') return;
  if (isDryRun()) {
    console.log('🧪 [dry-run] would add your GitHub token to the macOS Keychain for api.github.com.');
    return;
  }

  console.log(
    '\n🔑 This project needs a GitHub token in your macOS Keychain (api.github.com) so Xcode can download private Swift packages.'
  );
  const { addToKeychain } = await prompts({
    type: 'confirm',
    name: 'addToKeychain',
    message: 'Add it now, using your already-signed-in GitHub CLI token?',
    initial: true,
  });
  if (!addToKeychain) {
    console.log('ℹ️  Skipped — see the project README\'s "Keychain Configuration" section to do this by hand.');
    return;
  }

  try {
    const username = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
    // -U updates the item in place if one already exists for this
    // account+server, so re-running this is safe (no duplicate-item error).
    execFileSync(
      'security',
      ['add-internet-password', '-a', username, '-s', 'api.github.com', '-w', token, '-U'],
      { stdio: 'ignore' }
    );
    console.log('✅ Added your GitHub credentials to the Keychain for api.github.com.');
  } catch (err) {
    console.log(`⚠️  Could not add Keychain credentials automatically: ${err.message}`);
    console.log('   Add them by hand — see the project README\'s "Keychain Configuration" section.');
  }
}

// `git clone` only fetches LFS pointer files if `git lfs install` has been
// run at least once on this machine (it installs the smudge/clean filters
// into the user's global git config) — without it, large assets silently
// end up as tiny pointer text files instead of their real content. Both
// commands are safe to re-run (install is idempotent, pull is a no-op if
// already up to date).
function setupGitLfs(projectDir) {
  if (isDryRun()) {
    console.log('🧪 [dry-run] would run: git lfs install / git lfs pull');
    return;
  }
  try {
    run('git lfs install', { cwd: projectDir, stdio: 'ignore' });
    run('git lfs pull', { cwd: projectDir });
    console.log('✅ Git LFS assets pulled.');
  } catch (err) {
    console.log(`⚠️  Git LFS setup failed: ${err.message}`);
    console.log(
      '   Large binary assets (images, fixtures, etc.) may be missing or still be tiny pointer files instead of their real content. Try running `git lfs install && git lfs pull` yourself in the project directory — if that also fails, check `git lfs env` for a config/network issue.'
    );
  }
}

// Configures git to use the repo's own .githooks/ directory — exactly what
// the project's Scripts/setup-git-hooks.sh does; just run it if present,
// same as any other project-provided setup script.
function runGitHooksSetup(projectDir) {
  const scriptPath = path.join(projectDir, 'Scripts', 'setup-git-hooks.sh');
  if (!fs.existsSync(scriptPath)) return;
  if (isDryRun()) {
    console.log('🧪 [dry-run] would run: ./Scripts/setup-git-hooks.sh');
    return;
  }
  try {
    run('chmod +x Scripts/setup-git-hooks.sh && ./Scripts/setup-git-hooks.sh', { cwd: projectDir });
  } catch (err) {
    console.log(`⚠️  Git hooks setup script failed: ${err.message}`);
    console.log(
      '   Not fatal — this only means commit/push hooks (lint-staged, etc.) won\'t run locally yet. Try `./Scripts/setup-git-hooks.sh` yourself, or check the script\'s own output above for the actual cause.'
    );
  }
}

// Even after Xcode itself is installed (isXcodeFullyInstalled), a project's
// own xcodebuild commands can still fail with a cryptic "required plug-in
// failed to load ... IDESimulatorFoundation" error if Xcode has never
// completed its first-launch setup — normally automatic the first time
// Xcode.app is opened via the GUI, but skipped entirely when Xcode is
// installed headlessly (confirmed directly, right after a fresh `mas
// install` + license accept, with the error's own text pointing at
// `-runFirstLaunch`). Checked with `-checkFirstLaunchStatus` (Apple's own
// purpose-built flag for exactly this, exits non-zero when something's
// outstanding) rather than by reproducing the failure with a real command
// like `-list` — that also triggers this project's Swift Package
// resolution, which can legitimately take minutes over the network
// (observed directly: a `-list` call was still running after 3+ minutes),
// far too slow for a routine startup check.
function isXcodeFirstLaunchDone() {
  try {
    execFileSync('xcodebuild', ['-checkFirstLaunchStatus'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function ensureXcodeFirstLaunchDone() {
  if (isDryRun() || getPlatform() !== 'macos') return;
  if (isXcodeFirstLaunchDone()) return;

  console.log(
    "\n🛠  Xcode hasn't completed its first-launch setup yet (normally automatic the first time Xcode.app opens via the GUI — skipped here since Xcode was installed from the command line). Until this runs once, xcodebuild commands fail with a cryptic plug-in-load error instead of a clear one."
  );
  const { runFirstLaunch } = await prompts({
    type: 'confirm',
    name: 'runFirstLaunch',
    message: 'Run `sudo xcodebuild -runFirstLaunch` now? (asks for your admin password)',
    initial: true,
  });
  if (!runFirstLaunch) {
    console.log(
      '   Skipped — run `sudo xcodebuild -runFirstLaunch` yourself before building, or just open Xcode.app once via the GUI (that completes the same setup).'
    );
    return;
  }
  try {
    run('sudo xcodebuild -runFirstLaunch');
    console.log('✅ Xcode first-launch setup complete.');
  } catch (err) {
    console.log(`⚠️  \`xcodebuild -runFirstLaunch\` failed: ${err.message}`);
    console.log('   Open Xcode.app once by hand via the GUI instead — that completes the same setup.');
  }
}

// A bare Xcode install (via the App Store, mas, or otherwise) doesn't come
// with any Simulator runtime bundled — confirmed directly: `xcrun simctl
// list runtimes` returned zero runtimes right after a fresh install. Without
// one, ⌘R in Xcode has nothing to run against ("no destination" style
// errors) until a runtime is downloaded via Xcode > Settings > Platforms,
// or this (the same thing from the CLI).
function hasIosSimulatorRuntime() {
  try {
    const raw = execFileSync('xcrun', ['simctl', 'list', 'runtimes', 'available', '-j'], { encoding: 'utf8' });
    const parsed = JSON.parse(raw);
    return (parsed.runtimes || []).some((r) => /ios/i.test(r.platform || r.identifier || ''));
  } catch {
    return false; // simctl itself failing also means "not ready" -- same fix applies (run first-launch/reinstall)
  }
}

async function ensureIosSimulatorRuntime() {
  if (isDryRun() || getPlatform() !== 'macos') return;
  if (hasIosSimulatorRuntime()) return;

  console.log(
    '\n📲 No iOS Simulator runtime installed yet — needed to run the app without a physical device (this is separate from Xcode.app itself).'
  );
  const { download } = await prompts({
    type: 'confirm',
    name: 'download',
    message: 'Download the iOS Simulator runtime now? (multi-GB, can take a while)',
    initial: true,
  });
  if (!download) {
    console.log('   Skipped — download one later via Xcode > Settings > Platforms, or run: xcodebuild -downloadPlatform iOS');
    return;
  }
  try {
    run('xcodebuild -downloadPlatform iOS');
    console.log('✅ iOS Simulator runtime installed.');
  } catch (err) {
    console.log(`⚠️  Could not download the iOS Simulator runtime automatically: ${err.message}`);
    console.log('   Download one via Xcode > Settings > Platforms instead — the ⓘ next to a platform shows download progress.');
  }
}

// Full setup for a detected Xcode project — everything short of the actual
// build, which only Xcode's own GUI (or a scripted xcodebuild/simctl call,
// not yet automated here) can do.
async function setupXcodeProject(projectDir) {
  // admin:public_key/repo already covered by gh's own default scopes plus
  // what githubAuth() already ensures; write:discussion and user are the
  // ones this kind of project specifically adds (see the project's README).
  await ensureScopes(['write:discussion', 'user'], 'Xcode / private Swift package access');
  await ensureGithubTokenInKeychain();
  setupGitLfs(projectDir);
  runGitHooksSetup(projectDir);
  await ensureXcodeFirstLaunchDone();
  await ensureIosSimulatorRuntime();

  const projectEntry = findXcodeProjectEntry(projectDir);
  console.log('\n📱 This is an Xcode project — there\'s no CLI dev server to start, open it to build and run:');
  if (projectEntry) {
    console.log(`   open "${path.join(projectDir, projectEntry)}"`);
  }
  console.log('   Then pick a scheme at the top of the Xcode window and press ⌘B to build.');
}

module.exports = { detectXcodeProject, setupXcodeProject };
