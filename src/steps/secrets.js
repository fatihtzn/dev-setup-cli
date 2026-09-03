const { execFileSync } = require('child_process');
const { commandExists } = require('../platform');
const { isDryRun } = require('../dryRunState');

function isOpAvailable() {
  return commandExists('op');
}

function isOpSignedIn() {
  try {
    execFileSync('op', ['whoami'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// .env.example içindeki op://vault/item/field referanslarını 1Password'daki
// gerçek değerlerle doldurup .env dosyasına yazar (bkz. `op inject`).
// Kullanıcının 1Password CLI'ı kurulu ve giriş yapmış olması gerekir; secret
// değerleri hiçbir zaman bu script'in belleğine/stdout'una düşmez, doğrudan
// op CLI tarafından dosyaya yazılır.
function injectWith1Password(examplePath, envPath) {
  if (isDryRun()) {
    console.log(`🧪 [dry-run] op inject -i ${examplePath} -o ${envPath} çalıştırılacaktı.`);
    return { ok: true, simulated: true };
  }

  if (!isOpAvailable()) {
    console.log(
      '⚠️  1Password CLI (op) bulunamadı. Kurulum: "brew install 1password-cli" (macOS) / "winget install AgileBits.1Password-CLI" (Windows)'
    );
    return { ok: false, reason: 'op-not-found' };
  }

  if (!isOpSignedIn()) {
    console.log(
      '⚠️  1Password CLI\'a giriş yapılmamış görünüyor. 1Password masaüstü uygulamasında "CLI ile entegrasyon" ayarını aç ya da `op signin` çalıştır.'
    );
    return { ok: false, reason: 'not-signed-in' };
  }

  try {
    execFileSync('op', ['inject', '-i', examplePath, '-o', envPath], { stdio: 'inherit' });
    console.log('✅ .env, 1Password üzerinden gerçek secret değerleriyle oluşturuldu.');
    return { ok: true };
  } catch (err) {
    console.log(`⚠️  1Password ile secret enjeksiyonu başarısız oldu: ${err.message}`);
    return { ok: false, reason: 'inject-failed' };
  }
}

module.exports = { injectWith1Password, isOpAvailable, isOpSignedIn };
