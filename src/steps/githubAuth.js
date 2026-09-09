const { execSync } = require('child_process');
const { run } = require('../platform');
const { isDryRun } = require('../dryRunState');

function isAuthenticated() {
  try {
    execSync('gh auth status', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// gh's default minimum scope set (repo, read:org, gist) doesn't include
// GitHub Packages (npm.pkg.github.com) — some Airalo JS repos pull their
// dependencies from there as private packages; if the token doesn't have
// this scope it blows up with "Invalid authentication"/403 permission_denied
// (observed on a real Airalo frontend repo).
function hasPackagesScope() {
  try {
    // "gh auth status" prints its details (including Token scopes) to
    // stderr, not stdout, so we capture both.
    const status = execSync('gh auth status 2>&1', { encoding: 'utf-8' });
    return status.includes('read:packages');
  } catch {
    return false;
  }
}

function githubAuth() {
  if (isDryRun()) {
    console.log('🧪 [dry-run] gh auth login skipped (no real GitHub sign-in will happen).');
    return;
  }

  if (isAuthenticated()) {
    console.log('✅ GitHub CLI is already signed in.');
  } else {
    console.log('\n🔐 GitHub sign-in required. A browser will open, sign in via Okta SSO (including MFA).\n');
    // https protocol: no requirement to have an SSH key set up, gh
    // authenticates with its own token (including for git clone/push).
    run('gh auth login --web --git-protocol https --scopes read:packages');
    run('gh config set git_protocol https');
    run('gh config set -h github.com git_protocol https');
  }

  if (!hasPackagesScope()) {
    console.log('\n🔐 Adding read:packages permission for GitHub Packages (private npm/composer packages)...\n');
    run('gh auth refresh --hostname github.com --scopes read:packages');
  }
}

module.exports = { githubAuth };
