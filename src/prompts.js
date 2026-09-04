const prompts = require('prompts');
const overrides = require('../config/projects.json');
const { listRepos } = require('./steps/listGithubRepos');
const { isDryRun } = require('./dryRunState');

// dry-run modunda gh CLI'a hiç dokunulmaz; akışı yine de gösterebilmek için
// bunun yerine örnek bir repo listesi kullanılır.
const MOCK_REPOS = [
  {
    name: 'web-app',
    nameWithOwner: 'ornek-org/web-app',
    description: '(example) matches the override in config/projects.json',
  },
  {
    name: 'ornek-servis',
    nameWithOwner: 'ornek-org/ornek-servis',
    description: '(example) no override, generic flow runs',
  },
];

// Şirketin GitHub organizasyonu sabit — kullanıcıya sorulmuyor.
const ORG = 'Airalo';

// config/projects.json içinde repo adına göre özel ayar var mı diye bakar
// (örn. docker-compose dosya adı farklıysa, özel postClone komutları varsa).
// Bulamazsa null döner, generic akış devreye girer.
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
  console.log(`\n🔎 Fetching projects under ${ORG}...`);
  let repos;
  if (isDryRun()) {
    console.log('🧪 [dry-run] gh repo list not called, using sample repo list instead.');
    repos = MOCK_REPOS;
  } else {
    try {
      repos = listRepos(ORG);
    } catch (err) {
      console.error('❌ Could not fetch the repo list. Make sure you are signed in to GitHub (gh auth status).');
      throw err;
    }
  }

  if (repos.length === 0) {
    console.error(`❌ No accessible repos found under "${ORG}".`);
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
    // prompts kütüphanesinin varsayılan filtresi sadece başlangıç eşleşmesi yapar
    // (örn. "backend" yazınca "airalo-backend" bulunamaz). Repo adları çoğunlukla
    // ortak öneklerle (airalo-, nx-, plx-, px-, test-, ux-, data-...) başladığından
    // burada repo adının/açıklamasının HERHANGİ bir yerinde geçen metni arayan
    // case-insensitive bir substring filtresi kullanılıyor.
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
    ...override, // override varsa generic ayarların üzerine yazar
  };

  return { projectKey: repoName, config };
}

module.exports = { selectProject };
