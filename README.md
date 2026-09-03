# Dev Setup CLI

Yeni başlayanlar için tek komutla ortam kurulumu.

## Kullanım

### Sıfır bir makinede (Node/Git/GitHub CLI dahil hiçbir şey kurulu değilken)
`node bin/setup.js`'in kendisi Node gerektirdiği için, Node hiç kurulu değilse
bu komutu çalıştıramazsın — klasik bir tavuk-yumurta sorunu. Bunun için hiçbir
ön koşul gerektirmeyen birer bootstrap script'i var (Homebrew/nvm/rustup'ın
kullandığı desenin aynısı), her platform için ayrı:

**macOS** (`bootstrap.sh`, bash):
```bash
curl -fsSL https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.sh | bash
```

**Windows** (`bootstrap.ps1`, PowerShell — winget kullanır):
```powershell
irm https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.ps1 | iex
```

İkisi de sırasıyla: paket yöneticisini (Homebrew / winget) doğrular → git/node/gh'yi
(yoksa) kurar → GitHub'a giriş yaptırır (Okta SSO, tarayıcıda) → aracın kendisini
clone'lar → `node bin/setup.js`'e devreder.

**Doğrulama durumu:** `bootstrap.sh` bu oturumda macOS'ta gerçek çalıştırmalarla
test edildi (araç kurulum mekanizması dahil). `bootstrap.ps1` bu makine macOS
olduğu için gerçek bir Windows makinesinde **henüz hiç test edilmedi** — mantıksal
olarak yazıldı, ilk kullanımda dikkatli ol ve sorun bulursan bildir.

> ⚠️ **Repo private olduğu sürece yukarıdaki tek satırlar çalışmaz** —
> `raw.githubusercontent.com` private reponun içeriğini anonim isteklere
> döndürmüyor (404). `git clone` adımı sorun değil (script önce `gh auth login`
> yaptırıp SSH ile private repo'ya erişiyor) — sorun sadece bootstrap script'ini
> sıfır makineye ilk ulaştırma adımı. Repo private kaldığı sürece script'i elle
> kopyala (`scp bootstrap.sh kullanici@makine:~/` gibi) ya da içeriğini hedef
> makinede bir düzenleyiciyle yapıştır, sonra çalıştır. Araç resmi Airalo iş
> akışına geçtiğinde ya bootstrap script'leri ayrı, herkese görünür (public) bir
> gist/repo'da tutulabilir (asıl kod yine private kalır), ya da şirket içi bir
> dağıtım kanalından (VM imajı, MDM script'i vb.) verilebilir.

### Zaten git/node/gh kuruluysa
```bash
npm install
node bin/setup.js
```
(macOS ve Windows'ta aynı komut çalışır.)

### Dry-run modu
Gerçek bir org'a karşı denemeden önce akışı görmek için:
```bash
node bin/setup.js --dry-run
```
Bu modda `gh` CLI'a hiç dokunulmaz (org/repo listesi için örnek veri kullanılır),
gerçek bir `git clone` yapılmaz, dosya sistemine yazılmaz ve hiçbir kabuk komutu
(`npm install`, `docker compose up` vb.) gerçekten çalıştırılmaz — her adımda ne
yapılacağı `🧪 [dry-run]` etiketiyle sadece ekrana yazdırılır.

## Akış
1. Gerekli araç kontrolü (git, node, gh, docker) — eksikse ya da Docker Desktop
   kuruluysa-ama-kapalıysa, otomatik kurmayı/açmayı önerir (bkz.
   [Eksik Araçları Otomatik Halletme](#eksik-araçları-otomatik-halletme))
2. `gh auth login` ile GitHub/Okta SSO girişi (tarayıcıda, MFA dahil — şifre asla script'e girilmez)
3. Proje seçimi — GitHub organizasyonu (`Airalo`) koduna sabitlenmiştir, kullanıcıya sorulmaz;
   repo listesi otomatik çekilir ve autocomplete ile (repo adının/açıklamasının herhangi
   bir yerinde geçen metinle arama yapılabilir, örn. "backend" → `airalo-backend`) seçilir
4. Repo clone
5. Repo klonlandıktan sonra docker-compose dosyası ve paket yöneticisi (npm/yarn/pnpm,
   composer.json varsa composer — ikisi de varsa ikisi de) otomatik tespit edilir
6. `.env.example` → `.env` kopyalama (veya `secretManager: "1password"` tanımlıysa `op inject`)
7. `postCloneCommands` çalıştırma (örn. `npm install`)
8. Docker Compose varsa ayağa kaldırma, ardından docker-compose.yml'de yayınlanmış
   ilk portun (örn. `"3000:3000"` → 3000) gerçekten dinlemeye başlamasını bekler
   (health-check, TCP bağlantı denemesiyle — protokolden bağımsız) ve
   `http://localhost:<port>` adresini net şekilde ekrana basar
9. Docker gerektirmeyen projelerde (frontend/backend fark etmeksizin) dev server'ı
   arka planda başlatır, portunu tespit eder ve health-check ile bekler — bkz.
   [Projeyi Çalıştırma](#projeyi-çalıştırma-docker-gerektirmeyen-projeler)

## Yeni Proje/Departman Ekleme
Sadece `config/projects.json` dosyasına yeni bir kayıt eklemek yeterli, kod değişikliği gerekmez:

```json
"Backend": {
  "api-server": {
    "displayName": "API Server",
    "repo": "git@github.com:sirketiniz/api-server.git",
    "envExampleFile": ".env.example",
    "secretManager": "1password",
    "requiresDocker": true,
    "dockerComposeFile": "docker-compose.yml",
    "postCloneCommands": ["npm install"],
    "readyMessage": "API hazır!"
  }
}
```

### Secret Yönetimi (1Password)
Bir proje için `"secretManager": "1password"` tanımlarsan, `.env.example`
dosyasındaki `op://vault/item/field` referansları [1Password CLI](https://developer.1password.com/docs/cli/)
(`op inject`) ile gerçek değerlere çözülüp `.env` olarak yazılır. Gereksinimler:
- 1Password CLI kurulu olmalı (`brew install 1password-cli` / `winget install AgileBits.1Password-CLI`)
- 1Password masaüstü uygulamasında "CLI ile entegrasyon" açık olmalı ya da `op signin` ile giriş yapılmış olmalı

`op` kurulu değilse veya giriş yapılmamışsa, script otomatik olarak
`.env.example`'ı düz kopyalama davranışına geri döner (kurulum yarım kalmaz).

### Eksik Araçları Otomatik Halletme
git/node/gh/docker'dan biri eksikse ya da Docker Desktop kuruluysa-ama-kapalıysa,
script eksik olanları listeledikten sonra **tek bir onay** ister: "Eksik olanları
şimdi otomatik kurmayı/başlatmayı dene?" (varsayılan: evet).

- **Kurulum** (git/node/gh/docker eksikse): macOS'ta Homebrew (`brew install ...`),
  Windows'ta winget (`winget install ...`) ile gerçek zamanlı çıktı göstererek kurar
  (admin şifresi gerekiyorsa o da terminalde/native dialogda görünür). Kurulum
  komutu tam olarak ekranda gösterilen komutun aynısıdır.
- **Docker daemon başlatma** (Docker Desktop kuruluysa ama kapalıysa): Bu bir
  "kurulum" değil — sisteme hiçbir şey yüklenmez, sadece zaten kurulu olan
  Docker Desktop açılır (macOS: `open -a Docker`, Windows: `Docker Desktop.exe`
  — Windows yolu untested) ve daemon hazır olana kadar (varsayılan timeout: 90s)
  beklenir.

Onay verilmezse ya da bir araç otomatik halledilemezse, script eskisi gibi sadece
elle yapılacak komutu/adımı gösterip durur — hiçbir şey zorla yapılmaz.
`--dry-run` modunda bu adım hiç sorulmaz, hiçbir kurulum/başlatma denenmez.

Gerçek bu makinede test edildi: git/node/gh zaten kurulu olduğu için kurulum
kolu (brew install) gerçek bir paket ile denenmedi, ama **Docker Desktop
otomatik açma** gerçekten çalıştırıldı — `open -a Docker` ile uygulama açıldı,
daemon hazır olana kadar bekleyip `docker info`/`docker ps` ile gerçekten
çalıştığı doğrulandı.

### Docker Health-Check
`requiresDocker: true` olan projelerde `docker compose up -d` çalıştıktan sonra
script otomatik olarak `dockerComposeFile` içindeki ilk yayınlanmış (published)
host portunu okur (`ports: ["3000:3000"]` gibi kısa format ya da uzun format
`{ published: 3000, target: 3000 }` desteklenir) ve o porta TCP bağlantısı
kurulabilene kadar bekler (varsayılan timeout: 90s). Bağlantı kurulunca
`http://localhost:<port>` adresini basar; timeout'a uğrarsa container'ların
gerçekten ayakta olup olmadığını kontrol etmen için `docker compose logs`
komutunu önerir.

Port otomatik tespiti güvenmediğin ya da farklı bir port kontrol etmek
istediğin durumlarda, `config/projects.json`'da projeye özel
`"healthCheckPort": 3000` alanı tanımlayarak otomatik tespiti eleyebilirsin.

### Projeyi Çalıştırma (Docker Gerektirmeyen Projeler)
`requiresDocker: false` olan (ya da otomatik tespitte docker-compose bulunamayan)
projelerde, kurulum bittikten sonra script projeyi **arka planda kendisi başlatır** —
hiçbir elle müdahale gerekmez. Hangi komutun çalıştırılacağı şu öncelik sırasıyla
belirlenir (ilk eşleşen kazanır):

1. `config/projects.json`'da açık `"runCommand": "npm run start:dev"` tanımlıysa onu kullanır
2. `package.json`'da `dev` / `start` / `serve` script'lerinden ilk bulduğunu
   (`npm|yarn|pnpm run <script>`, paket yöneticisi lockfile'a göre otomatik seçilir)
3. Laravel projelerinde (kök dizinde `artisan` dosyası varsa) `php artisan serve`
4. Hiçbiri yoksa `README.md` dosyasındaki "Setup / Kurulum / Run / Development /
   Çalıştırma" gibi başlıkların altındaki kod bloklarını tarar — **sadece**
   `npm`/`yarn`/`pnpm`/`npx` ile başlayan `dev`/`start`/`serve` komutlarını
   güvenli kabul edip otomatik çalıştırır. README'ler makine değil insan için
   yazıldığından (placeholder token, platforma özel alternatif, yanlışlıkla
   yıkıcı örnek komut içerebilir) başka hiçbir satır otomatik çalıştırılmaz —
   bulunursa sadece ekrana "elle bakman gerekebilir" notuyla yazdırılır.

Komut bulunduğunda süreç `spawn(..., { detached: true })` ile arka planda
başlatılır, çıktısı `<proje>/.dev-setup-run.log` dosyasına yazılır. Script bu
log'da `http://localhost:<port>` gibi bir kalıp arayarak (Vite/Next.js/CRA/Vue
CLI gibi araçların tipik çıktısı) portu tespit eder; bulamazsa en yaygın dev
server portlarını (3000, 5173, 8080, 4200, 5000, 8000, 4000) dener. Port
tespit edilip health-check geçince `✅ Proje çalışıyor: http://localhost:<port>`
basılır; süreç PID'i ve log yolu da gösterilir (durdurmak için `kill <PID>`).

Port otomatik tespitine güvenmiyorsan `config/projects.json`'da
`"runPort": 3000` tanımlayarak log taramasını atlayabilirsin. Mobil (iOS/Android,
Xcode/Android Studio gerektiren) projeler bu turda kapsam dışıdır — script bir
run komutu bulamazsa sadece bilgilendirme mesajı basar.

## Bilinen Sınırlamalar / Sonraki Adımlar
- ~~Araç eksikse otomatik kurmuyor~~ **Değişti:** artık tek bir onayla eksik araçları otomatik kurabiliyor / Docker Desktop'ı otomatik açabiliyor, bkz. [Eksik Araçları Otomatik Halletme](#eksik-araçları-otomatik-halletme)
- Windows'ta Docker gerektiren projelerde WSL2 durumu kontrol edilir (`checkWsl2Status`), ancak bu en iyi çaba (best-effort) bir kontroldür ve sadece uyarı verir, kurulumu durdurmaz — gerçek bir Windows makinesinde henüz doğrulanmadı
- **Bilinen bug (kod incelemesinde bulundu, düzeltildi):** `runProject`, tespit edilen çalıştırma komutunu (`npm`/`yarn`/`pnpm`/`php` vb.) `child_process.spawn` ile arka planda başlatıyor; bu komut PATH'te yoksa (örn. repo yarn/pnpm istiyor ama kurulu değil) Node.js'in `spawn` fonksiyonu asenkron bir `'error'` event'i fırlatır — dinlenmezse bu, script'i ham bir stack trace ile çökertir (docker-daemon bug'ıyla aynı sınıftan, ama execSync'in aksine üst seviyedeki `catch`'e bile düşmeden çöker). `child.once('spawn', ...)` / `child.once('error', ...)` ile düzeltildi ve hem başarısız (`ENOENT`) hem başarılı senaryo gerçek bir alt süreçle test edildi
- **Bilinen bug (kod incelemesinde bulundu, düzeltildi):** `runProject`, komutu `command.split(' ')` ile ayrıştırıyordu — tırnaklı argümanları (örn. `node server.js --title "My App"`) yanlış bölüyor, çoklu boşluğu boş token'a çeviriyordu. Basit bir tırnak-farkında `parseCommand` parser'ı ile değiştirildi, tırnaklı/çoklu-boşluklu senaryolarla test edildi
- **Bilinen bug (kod incelemesinde bulundu, düzeltildi):** log'dan port yakalanamadığında devreye giren "en yaygın portları dene" fallback'i, geliştiricinin bambaşka bir projeden zaten açık bıraktığı bir portu (örn. 3000) bizim yeni başlattığımız servis sanıp yanlışlıkla "hazır" diye raporlayabiliyordu. `snapshotOpenPorts`, spawn'dan ÖNCE hangi ortak portların zaten açık olduğunu kaydedip fallback'te onları eliyor artık; hem "önceden meşgul port yanlışlıkla raporlanmıyor" hem "gerçekten yeni açılan ortak port doğru tespit ediliyor" senaryoları gerçek alt süreçlerle test edildi
- **Bilinen bug (gerçek testte bulundu, düzeltildi):** `runPostCloneCommands`'daki bir komut (örn. `composer install`) reponun kendi yapılandırma sorunu yüzünden başarısız olursa, script eskiden HER ŞEYİ (kalan postCloneCommands, docker/runProject adımları, kapanış mesajı) durdurup üst seviye hatayla çöküyordu. Gerçek bir Airalo reposunda (`test-dev-playground`, `composer.json`'ı var olmayan bir `modules/*` path repository'sine referans veriyor) gözlemlendi. Artık başarısız komut bir uyarı olarak işaretlenip script geri kalan adımlara devam ediyor, kapanışta başarısız komutlar ayrıca listeleniyor — gerçek repo ile test edildi
- Doppler gibi başka secret yöneticileri için entegrasyon eklenmedi, sadece 1Password destekleniyor
- Mobil projeler (iOS/Android) için otomatik çalıştırma desteklenmiyor — script sadece run komutu bulamadığını bildirir, README'deki adımlar elle uygulanmalı
- Python (pip/poetry), Ruby (bundler), Go gibi diğer diller için henüz install/run tespiti yok — sadece npm/yarn/pnpm ve composer/Laravel destekleniyor
- **Bilinen bug (gerçek testte, sıfır bir VM'de bulundu, düzeltildi):** `node bin/setup.js`'in kendisi Node gerektirdiği için, Node hiç kurulu değilse script'in "eksik araçları otomatik kur" özelliği bile devreye giremiyordu (script'i başlatacak şeyin kendisi eksikti) — klasik tavuk-yumurta sorunu. `bootstrap.sh` eklendi: saf bash ile yazılmış, hiçbir ön koşul gerektirmeyen bir script Homebrew → git/node/gh → GitHub girişi → repo clone → `node bin/setup.js` zincirini kurup devrediyor. "Zaten kurulu" tespiti (git/node/gh/homebrew) ve genel kurulum mekanizması (`brew install` + doğrulama) bu makinede gerçek çalıştırmalarla test edildi (git/node/gh zaten kurulu olduğu için o üçünü silip yeniden kurmak yerine, aynı mekanizma zararsız bir paketle — `tree` — doğrulandı); placeholder repo URL'i yüzünden clone adımı ve sonrası (npm install, gerçek node bin/setup.js devri) henüz sıfır bir makinede uçtan uca doğrulanmadı
- ~~Docker Compose `profiles` sorunu~~ **Düzeltildi:** `detectComposeHostPort` artık `profiles` alanı olan servisleri (örn. `profiles: ["app"]`) health-check portu adayı olarak değerlendirmiyor — çünkü bizim çalıştırdığımız düz `docker compose up -d` hiçbir profil seçmez, o servisler hiç başlamaz. Bu, gerçek bir Airalo reposunda (`test-plx-airlock`, backend/frontend'i `app` profiline gizleyip sadece `make prod-local` ile başlatan bir Makefile akışı kullanıyor) gözlemlenmişti — script eskiden ayağa kalkmayan bir servisi "hazır" gibi yanlış raporlayabilirdi. Sentetik senaryolarla (profil arkasındaki servis önce/sonra listelenmiş, tüm servisler profilli) ve gerçek `test-plx-airlock` compose dosyasıyla doğrulandı (artık doğru şekilde postgres'in 5433 portunu seçiyor, profilli backend/frontend'i değil)
- **Gerçek Airalo repolarına karşı uçtan uca doğrulandı** (`expect` ile interaktif autocomplete otomatikleştirilip tam akış — `gh auth` → `gh repo list` → repo seçimi → gerçek `git clone` → `autoDetect` → kurulum → `runProject` — hatasız çalıştırıldı):
  - `test-dev-playground` (PHP/composer, run komutu yok) → composer/Laravel desteğinin eklenmesine yol açtı
  - `test-task` (gerçek Laravel + Vite + docker-compose) → docker-compose gerçekten kullanıldığında **`checkPrerequisites`'in `docker` CLI'ın PATH'te olmasını "docker çalışıyor" sanma bug'ını** ortaya çıkardı: bu makinede docker CLI kuruluydu ama Docker Desktop kapalıydı, script `docker compose up` adımına kadar ilerleyip ham bir hatayla çöküyordu. `isDockerDaemonRunning()` (`docker info` ile) eklenerek düzeltildi ve gerçek repo ile tekrar test edilip temiz bir "Docker Desktop'ı aç" mesajıyla düzgün durduğu doğrulandı
  - `airalo-partner-panel-frontend` (gerçek production Vue/Vite/Yarn Berry frontend'i) → gerçek `yarn install` (corepack ile yarn 4.13.0), gerçek `.env.example` → `.env` kopyalama, `yarn run serve` script'inin doğru tespiti (öncelik listesindeki `dev`/`start` değil `serve` — gerçek dünyada ilk kez bu dalın çalıştığı görüldü), Vite dev server'ının arka planda başlatılıp portunun (5173) log'dan doğru sniff edilmesi ve health-check'in geçmesi — `curl` ile `HTTP 200` alınarak uygulamanın gerçekten ayakta olduğu doğrulandı
  - `partner-platform-lite` (gerçek Vue/Vite Chrome extension projesi, pnpm) → paket yöneticisi üçlüsünün son ayağı: gerçek `pnpm install`, `.env.example` → `.env`, `pnpm run dev` script tespiti, Vite dev server (5173) health-check — `curl` ile `HTTP 200`. Böylece npm/yarn/pnpm'in üçü de gerçek Airalo repolarıyla doğrulanmış oldu
  - Tüm bu testler tekrarlanıp (docker-daemon, spawn-crash, compose-profiles, command-parsing, port-false-positive, postCloneCommands-devam-etme düzeltmelerinden SONRA) hâlâ doğru çalıştığı doğrulandı; ayrıca `test-dev-playground`'da `composer install`'ın reponun kendi `modules/*` path repository sorunu yüzünden gerçekten başarısız olduğu ve script'in artık çökmek yerine geri kalan adımlara devam ettiği gerçek veriyle doğrulandı
- **Bilinen bug (gerçek testte bulundu, düzeltildi):** `dockerUp`'taki `docker compose up -d` komutu port çakışması/build hatası gibi nedenlerle başarısız olursa, script eskiden tüm kalan adımları (kapanış mesajı dahil) durdurup üst seviye hatayla çöküyordu. Gerçek bir Airalo reposunda (`test-task`, Docker Desktop otomatik açıldıktan sonra) kullanıcının **bambaşka bir projesinden** (`airalo-shopify`) kalma bir container'ın aynı host portunu (`63790`, redis) tutması yüzünden gerçekten tetiklendi. Artık başarısız olursa uyarı basıp devam ediyor — `runPostCloneCommands` ile aynı dayanıklılık ilkesi
- **Bilinen bug (aynı testte bulundu, düzeltildi):** yukarıdaki senaryoda `docker compose up` başarısız olmasına rağmen script'in kapanış mesajı hâlâ proje-özel `readyMessage`'ı ("Docker ile ayağa kalktı! http://localhost:8080...") gösteriyordu — yanıltıcıydı. `dockerUp` artık başarı durumunu döndürüyor; başarısızsa `readyMessage` yerine dürüst bir uyarı basılıyor. Gerçek repo ile (aynı port çakışması senaryosunda) doğrulandı
- Henüz gerçek bir Airalo reposuna karşı doğrulanmayan kısımlar: 1Password `op inject` (gerçek 1Password hesabıyla denenmedi — bu makinede op kurulu değil), `php artisan serve` run yolu (gerçek bir Laravel reposunda run komutu tetiklenmedi, Airalo'daki gerçek Laravel repoları hep docker-compose kullanıyor), Docker Desktop otomatik açıldıktan sonra **başarılı** bir `docker compose up` + health-check'in tam mutlu yolu (bu makinede denenen tek gerçek docker-compose reposu, kullanıcının kendi başka bir projesiyle port çakıştığı için hep başarısız oldu — hata yolu iyi test edildi ama başarı yolu henüz gerçek bir repo ile görülmedi)
