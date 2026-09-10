#!/usr/bin/env bash
#
# Dev Setup — Bootstrap
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
# NOTE: if you fork this tool under your own GitHub org/account, update
# GH_REPO below (and the curl URL in the usage comment above) to point at
# your fork.

set -euo pipefail

# ---- The one configurable value: the tool's actual repo ------------------
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

# gh's own "press Enter -> open the browser" mechanism sometimes fails to
# silently open the browser on some virtual machines (e.g. a screen-shared
# VM) even after pressing Enter (observed in a real test). So we watch gh's
# output in the background and open the login URL ourselves via `open` —
# we attach it to a real pty via `script` so as not to break gh's normal
# flow (otherwise stdout turns into a pipe, which can disable gh's
# interactive mode/color output). Both "gh auth login" and "gh auth
# refresh" use the same browser-opening behavior, hence a shared function.
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
echo "${BOLD}👋 Dev Setup — Bootstrap${RESET}"
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

# brew installs under /opt/homebrew (Apple Silicon) or /usr/local (Intel)
# and may not automatically end up on PATH. We set up PATH persistently
# (~/.zprofile) for both this session and terminals opened later —
# otherwise, after the script closes, errors like "gh: command not found"
# show up, because eval only affects the current process, not permanently.
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
  # https protocol: no requirement for an SSH key to be set up/registered
  # on the machine, gh authenticates with its own token (including for git
  # clone/push). read:packages: needed to pull private packages from
  # GitHub Packages (npm.pkg.github.com), gh's default minimum scope set
  # doesn't include this (see the read:packages check below).
  run_gh_auth_with_reliable_browser_open gh auth login --web --git-protocol https --scopes read:packages

  gh auth status >/dev/null 2>&1 || fail "GitHub sign-in did not complete. Try again: gh auth login --web --git-protocol https --scopes read:packages"
fi

# A previous sign-in may have used the ssh protocol (old bootstrap runs) —
# to fully remove the SSH key requirement, we force https here too, even
# if we skipped the sign-in step. gh keeps the host-based protocol
# SEPARATELY in ~/.config/gh/hosts.yml, and it overrides the general config
# (config.yml) — if we don't set both, "gh repo clone" silently falls back to ssh.
gh config set git_protocol https
gh config set -h github.com git_protocol https

# gh's default minimum scope set (repo, read:org, gist) does NOT include
# GitHub Packages (npm.pkg.github.com) — some JS repos pull their
# dependencies from there as private packages (observed on a real production
# frontend repo as "Invalid authentication"/403 permission_denied). A
# previous sign-in may have happened without requesting this scope, so we
# check idempotently here too and add it if missing.
if ! gh auth status 2>&1 | grep -q "read:packages"; then
  info "Adding read:packages permission for GitHub Packages (private npm packages)..."
  run_gh_auth_with_reliable_browser_open gh auth refresh --hostname github.com --scopes read:packages
fi
gh auth setup-git >/dev/null 2>&1 || true

# ---- 4) Clone dev-setup-cli (updates it if already present) ---------------
# To avoid requiring an SSH key, we clone with gh's own (token-based,
# HTTPS) authentication instead of git+ssh — there's no requirement for
# an SSH key to be registered on GitHub for this machine.
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
