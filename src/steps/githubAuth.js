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

function githubAuth() {
  if (isDryRun()) {
    console.log('🧪 [dry-run] gh auth login atlandı (gerçek GitHub girişi yapılmayacak).');
    return;
  }

  if (isAuthenticated()) {
    console.log('✅ GitHub CLI zaten giriş yapılmış durumda.');
    return;
  }

  console.log('\n🔐 GitHub girişi gerekiyor. Tarayıcı açılacak, Okta SSO ile giriş yap (MFA dahil).\n');
  run('gh auth login --web --git-protocol ssh');
}

module.exports = { githubAuth };
