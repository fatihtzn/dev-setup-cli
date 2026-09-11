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
  }
}

// Full setup for a detected Xcode project — everything short of the actual
// build, which only Xcode's own GUI can do.
async function setupXcodeProject(projectDir) {
  // admin:public_key/repo already covered by gh's own default scopes plus
  // what githubAuth() already ensures; write:discussion and user are the
  // ones this kind of project specifically adds (see the project's README).
  await ensureScopes(['write:discussion', 'user'], 'Xcode / private Swift package access');
  await ensureGithubTokenInKeychain();
  setupGitLfs(projectDir);
  runGitHooksSetup(projectDir);

  const projectEntry = findXcodeProjectEntry(projectDir);
  console.log('\n📱 This is an Xcode project — there\'s no CLI dev server to start, open it to build and run:');
  if (projectEntry) {
    console.log(`   open "${path.join(projectDir, projectEntry)}"`);
  }
  console.log('   Then pick a scheme at the top of the Xcode window and press ⌘B to build.');
}

module.exports = { detectXcodeProject, setupXcodeProject };
