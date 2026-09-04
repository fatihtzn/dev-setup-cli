# Dev Setup CLI

One-command environment setup for new hires.

## Usage

### On a completely fresh machine (nothing installed, not even Node/Git/GitHub CLI)
Since `node bin/setup.js` itself requires Node, you can't run this command if
Node isn't installed at all — a classic chicken-and-egg problem. To solve
this, there's a bootstrap script that requires no prerequisites at all (the
same pattern Homebrew/nvm/rustup use), one per platform:

**macOS** (`bootstrap.sh`, bash):
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.sh)
```

**Windows** (`bootstrap.ps1`, PowerShell — uses winget):
```powershell
irm https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.ps1 | iex
```

Both do, in order: verify the package manager (Homebrew / winget) → install
git/node/gh (if missing) → sign in to GitHub (Okta SSO, in the browser) →
clone the tool itself → hand off to `node bin/setup.js`.

> ⚠️ **Use `bash <(curl ...)` (process substitution), NOT `curl ... | bash`
> (pipe).** With a pipe, the script's stdin gets filled with curl's output,
> so the terminal is no longer a TTY; this is why `gh auth login --web` can't
> open the browser automatically and just prints the code/URL instead (the
> "Running in non-interactive mode because `stdin` is not a TTY" warning is
> the telltale sign). With process substitution, stdin stays the real
> terminal and the browser opens automatically.
>
> ⚠️ **Do not run the script with `sudo`.** Under sudo, `$HOME` points to
> `/var/root`; the clone, gh sign-in, and PATH setup would then go to root
> instead of your normal user and become invisible from your own terminal.
> brew/gh will already ask for your password themselves when they actually
> need it — run the script as a plain user.

**Verification status:** `bootstrap.sh` has been tested end-to-end both on
macOS and on a real VM (including Homebrew install, PATH persistence, gh
HTTPS sign-in). `bootstrap.ps1` has **not been tested on a real Windows
machine yet** since this machine is macOS — it was written logically, so be
careful on first use and report any issues you find.

### If git/node/gh are already installed
```bash
npm install
node bin/setup.js
```
(the same command works on both macOS and Windows.)

### Dry-run mode
To see the flow before trying it against a real org:
```bash
node bin/setup.js --dry-run
```
In this mode the `gh` CLI is never touched (sample data is used for the
org/repo list), no real `git clone` happens, nothing is written to disk, and
no shell command (`npm install`, `docker compose up`, etc.) is actually run —
what each step *would* do is only printed to the screen, tagged with
`🧪 [dry-run]`.

## Flow
1. Required-tool check (git, node, gh, docker) — if something is missing, or
   Docker Desktop is installed-but-not-running, it offers to automatically
   install/start it (see
   [Handling Missing Tools Automatically](#handling-missing-tools-automatically))
2. GitHub/Okta SSO sign-in via `gh auth login` (in the browser, including MFA
   — a password is never entered into the script)
3. Project selection — the GitHub organization (`Airalo`) is hardcoded, never
   asked; the repo list is fetched automatically and selected via
   autocomplete (matches any part of the repo name/description, e.g.
   "backend" → `airalo-backend`)
4. Repo clone
5. After the repo is cloned, the docker-compose file and package manager
   (npm/yarn/pnpm, and composer if composer.json exists — both if both are
   present) are auto-detected
6. `.env.example` → `.env` copy (or `op inject` if `secretManager: "1password"`
   is configured)
7. Running `postCloneCommands` (e.g. `npm install`)
8. If Docker Compose is used, bring it up, then wait for the first published
   port in docker-compose.yml (e.g. `"3000:3000"` → 3000) to actually start
   listening (health-check via a raw TCP connection attempt — protocol
   agnostic) and clearly print `http://localhost:<port>`
9. For projects that don't require Docker (frontend or backend, doesn't
   matter), start the dev server in the background, detect its port, and wait
   via health-check — see
   [Running the Project](#running-the-project-projects-that-dont-require-docker)

## Adding a New Project/Department
Just add a new entry to `config/projects.json` — no code changes needed:

```json
"Backend": {
  "api-server": {
    "displayName": "API Server",
    "repo": "git@github.com:yourcompany/api-server.git",
    "envExampleFile": ".env.example",
    "secretManager": "1password",
    "requiresDocker": true,
    "dockerComposeFile": "docker-compose.yml",
    "postCloneCommands": ["npm install"],
    "readyMessage": "API is ready!"
  }
}
```

### Secret Management (1Password)
If you set `"secretManager": "1password"` for a project, `op://vault/item/field`
references inside `.env.example` are resolved to real values via the
[1Password CLI](https://developer.1password.com/docs/cli/) (`op inject`) and
written out as `.env`. Requirements:
- The 1Password CLI must be installed (`brew install 1password-cli` /
  `winget install AgileBits.1Password-CLI`)
- "Integrate with 1Password CLI" must be enabled in the 1Password desktop
  app, or you must be signed in via `op signin`

If `op` isn't installed or isn't signed in, the script automatically falls
back to plainly copying `.env.example` (setup doesn't get stuck halfway).

### Handling Missing Tools Automatically
If any of git/node/gh/docker is missing, or Docker Desktop is
installed-but-not-running, the script lists what's missing and then asks for
**a single confirmation**: "Try to automatically install/start the missing
ones now?" (default: yes).

- **Installation** (if git/node/gh/docker is missing): installs via Homebrew
  on macOS (`brew install ...`) or winget on Windows (`winget install ...`)
  with real-time output shown (if an admin password is needed, that also
  appears in the terminal/native dialog). The install command is exactly the
  same command shown on screen.
- **Starting the Docker daemon** (if Docker Desktop is installed but not
  running): this is not an "install" — nothing is downloaded to the system,
  it just launches the already-installed Docker Desktop app (macOS:
  `open -a Docker`, Windows: `Docker Desktop.exe` — Windows path untested)
  and waits until the daemon is ready (default timeout: 90s).

If confirmation is declined, or a tool can't be fixed automatically, the
script just shows the manual command/step to run and stops, same as
before — nothing is ever forced. In `--dry-run` mode this step is never
asked, and no install/start is ever attempted.

Tested for real on this machine: since git/node/gh were already installed,
the install path (brew install) wasn't tried with a real package, but
**automatically opening Docker Desktop** was genuinely run — the app was
opened via `open -a Docker`, the script waited until the daemon was ready,
and it was verified to actually be running via `docker info`/`docker ps`.

### Docker Health-Check
For projects with `requiresDocker: true`, after `docker compose up -d` runs,
the script automatically reads the first published host port from
`dockerComposeFile` (both the short format `ports: ["3000:3000"]` and the
long format `{ published: 3000, target: 3000 }` are supported) and waits
until a TCP connection can be made to that port (default timeout: 90s). Once
connected, it prints `http://localhost:<port>`; on timeout, it suggests
running `docker compose logs` so you can check whether the containers are
actually up.

If you don't trust the automatic port detection, or want to check a
different port, you can override it by setting a project-specific
`"healthCheckPort": 3000` field in `config/projects.json`.

### Running the Project (Projects That Don't Require Docker)
For projects with `requiresDocker: false` (or where docker-compose wasn't
found during auto-detection), once setup finishes the script **starts the
project itself in the background** — no manual intervention is needed. Which
command to run is decided by this priority order (first match wins):

1. If an explicit `"runCommand": "npm run start:dev"` is defined in
   `config/projects.json`, use it
2. The first `dev` / `start` / `serve` script found in `package.json`
   (`npm|yarn|pnpm run <script>`, the package manager is auto-selected based
   on the lockfile)
3. For Laravel projects (if an `artisan` file exists at the repo root),
   `php artisan serve`
4. If none of the above apply, scan the code blocks under headings like
   "Setup / Installation / Run / Development" in `README.md` — **only**
   `dev`/`start`/`serve` commands starting with `npm`/`yarn`/`pnpm`/`npx` are
   considered safe and run automatically. Since READMEs are written for
   humans, not machines (they may contain placeholder tokens,
   platform-specific alternatives, or an accidentally destructive example
   command), no other line is ever run automatically — if found, it's only
   printed to the screen with a "you may need to check this manually" note.

Once a command is found, the process is started in the background via
`spawn(..., { detached: true })`, with its output written to
`<project>/.dev-setup-run.log`. The script scans this log for a pattern like
`http://localhost:<port>` (typical output from tools like
Vite/Next.js/CRA/Vue CLI) to detect the port; if it can't find one, it tries
the most common dev server ports (3000, 5173, 8080, 4200, 5000, 8000, 4000).
Once the port is found and the health-check passes,
`✅ Project is running: http://localhost:<port>` is printed, along with the
process PID and log path (to stop it, `kill <PID>`).

If you don't trust the automatic port detection, you can skip log scanning
by defining `"runPort": 3000` in `config/projects.json`. Mobile projects
(iOS/Android, requiring Xcode/Android Studio) are out of scope for this
round — if the script can't find a run command, it just prints an
informational message.

## Known Limitations / Next Steps
- ~~Doesn't auto-install missing tools~~ **Changed:** it can now automatically
  install missing tools / auto-open Docker Desktop with a single
  confirmation, see
  [Handling Missing Tools Automatically](#handling-missing-tools-automatically)
- On Windows, WSL2 status is checked for Docker-requiring projects
  (`checkWsl2Status`), but this is a best-effort check that only warns and
  doesn't stop setup — not yet verified on a real Windows machine
- **Known bug (found via code review, fixed):** `runProject` spawns the
  detected run command (`npm`/`yarn`/`pnpm`/`php` etc.) in the background via
  `child_process.spawn`; if that command isn't on PATH (e.g. the repo wants
  yarn/pnpm but it isn't installed), Node's `spawn` function fires an
  asynchronous `'error'` event — if unhandled, this crashes the script with a
  raw stack trace (same class of bug as the docker-daemon one, but unlike
  execSync it crashes without even reaching the top-level `catch`). Fixed
  with `child.once('spawn', ...)` / `child.once('error', ...)`, and both the
  failure (`ENOENT`) and success scenarios were tested with a real
  subprocess
- **Known bug (found via code review, fixed):** `runProject` parsed the
  command with `command.split(' ')` — this incorrectly split quoted
  arguments (e.g. `node server.js --title "My App"`) and turned multiple
  spaces into empty tokens. Replaced with a simple quote-aware `parseCommand`
  parser, tested with quoted/multi-space scenarios
- **Known bug (found via code review, fixed):** the "try the most common
  ports" fallback that kicks in when the port can't be sniffed from the log
  could mistakenly report a port already left open by a completely different
  project (e.g. 3000) as the service we just started, falsely reporting
  "ready". `snapshotOpenPorts` now records which common ports were already
  open BEFORE spawning and excludes them from the fallback; both "a
  previously busy port isn't falsely reported" and "a genuinely newly-opened
  common port is correctly detected" scenarios were tested with real
  subprocesses
- **Known bug (found via real testing, fixed):** if a command in
  `runPostCloneCommands` (e.g. `composer install`) failed due to the repo's
  own configuration issue, the script used to stop EVERYTHING (remaining
  postCloneCommands, docker/runProject steps, the closing message) and crash
  with a top-level error. Observed in a real Airalo repo (`test-dev-playground`,
  whose `composer.json` references a `modules/*` path repository that
  doesn't exist). The failed command is now flagged as a warning and the
  script continues with the remaining steps, with failed commands listed
  again at the end — tested with the real repo
- No integration for other secret managers like Doppler — only 1Password is
  supported
- Automatic run isn't supported for mobile projects (iOS/Android) — the
  script just reports that it couldn't find a run command, the README's
  steps must be followed manually
- No install/run detection yet for other languages like Python (pip/poetry),
  Ruby (bundler), Go — only npm/yarn/pnpm and composer/Laravel are supported
- **Known bug (found via real testing on a fresh VM, fixed):** since
  `node bin/setup.js` itself requires Node, if Node isn't installed at all,
  the script's own "auto-install missing tools" feature couldn't even kick
  in (the thing needed to start the script was itself missing) — a classic
  chicken-and-egg problem. `bootstrap.sh` was added: a pure-bash script with
  no prerequisites that sets up the Homebrew → git/node/gh → GitHub sign-in →
  repo clone → `node bin/setup.js` chain and hands off. The "already
  installed" detection (git/node/gh/homebrew) and the general install
  mechanism (`brew install` + verification) were tested with real runs on
  this machine (since git/node/gh were already installed, rather than
  removing and reinstalling those three, the same mechanism was verified
  with a harmless package — `tree`); because of the placeholder repo URL,
  the clone step and beyond (npm install, the real hand-off to
  `node bin/setup.js`) haven't yet been verified end-to-end on a truly fresh
  machine
- ~~Docker Compose `profiles` issue~~ **Fixed:** `detectComposeHostPort` no
  longer considers services with a `profiles` field (e.g.
  `profiles: ["app"]`) as health-check port candidates — because the plain
  `docker compose up -d` we run doesn't select any profile, those services
  never start. This was observed in a real Airalo repo (`test-plx-airlock`,
  which hides backend/frontend behind an `app` profile and only starts them
  via a Makefile flow with `make prod-local`) — the script used to falsely
  report a service that never came up as "ready". Verified with synthetic
  scenarios (the profile-gated service listed first/last, all services
  profiled) and with the real `test-plx-airlock` compose file (now correctly
  picks postgres's port 5433, not the profile-gated backend/frontend)
- **Verified end-to-end against real Airalo repos** (interactive autocomplete
  automated via `expect`, running the full flow — `gh auth` → `gh repo list`
  → repo selection → real `git clone` → `autoDetect` → setup → `runProject` —
  without errors):
  - `test-dev-playground` (PHP/composer, no run command) → led to adding
    composer/Laravel support
  - `test-task` (real Laravel + Vite + docker-compose) → when
    docker-compose was actually used, this surfaced **the bug where
    `checkPrerequisites` mistook the `docker` CLI being on PATH for "docker
    is running"**: on this machine the docker CLI was installed but Docker
    Desktop wasn't running, and the script would get all the way to the
    `docker compose up` step before crashing with a raw error. Fixed by
    adding `isDockerDaemonRunning()` (via `docker info`), re-tested with the
    real repo and confirmed it now stops cleanly with a clear "open Docker
    Desktop" message
  - `airalo-partner-panel-frontend` (a real production Vue/Vite/Yarn Berry
    frontend) → a real `yarn install` (yarn 4.13.0 via corepack), a real
    `.env.example` → `.env` copy, correct detection of the `yarn run serve`
    script (`serve`, not `dev`/`start` which come first in the priority
    list — the first time in the real world this branch was seen to run),
    the Vite dev server starting in the background with its port (5173)
    correctly sniffed from the log, and the health-check passing — verified
    with `curl` getting `HTTP 200`, confirming the app was genuinely up
  - `partner-platform-lite` (a real Vue/Vite Chrome extension project, pnpm)
    → the last leg of the package-manager trio: a real `pnpm install`,
    `.env.example` → `.env`, `pnpm run dev` script detection, Vite dev
    server (5173) health-check — `curl` got `HTTP 200`. This verified all
    three of npm/yarn/pnpm against real Airalo repos
  - All these tests were re-run (AFTER the docker-daemon, spawn-crash,
    compose-profiles, command-parsing, port-false-positive, and
    postCloneCommands-continues-on-failure fixes) and confirmed to still
    work correctly; it was also confirmed with real data that in
    `test-dev-playground`, `composer install` genuinely failed due to the
    repo's own `modules/*` path repository issue, and that the script now
    continues with the remaining steps instead of crashing
- **Known bug (found via real testing, fixed):** if the `docker compose up -d`
  command in `dockerUp` failed (e.g. due to a port conflict or build error),
  the script used to stop all remaining steps (including the closing
  message) and crash with a top-level error. This was genuinely triggered in
  a real Airalo repo (`test-task`, after Docker Desktop was auto-opened) by a
  leftover container from the user's **completely unrelated project**
  (`airalo-shopify`) holding the same host port (`63790`, redis). It now
  prints a warning and continues on failure — the same resilience principle
  as `runPostCloneCommands`
- **Known bug (found in the same test, fixed):** in the scenario above, even
  though `docker compose up` failed, the script's closing message still
  showed the project-specific `readyMessage` ("Up and running via Docker!
  http://localhost:8080...") — misleading. `dockerUp` now returns its
  success status; on failure, an honest warning is printed instead of
  `readyMessage`. Verified with the real repo (in the same port-conflict
  scenario)
- Parts not yet verified against a real Airalo repo: 1Password `op inject`
  (not tried with a real 1Password account — `op` isn't installed on this
  machine), the `php artisan serve` run path (no run command was triggered
  in a real Laravel repo — Airalo's real Laravel repos all use
  docker-compose), and the full happy path of a **successful**
  `docker compose up` + health-check after Docker Desktop is auto-opened
  (the only real docker-compose repo tried on this machine always failed due
  to a port conflict with the user's own other project — the failure path
  is well tested, but the success path hasn't been seen with a real repo yet)
