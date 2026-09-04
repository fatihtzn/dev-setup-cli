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

// gh'nin varsayılan minimum scope seti (repo, read:org, gist) GitHub
// Packages'ı (npm.pkg.github.com) içermez — bazı Airalo JS repoları
// bağımlılıklarını oradan private paket olarak çeker; token bu scope'a
// sahip değilse "Invalid authentication"/403 permission_denied ile patlar
// (gerçek bir Airalo frontend reposunda gözlemlendi).
function hasPackagesScope() {
  try {
    // "gh auth status" detayları (Token scopes dahil) stdout'a değil
    // stderr'e basar, bu yüzden ikisini birden yakalıyoruz.
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
    // https protokolü: SSH key kurulu olması şartı yok, gh kendi
    // token'ıyla kimlik doğruluyor (git clone/push dahil).
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
