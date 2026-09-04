# Airalo Dev Setup — Bootstrap (Windows)
#
# This is the ONE command to run on a fresh machine (nothing installed yet,
# not even Node/Git/GitHub CLI). Goal: install the minimum toolchain needed
# to run dev-setup-cli (winget -> git/node/gh), sign in to GitHub, clone the
# actual tool, and hand off to it. This is the exact Windows/PowerShell
# equivalent of bootstrap.sh (macOS).
#
# Usage (open PowerShell AS ADMINISTRATOR, on a new machine, one line):
#   irm https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.ps1 | iex
#
# or download/copy this file manually and run it:
#   .\bootstrap.ps1
#
# NOTE: this script has not been verified end-to-end on a real Windows
# machine yet (bootstrap.sh was verified with real runs on macOS; this
# Windows equivalent was written by mirroring that logic) -- be careful on
# first use and share the exact error text if something goes wrong.

# Bilerek "Stop" DEGIL. Harici (.exe) komutlar (winget, git, npm, gh) stderr'e
# bir sey yazdiginda -- basarili kurulumlarda bile sik sik ilerleme/bilgi
# mesaji yazarlar -- PowerShell $ErrorActionPreference = "Stop" iken bunu
# TERMINATING bir hataya cevirip scripti aninda, hicbir aciklama vermeden
# durduruyor (gercek bir Windows makinesinde "winget kurduktan sonra hata
# verip kapaniyor" olarak gozlemlendi). Bunun yerine "Continue" kullanip her
# kritik native komuttan sonra GERCEK basariyi $LASTEXITCODE ile kontrol
# ediyoruz.
$ErrorActionPreference = "Continue"

# ---- Ayarlanabilir tek deger: aracin gercek reposu ------------------------
$GhRepo   = "fatihtzn/dev-setup-cli"
$CloneDir = Join-Path $HOME "dev-setup-cli"
# ----------------------------------------------------------------------------

function Write-Info { param($msg) Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok   { param($msg) Write-Host "OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "!!  $msg" -ForegroundColor Yellow }
# exit yerine throw: en disttaki try/catch hatayi yakalayip pencere
# kapanmadan once kullaniciya gosterip Enter bekleyebilsin diye.
function Write-Fail { param($msg) Write-Host "X   $msg" -ForegroundColor Red; throw $msg }

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

try {
    Write-Host ""
    Write-Host "Airalo Dev Setup - Bootstrap (Windows)" -ForegroundColor White
    Write-Host "This script installs git/node/gh if missing, signs you in to GitHub, then hands off to dev-setup-cli."
    Write-Host ""

    # ---- 1) Check for winget -----------------------------------------------
    if (-not (Test-CommandExists "winget")) {
        Write-Fail "winget not found. On Windows 10 (1709+)/11, 'App Installer' must be installed from the Microsoft Store. Install it and re-run the script: https://apps.microsoft.com/detail/9nblggh4nns1"
    }
    Write-Ok "winget available."

    # ---- 2) git / node / gh -----------------------------------------------------
    $tools = @(
        @{ Cmd = "git";  WingetId = "Git.Git" },
        @{ Cmd = "node";  WingetId = "OpenJS.NodeJS" },
        @{ Cmd = "gh";    WingetId = "GitHub.cli" }
    )

    foreach ($tool in $tools) {
        if (Test-CommandExists $tool.Cmd) {
            Write-Ok "$($tool.Cmd) already installed."
            continue
        }
        Write-Info "Installing $($tool.Cmd) (winget install --id $($tool.WingetId))..."
        # --source winget: winget ID'yi hem "winget" hem "msstore" kaynagida
        # ararsa hangisini kullanacagini sormadan winget kaynagina sabitler.
        # msstore kaynaginin sertifika dogrulamasi bazi (ozellikle disposable/
        # test) VM'lerde basarisiz olup ("0x8a15005e: The server certificate
        # did not match...") tum kurulumu hicbir sey kurmadan durdurabiliyor
        # -- gercek bir Windows VM'de gozlemlendi.
        winget install --id $tool.WingetId --source winget --silent --accept-package-agreements --accept-source-agreements
        # winget bazi surumlerde/paketlerde basarili kurulumda bile stderr'e
        # yazabildigi ve donus kodu tutarsiz olabildigi icin, gercek basari
        # olcutu $LASTEXITCODE degil asagidaki Test-CommandExists kontrolu.
        Update-SessionPath
        if (-not (Test-CommandExists $tool.Cmd)) {
            Write-Fail "$($tool.Cmd) was installed but still cannot be found in this session. Open a new PowerShell window and re-run the script."
        }
        Write-Ok "$($tool.Cmd) installed."
    }

    # ---- 3) Sign in to GitHub (Okta SSO, in the browser) -----------------------
    gh auth status *> $null
    $ghAuthOk = ($LASTEXITCODE -eq 0)

    if ($ghAuthOk) {
        Write-Ok "GitHub CLI is already signed in."
    } else {
        Write-Info "GitHub sign-in required. A browser will open, sign in via Okta SSO (including MFA)."
        # https protokolü: makinede SSH key kurulu/kayıtlı olması şartı yok, gh
        # kendi token'ıyla kimlik doğruluyor (git clone/push dahil) — macOS'taki
        # bootstrap.sh'de "Permission denied (publickey)" ile bulunan aynı sorunun
        # Windows tarafı. read:packages: GitHub Packages'tan (npm.pkg.github.com)
        # private paket çekebilmek için gerekli, gh'nin varsayılan minimum scope
        # seti bunu içermez.
        gh auth login --web --git-protocol https --scopes read:packages
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "GitHub sign-in did not complete (exit code $LASTEXITCODE). Try again: gh auth login --web --git-protocol https --scopes read:packages"
        }
    }

    # Daha önce ssh protokolüyle ya da read:packages olmadan giriş yapılmış
    # olabilir — burada da idempotent şekilde düzeltiyoruz. gh, host bazlı
    # protokolü ayrıca tutar ve genel config'i ezer, ikisini de set ediyoruz.
    gh config set git_protocol https
    gh config set -h github.com git_protocol https
    $authStatusText = (gh auth status 2>&1 | Out-String)
    if ($authStatusText -notmatch "read:packages") {
        Write-Info "Adding read:packages permission for GitHub Packages (private npm packages)..."
        gh auth refresh --hostname github.com --scopes read:packages
    }
    gh auth setup-git *> $null

    # ---- 4) Clone dev-setup-cli (updates it if already present) ---------------
    # SSH anahtarı gerektirmemesi için git+ssh yerine gh'nin kendi (token
    # tabanlı, HTTPS) kimlik doğrulamasıyla clone ediyoruz.
    if (Test-Path (Join-Path $CloneDir ".git")) {
        Write-Info "dev-setup-cli already exists at $CloneDir, updating..."
        git -C $CloneDir pull --ff-only
        if ($LASTEXITCODE -ne 0) { Write-Fail "git pull failed (exit code $LASTEXITCODE)." }
    } else {
        Write-Info "Cloning dev-setup-cli -> $CloneDir"
        gh repo clone $GhRepo $CloneDir
        if ($LASTEXITCODE -ne 0) { Write-Fail "gh repo clone failed (exit code $LASTEXITCODE)." }
    }

    # ---- 5) Install npm dependencies and run the actual tool -------------------
    Write-Info "Installing dependencies (npm install)..."
    Push-Location $CloneDir
    try {
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed (exit code $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }

    Write-Ok "Setup complete, handing off to dev-setup-cli..."
    Write-Host ""
    node (Join-Path $CloneDir "bin\setup.js") @args
} catch {
    Write-Host ""
    Write-Host "X   Bootstrap failed:" -ForegroundColor Red
    Write-Host "    $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "(window kept open so you can read this -- press Enter to close)"
    Read-Host | Out-Null
    exit 1
}
