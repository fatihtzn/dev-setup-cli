const prompts = require('prompts');
const { commandExists, getPlatform, checkWsl2Status, isDockerDaemonRunning, run } = require('../platform');
const { isDryRun } = require('../dryRunState');

// installHint aynı zamanda GERÇEK, çalıştırılabilir kurulum komutu — otomatik
// kurulum onaylanırsa doğrudan bu string execSync ile çalıştırılır.
const REQUIRED_TOOLS = [
  {
    cmd: 'git',
    kind: 'install',
    installHint: { macos: 'brew install git', windows: 'winget install --id Git.Git' },
  },
  {
    cmd: 'node',
    kind: 'install',
    installHint: { macos: 'brew install node', windows: 'winget install OpenJS.NodeJS' },
  },
  {
    cmd: 'gh',
    kind: 'install',
    installHint: { macos: 'brew install gh', windows: 'winget install --id GitHub.cli' },
  },
  {
    cmd: 'docker',
    kind: 'install',
    installHint: { macos: 'brew install --cask docker', windows: 'winget install Docker.DockerDesktop' },
  },
];

// Docker Desktop kurulu ama kapalıysa "aç ve bekle" ile hallolur — bu, "kur"
// ile aynı şey değil (sisteme hiçbir şey yüklemez, sadece zaten kurulu bir
// uygulamayı başlatır), bu yüzden ayrı bir "start-daemon" türü var.
async function startDockerDaemonAndWait(platform, { timeoutMs = 90000, intervalMs = 3000 } = {}) {
  try {
    if (platform === 'macos') {
      run('open -a Docker', { stdio: 'ignore' });
    } else if (platform === 'windows') {
      // Docker Desktop'ın varsayılan kurulum yolu — farklı bir yere kurulmuşsa
      // bu başarısız olur ve elle açma talimatına düşülür (untested: gerçek
      // bir Windows makinesinde henüz doğrulanmadı).
      run('start "" "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"', { stdio: 'ignore' });
    } else {
      return false;
    }
  } catch {
    return false;
  }

  process.stdout.write('⏳ Docker Desktop açılıyor, hazır olması bekleniyor');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isDockerDaemonRunning()) {
      console.log(' ✅');
      return true;
    }
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  console.log(' ⏱️');
  return false;
}

async function attemptAutoFix(tool, platform) {
  if (tool.kind === 'start-daemon') {
    return startDockerDaemonAndWait(platform);
  }

  const cmd = tool.installHint[platform] || tool.installHint.macos;
  console.log(`\n📦 ${tool.cmd} kuruluyor: ${cmd}`);
  try {
    run(cmd);
    return commandExists(tool.cmd);
  } catch (err) {
    console.log(`⚠️  ${tool.cmd} kurulumu başarısız oldu: ${err.message}`);
    return false;
  }
}

async function checkPrerequisites(config) {
  const platform = getPlatform();
  const missing = [];

  for (const tool of REQUIRED_TOOLS) {
    if (tool.cmd === 'docker' && !config.requiresDocker) continue;
    if (!commandExists(tool.cmd)) {
      missing.push(tool);
    }
  }

  // docker CLI PATH'te olsa bile Docker Desktop kapalıysa her docker komutu
  // (docker compose up dahil) başarısız olur — bunu burada yakalamazsak script
  // ilerideki bir adımda ham, anlaşılmaz bir hata ile çöker.
  const dockerBinaryMissing = missing.some((t) => t.cmd === 'docker');
  if (config.requiresDocker && !dockerBinaryMissing && !isDockerDaemonRunning()) {
    missing.push({
      cmd: 'docker (daemon)',
      kind: 'start-daemon',
      installHint: {
        macos: 'Docker Desktop uygulamasını aç (Applications > Docker) ve balina ikonu "running" olana kadar bekle',
        windows: 'Docker Desktop uygulamasını başlat ve sistem tepsisindeki balina ikonu "running" olana kadar bekle',
      },
    });
  }

  const warnings = [];
  if (config.requiresDocker && platform === 'windows') {
    const wsl = checkWsl2Status();
    if (!wsl.ok) {
      warnings.push(
        wsl.reason === 'wsl-not-found'
          ? 'WSL bulunamadı. Docker Desktop\'ın WSL2 backend\'i için WSL kurulu olmalı: "wsl --install" çalıştırıp bilgisayarı yeniden başlat.'
          : 'WSL2 tabanlı bir dağıtım bulunamadı görünüyor. Docker Desktop ayarlarında "Use the WSL 2 based engine" açık olmalı ve en az bir dağıtım WSL2 kullanmalı ("wsl --set-version <dağıtım> 2").'
      );
    }
  }

  if (missing.length === 0) {
    console.log('\n✅ Tüm gerekli araçlar zaten kurulu.');
    if (warnings.length) {
      console.log('\n⚠️  Uyarılar:\n');
      warnings.forEach((w) => console.log(`  - ${w}`));
    }
    return { ok: true, warnings };
  }

  console.log('\n⚠️  Eksik araçlar / eksik hazırlık bulundu:\n');
  for (const tool of missing) {
    const hint = tool.installHint[platform] || tool.installHint.macos;
    console.log(`  - ${tool.cmd}: ${hint}`);
  }
  if (warnings.length) {
    console.log('\n⚠️  Uyarılar:\n');
    warnings.forEach((w) => console.log(`  - ${w}`));
  }

  if (isDryRun()) {
    console.log('\n🧪 [dry-run] Otomatik kurulum/başlatma denenmeyecek.\n');
    return { ok: false, missing, warnings };
  }

  const { autoFix } = await prompts({
    type: 'confirm',
    name: 'autoFix',
    message: 'Eksik olanları şimdi otomatik kurmayı/başlatmayı dene? (İndirme/kurulum süresi alabilir, admin şifresi isteyebilir)',
    initial: true,
  });

  if (!autoFix) {
    console.log('\nBunları hallettikten sonra script\'i tekrar çalıştır.\n');
    return { ok: false, missing, warnings };
  }

  const stillMissing = [];
  for (const tool of missing) {
    const fixed = await attemptAutoFix(tool, platform);
    if (!fixed) stillMissing.push(tool);
  }

  if (stillMissing.length > 0) {
    console.log('\n⚠️  Şunlar otomatik olarak halledilemedi, elle bakman gerekiyor:\n');
    for (const tool of stillMissing) {
      const hint = tool.installHint[platform] || tool.installHint.macos;
      console.log(`  - ${tool.cmd}: ${hint}`);
    }
    console.log('\nBunları hallettikten sonra script\'i tekrar çalıştır.\n');
    return { ok: false, missing: stillMissing, warnings };
  }

  console.log('\n✅ Eksik olan her şey hallolundu, devam ediliyor.\n');
  return { ok: true, warnings };
}

module.exports = { checkPrerequisites };
