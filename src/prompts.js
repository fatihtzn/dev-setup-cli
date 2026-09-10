const prompts = require('prompts');
const overrides = require('../config/projects.json');
const { listRepos } = require('./steps/listGithubRepos');
const { isDryRun } = require('./dryRunState');

// In dry-run mode the gh CLI is never touched; a sample repo list is used
// instead, so the flow can still be shown.
const MOCK_REPOS = [
  {
    name: 'test-web-app',
    nameWithOwner: 'test-org/test-web-app',
    description: '(example) no override, generic flow runs',
  },
  {
    name: 'test-service',
    nameWithOwner: 'test-org/test-service',
    description: '(example) no override, generic flow runs',
  },
];

// Which GitHub org/user to list repos from is not fixed — this tool is
// meant to be reused by any team. Set the GITHUB_ORG environment variable
// to skip being asked every run; otherwise it's asked once per run.
async function resolveOrg() {
  if (process.env.GITHUB_ORG) return process.env.GITHUB_ORG;
  const { org } = await prompts({
    type: 'text',
    name: 'org',
    message: 'Which GitHub org or user should this tool list repos from?',
  });
  if (!org) process.exit(0);
  console.log('   (tip: set the GITHUB_ORG environment variable to skip this next time)\n');
  return org;
}

// Looks up whether config/projects.json has a special setting for this repo
// name (e.g. a different docker-compose filename, custom postClone commands).
// Returns null if not found, and the generic flow takes over.
function findOverride(repoName) {
  for (const dep of Object.keys(overrides)) {
    if (dep === '_readme') continue;
    for (const key of Object.keys(overrides[dep])) {
      if (key === repoName) return { department: dep, ...overrides[dep][key] };
    }
  }
  return null;
}

async function selectProject() {
  let repos;
  let org;
  if (isDryRun()) {
    console.log('\n🧪 [dry-run] gh repo list not called, using sample repo list instead.');
    repos = MOCK_REPOS;
    org = 'test-org';
  } else {
    org = await resolveOrg();
    console.log(`\n🔎 Fetching projects under ${org}...`);
    try {
      repos = listRepos(org);
    } catch (err) {
      console.error('❌ Could not fetch the repo list. Make sure you are signed in to GitHub (gh auth status).');
      throw err;
    }
  }

  if (repos.length === 0) {
    console.error(`❌ No accessible repos found under "${org}".`);
    process.exit(1);
  }

  const { repoName } = await prompts({
    type: 'autocomplete',
    name: 'repoName',
    message: 'Which project do you want to set up?',
    choices: repos.map((r) => ({
      title: r.description ? `${r.name} — ${r.description}` : r.name,
      value: r.name,
    })),
    // The prompts library's default filter only matches from the start
    // (e.g. typing "backend" won't find "company-backend"). Repo names often
    // share a common org/product prefix, so a case-insensitive substring
    // filter is used here that matches text ANYWHERE in the repo
    // name/description.
    suggest: (input, choices) => {
      const term = input.trim().toLowerCase();
      if (!term) return Promise.resolve(choices);
      return Promise.resolve(choices.filter((c) => c.title.toLowerCase().includes(term)));
    },
  });

  if (!repoName) process.exit(0);

  const repo = repos.find((r) => r.name === repoName);
  const override = findOverride(repoName) || {};

  const config = {
    displayName: repoName,
    repo: repo.nameWithOwner,
    envExampleFile: '.env.example',
    ...override, // if an override exists, it overwrites the generic settings
  };

  return { projectKey: repoName, config };
}

module.exports = { selectProject };
