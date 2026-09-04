const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isDryRun } = require('../dryRunState');
const { waitForPort } = require('./healthCheck');

// Dev server loglarında portu yakalamak için denenen kalıplar (Vite, Next.js,
// CRA, Vue CLI, Express/Nest gibi araçların tipik çıktılarını kapsar).
const PORT_PATTERNS = [/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/i, /port[:\s]+(\d{3,5})/i];

// Log'dan port yakalanamazsa denenecek en yaygın dev server portları.
const COMMON_DEV_PORTS = [3000, 5173, 8080, 4200, 5000, 8000, 4000];

// command.split(' ') tırnaklı argümanları (örn. --title "My App") yanlış
// böler ve fazladan boşlukları boş string token'a çevirir. Bu basit parser
// çift/tek tırnak içindeki bloğu tek argüman olarak korur; tam bir shell
// parser değildir (iç içe/kaçışlı tırnak desteklemez) ama bizim desteklediğimiz
// tüm komutlar (npm/yarn/pnpm/npx/php run komutları) için yeterlidir.
function parseCommand(command) {
  const TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const parts = [];
  let match;
  while ((match = TOKEN_RE.exec(command)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

function detectPackageManager(projectDir) {
  if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

// package.json'daki scripts alanında dev/start/serve konvansiyonunu arar
// (JS ekosisteminde en yaygın "projeyi çalıştır" script isimleri).
function detectNpmRunScript(projectDir) {
  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }

  const scripts = pkg.scripts || {};
  const pm = detectPackageManager(projectDir);
  // yarn/pnpm'i PATH'ten çıplak çağırmak yerine corepack üzerinden
  // çalıştırıyoruz — bkz. setupProject.js'deki ensureCorepackAvailable
  // yorumu: PATH'te globalce kurulu, projenin pinlenmiş sürümüyle
  // (package.json "packageManager" alanı) uyuşmayan bir yarn/pnpm olabilir.
  const runner = pm === 'npm' ? pm : `corepack ${pm}`;
  for (const candidate of ['dev', 'start', 'serve']) {
    if (scripts[candidate]) return `${runner} run ${candidate}`;
  }
  return null;
}

const README_RUN_HEADING_RE =
  /^#+\s*(getting started|installation|install|setup|kurulum|run|running|development|local development|start|çalıştırma|başlatma)/i;
// Sadece bilinen paket yöneticisi komutlarıyla başlayan tek satırlık, "dev/start/serve"
// script'i çalıştıran komutlar güvenli kabul edilir ve otomatik çalıştırılır.
// README'ler makine tarafından çalıştırılmak için yazılmadığından (placeholder'lar,
// platforma özel alternatifler, sudo/rm gibi örnekler içerebilir) başka hiçbir satır
// otomatik çalıştırılmaz.
const SAFE_CMD_RE = /^(npm|yarn|pnpm|npx)\s+(run\s+)?(dev|start|serve)\b/i;

function findReadmeFile(projectDir) {
  const candidates = ['README.md', 'Readme.md', 'readme.md', 'README.MD'];
  return candidates.find((f) => fs.existsSync(path.join(projectDir, f))) || null;
}

// README.md içindeki "run/setup/kurulum/çalıştırma" gibi başlıkların altındaki kod
// bloklarını tarar. Güvenli bir komut bulursa onu döner; bulamazsa (ama ilgili
// bölümde başka komut satırları varsa) kullanıcının elle bakması için "hints" döner.
function detectReadmeRunCommand(projectDir) {
  const readmeFile = findReadmeFile(projectDir);
  if (!readmeFile) return { command: null, hints: [] };

  const lines = fs.readFileSync(path.join(projectDir, readmeFile), 'utf-8').split('\n');

  let inRelevantSection = false;
  let inCodeBlock = false;
  let currentHeadingLevel = 0;
  const hints = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#+)\s*(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      if (README_RUN_HEADING_RE.test(line)) {
        inRelevantSection = true;
        currentHeadingLevel = level;
      } else if (inRelevantSection && level <= currentHeadingLevel) {
        inRelevantSection = false;
      }
      continue;
    }

    if (!inRelevantSection) continue;

    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (!inCodeBlock) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (SAFE_CMD_RE.test(trimmed)) {
      return { command: trimmed, hints: [] };
    }
    if (hints.length < 5) hints.push(trimmed);
  }

  return { command: null, hints };
}

// Laravel projelerinde kök dizinde `artisan` betiği bulunur; bu tek dosyanın
// varlığı bile "bu bir Laravel projesi" demek için yeterli, yaygın bir kanıt.
// `php artisan serve` varsayılan olarak http://127.0.0.1:8000 adresinde dinler
// ve bunu stdout'a basar, bu yüzden port sniffing ek bir işlem gerektirmeden çalışır.
function detectArtisanRunCommand(projectDir) {
  return fs.existsSync(path.join(projectDir, 'artisan')) ? 'php artisan serve' : null;
}

// Öncelik sırası: 1) config/projects.json'da açık runCommand  2) package.json
// dev/start/serve script'i  3) Laravel artisan  4) README.md'den çıkarılan güvenli komut.
function detectRunCommand(config, projectDir) {
  if (config.runCommand) return { command: config.runCommand, source: 'config override' };

  const npmScript = detectNpmRunScript(projectDir);
  if (npmScript) return { command: npmScript, source: 'package.json script' };

  const artisanCommand = detectArtisanRunCommand(projectDir);
  if (artisanCommand) return { command: artisanCommand, source: 'Laravel (artisan)' };

  const readme = detectReadmeRunCommand(projectDir);
  if (readme.command) return { command: readme.command, source: 'README.md' };
  if (readme.hints.length) return { command: null, hints: readme.hints, source: 'README.md' };

  return null;
}

function sniffPortFromLog(logPath) {
  if (!fs.existsSync(logPath)) return null;
  const content = fs.readFileSync(logPath, 'utf-8');
  for (const re of PORT_PATTERNS) {
    const match = content.match(re);
    if (match) {
      const port = parseInt(match[1], 10);
      if (!Number.isNaN(port)) return port;
    }
  }
  return null;
}

// Spawn'dan ÖNCE hangi ortak portların zaten (bizim başlattığımız süreçle
// ilgisiz) açık olduğunu kaydeder. Aksi halde, log'dan port yakalanamadığında
// devreye giren fallback, örneğin geliştiricinin başka bir projeden zaten
// açık bıraktığı 3000 portunu bizim yeni başlattığımız servis sanıp yanlışlıkla
// "hazır" diye raporlayabilirdi.
async function snapshotOpenPorts(ports) {
  const results = await Promise.all(ports.map((port) => waitForPort(port, { timeoutMs: 300, intervalMs: 300 })));
  return new Set(ports.filter((_, i) => results[i].ok));
}

// Önce config.runPort'a, sonra log çıktısında yakalanan porta, o da yoksa en
// yaygın dev server portlarından spawn'dan önce KAPALI olup sonradan açılan
// ilk porta bakar (hepsi best-effort).
async function detectPort(config, logPath, preOpenPorts, { sniffTimeoutMs = 15000, sniffIntervalMs = 1000 } = {}) {
  if (config.runPort) return config.runPort;

  const start = Date.now();
  while (Date.now() - start < sniffTimeoutMs) {
    const port = sniffPortFromLog(logPath);
    if (port) return port;
    await new Promise((resolve) => setTimeout(resolve, sniffIntervalMs));
  }

  for (const port of COMMON_DEV_PORTS) {
    if (preOpenPorts.has(port)) continue;
    const result = await waitForPort(port, { timeoutMs: 1500, intervalMs: 500 });
    if (result.ok) return port;
  }

  return null;
}

// docker gerektirmeyen projelerde, kurulum bittikten sonra dev server'ı arka
// planda (detached) başlatır, portunu tespit eder ve dinlemeye başlayana kadar
// bekler — amaç, tool'dan başka hiçbir elle müdahale gerekmeden projeyi
// çalışır halde ekrana (URL olarak) yansıtmak.
async function runProject(config, projectDir) {
  if (config.requiresDocker) return; // bu durumu dockerUp zaten yönetiyor

  const detected = detectRunCommand(config, projectDir);

  if (!detected || !detected.command) {
    if (detected && detected.hints && detected.hints.length) {
      console.log(
        '\nℹ️  No safe/automatic start command found for this project. The following lines were found in README.md, you may need to run them manually:\n'
      );
      detected.hints.forEach((h) => console.log(`  ${h}`));
    } else {
      console.log(
        '\nℹ️  No automatic start command found for this project (via config override, package.json script, or README.md). You may need to check README.md.'
      );
    }
    return;
  }

  const { command, source } = detected;

  if (isDryRun()) {
    console.log(`🧪 [dry-run] Project would have been started (${source}): ${command}`);
    return;
  }

  console.log(`\n🚀 Starting project (${source}): ${command}`);

  const logPath = path.join(projectDir, '.dev-setup-run.log');
  const logFd = fs.openSync(logPath, 'w');

  // Spawn'dan önceki port durumunu kaydet (bkz. detectPort/snapshotOpenPorts).
  const preOpenPorts = await snapshotOpenPorts(COMMON_DEV_PORTS);

  const [cmd, ...args] = parseCommand(command);
  const child = spawn(cmd, args, {
    cwd: projectDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    shell: process.platform === 'win32',
  });
  child.unref();

  // 'error' event'i dinlenmezse (örn. cmd komutu — yarn/pnpm/php gibi — PATH'te
  // yoksa) Node.js unhandled exception fırlatıp scripti çökertir. Bu listener
  // hem başlangıç hatasını (ENOENT) temiz bir mesaja çevirir, hem de child'ın
  // ömrü boyunca kayıtlı kalarak sonraki olası bir hatanın da script'i çökertmesini engeller.
  const spawnResult = await new Promise((resolve) => {
    child.once('spawn', () => resolve({ ok: true }));
    child.once('error', (err) => resolve({ ok: false, error: err }));
  });

  if (!spawnResult.ok) {
    console.log(
      `⚠️  Could not run "${cmd}" (it may not be installed): ${spawnResult.error.message}`
    );
    return;
  }

  console.log(`⏳ Waiting for the service to come up (logs: ${logPath})...`);
  const port = await detectPort(config, logPath, preOpenPorts);

  if (!port) {
    console.log(
      `⚠️  Process started in the background (PID: ${child.pid}) but could not detect which port it's listening on. Check the logs: ${logPath}`
    );
    return;
  }

  const result = await waitForPort(port, { timeoutMs: 60000 });
  if (result.ok) {
    console.log(`✅ Project is running: http://localhost:${port} (PID: ${child.pid})`);
    console.log(`   To stop it: kill ${child.pid}   (logs: ${logPath})`);
  } else {
    console.log(`⚠️  Could not connect to localhost:${port}. Process PID: ${child.pid}, logs: ${logPath}`);
  }
}

module.exports = {
  runProject,
  detectRunCommand,
  detectNpmRunScript,
  detectArtisanRunCommand,
  detectReadmeRunCommand,
};
