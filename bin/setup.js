#!/usr/bin/env node

const path = require('path');
const { selectProject } = require('../src/prompts');
const { checkPrerequisites } = require('../src/steps/checkPrerequisites');
const { githubAuth } = require('../src/steps/githubAuth');
const {
  cloneRepo,
  setupEnv,
  runPostCloneCommands,
  dockerUp,
  autoDetect,
} = require('../src/steps/setupProject');
const { runProject } = require('../src/steps/runProject');
const { setDryRun, isDryRun } = require('../src/dryRunState');

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run') || argv.includes('-n'),
  };
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  setDryRun(dryRun);

  console.log('👋 Şirket Dev Ortamı Kurulum Aracına hoş geldin!\n');
  if (isDryRun()) {
    console.log(
      '🧪 DRY RUN modu aktif: gh CLI çağrılmayacak, dosya sistemine yazılmayacak/klonlanmayacak, akış sadece simüle edilecek.\n'
    );
  }

  // Repo listesini çekebilmek için önce GitHub/Okta girişi gerekiyor.
  const prereq = await checkPrerequisites({ requiresDocker: false });
  if (!prereq.ok) process.exit(1);
  githubAuth();

  const { projectKey, config: initialConfig } = await selectProject();
  console.log(`\n➡️  Seçim: ${initialConfig.displayName}\n`);

  const targetDir = path.join(process.cwd(), projectKey);
  cloneRepo(initialConfig, targetDir);

  // Repo klonlandıktan sonra docker-compose / paket yöneticisi otomatik tespit edilir
  // (config/projects.json'da bu proje için özel ayar tanımlıysa onlar önceliklidir).
  const config = autoDetect(initialConfig, targetDir);

  if (config.requiresDocker) {
    const dockerCheck = await checkPrerequisites(config);
    if (!dockerCheck.ok) process.exit(1);
  }

  setupEnv(config, targetDir);
  const { failed: failedCommands } = runPostCloneCommands(config, targetDir);
  const { ok: dockerOk } = await dockerUp(config, targetDir);
  // Docker gerektirmeyen projelerde (frontend/backend fark etmeksizin) dev server'ı
  // arka planda başlatıp portu tespit eder; docker'lı projelerde no-op'tur.
  await runProject(config, targetDir);

  // dockerUp başarısız olduysa, proje-özel readyMessage ("... çalışıyor!" gibi)
  // yanıltıcı olur — bu yüzden o durumda gösterilmez, sadece uyarı basılır.
  if (dockerOk) {
    console.log(`\n🎉 ${config.readyMessage || 'Kurulum tamamlandı, kod yazmaya hazırsın!'}\n`);
  } else {
    console.log('\n⚠️  Kurulum tamamlandı ama Docker Compose başlatılamadı — yukarıdaki hataya bak.\n');
  }
  if (failedCommands.length) {
    console.log('⚠️  Şu kurulum komutları başarısız oldu, elle tekrar bakman gerekebilir:');
    failedCommands.forEach((cmd) => console.log(`  - ${cmd}`));
    console.log();
  }
}

main().catch((err) => {
  console.error('\n❌ Bir hata oluştu:', err.message);
  process.exit(1);
});
