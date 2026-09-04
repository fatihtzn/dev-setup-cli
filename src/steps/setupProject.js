const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { run, commandExists, getNvmCommandPrefix } = require('../platform');
const { isDryRun } = require('../dryRunState');
const { injectWith1Password } = require('./secrets');
const { waitForPort } = require('./healthCheck');

function cloneRepo(config, targetDir) {
  if (isDryRun()) {
    console.log(`🧪 [dry-run] gh repo clone ${config.repo} ${targetDir}`);
    return;
  }
  if (fs.existsSync(targetDir)) {
    console.log(`ℹ️  "${targetDir}" already exists, skipping clone.`);
    return;
  }
  console.log(`\n📥 Cloning repo: ${config.repo}`);
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
    console.log('ℹ️  .env already exists, left untouched.');
    return;
  }

  // Dry-run'da repo gerçekten klonlanmadığı için .env.example diskte yok;
  // akışı yine de gösterebilmek adına varmış gibi devam ederiz.
  const exampleExists = isDryRun() || fs.existsSync(examplePath);
  if (!exampleExists) {
    console.log('⚠️  .env.example not found, .env needs to be created manually.');
    return;
  }

  if (config.secretManager === '1password') {
    const result = injectWith1Password(examplePath, envPath);
    if (result.ok) return;
    console.log('ℹ️  Falling back to a plain copy of .env.example — you will need to fill in the real values manually.');
  }

  if (isDryRun()) {
    console.log(`🧪 [dry-run] ${examplePath} -> ${envPath} would have been copied.`);
    return;
  }

  fs.copyFileSync(examplePath, envPath);
  console.log('✅ .env created from .env.example. Remember to fill in the real values.');
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
      console.log(`⚠️  "${cmd}" failed, continuing: ${err.message}`);
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
// gözlemlendi. Node'un içinde gelmesi beklenen corepack, bazı dağıtımlarda
// (ör. Homebrew'ın node formülü) hiç bulunmuyor; "npm install -g yarn" gibi
// bir fallback ise projenin package.json'ında pinlenmiş sürümü (ör.
// "packageManager": "yarn@4.13.0") yok sayan klasik/genel bir yarn kurar ve
// "Corepack must be enabled" hatasıyla patlar (gerçek VM testinde
// gözlemlendi). Bu yüzden PATH'teki "yarn"/"pnpm" komutuna hiç güvenmiyoruz —
// corepack yoksa npm ile kuruyoruz, kurulum komutunu da her zaman
// "corepack <pm> install" olarak çalıştırıyoruz; bu, PATH'te ne olursa olsun
// projenin pinlenmiş sürümünü doğru şekilde indirip kullanır.
function ensureCorepackAvailable(commands) {
  if (!commandExists('corepack')) {
    // corepack paketi kendi "yarn"/"pnpm" bin'lerini de kurmaya çalışır;
    // makinede (ör. bu aracın önceki, düzeltilmemiş bir sürümünden veya
    // başka bir yerden) npm ile kurulmuş çıplak bir global yarn/pnpm varsa,
    // npm o dosyaların üzerine yazmayı reddedip "EEXIST: file already
    // exists" ile patlar (gerçek VM testinde gözlemlendi). Önce onları
    // temizliyoruz; yoklarsa uninstall zaten sessizce no-op olur.
    commands.push('npm uninstall -g yarn pnpm >/dev/null 2>&1 || true');
    commands.push('npm install -g corepack');
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
      '🧪 [dry-run] Docker Compose/package manager detection skipped since the repo was not actually cloned (an override, if defined, is used instead).'
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

    // Bazı Airalo JS repoları paket.json bağımlılıklarını GitHub Packages'tan
    // (npm.pkg.github.com) çeker; bu private scope'lar kimlik doğrulama
    // ister. actions/setup-node'un yaygınlaştırdığı NODE_AUTH_TOKEN
    // konvansiyonu (.yarnrc.yml'de "npmAuthToken: ${NODE_AUTH_TOKEN}" gibi)
    // gerçek bir Airalo reposunda (airalo-partner-panel-frontend) gözlemlendi
    // — anonim istek "Invalid authentication" ile patlıyordu. gh zaten giriş
    // yapılmış olduğundan token'ı oradan sağlıyoruz; repo bu değişkeni hiç
    // kullanmıyorsa zararsız, kullanıyorsa otomatik doğru çalışır.
    const NODE_AUTH_TOKEN_PREFIX = 'NODE_AUTH_TOKEN="$(gh auth token 2>/dev/null)" ';
    // Repo, o an aktif olan global Node sürümünden farklı bir sürüm
    // isteyebilir (.nvmrc / engines.node) — bkz. getNvmCommandPrefix yorumu.
    // Yanlış sürümle kurulan native (derlenen) bağımlılıklar sessizce
    // bozuk kurulur, bu yüzden install komutundan ÖNCE (NODE_AUTH_TOKEN'dan
    // da önce) doğru sürüme geçiyoruz.
    const nvmPrefix = getNvmCommandPrefix(projectDir);

    if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) {
      ensureCorepackAvailable(commands);
      commands.push(`${nvmPrefix}${NODE_AUTH_TOKEN_PREFIX}corepack pnpm install`);
    } else if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) {
      ensureCorepackAvailable(commands);
      commands.push(`${nvmPrefix}${NODE_AUTH_TOKEN_PREFIX}corepack yarn install`);
    } else if (fs.existsSync(path.join(projectDir, 'package.json'))) {
      commands.push(`${nvmPrefix}${NODE_AUTH_TOKEN_PREFIX}npm install`);
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
      console.log(`🧪 [dry-run] would have waited for localhost:${config.healthCheckPort} to be ready.`);
    }
    return { ok: true };
  }

  console.log(`\n🐳 Starting Docker Compose (${composeFile})...`);
  try {
    run(`docker compose -f ${composeFile} up -d`, { cwd: projectDir });
  } catch (err) {
    // Port çakışması (örn. başka bir projeden kalma container), image build
    // hatası vb. nedenlerle başarısız olabilir — gerçek docker hatası zaten
    // stdio:'inherit' ile ekranda görünür. Burada yakalamazsak script tüm
    // kalan adımları (kapanış mesajı dahil) durdurup üst seviye hatayla çöker.
    console.log(`⚠️  docker compose up failed: ${err.message}`);
    console.log(`   Check the containers: docker compose -f ${composeFile} ps`);
    return { ok: false };
  }

  if (!config.healthCheckPort) {
    console.log('ℹ️  No published port found in the docker-compose file, skipping health-check.');
    return { ok: true };
  }

  console.log(`\n⏳ Waiting for localhost:${config.healthCheckPort} to come up...`);
  const result = await waitForPort(config.healthCheckPort, { timeoutMs: 90000 });
  if (result.ok) {
    console.log(
      `✅ Service is up: http://localhost:${config.healthCheckPort} (in ${Math.round(result.elapsedMs / 1000)}s)`
    );
  } else {
    console.log(
      `⚠️  Could not connect to localhost:${config.healthCheckPort} after waiting ${Math.round(result.elapsedMs / 1000)}s. Check whether the container is up: docker compose -f ${composeFile} logs`
    );
  }
  // "up -d" komutu başarılı olduğu için ok:true — health-check timeout'u ayrı,
  // daha yumuşak bir uyarı olarak yukarıda zaten gösterildi.
  return { ok: true };
}

module.exports = { cloneRepo, setupEnv, runPostCloneCommands, dockerUp, autoDetect };
