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
#   bash <(curl -fsSL https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.sh)
#
# ya da bu dosya elle indirilip/kopyalanıp çalıştırılabilir:
#   bash bootstrap.sh
#
# ÖNEMLİ: "curl ... | bash" (pipe) DEĞİL, "bash <(curl ...)" (process
# substitution) kullanılmalı. Pipe'ta script'in stdin'i curl'ün çıktısıyla
# dolduğu için terminal artık TTY değildir; bu da "gh auth login --web"in
# tarayıcıyı otomatik açmasını engeller (sadece kodu/URL'i basıp kalır).
# Process substitution'da script bir dosya argümanı gibi okunur, stdin
# gerçek terminalde kalır, tarayıcı otomatik açılır.
#
# ÖNEMLİ: bu script'i SUDO ile çalıştırma. sudo altında $HOME kökün evine
# (/var/root) döner; clone, gh girişi ve PATH ayarları yanlış kullanıcıya
# gider ve normal terminalinden görünmez olur.
#
# NOT: Şu an fatihtzn'in KİŞİSEL (private) reposuna işaret ediyor —
# bu araç gerçek Airalo GitHub org'una taşındığında burası ve yukarıdaki
# curl URL'i güncellenmeli.

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
  fail "Bu script'i sudo ile çalıştırma. sudo altında \$HOME /var/root'a döner; clone, gh girişi ve PATH ayarları senin kullanıcına değil root'a gider. Normal kullanıcı olarak (sudo'suz) tekrar çalıştır — brew/gh gerektiğinde kendi şifreni zaten soracak."
fi

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
  ok "Homebrew kuruldu."
else
  ok "Homebrew zaten kurulu."
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
    info "PATH kalıcı olarak ~/.zprofile içine eklendi (yeni terminallerde de gh/git/node bulunacak)."
  fi
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
  # https protokolü: makinede SSH key kurulu/kayıtlı olması şartı yok,
  # gh kendi token'ıyla kimlik doğruluyor (git clone/push dahil).
  # read:packages: GitHub Packages'tan (npm.pkg.github.com) private paket
  # çekebilmek için gerekli, gh'nin varsayılan minimum scope seti bunu
  # içermez (aşağıdaki read:packages kontrolüne bakınız).
  run_gh_auth_with_reliable_browser_open gh auth login --web --git-protocol https --scopes read:packages

  gh auth status >/dev/null 2>&1 || fail "GitHub girişi tamamlanamadı. Tekrar dene: gh auth login --web --git-protocol https --scopes read:packages"
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
  info "GitHub Packages (private npm paketleri) için read:packages izni ekleniyor..."
  run_gh_auth_with_reliable_browser_open gh auth refresh --hostname github.com --scopes read:packages
fi
gh auth setup-git >/dev/null 2>&1 || true

# ---- 4) dev-setup-cli'ı clone'la (zaten varsa günceller) -------------------
# SSH anahtarı gerektirmemesi için git+ssh yerine gh'nin kendi (token
# tabanlı, HTTPS) kimlik doğrulamasıyla clone ediyoruz — makinede GitHub'a
# kayıtlı bir SSH key olması şart değil.
if [ -d "$CLONE_DIR/.git" ]; then
  info "dev-setup-cli zaten $CLONE_DIR altında, güncelleniyor..."
  git -C "$CLONE_DIR" pull --ff-only
else
  info "dev-setup-cli clone'lanıyor -> $CLONE_DIR"
  gh repo clone "$GH_REPO" "$CLONE_DIR"
fi

# ---- 5) npm bağımlılıkları + asıl aracı çalıştır ---------------------------
info "Bağımlılıklar kuruluyor (npm install)..."
(cd "$CLONE_DIR" && npm install --no-audit --no-fund)

ok "Hazırlık tamamlandı, dev-setup-cli'a devrediliyor...\n"
exec node "$CLONE_DIR/bin/setup.js" "$@"
