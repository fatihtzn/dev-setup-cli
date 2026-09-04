const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { run, commandExists } = require('../platform');
const { isDryRun } = require('../dryRunState');
const { injectWith1Password } = require('./secrets');
const { waitForPort } = require('./healthCheck');

function cloneRepo(config, targetDir) {
  if (isDryRun()) {
    console.log(`🧪 [dry-run] gh repo clone ${config.repo} ${targetDir}`);
    return;
  }
  if (fs.existsSync(targetDir)) {
    console.log(`ℹ️  "${targetDir}" zaten mevcut, clone atlanıyor.`);
    return;
  }
  console.log(`\n📥 Repo klonlanıyor: ${config.repo}`);
  // Ham "git clone" SSH URL'i (git@github.com:...) gerektirir; makinede
  // GitHub'a kayıtlı bir SSH key olmayan taze bir kurulumda "Permission
  // denied (publickey)" ile patlar (gerçek VM testinde gözlemlendi).
  // "gh repo clone", gh'nin zaten yapılmış https token girişini kullanır —
  // SSH key şartı yok. execFileSync argümanları shell'e string olarak
  // birleştirmez, bu yüzden path içinde boşluk olsa bile sorun çıkmaz.
  execFileSync('gh', ['repo', 'clone', config.repo, targetDir], { stdio: 'inherit' });
}

function setupEnv(config, projectDir) {
  const examplePath = path.join(projectDir, config.envExampleFile || '.env.example');
  const envPath = path.join(projectDir, '.env');

  if (!isDryRun() && fs.existsSync(envPath)) {
    console.log('ℹ️  .env zaten mevcut, dokunulmadı.');
    return;
  }

  // Dry-run'da repo gerçekten klonlanmadığı için .env.example diskte yok;
  // akışı yine de gösterebilmek adına varmış gibi devam ederiz.
  const exampleExists = isDryRun() || fs.existsSync(examplePath);
  if (!exampleExists) {
    console.log('⚠️  .env.example bulunamadı, .env manuel oluşturulmalı.');
    return;
  }

  if (config.secretManager === '1password') {
    const result = injectWith1Password(examplePath, envPath);
    if (result.ok) return;
    console.log('ℹ️  Bunun yerine .env.example düz kopyalanacak, gerçek değerleri elle doldurman gerekecek.');
  }

  if (isDryRun()) {
    console.log(`🧪 [dry-run] ${examplePath} -> ${envPath} kopyalanacaktı.`);
    return;
  }

  fs.copyFileSync(examplePath, envPath);
  console.log('✅ .env, .env.example üzerinden oluşturuldu. Gerçek değerleri doldurmayı unutma.');
}

// Bir postCloneCommand (örn. composer install) reponun kendi yapılandırma
// sorunu yüzünden başarısız olabilir. Tek bir komutun başarısız olması geri
// kalan her şeyi (diğer postCloneCommands'lar, .env zaten yapıldıysa docker/
// runProject adımları) durdurmamalı — amaç, dış müdahale olmadan script'in
// mümkün olduğunca ileri gitmesi. Başarısız komutlar uyarı olarak listelenir.
function runPostCloneCommands(config, projectDir) {
  const failed = [];
  for (const cmd of config.postCloneCommands || []) {
    if (isDryRun()) {
      console.log(`🧪 [dry-run] ${cmd}`);
      continue;
    }
    console.log(`\n▶️  ${cmd}`);
    try {
      run(cmd, { cwd: projectDir });
    } catch (err) {
      console.log(`⚠️  "${cmd}" başarısız oldu, devam ediliyor: ${err.message}`);
      failed.push(cmd);
    }
  }
  return { failed };
}

// docker-compose dosyasındaki ilk yayınlanmış (published) host portunu okur,
// böylece "servis ayağa kalktı mı?" health-check'i hangi portu deneyeceğini bilir.
// "3000:3000", "127.0.0.1:3000:3000" ve uzun format ({ published: 3000 }) desteklenir.
//
// `profiles` alanı olan servisler ATLANIR: bizim çalıştırdığımız düz
// `docker compose up -d` hiçbir profil seçmez, bu yüzden profiles: ["app"]
// gibi bir profil arkasındaki servis o komutla hiç başlamaz — böyle bir
// servisin portunu health-check hedefi seçmek, aslında ayağa kalkmayan bir
// uygulamayı "hazır" gibi yanlış raporlamaya yol açar (gerçek bir Airalo
// reposunda gözlemlendi: backend/frontend `app` profiline gizliydi, sadece
// `make prod-local` ile başlıyordu).
function detectComposeHostPort(projectDir, composeFile) {
  if (!composeFile) return null;
  try {
    const raw = fs.readFileSync(path.join(projectDir, composeFile), 'utf-8');
    const doc = yaml.load(raw);
    const services = (doc && doc.services) || {};
    for (const service of Object.values(services)) {
      if (service.profiles && service.profiles.length) continue;
      for (const p of service.ports || []) {
        if (typeof p === 'string') {
          const parts = p.split(':');
          const hostPort = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
          const port = parseInt(hostPort, 10);
          if (!Number.isNaN(port)) return port;
        } else if (p && typeof p === 'object' && p.published) {
          const port = parseInt(p.published, 10);
          if (!Number.isNaN(port)) return port;
        }
      }
    }
  } catch {
    // docker-compose.yml okunamadı/parse edilemedi, sessizce vazgeç — health-check atlanır.
  }
  return null;
}

// Bir repo yarn.lock/pnpm-lock.yaml ile gelebilir ama o paket yöneticisi
// makinede hiç kurulu olmayabilir (ör. bootstrap.sh sadece git/node/gh
// kurar) — gerçek bir VM testinde "yarn: command not found" ile
// gözlemlendi. Node'la birlikte gelen corepack ekstra global kurulum
// gerektirmeden yarn/pnpm'i talep anında indirip aktive eder; corepack da
// yoksa (çok eski Node) npm ile global kuruluma düşülür.
function ensurePackageManagerAvailable(pm, commands) {
  if (commandExists(pm)) return;
  if (commandExists('corepack')) {
    commands.push('corepack enable');
  } else {
    commands.push(`npm install -g ${pm}`);
  }
}

// Override config'te bilgi yoksa, klonlanan repoyu inceleyip
// docker-compose dosyası ve paket yöneticisini otomatik tespit eder.
function autoDetect(config, projectDir) {
  const detected = { ...config };

  if (isDryRun()) {
    if (detected.requiresDocker === undefined) detected.requiresDocker = false;
    if (!detected.postCloneCommands) detected.postCloneCommands = [];
    console.log(
      '🧪 [dry-run] Repo gerçekten klonlanmadığı için docker-compose/paket yöneticisi tespiti atlandı (override tanımlıysa o kullanılıyor).'
    );
    return detected;
  }

  const composeCandidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  if (detected.requiresDocker === undefined) {
    const found = composeCandidates.find((f) => fs.existsSync(path.join(projectDir, f)));
    detected.requiresDocker = Boolean(found);
    detected.dockerComposeFile = found;
  } else if (detected.requiresDocker && detected.dockerComposeFile === undefined) {
    // requiresDocker override'da açıkça true verilmiş ama dockerComposeFile
    // belirtilmemiş — yukarıdaki dal hiç çalışmadığı için dosya adı hâlâ
    // bilinmiyor. Aramayı burada da yapmazsak detectComposeHostPort composeFile
    // olmadan çağrılır ve health-check sessizce atlanır (gerçek bir Airalo
    // reposunda, requiresDocker:true override'ı olan ama dockerComposeFile
    // vermeyen bir projede gözlemlendi).
    detected.dockerComposeFile = composeCandidates.find((f) => fs.existsSync(path.join(projectDir, f)));
  }

  if (detected.requiresDocker && detected.healthCheckPort === undefined) {
    detected.healthCheckPort = detectComposeHostPort(projectDir, detected.dockerComposeFile);
  }

  // Bir repo hem composer.json (PHP/Laravel) hem package.json (örn. gömülü bir
  // frontend) içerebilir; ikisi de varsa ikisinin de install komutu eklenir.
  if (!detected.postCloneCommands) {
    const commands = [];

    if (fs.existsSync(path.join(projectDir, 'composer.json'))) {
      commands.push('composer install');
    }

    if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) {
      ensurePackageManagerAvailable('pnpm', commands);
      commands.push('pnpm install');
    } else if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) {
      ensurePackageManagerAvailable('yarn', commands);
      commands.push('yarn install');
    } else if (fs.existsSync(path.join(projectDir, 'package.json'))) {
      commands.push('npm install');
    }

    detected.postCloneCommands = commands;
  }

  return detected;
}

async function dockerUp(config, projectDir) {
  if (!config.requiresDocker) return { ok: true };
  const composeFile = config.dockerComposeFile || 'docker-compose.yml';

  if (isDryRun()) {
    console.log(`🧪 [dry-run] docker compose -f ${composeFile} up -d`);
    if (config.healthCheckPort) {
      console.log(`🧪 [dry-run] localhost:${config.healthCheckPort} portu hazır olana kadar beklenecekti.`);
    }
    return { ok: true };
  }

  console.log(`\n🐳 Docker Compose başlatılıyor (${composeFile})...`);
  try {
    run(`docker compose -f ${composeFile} up -d`, { cwd: projectDir });
  } catch (err) {
    // Port çakışması (örn. başka bir projeden kalma container), image build
    // hatası vb. nedenlerle başarısız olabilir — gerçek docker hatası zaten
    // stdio:'inherit' ile ekranda görünür. Burada yakalamazsak script tüm
    // kalan adımları (kapanış mesajı dahil) durdurup üst seviye hatayla çöker.
    console.log(`⚠️  docker compose up başarısız oldu: ${err.message}`);
    console.log(`   Container'ları kontrol et: docker compose -f ${composeFile} ps`);
    return { ok: false };
  }

  if (!config.healthCheckPort) {
    console.log('ℹ️  docker-compose dosyasında yayınlanmış bir port bulunamadı, health-check atlanıyor.');
    return { ok: true };
  }

  console.log(`\n⏳ localhost:${config.healthCheckPort} portunun ayağa kalkması bekleniyor...`);
  const result = await waitForPort(config.healthCheckPort, { timeoutMs: 90000 });
  if (result.ok) {
    console.log(
      `✅ Servis ayakta: http://localhost:${config.healthCheckPort} (${Math.round(result.elapsedMs / 1000)}s içinde)`
    );
  } else {
    console.log(
      `⚠️  ${Math.round(result.elapsedMs / 1000)}s bekledikten sonra localhost:${config.healthCheckPort} portuna bağlanılamadı. Container ayakta mı diye kontrol et: docker compose -f ${composeFile} logs`
    );
  }
  // "up -d" komutu başarılı olduğu için ok:true — health-check timeout'u ayrı,
  // daha yumuşak bir uyarı olarak yukarıda zaten gösterildi.
  return { ok: true };
}

module.exports = { cloneRepo, setupEnv, runPostCloneCommands, dockerUp, autoDetect };
