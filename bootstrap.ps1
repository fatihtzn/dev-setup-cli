# Dev Setup — Bootstrap (Windows)
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

# Deliberately NOT "Stop". When external (.exe) commands (winget, git, npm,
# gh) write anything to stderr -- they often print progress/info messages
# even on successful installs -- PowerShell's $ErrorActionPreference =
# "Stop" turns this into a TERMINATING error and kills the script instantly,
# with no explanation (observed on a real Windows machine as "errors out
# and closes right after installing winget"). Instead we use "Continue"
# and check the REAL success via $LASTEXITCODE after every critical native command.
$ErrorActionPreference = "Continue"

# On Windows, npm ships as both npm.cmd and npm.ps1; in PowerShell, the
# bare "npm" command usually tries to run npm.ps1. Because the default
# Windows PowerShell execution policy (Restricted) blocks unsigned .ps1
# files, this used to stop the script with a "npm.ps1 cannot be loaded
# because running scripts is disabled on this system" error (observed on a
# real Windows machine). The "Process" scope only affects the current
# PowerShell process this script is running in -- it does NOT change any
# persistent system/user setting, ends on its own when the process closes,
# and doesn't require admin rights.
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force

# ---- The one configurable value: the tool's actual repo ------------------
$GhRepo   = "fatihtzn/dev-setup-cli"
$CloneDir = Join-Path $HOME "dev-setup-cli"
# ----------------------------------------------------------------------------

function Write-Info { param($msg) Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok   { param($msg) Write-Host "OK  $msg" -ForegroundColor Green }
function Write-Warn { param($msg) Write-Host "!!  $msg" -ForegroundColor Yellow }
# throw instead of exit: so the outermost try/catch can catch the error,
# show it to the user before the window closes, and wait for Enter.
function Write-Fail { param($msg) Write-Host "X   $msg" -ForegroundColor Red; throw $msg }

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# After installing something with winget, that program's PATH change isn't
# automatically reflected in this PowerShell session (Windows PATH is
# cached per-process). We merge the Machine + User PATHs and reapply them
# to the current session, otherwise we get an "installed but still not
# found" error.
function Update-SessionPath {
    $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

try {
    Write-Host ""
    Write-Host "Dev Setup - Bootstrap (Windows)" -ForegroundColor White
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
        # --source winget: if the winget ID exists in both the "winget" and
        # "msstore" sources, this pins it to the winget source without
        # asking which one to use. The msstore source's certificate
        # validation can fail on some (especially disposable/test) VMs
        # ("0x8a15005e: The server certificate did not match...") and stop
        # the whole install without installing anything -- observed on a
        # real Windows VM.
        winget install --id $tool.WingetId --source winget --silent --accept-package-agreements --accept-source-agreements
        # Since winget can write to stderr even on a successful install
        # (depending on version/package) and its return code can be
        # inconsistent, the real success criterion is the Test-CommandExists
        # check below, not $LASTEXITCODE.
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
        # https protocol: no requirement for an SSH key to be set up/registered
        # on the machine, gh authenticates with its own token (including for
        # git clone/push) — this is the Windows side of the same issue found
        # as "Permission denied (publickey)" in macOS's bootstrap.sh.
        # read:packages: needed to pull private packages from GitHub Packages
        # (npm.pkg.github.com), gh's default minimum scope set doesn't include this.
        gh auth login --web --git-protocol https --scopes read:packages
        if ($LASTEXITCODE -ne 0) {
            Write-Fail "GitHub sign-in did not complete (exit code $LASTEXITCODE). Try again: gh auth login --web --git-protocol https --scopes read:packages"
        }
    }

    # A previous sign-in may have used the ssh protocol, or happened
    # without read:packages — we fix this idempotently here too. gh keeps
    # the host-based protocol separately and it overrides the general
    # config, so we set both.
    gh config set git_protocol https
    gh config set -h github.com git_protocol https
    $authStatusText = (gh auth status 2>&1 | Out-String)
    if ($authStatusText -notmatch "read:packages") {
        Write-Info "Adding read:packages permission for GitHub Packages (private npm packages)..."
        gh auth refresh --hostname github.com --scopes read:packages
    }
    gh auth setup-git *> $null

    # ---- 4) Clone dev-setup-cli (updates it if already present) ---------------
    # To avoid requiring an SSH key, we clone with gh's own (token-based,
    # HTTPS) authentication instead of git+ssh.
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
