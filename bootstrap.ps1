# Airalo Dev Setup — Bootstrap (Windows)
#
# Sifir bir makinede (Node/Git/GitHub CLI dahil hicbir sey kurulu degilken)
# calistirilacak TEK komut budur. Amac: dev-setup-cli'i calistirabilmek icin
# gereken minimum arac zincirini (winget -> git/node/gh) kurmak, GitHub'a
# giris yaptirmak, asil araci clone'lamak ve ona devretmek. bootstrap.sh'in
# (macOS) birebir Windows/PowerShell esdegeridir.
#
# Kullanim (PowerShell'i YONETICI OLARAK acip, yeni bir makinede tek satir):
#   irm https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.ps1 | iex
#
# ya da bu dosya elle indirilip/kopyalanip calistirilabilir:
#   .\bootstrap.ps1
#
# NOT: Bu script gercek bir Windows makinesinde henuz test edilmedi
# (bootstrap.sh macOS'ta gercek calistirmalarla dogrulandi, bu Windows
# esdegeri sadece mantiksal olarak yazildi) -- ilk calistirmada dikkatli ol.

$ErrorActionPreference = "Stop"

# ---- Ayarlanabilir tek deger: aracin gercek reposu ------------------------
$RepoUrl  = "git@github.com:fatihtzn/dev-setup-cli.git"
$CloneDir = Join-Path $HOME "dev-setup-cli"
# ----------------------------------------------------------------------------

function Write-Info { param($msg) Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok   { param($msg) Write-Host "OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "!!  $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "X   $msg" -ForegroundColor Red; exit 1 }

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# winget ile bir sey kurduktan sonra, o programin PATH degisikligi bu
# PowerShell oturumuna otomatik yansimaz (Windows PATH process-basli cache'lenir).
# Machine + User PATH'lerini birlestirip mevcut oturuma yeniden uyguluyoruz,
# aksi halde "kuruldu ama hala bulunamiyor" hatasi alinir.
function Update-SessionPath {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

Write-Host ""
Write-Host "Airalo Dev Setup - Bootstrap (Windows)" -ForegroundColor White
Write-Host "Bu script git/node/gh eksikse kurar, GitHub'a giris yaptirir, sonra dev-setup-cli'a devreder."
Write-Host ""

# ---- 1) winget kontrolu -----------------------------------------------------
if (-not (Test-CommandExists "winget")) {
    Write-Fail "winget bulunamadi. Windows 10 (1709+)/11'de 'App Installer' Microsoft Store'dan kurulu olmali. Kurup script'i tekrar calistir: https://apps.microsoft.com/detail/9nblggh4nns1"
}
Write-Ok "winget mevcut."

# ---- 2) git / node / gh -----------------------------------------------------
$tools = @(
    @{ Cmd = "git";  WingetId = "Git.Git" },
    @{ Cmd = "node";  WingetId = "OpenJS.NodeJS" },
    @{ Cmd = "gh";    WingetId = "GitHub.cli" }
)

foreach ($tool in $tools) {
    if (Test-CommandExists $tool.Cmd) {
        Write-Ok "$($tool.Cmd) zaten kurulu."
        continue
    }
    Write-Info "$($tool.Cmd) kuruluyor (winget install --id $($tool.WingetId))..."
    winget install --id $tool.WingetId --silent --accept-package-agreements --accept-source-agreements
    Update-SessionPath
    if (-not (Test-CommandExists $tool.Cmd)) {
        Write-Fail "$($tool.Cmd) kuruldu ama bu oturumda hala bulunamiyor. Yeni bir PowerShell penceresi ac ve script'i tekrar calistir."
    }
    Write-Ok "$($tool.Cmd) kuruldu."
}

# ---- 3) GitHub'a giris (Okta SSO, tarayicida) ------------------------------
$ghAuthOk = $true
try {
    gh auth status *> $null
} catch {
    $ghAuthOk = $false
}

if ($ghAuthOk) {
    Write-Ok "GitHub CLI zaten giris yapilmis."
} else {
    Write-Info "GitHub girisi gerekiyor. Tarayici acilacak, Okta SSO ile giris yap (MFA dahil)."
    gh auth login --web --git-protocol ssh
}

# ---- 4) dev-setup-cli'i clone'la (zaten varsa gunceller) -------------------
if (Test-Path (Join-Path $CloneDir ".git")) {
    Write-Info "dev-setup-cli zaten $CloneDir altinda, guncelleniyor..."
    git -C $CloneDir pull --ff-only
} else {
    Write-Info "dev-setup-cli clone'laniyor -> $CloneDir"
    git clone $RepoUrl $CloneDir
}

# ---- 5) npm bagimliliklari + asil araci calistir ---------------------------
Write-Info "Bagimliliklar kuruluyor (npm install)..."
Push-Location $CloneDir
try {
    npm install --no-audit --no-fund
} finally {
    Pop-Location
}

Write-Ok "Hazirlik tamamlandi, dev-setup-cli'a devrediliyor..."
Write-Host ""
node (Join-Path $CloneDir "bin\setup.js") @args
