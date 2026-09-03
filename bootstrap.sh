#!/usr/bin/env bash
#
# Airalo Dev Setup — Bootstrap
#
# Sıfır bir makinede (Node/Git/GitHub CLI dahil hiçbir şey kurulu değilken)
# çalıştırılacak TEK komut budur. Amaç: dev-setup-cli'ı çalıştırabilmek için
# gereken minimum araç zincirini (Homebrew -> git/node/gh) kurmak, GitHub'a
# giriş yaptırmak, asıl aracı clone'lamak ve ona devretmek.
#
# Kullanım (yeni bir makinede, terminali açıp tek satır):
#   curl -fsSL https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.sh | bash
#
# ya da bu dosya elle indirilip/kopyalanıp çalıştırılabilir:
#   bash bootstrap.sh
#
# NOT: Şu an fatihtzn'in KİŞİSEL (private) reposuna işaret ediyor —
# bu araç gerçek Airalo GitHub org'una taşındığında burası ve yukarıdaki
# curl URL'i güncellenmeli.

set -euo pipefail

# ---- Ayarlanabilir tek değer: aracın gerçek reposu ----------------------
REPO_URL="git@github.com:fatihtzn/dev-setup-cli.git"
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

OS="$(uname -s)"
if [ "$OS" != "Darwin" ]; then
  fail "Bu bootstrap script'i şu an sadece macOS için test edildi (Darwin). Tespit edilen: $OS. Windows'ta bu betiği kullanma, ekip arkadaşından PowerShell eşdeğerini iste."
fi

echo
echo "${BOLD}👋 Airalo Dev Setup — Bootstrap${RESET}"
echo "Bu script git/node/gh eksikse kurar, GitHub'a giriş yaptırır, sonra dev-setup-cli'a devreder."
echo

# ---- 1) Homebrew ----------------------------------------------------------
if ! command_exists brew; then
  info "Homebrew bulunamadı, kuruluyor (resmi kurulum betiği ile)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Apple Silicon'da brew /opt/homebrew altına kurulur ve PATH'e otomatik
  # girmeyebilir; bu oturum için elle ekliyoruz.
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
  ok "Homebrew kuruldu."
else
  ok "Homebrew zaten kurulu."
fi

# ---- 2) git / node / gh ----------------------------------------------------
for tool in git node gh; do
  if command_exists "$tool"; then
    ok "$tool zaten kurulu."
    continue
  fi
  info "$tool kuruluyor (brew install $tool)..."
  brew install "$tool"
  command_exists "$tool" || fail "$tool kurulamadı, elle 'brew install $tool' çalıştırıp tekrar dene."
  ok "$tool kuruldu."
done

# ---- 3) GitHub'a giriş (Okta SSO, tarayıcıda) ------------------------------
if gh auth status >/dev/null 2>&1; then
  ok "GitHub CLI zaten giriş yapılmış."
else
  info "GitHub girişi gerekiyor. Tarayıcı açılacak, Okta SSO ile giriş yap (MFA dahil)."
  gh auth login --web --git-protocol ssh
fi

# ---- 4) dev-setup-cli'ı clone'la (zaten varsa günceller) -------------------
if [ -d "$CLONE_DIR/.git" ]; then
  info "dev-setup-cli zaten $CLONE_DIR altında, güncelleniyor..."
  git -C "$CLONE_DIR" pull --ff-only
else
  info "dev-setup-cli clone'lanıyor -> $CLONE_DIR"
  git clone "$REPO_URL" "$CLONE_DIR"
fi

# ---- 5) npm bağımlılıkları + asıl aracı çalıştır ---------------------------
info "Bağımlılıklar kuruluyor (npm install)..."
(cd "$CLONE_DIR" && npm install --no-audit --no-fund)

ok "Hazırlık tamamlandı, dev-setup-cli'a devrediliyor...\n"
exec node "$CLONE_DIR/bin/setup.js" "$@"
