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
    description: '(örnek) config/projects.json içindeki override ile eşleşir',
  },
  {
    name: 'ornek-servis',
    nameWithOwner: 'ornek-org/ornek-servis',
    description: '(örnek) override yok, generic akış çalışır',
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
  console.log(`\n🔎 ${ORG} altındaki projeler çekiliyor...`);
  let repos;
  if (isDryRun()) {
    console.log('🧪 [dry-run] gh repo list çağrılmadı, örnek repo listesi kullanılıyor.');
    repos = MOCK_REPOS;
  } else {
    try {
      repos = listRepos(ORG);
    } catch (err) {
      console.error('❌ Repo listesi alınamadı. GitHub girişi yapıldığından emin ol (gh auth status).');
      throw err;
    }
  }

  if (repos.length === 0) {
    console.error(`❌ "${ORG}" altında erişebildiğin repo bulunamadı.`);
    process.exit(1);
  }

  const { repoName } = await prompts({
    type: 'autocomplete',
    name: 'repoName',
    message: 'Hangi proje için kurulum yapmak istiyorsun?',
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
