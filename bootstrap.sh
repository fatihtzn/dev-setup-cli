#!/usr/bin/env bash
#
# Airalo Dev Setup — Bootstrap
#
# This is the ONE command to run on a fresh machine (nothing installed yet,
# not even Node/Git/GitHub CLI). Goal: install the minimum toolchain needed
# to run dev-setup-cli (Homebrew -> git/node/gh), sign in to GitHub, clone
# the actual tool, and hand off to it.
#
# Usage (on a new machine, open a terminal and run this one line):
#   bash <(curl -fsSL https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.sh)
#
# or download/copy this file manually and run it:
#   bash bootstrap.sh
#
# IMPORTANT: use "bash <(curl ...)" (process substitution), NOT
# "curl ... | bash" (pipe). With a pipe, the script's stdin gets filled with
# curl's own output, so the terminal is no longer a TTY — this prevents
# "gh auth login --web" from opening the browser automatically (it just
# prints the code/URL and stops). With process substitution the script is
# read like a file argument, stdin stays the real terminal, and the browser
# opens automatically.
#
# IMPORTANT: do not run this script with SUDO. Under sudo, $HOME points to
# root's home (/var/root); the clone, gh sign-in, and PATH setup would then
# go to the wrong user and be invisible from your normal terminal.
#
# NOTE: this currently points at fatihtzn's PERSONAL (private) repo — once
# this tool moves to the real Airalo GitHub org, this comment and the curl
# URL above need to be updated.

set -euo pipefail

# ---- Ayarlanabilir tek değer: aracın gerçek reposu ----------------------
GH_REPO="fatihtzn/dev-setup-cli"
CLONE_DIR="${HOME}/dev-setup-cli"
# --------------------------------------------------------------------------

BOLD="$(tput bold 2>/dev/null || true)"
RESET="$(tput sgr0 2>/dev/null || true)"
GREEN="$(tput setaf 2 2>/dev/null || true)"
YELLOW="$(tput setaf 3 2>/dev/null || true)"
RED="$(tput setaf 1 2>/dev/null || true)"

info()  { printf '%s\n' "${BOLD}==>${RESET} $*"; }
warn()  { printf '%s\n' "${YELLOW}⚠️  $*${RESET}"; }
ok()    { printf '%s\n' "${GREEN}✅ $*${RESET}"; }
fail()  { printf '%s\n' "${RED}❌ $*${RESET}"; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# gh'nin kendi "Enter'a bas -> tarayıcıyı aç" mekanizması bazı sanal
# makinelerde (ör. ekran paylaşımlı VM) Enter'a basılsa bile tarayıcıyı
# sessizce açmayabiliyor (gerçek testte gözlemlendi). Bu yüzden gh'nin
# çıktısını arka planda izleyip login URL'ini biz de `open` ile açıyoruz —
# gh'nin normal akışını bozmamak için `script` ile gerçek bir pty'ye
# bağlıyoruz (aksi halde stdout pipe'a döner, gh interaktif modu/renk
# çıktısını kapatabilir). Hem "gh auth login" hem "gh auth refresh" aynı
# tarayıcı-açma davranışını kullandığı için ortak bir fonksiyon.
run_gh_auth_with_reliable_browser_open() {
  if ! command_exists script; then
    "$@"
    return
  fi
  local log
  log="$(mktemp)"
  (
    for _ in $(seq 1 300); do
      if [ -s "$log" ]; then
        url="$(grep -oE 'https://github\.com/login/device[^[:space:]]*' "$log" 2>/dev/null | head -1 || true)"
        if [ -n "$url" ]; then
          open "$url" >/dev/null 2>&1 || true
          break
        fi
      fi
      sleep 0.2
    done
  ) &
  local watcher_pid=$!

  script -q "$log" "$@"

  kill "$watcher_pid" >/dev/null 2>&1 || true
  wait "$watcher_pid" 2>/dev/null || true
  rm -f "$log"
}

if [ "$(id -u)" -eq 0 ]; then
  fail "Do not run this script with sudo. Under sudo \$HOME points to root's home, not yours; the clone, gh sign-in, and PATH setup would go to root instead of your user. Run it again as a normal user (no sudo) — brew/gh will ask for your password themselves when they actually need it."
fi

OS="$(uname -s)"
if [ "$OS" != "Darwin" ]; then
  fail "This bootstrap script is currently only tested on macOS (Darwin). Detected: $OS. Don't use this script on Windows — ask a teammate for the PowerShell equivalent."
fi

echo
echo "${BOLD}👋 Airalo Dev Setup — Bootstrap${RESET}"
echo "This script installs git/node/gh if missing, signs you in to GitHub, then hands off to dev-setup-cli."
echo

# ---- 1) Homebrew ----------------------------------------------------------
if ! command_exists brew; then
  info "Homebrew not found, installing (via the official install script)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ok "Homebrew installed."
else
  ok "Homebrew already installed."
fi

# brew /opt/homebrew (Apple Silicon) ya da /usr/local (Intel) altına kurulur
# ve PATH'e otomatik girmeyebilir. Hem bu oturum hem de ileride açılacak
# terminaller için PATH'i kalıcı şekilde ayarlıyoruz (~/.zprofile) —
# aksi halde script kapandıktan sonra "gh: command not found" gibi hatalar
# alınır çünkü eval sadece o anki process'i etkiler, kalıcı olmaz.
BREW_BIN=""
if [ -x /opt/homebrew/bin/brew ]; then
  BREW_BIN="/opt/homebrew/bin/brew"
elif [ -x /usr/local/bin/brew ]; then
  BREW_BIN="/usr/local/bin/brew"
fi
if [ -n "$BREW_BIN" ]; then
  eval "$("$BREW_BIN" shellenv)"
  SHELLENV_LINE="eval \"\$($BREW_BIN shellenv)\""
  touch "${HOME}/.zprofile"
  if ! grep -qF "$SHELLENV_LINE" "${HOME}/.zprofile" 2>/dev/null; then
    printf '\n%s\n' "$SHELLENV_LINE" >> "${HOME}/.zprofile"
    info "PATH permanently added to ~/.zprofile (gh/git/node will also be found in new terminals)."
  fi
fi

# ---- 2) git / node / gh ----------------------------------------------------
for tool in git node gh; do
  if command_exists "$tool"; then
    ok "$tool already installed."
    continue
  fi
  info "Installing $tool (brew install $tool)..."
  brew install "$tool"
  command_exists "$tool" || fail "$tool could not be installed, run 'brew install $tool' manually and try again."
  ok "$tool installed."
done

# ---- 3) Sign in to GitHub (Okta SSO, in the browser) -----------------------
if gh auth status >/dev/null 2>&1; then
  ok "GitHub CLI is already signed in."
else
  info "GitHub sign-in required. A browser will open, sign in via Okta SSO (including MFA)."
  # https protokolü: makinede SSH key kurulu/kayıtlı olması şartı yok,
  # gh kendi token'ıyla kimlik doğruluyor (git clone/push dahil).
  # read:packages: GitHub Packages'tan (npm.pkg.github.com) private paket
  # çekebilmek için gerekli, gh'nin varsayılan minimum scope seti bunu
  # içermez (aşağıdaki read:packages kontrolüne bakınız).
  run_gh_auth_with_reliable_browser_open gh auth login --web --git-protocol https --scopes read:packages

  gh auth status >/dev/null 2>&1 || fail "GitHub sign-in did not complete. Try again: gh auth login --web --git-protocol https --scopes read:packages"
fi

# Daha önce ssh protokolüyle giriş yapılmış olabilir (eski bootstrap
# çalıştırmaları) — SSH key şartını tamamen kaldırmak için burada da
# https'e zorluyoruz, giriş adımını atlasak bile. gh, host bazlı protokolü
# ~/.config/gh/hosts.yml içinde AYRICA tutar ve genel config'i (config.yml)
# ezer — ikisini de set etmezsek "gh repo clone" sessizce ssh'e döner.
gh config set git_protocol https
gh config set -h github.com git_protocol https

# gh'nin varsayılan minimum scope seti (repo, read:org, gist) GitHub
# Packages'ı (npm.pkg.github.com) İÇERMEZ — bazı Airalo JS repoları
# bağımlılıklarını oradan private paket olarak çeker (gerçek bir Airalo
# frontend reposunda "Invalid authentication"/403 permission_denied ile
# gözlemlendi). Daha önce (bu scope talep edilmeden) giriş yapılmış olabilir,
# bu yüzden burada da idempotent şekilde kontrol edip eksikse ekliyoruz.
if ! gh auth status 2>&1 | grep -q "read:packages"; then
  info "Adding read:packages permission for GitHub Packages (private npm packages)..."
  run_gh_auth_with_reliable_browser_open gh auth refresh --hostname github.com --scopes read:packages
fi
gh auth setup-git >/dev/null 2>&1 || true

# ---- 4) Clone dev-setup-cli (updates it if already present) ---------------
# SSH anahtarı gerektirmemesi için git+ssh yerine gh'nin kendi (token
# tabanlı, HTTPS) kimlik doğrulamasıyla clone ediyoruz — makinede GitHub'a
# kayıtlı bir SSH key olması şart değil.
if [ -d "$CLONE_DIR/.git" ]; then
  info "dev-setup-cli already exists at $CLONE_DIR, updating..."
  git -C "$CLONE_DIR" pull --ff-only
else
  info "Cloning dev-setup-cli -> $CLONE_DIR"
  gh repo clone "$GH_REPO" "$CLONE_DIR"
fi

# ---- 5) Install npm dependencies and run the actual tool -------------------
info "Installing dependencies (npm install)..."
(cd "$CLONE_DIR" && npm install --no-audit --no-fund)

ok "Setup complete, handing off to dev-setup-cli...\n"
exec node "$CLONE_DIR/bin/setup.js" "$@"
