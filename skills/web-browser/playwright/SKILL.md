---
name: playwright
description: "Use when the task requires automating a real browser from the terminal (navigation, form filling, snapshots, screenshots, data extraction, UI-flow debugging) via `playwright-cli` or the bundled wrapper script."
---


# Playwright CLI Skill

Drive a real browser from the terminal using `playwright-cli`. Prefer the bundled wrapper script so the CLI works even when it is not globally installed.
Treat this skill as CLI-first automation. Do not pivot to `@playwright/test` unless the user explicitly asks for test files.

## Prerequisite check (required)

Before proposing commands, check whether `npx` is available (the wrapper depends on it):

```bash
command -v npx >/dev/null 2>&1
```

If it is not available, pause and ask the user to install Node.js/npm (which provides `npx`). Provide these steps verbatim:

```bash
# Verify Node/npm are installed
node --version
npm --version

# If missing, install Node.js/npm, then:
npm install -g playwright-core@1.64.1
playwright-core cli --help
```

Once `npx` is present, proceed with the wrapper script. A global install is optional.

## Skill path (set once)

```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
```

User-scoped skills install under `$CODEX_HOME/skills` (default: `~/.codex/skills`).

Always run the wrapper as `bash "$PWCLI"`. A skill install or sync may not keep the script's execute bit, and then `"$PWCLI"` on its own fails with `Permission denied`.

## Browser sandbox (required)

Keep Chromium's sandbox on. Set it once per host in the CLI's global config, `~/.playwright/cli.config.json` (`%USERPROFILE%\.playwright\cli.config.json` on Windows):

```json
{"browser":{"browserName":"chromium","launchOptions":{"channel":"chrome","chromiumSandbox":true}}}
```

- `channel: "chrome"` runs the installed Google Chrome, which keeps itself up to date. Keep `browserName`: without it the CLI ignores `channel` and always uses Chrome.
- Without `chromiumSandbox: true`, the CLI starts Playwright's bundled Chromium on Linux with `--no-sandbox`.
- The CLI applies a session's own config (`--config`, or `.playwright/cli.config.json` in the working folder) on top of this file. Never set `chromiumSandbox` to false there or pass `--no-sandbox`.
- On a Linux host without Google Chrome, set `"channel": "chromium"` (Playwright's bundled Chromium, installed with `bash "$PWCLI" install-browser chromium`) and keep `chromiumSandbox: true`. It sandboxes through unprivileged user namespaces. If the browser will not start with the sandbox, stop and report it; do not turn the sandbox off.

## Windows: seeded profiles (required)

On a fresh Chrome or Edge profile, Chrome checks whether the Windows account has a blank password by trying to log on with an empty one. Each try logs a failed logon (Security event 4625), and enough of them in a few minutes lock the account, SSH included. A profile whose `Local State` already holds the cached answer (`password_manager.os_password_blank` false, `os_password_last_changed` `"9223372036854775807"`) skips the check. `scripts/seed_local_state.ps1` writes it: it merges those two keys into an existing `Local State` and keeps every other key, creates the file only when it is missing, and writes nothing when the profile is already seeded, so it is safe before every launch.

- The wrapper seeds on Windows (Git Bash) before every `open`, adding about a second. It finds the profile the CLI will start, as the CLI does: `--profile`, else `browser.userDataDir` from the config files or `PLAYWRIGHT_MCP_USER_DATA_DIR`, else the CLI's own folder for `--persistent`. It seeds that folder and passes it to the CLI as `--profile`.
- A session with none of those would start on a temporary profile that the browser launch creates, too late to seed. The wrapper gives it a fresh seeded profile instead, a new one at each `open`, so it still starts empty. `delete-data` removes these, and each `open` removes older ones that no session uses.
- If seeding fails, the wrapper stops before any browser starts. Fix the cause it names; never start the browser another way.
- On Windows the wrapper refuses `show`, whose dashboard runs Chrome on a temporary profile, and a config with `browser.isolated: true` or `PLAYWRIGHT_MCP_ISOLATED`.
- To start Chrome or Edge on Windows outside the wrapper (a Playwright script, or a browser you launch yourself), use a profile folder and seed it first: `powershell -NoProfile -ExecutionPolicy Bypass -File "$(dirname "$PWCLI")/seed_local_state.ps1" -Profile <dir>`. Then launch with `chromium.launchPersistentContext('<dir>', ...)` or `--user-data-dir=<dir>`. If the helper fails, do not launch. Never use `chromium.launch()` there: it starts on a temporary profile.
- Attaching to a running browser (`attach`, a CDP endpoint, the extension) starts no new profile, and Firefox and WebKit have no such check. None of them needs seeding.
- Not needed on macOS or Linux; the wrapper skips it there.

## Quick start

Use the wrapper script:

```bash
bash "$PWCLI" open https://playwright.dev --headed
bash "$PWCLI" snapshot
bash "$PWCLI" click e15
bash "$PWCLI" type "Playwright"
bash "$PWCLI" press Enter
bash "$PWCLI" screenshot
```

If the user prefers a global install, this is also valid (the command is then `playwright-core cli`):

```bash
npm install -g playwright-core@1.64.1
playwright-core cli --help
```

## Core workflow

1. Open the page.
2. Snapshot to get stable element refs.
3. Interact using refs from the latest snapshot.
4. Re-snapshot after navigation or significant DOM changes.
5. Capture artifacts (screenshot, pdf, traces) when useful.

Minimal loop:

```bash
bash "$PWCLI" open https://example.com
bash "$PWCLI" snapshot
bash "$PWCLI" click e3
bash "$PWCLI" snapshot
```

## When to snapshot again

Snapshot again after:

- navigation
- clicking elements that change the UI substantially
- opening/closing modals or menus
- tab switches

Refs can go stale. When a command fails due to a missing ref, snapshot again.

## Recommended patterns

### Form fill and submit

```bash
bash "$PWCLI" open https://example.com/form
bash "$PWCLI" snapshot
bash "$PWCLI" fill e1 "user@example.com"
bash "$PWCLI" fill e2 "password123"
bash "$PWCLI" click e3
bash "$PWCLI" snapshot
```

### Debug a UI flow with traces

```bash
bash "$PWCLI" open https://example.com --headed
bash "$PWCLI" tracing-start
# ...interactions...
bash "$PWCLI" tracing-stop
```

### Multi-tab work

```bash
bash "$PWCLI" tab-new https://example.com
bash "$PWCLI" tab-list
bash "$PWCLI" tab-select 0
bash "$PWCLI" snapshot
```

## Wrapper script

The wrapper script uses the pinned `npx --package playwright-core@1.64.1 playwright-core cli` so the CLI can run without a global install. That is the CLI shipped in the stable Playwright release. The separate `@playwright/cli` package pins pre-release Playwright builds, so the skill does not use it; move the pin only to a newer stable `playwright-core`.

```bash
bash "$PWCLI" --help
```

Prefer the wrapper unless the repository already standardizes on a global install.

## References

Open only what you need:

- CLI command reference: `references/cli.md`
- Practical workflows and troubleshooting: `references/workflows.md`

## Guardrails

- Always snapshot before referencing element ids like `e12`.
- Re-snapshot when refs seem stale.
- Prefer explicit commands over `eval` and `run-code` unless needed.
- When you do not have a fresh snapshot, use placeholder refs like `eX` and say why; do not bypass refs with `run-code`.
- Use `--headed` when a visual check will help.
- When capturing artifacts in this repo, use `output/playwright/` and avoid introducing new top-level artifact folders.
- Default to CLI commands and workflows, not Playwright test specs.
