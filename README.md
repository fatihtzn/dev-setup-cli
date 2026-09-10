# Dev Setup CLI

**One command, and your dev environment is ready.** This tool sets up a
company project on a new machine end-to-end: it installs the tools you need,
signs you in to GitHub, clones the project you pick, and starts it running —
all with a single command, no manual steps.

It's written for two audiences:
- **Anyone joining the team**, even with little command-line experience — the
  [Quick Start](#quick-start) below is all you need.
- **Developers** who want to add a new project to the tool, or understand how
  it works — see [For Developers](#for-developers).

---

## Table of Contents
- [Quick Start](#quick-start)
  - [Brand new machine (nothing installed yet)](#brand-new-machine-nothing-installed-yet)
  - [git / node / gh already installed](#git--node--gh-already-installed)
- [What Happens When You Run It](#what-happens-when-you-run-it)
- [Troubleshooting](#troubleshooting)
- [For Developers](#for-developers)
  - [Dry-run mode](#dry-run-mode)
  - [Adding a New Project](#adding-a-new-project)
  - [Project Config Reference](#project-config-reference)
  - [Secret Management](#secret-management)
- [FAQ](#faq)
- [Known Limitations](#known-limitations)

---

## Quick Start

### Brand new machine (nothing installed yet)

If this is a fresh computer — no Git, no Node.js, nothing — you don't need to
install anything by hand. Just open a terminal and run **one line**.

**On macOS:** open the **Terminal** app and paste this in, then press Enter:
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.sh)
```

**On Windows:** open **PowerShell** and paste this in, then press Enter:
```powershell
irm https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.ps1 | iex
```

That's it — sit back and follow the prompts. The script will:
1. Install a package manager if needed (Homebrew on macOS / winget on Windows)
2. Install Git, Node.js, and the GitHub CLI if any are missing
3. Open your browser so you can sign in to GitHub (via your company Okta account)
4. Ask which project you want to set up, then clone and start it for you

A few things to know before you run it:

> ⚠️ **On macOS, don't run the command with `sudo`.** If you do, the setup
> ends up in the wrong place and won't work from your normal terminal. Just
> run it as yourself — if a password is needed, it will ask for it when it's
> actually needed.
>
> ⚠️ **If the command fails with the exact same error right after a fix was
> announced**, it's very likely a caching issue on GitHub's side, not a real
> problem. Just add a random number to the end of the URL to force a fresh
> copy:
> ```bash
> bash <(curl -fsSL "https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.sh?$RANDOM")
> ```
> ```powershell
> irm "https://raw.githubusercontent.com/fatihtzn/dev-setup-cli/main/bootstrap.ps1?$(Get-Random)" | iex
> ```

### git / node / gh already installed

If your machine already has Git, Node.js, and the GitHub CLI (`gh`), you can
skip the bootstrap script and run the tool directly:

```bash
npm install
node bin/setup.js
```

This works the same way on macOS and Windows.

**Which GitHub org?** This tool isn't tied to any one company — the first
time it runs, it asks which GitHub org or user to list repos from. Set the
`GITHUB_ORG` environment variable (e.g. `export GITHUB_ORG=your-org` in your
shell profile) to skip that question on every future run.

---

## What Happens When You Run It

In plain terms, here's the journey from start to finish:

1. **Checks your tools.** It looks for Git, Node.js, the GitHub CLI, and (if
   the project needs it) Docker. Anything missing gets offered to you as a
   one-click install — you just confirm once.
2. **Signs you in to GitHub.** A browser tab opens where you log in with your
   company account (Okta single sign-on, including two-factor if your
   company requires it). Your password is never typed into the tool itself.
3. **Asks which GitHub org to use** (skipped if `GITHUB_ORG` is set), then
   **which project you want.** Start typing any part of a project's name
   (e.g. "backend") and matching projects show up — pick one with the arrow
   keys and Enter.
4. **Clones the project** from GitHub onto your machine.
5. **Sets up its configuration** (`.env` file) — asking how to fill in real
   secret values if the project doesn't already have that pre-configured,
   see [Secret Management](#secret-management) — and installs its
   dependencies (`npm install` or equivalent) automatically.
6. **Checks the dev server's hostname is reachable.** If the project's `.env`
   binds it to something other than localhost (`HOST=my-app.local`, common
   for projects that need a fixed HTTPS/cookie domain) and that name doesn't
   already resolve to your machine, offers to add it to your hosts file
   (asks for your password — this is the one step that touches a system
   file, so it's never done silently).
7. **Starts the project** — either via Docker, or by running its normal dev
   server — and waits until it's actually reachable.
8. **Shows you the finished link**, e.g. `✅ Project is running:
   http://localhost:5173`, and opens it in your browser automatically.

If a step fails for a reason outside the tool's control (say, a project's own
setup script has a bug), it prints a clear warning and keeps going with
everything else instead of stopping cold — you'll see a summary of anything
that needs a manual look at the end.

**Stopping a project**: `node bin/stop.js <project-name>` (or with no
argument, stops every project this tool has running in the current
directory) — no need to hunt down or copy a PID from old terminal output.

---

## Troubleshooting

Look for the message you're seeing below.

<details>
<summary><strong>Windows: "winget" fails with a certificate error (0x8a15005e)</strong></summary>

This is a known issue with one of winget's sources on some machines/networks.
It's already handled in the latest version of the script — if you still hit
it, make sure you're running the *current* bootstrap command (see the
CDN-cache note in [Quick Start](#quick-start)), then try again.
</details>

<details>
<summary><strong>Windows: "npm.ps1 cannot be loaded because running scripts is disabled on this system"</strong></summary>

This is Windows' default security setting blocking npm's PowerShell script.
The bootstrap script already works around this safely for its own session —
if you hit this error running `npm` yourself afterward in a **different**
PowerShell window, run this once in that window and try again:
```powershell
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force
```
This only affects the current window and doesn't change any permanent
setting on your computer.
</details>

<details>
<summary><strong>macOS: "docker: unknown command: docker compose"</strong></summary>

Docker itself is installed, but Docker's own `compose` add-on isn't wired up
correctly (a known Homebrew quirk). Just re-run the tool — it now detects and
fixes this automatically before it becomes a problem.
</details>

<details>
<summary><strong>"Docker Desktop" won't start / times out</strong></summary>

Open the **Docker Desktop** app yourself (Applications on macOS, Start Menu
on Windows) and wait for the whale icon to say it's running, then re-run the
tool. If Docker Desktop isn't installed at all, let the tool install it for
you when it offers to.
</details>

<details>
<summary><strong>"Invalid authentication" / 403 error while installing a project's dependencies</strong></summary>

This means your GitHub sign-in is missing a permission needed to download the
company's private packages. Re-run this once and sign in again if prompted:
```bash
gh auth refresh --hostname github.com --scopes read:packages
```
The tool also tries to add this permission automatically during sign-in, so
this should be rare.
</details>

<details>
<summary><strong>A project's start command isn't found automatically</strong></summary>

Some projects don't follow a common enough convention for the tool to guess
their start command safely on its own. In that case, it prints any relevant
lines it found in that project's `README.md` — follow those manually. If
you're a developer setting this project up for the team, see
[Adding a New Project](#adding-a-new-project) to make it fully automatic
next time.
</details>

<details>
<summary><strong>A project fails to install with a native module build error (e.g. mentions "node-gyp", "gyp ERR!", or a package like "isolated-vm")</strong></summary>

This usually means the project needs a different Node.js version than the
one currently active on your machine (declared in its `.nvmrc` or
`package.json`). The tool already tries to switch to the right version
automatically via `nvm` before installing — if you still hit this:
1. Make sure `nvm` is installed (`curl -fsSL
   https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash`,
   then open a new terminal)
2. Re-run the tool

If it still fails after that, the project's own native dependency may need
an additional build tool on your machine (e.g. Xcode Command Line Tools on
macOS: `xcode-select --install`) — check with a developer on the team.
</details>

<details>
<summary><strong>You want to stop a project the tool started</strong></summary>

The tool prints the exact command to use right under "Project is running",
tailored to your OS — copy and run that one. It looks like this:

- **macOS/Linux:** `kill -- -<PID>`
- **Windows:** `taskkill /PID <PID> /T /F`

(A plain `kill <PID>` on macOS/Linux often *won't* fully stop it — the
command above is intentionally different for that reason.)
</details>

<details>
<summary><strong>Something else / an error not listed here</strong></summary>

Copy the exact error text and share it with the team channel — most issues
seen so far have come from something specific to one project's setup, and
get fixed quickly once someone can see the real error.
</details>

---

## For Developers

### Dry-run mode

To see exactly what the tool *would* do, without touching GitHub, your disk,
or running any real command:
```bash
node bin/setup.js --dry-run
```
Every action is printed with a `🧪 [dry-run]` tag instead of being executed —
useful for testing changes to the tool itself, or previewing the flow for a
new project before running it for real.

### Adding a New Project

Most projects need **zero configuration** — clone them once with the tool
and it auto-detects the docker-compose file, the package manager
(npm/yarn/pnpm, and composer if `composer.json` exists), and the run command.

Only add an entry to `config/projects.json` when a project needs something
different from that default behavior. The key must exactly match the
project's real GitHub repo name:

```json
"Backend": {
  "api-server": {
    "displayName": "API Server",
    "secretManager": "1password",
    "requiresDocker": true,
    "dockerComposeFile": "docker-compose.yml",
    "postCloneCommands": ["npm install"],
    "readyMessage": "API is ready!"
  }
}
```

See [Project Config Reference](#project-config-reference) below for every
available field.

### Project Config Reference

All fields are optional — only set the ones that differ from the
auto-detected default.

| Field | Type | What it does |
|---|---|---|
| `displayName` | string | Friendly name shown in the project picker and messages. |
| `envExampleFile` | string | Name of the example env file to copy from, resolved **inside the cloned repo** (default: `.env.example`). |
| `envTemplateFile` | string | Like `envExampleFile`, but resolved inside **this tool's own repo** instead (e.g. `config/env-templates/<repo>.env.tpl`) — use this when the template carries real `op://` vault references, so they never have to be committed to the shared project repo. Takes priority over `envExampleFile` when both could apply. |
| `secretManager` | `"1password"` | If set, real secret values are pulled from 1Password instead of leaving `.env` as a plain copy — see [Secret Management](#secret-management). |
| `secretFiles` | `{ref, dest}[]` | Non-`.env` files to restore from 1Password after `.env` is set up (e.g. a dev HTTPS cert/key pair) — `ref` is an `op://vault/item/field` URI, `dest` is the path to write it to (relative to the cloned repo). Skipped per-file if `dest` already exists. See [Secret Management](#secret-management). |
| `requiresDocker` | boolean | Force Docker Compose on/off instead of auto-detecting it from the repo's files. |
| `dockerComposeFile` | string | Which compose file to use, if not the default `docker-compose.yml`. |
| `healthCheckPort` | number | Which port to health-check after `docker compose up`, instead of auto-reading it from the compose file. |
| `postCloneCommands` | string[] | Shell commands to run after cloning, in order (e.g. `composer install`). Defaults to installing dependencies with the detected package manager. |
| `runCommand` | string | The command that starts the project's dev server, if it can't be auto-detected (e.g. `"npm run start:dev"`). |
| `runPort` | number | Which port to check for "is it running", instead of auto-detecting it from the dev server's own logs. |
| `readyMessage` | string | Custom message shown once setup finishes successfully. |

### Secret Management

Every project needs its `.env` filled in with real values somehow. This tool
supports two ways to get there — a zero-friction **static** path a team can
pre-configure once, and a **dynamic**, interactive fallback that needs no
setup at all and just asks.

#### Dynamic (no setup needed)

If a project has no `secretManager` configured in `config/projects.json` at
all (the default — the shipped `projects.json` starts empty), the tool asks,
every time it sets up that project:

1. **Pull values from 1Password** — first looks for an item titled
   `[dev-setup-cli] <repo-name>` across every vault you have access to (see
   the naming convention below); if one already exists, it's used
   automatically with **no vault/item prompt at all**. Otherwise asks for a
   vault and item (name or ID) — worth setting up that pre-configured item
   once so every future clone of the same project skips straight past this.
   Either way, it then reads the item's field *names* (never values) via
   `op item get`, and for every `KEY=` line in the project's `.env.example`
   whose key matches a field name on that item, swaps in a real `op://`
   reference; anything without a matching field is left as the example's own
   default. Then asks once for any extra non-`.env` files to restore (see
   the `file__` field convention below). If the 1Password CLI isn't
   installed or authorized yet, it offers to install it and walks through
   the one-time-per-machine authorization step (see below).
2. **Copy from a working local checkout** — asks for a path to a directory
   (or a file directly); copies its `.env`, then asks for any extra
   filenames to copy alongside it from the same place.
3. **Skip / I don't know** — copies `.env.example` as-is, same as always;
   fill in the real values by hand later.

Nothing is remembered between runs on purpose — it's asked again next time,
by design (see the static path below if you'd rather configure this once for
your whole team instead).

#### Static (pre-configured, zero-friction for your team)

If a project sets `"secretManager": "1password"` in `config/projects.json`,
any `op://vault/item/field` references inside its env template are resolved
to real values via the [1Password CLI](https://developer.1password.com/docs/cli/)
and written out as `.env` — the real secret values never pass through this
tool's own code, 1Password's CLI writes them directly to the file. The
template is either the cloned repo's own `.env.example`/`envExampleFile`, or
(recommended — see `envTemplateFile` in the [Project Config
Reference](#project-config-reference) above) a file living in this tool's own
repo, so your team's vault layout never has to be committed into the shared
project repo. If this fails for any reason (CLI not ready, wrong vault/item),
the tool falls back to the dynamic flow above rather than getting stuck.

Both paths need, on your machine:
- The 1Password CLI installed (`brew install 1password-cli` on macOS,
  `winget install AgileBits.1Password-CLI` on Windows) — automated by
  `checkPrerequisites` for the static path, offered inline for the dynamic path
- Either "Integrate with 1Password CLI" enabled in the 1Password desktop app
  (recommended), or being signed in via `op signin` — this part is a
  one-time, per-machine, human-in-the-loop step by 1Password's own design
  (no CLI/API can flip it on remotely), so the tool pauses once with the
  exact instruction rather than silently failing

**Setting up the static path for a project** — use
`scripts/migrate-env-to-1password.js` to push a working local `.env` (+ any
extra files) into a 1Password item, following this convention:

```bash
node scripts/migrate-env-to-1password.js \
  --vault <your-shared-vault-name-or-id> \
  --repo <repo-name> \
  --env-dir /path/to/a/working/local/checkout \
  [--file some.cert --file some.key ...]
```

1. Use a **shared team vault** everyone using this tool already has access
   to. Do **not** use a personal vault (e.g. one named "Employee" or
   similar) — those typically belong to a single person and nobody else on
   the team can read from them.
2. One item per project, category "Secure Note", titled
   **`[dev-setup-cli] <repo-name>`** — easy to spot among a vault's other,
   unrelated items. This title is for humans browsing the vault only — see
   the next point for what actually goes in `op://` references.
3. **Reference the item by its UUID, not its title, in every `op://` URI**
   (the script prints it at the end — you'll need it for step 6 below).
   `op read`/`op inject` flat out reject characters like `[` or a space in a
   secret reference ("invalid character in secret reference"), and the
   bracketed title above has both. The UUID is also immune to the item ever
   being renamed later, same reasoning as referencing the vault by ID.
4. One field per env var, with the field's id/label set to the exact env var
   name (e.g. `SENTRY_DSN`); non-`.env` files (a cert, a key, ...) become
   fields named **`file__<filename, dots as underscores>`** (e.g. a file
   named `some.cert` becomes field `file__some_cert`).
5. Reference `file__...` fields from that project's `secretFiles` in
   `projects.json`.
6. Add a `config/env-templates/<repo-name>.env.tpl` file here mirroring the
   repo's own `.env.example`, but with each value that has a matching
   1Password field swapped for `op://<your-vault-id>/<item-uuid>/<FIELD>`.
   Leave anything without a matching field as its original plain value.
   ⚠️ `op inject` scans the **whole file**, comments included, for anything
   shaped like a secret reference — don't write that prefix literally in a
   comment (e.g. spelled out as a warning) or it'll try to parse the comment
   itself and fail the whole file.

`op` CLI quirks `scripts/migrate-env-to-1password.js` works around, for
context (both the static-path script and the dynamic flow above avoid them):
- `op item create` piped a JSON template on stdin **silently drops the
  template's `title` and `fields`** whenever the JSON body *also* has a
  `category` key while `--category` is passed as a CLI flag (which this CLI
  version requires — it rejects a bare JSON `category`). Put `category` in
  the flag only, never in the JSON body.
- Feed JSON to `op` via a real file descriptor, not `child_process.spawnSync`'s
  `input:` option — with `input:`, a large multi-field template was accepted
  silently (exit 0, item version incremented) but the fields never actually
  landed. The identical JSON piped from a file via a plain shell
  (`cat file | op item edit ...`) worked correctly every time.
- `op item edit` reads piped JSON implicitly — passing an explicit `-` (which
  `item create` requires) gets parsed as a no-op assignment statement instead
  and silently swallows the template.
- A naive `.env` line parser that does `value = line.slice(eq + 1).trim()`
  swallows a trailing `# comment` into the value itself for a line like
  `KEY="1.0" # note`. Strip everything after the closing quote.

---

## FAQ

**Do I need to know Git/Node.js/Docker to use this?**
No. The bootstrap command installs everything for you. You only need to know
how to open a terminal and pick a project from a list.

**Is my password ever typed into this tool?**
No. Sign-in happens entirely in your browser via your company's normal
login page (Okta SSO). The tool only ever holds a GitHub access token that
your browser sign-in produces — it never sees or asks for your password.

**Can I run this again later, e.g. for a second project?**
Yes — just run `node bin/setup.js` again (or re-run the one-line bootstrap
command) any time. It re-uses your existing GitHub sign-in and any tools
already installed, so later runs are much faster.

**What if I already have a project cloned in this same folder?**
The tool won't overwrite it — if the folder already exists, cloning is
skipped and it works with what's already there.

---

## Known Limitations

- Mobile projects (iOS/Android) aren't started automatically — you'll get a
  message to check that project's own README for the run steps.
- Languages other than the JS ecosystem (npm/yarn/pnpm) and PHP/Composer
  aren't auto-detected yet (e.g. Python, Ruby, Go) — such a project needs an
  explicit `postCloneCommands`/`runCommand` entry in `config/projects.json`.
- Only 1Password is supported as a secret manager today.
- The Windows bootstrap script's Docker Desktop auto-start path is untested
  on a real Windows machine — if it doesn't work, just start Docker Desktop
  yourself and re-run the tool.
