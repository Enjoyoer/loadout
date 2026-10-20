---
name: bw-login
description: Log in to a website with Bitwarden without ever seeing the values. Use when an owner task reaches a sign-in page, or the owner says "use bw" or "sign into X".
---

# bw-login

Sign in with the `bw-paste` helper. Values never appear in output, logs, files, screenshots or tool arguments.

## 1. Pick the login

- Run `bw-paste <site>`, which prints one JSON line per matching login (`id`, `name`, `uris`, `username`; never passwords), and choose the item matching the account the owner named or the task implies. If more than one fits, ask.
- Get only that site's login. Never look up any other item.
- Never use the raw `bw` CLI or `bw-paste --raw`, and never type a password into any tool (no `fill`, `type` or `eval` with a value).

## 2. Never look at the page while it holds a password

Browser snapshots can contain field values: Playwright's aria snapshot, `playwright-cli` snapshots (printed and saved as `.playwright-cli/*.yml`), Paseo `browser_snapshot` for a field without a label or placeholder, and Codex Browser Use's `domSnapshot`/`ariaSnapshot`. So, on every path below:

- Snapshot the sign-in form once, before filling, and take the field and submit refs from it.
- From the password fill until the submit, nothing else touches the browser: no snapshot, screenshot, eval, console or network listing (`requests`, `request-body`), tracing or video. Do not start tracing or video at all during sign-in.
- After submitting, take a fresh snapshot only once the password field is gone or empty. If the login form is still there with the password in it, clear the field before any snapshot (the CDP path does this itself), then report.

## 3. Fill, by environment

Use only these paths. For anything else, stop and report the exact error line.

### a. Desktop browser, or a tool that sends real OS keys

Run `bw-paste <id> username` or `bw-paste <id> password`. It copies the value to the OS clipboard and clears it after 20 seconds. Click the field and press Cmd+V on Mac or Ctrl+V elsewhere within 20 seconds. After the password, submit right away (Enter or the submit ref from your pre-fill snapshot).

Paseo `browser_*` tools expose no DevTools endpoint, so they can only use this path. If the paste fills nothing, stop and report.

### b. Codex app Browser Use (its own virtual clipboard)

The error `Browser Use virtual clipboard has no data to paste` means this path. Bridge the OS clipboard into the tab clipboard inside the node REPL, and never print, log, return or screenshot the value.

- Run `bw-paste` with the agent's shell tool (`exec_command`), never inside the REPL: the REPL may not be able to start it.
- Read the OS clipboard in the REPL with `execFileSync` from `node:child_process`: on Windows `execFileSync('powershell',['-NoProfile','-Command','Get-Clipboard -Raw']).toString().replace(/\r?\n$/,'')`, on Mac `pbpaste`.
- Probe first with no secret: set the clipboard to `probe123`. In one REPL call, read it as above into `v`, run `tab.clipboard.writeText(v)`, and output only whether `readText()` equals `probe123`.
- Then for real: run `bw-paste`, then in one REPL call bridge, click the field, `pressKey` `Control_L+v` (`Meta+v` on Mac), and output only `pasted`. For the password, press Enter (or click the submit locator) in that same call, so no other call sees the filled field. Wrap the bridge, click, paste and submit in `try` with `tab.clipboard.writeText('')` in `finally`, so the tab clipboard is cleared even if a step throws.
- Verified live on Windows on 2026-10-17 and again on 2026-10-18 (lengths matched, clipboard empty after 20 seconds).

### c. Playwright and other automation-owned Chromium browsers (CDP fill)

Use this path for headless or automation browsers: `playwright-cli` sessions, plain Playwright scripts, and any Chromium, Chrome or Edge that this task launched itself. The clipboard does not reach these browsers. `bw-paste` types the value over the browser's loopback DevTools protocol (CDP), checks it, and for a password submits the form itself.

1. Enable remote debugging when the session starts. It cannot be added to a running session, so close and reopen one that started without it.
   - `playwright-cli`: in a scratch folder, write `cli.config.json` containing `{"browser":{"launchOptions":{"headless":true,"args":["--remote-debugging-port=0"]}}}` and keep any other settings you need in it. Open with `"$PWCLI" open <login-url> --config <dir>/cli.config.json --profile <dir>/profile`. The browser then writes `<dir>/profile/DevToolsActivePort`, and the endpoint flag is `--cdp-profile <dir>/profile`.
   - Plain Playwright script: `chromium.launchPersistentContext('<dir>/profile', { args: ['--remote-debugging-port=0'] })`, then use `--cdp-profile <dir>/profile`. With a fixed `--remote-debugging-port=<port>`, use `--cdp http://127.0.0.1:<port>` instead.
   - A Chrome or Edge you launch yourself: start it with `--remote-debugging-port=0` and its own `--user-data-dir=<dir>/profile`. Never relaunch the owner's own browser for this; use path a there.
2. Snapshot the form once and note the username, password and submit refs.
3. Click the username field, then run `bw-paste <id> username --cdp-profile <dir>/profile`. When the username is on its own page (two-step sign-in), add `--submit`.
4. Click the password field, then run `bw-paste <id> password --cdp-profile <dir>/profile --submit`. `--submit` is required for passwords.
5. Expect `filled username for <name>`, then `filled password for <name>; submitted`. Then follow section 2 for the fresh snapshot.

Before it types, `bw-paste` refuses (exit 5, one fixed line) when:
- the page's host does not match one of the item's saved URIs;
- there is more than one candidate tab (pass `--target-url-prefix <login-url-prefix>` or close the others);
- no editable field in the page's main frame has focus;
- the field type is wrong (a password needs a password input);
- the page changed under it.

After typing, it checks only that the field's length matches. It submits with Enter on the field, then waits up to 10 seconds for the field to leave the page. If the field still holds the value, it clears it and exits 5. Read the page then, but never the field. A field inside an iframe is refused, and Firefox and WebKit have no CDP fill: stop and report.

Remote debugging lets any local process drive that browser while it runs. Keep the profile in your own scratch folder, and close the session when the task is done.

## 4. Submit

On paths a and b, check that each field is not empty before submitting. Use length only: an expression that returns just the number, never the value. Then submit at once. Path c checks and submits for you.

## 5. CAPTCHA, 2FA, locked vault

- CAPTCHA: solve it yourself, whether it is a checkbox, an image grid, an audio challenge or a slider puzzle. If it expires or fails, reload and try again. Ask the owner only after 3 real attempts fail, or when it needs something you cannot do (a phone call or a hardware key). Then leave the page visible and say what blocked you.
- 2FA belongs to the owner: stop, leave the page visible, and ask.
- Vault locked (exit 3): ask the owner to run `bw-unlock`.
