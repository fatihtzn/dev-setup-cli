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

// "gh auth status" prints its details (including Token scopes) to stderr,
// not stdout, so both streams are captured.
function currentScopes() {
  try {
    return execSync('gh auth status 2>&1', { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

// gh's default minimum scope set (repo, read:org, gist) doesn't cover
// everything every project needs — GitHub Packages (npm.pkg.github.com)
// needs read:packages (some JS repos pull private dependencies from there;
// observed on a real production frontend repo as "Invalid
// authentication"/403 permission_denied), and native iOS projects that
// download private Swift packages via Xcode need admin:public_key,
// write:discussion, and user (see the project's own README) — Xcode itself
// requires admin:public_key even though it's not one of the ones this tool
// requests here since it's already part of gh's own default scope set.
// `gh auth refresh --scopes` is additive (expands the existing token's
// scopes, confirmed directly: repeated calls with different scope lists
// accumulate rather than replace), so this only needs to request whatever's
// still missing from the FULL desired set, not the whole thing every time.
async function ensureScopes(scopes, reason) {
  if (isDryRun()) {
    console.log(`🧪 [dry-run] would ensure GitHub token scopes for ${reason}: ${scopes.join(', ')}`);
    return;
  }

  const status = currentScopes();
  const missing = scopes.filter((s) => !status.includes(s));
  if (missing.length === 0) return;

  console.log(`\n🔐 Adding GitHub token permission(s) for ${reason}: ${missing.join(', ')}...\n`);
  run(`gh auth refresh --hostname github.com --scopes ${missing.join(',')}`);
}

async function githubAuth() {
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

  await ensureScopes(['read:packages'], 'GitHub Packages (private npm/composer packages)');
}

module.exports = { githubAuth, ensureScopes };
