const { execFileSync } = require('child_process');

/**
 * Fetches an organization's (or user's) repos via the gh CLI.
 * gh auth login must already be done (the token is stored in gh after Okta SSO).
 */
function listRepos(owner) {
  const raw = execFileSync(
    'gh',
    [
      'repo', 'list', owner,
      '--limit', '200',
      '--json', 'name,nameWithOwner,description,isArchived',
    ],
    { encoding: 'utf-8' }
  );

  const repos = JSON.parse(raw);
  return repos.filter((r) => !r.isArchived);
}

module.exports = { listRepos };
