const { execFileSync } = require('child_process');

/**
 * gh CLI üzerinden bir organizasyonun (veya kullanıcının) repolarını çeker.
 * gh auth login zaten yapılmış olmalı (Okta SSO sonrası token gh'de saklı).
 */
function listRepos(owner) {
  const raw = execFileSync(
    'gh',
    [
      'repo', 'list', owner,
      '--limit', '200',
      '--json', 'name,sshUrl,description,isArchived',
    ],
    { encoding: 'utf-8' }
  );

  const repos = JSON.parse(raw);
  return repos.filter((r) => !r.isArchived);
}

module.exports = { listRepos };
