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
- From the password fill until the submit, nothing else touches the browser: no snapshot, screenshot, eval, console or network listing (`requests`, `request-body`), tracing or video. The only exceptions are the checks inside `bw-paste` itself (path c) and the length-only check inside the single paste-and-submit REPL call (path b). Do not start tracing or video at all during sign-in.
- After submitting, and after any failure, run one length check before anything else reads the page: an expression that returns only the number of password inputs with a non-empty value, never a value. Path c does this check itself.
  - If it returns 0, or the sign-in page is gone, you may take a fresh snapshot.
  - If it is above 0, set each password input to an empty string (an empty `fill`, never a value) and check again.
  - If it still is not 0, or the check fails, close that tab without a snapshot or screenshot, then report.
- Never snapshot a page whose password fields you have not just verified empty.

## 3. Fill, by environment

Use only these paths. For anything else, stop and report the exact error line.

### a. Desktop browser, or a tool that sends real OS keys

Run `bw-paste <id> username` or `bw-paste <id> password`. It copies the value to the OS clipboard and clears it after 20 seconds. Click the field and press Cmd+V on Mac or Ctrl+V elsewhere within 20 seconds. After pasting the password, submit right away with no check in between (Enter, or the submit ref from your pre-fill snapshot). Then run the section 2 length check.

Paseo `browser_*` tools expose no DevTools endpoint, so they can only use this path. If the paste fills nothing, stop and report.

### b. Codex app Browser Use (its own virtual clipboard)

The error `Browser Use virtual clipboard has no data to paste` means this path. Bridge the OS clipboard into the tab clipboard inside the node REPL, and never print, log, return or screenshot the value.

- Run `bw-paste` with the agent's shell tool (`exec_command`), never inside the REPL: the REPL may not be able to start it.
- Read the OS clipboard in the REPL with `execFileSync` from `node:child_process`: on Windows `execFileSync('powershell',['-NoProfile','-Command','Get-Clipboard -Raw']).toString().replace(/\r?\n$/,'')`, on Mac `pbpaste`.
- Probe first with no secret: set the clipboard to `probe123`. In one REPL call, read it as above into `v`, run `tab.clipboard.writeText(v)`, and output only whether `readText()` equals `probe123`.
- Then for real: run `bw-paste`, then in one REPL call bridge, click the field, `pressKey` `Control_L+v` (`Meta+v` on Mac), and output only `pasted`.
- For the password, do the whole sequence in that one call, so no other call sees the filled field: bridge, click, paste, check that the field's length is above 0 (a number only), then press Enter or click the submit locator.
- Wrap all of it in `try`, and in `finally` do two things. First, `tab.clipboard.writeText('')`. Second, if the submit did not happen, set the password field to `''` and confirm its length is 0; if that fails, close the tab.
- Output only `submitted`, `cleared` or `closed`. Then run the section 2 length check before any snapshot.
- Verified live on Windows on 2026-10-17 and again on 2026-10-18 (lengths matched, clipboard empty after 20 seconds).

### c. Playwright and other automation-owned Chromium browsers (CDP fill)

Use this path for headless or automation browsers: `playwright-cli` sessions, plain Playwright scripts, and any Chromium, Chrome or Edge that this task launched itself. The clipboard does not reach these browsers. `bw-paste` writes the value over the browser's loopback DevTools protocol (CDP) into the exact field it checked, verifies it, and for a password submits the form itself.

1. Enable remote debugging when the session starts. It cannot be added to a running session, so close and reopen one that started without it.
   - `playwright-cli`: in a scratch folder, write `cli.config.json` containing `{"browser":{"launchOptions":{"headless":true,"args":["--remote-debugging-port=0"]}}}` and keep any other settings you need in it. Open with `"$PWCLI" open <login-url> --config <dir>/cli.config.json --profile <dir>/profile`. The browser then writes `<dir>/profile/DevToolsActivePort`, and the endpoint flag is `--cdp-profile <dir>/profile`.
   - Plain Playwright script: `chromium.launchPersistentContext('<dir>/profile', { args: ['--remote-debugging-port=0'] })`, then use `--cdp-profile <dir>/profile`. With a fixed `--remote-debugging-port=<port>`, use `--cdp http://127.0.0.1:<port>` instead (IPv4 loopback only; `[::1]` is refused).
   - A Chrome or Edge you launch yourself: start it with `--remote-debugging-port=0` and its own `--user-data-dir=<dir>/profile`. Never relaunch the owner's own browser for this; use path a there.
2. Snapshot the form once and note the username, password and submit refs.
3. Click the username field, then run `bw-paste <id> username --cdp-profile <dir>/profile`. When the username is on its own page (two-step sign-in), add `--submit`.
4. Click the password field, then run `bw-paste <id> password --cdp-profile <dir>/profile --submit`. `--submit` is required for passwords.
5. Expect `filled username for <name>`, then `filled password for <name>; submitted`. Exit 0 after `--submit` means `bw-paste` already verified that no password field in the page still holds a value, so a fresh snapshot is allowed.

What `bw-paste` does:
- Tab: it needs exactly one open http(s) tab. Pass `--target-url-prefix <login-url-prefix>` or close the other tabs; it never guesses by focus.
- Origin: the page URL must match one of the item's saved URIs under that URI's Bitwarden match mode.
  - Domain (the default) matches the same site, including subdomains.
  - Host matches host and port.
  - Starts with and Exact compare the full URL, including port and path.
  - Regular expression and Never never authorize.
- Field: the focused field in the page's main frame must fit (a password needs a password input; a username a text-like input or textarea). That field is pinned. The value is written into the pinned field itself, never into whatever has focus, and the field is checked again in the same step.
- Submit: it uses the pinned field's own form. It clicks that form's default submit button, as Enter does. If the form has no button, it submits the form; if there is no form, it sends Enter to the field. It then waits up to 10 seconds until no password field in the page holds a value.

Exit codes:
- 5, one fixed line, value not in the page:
  - before writing: wrong origin, not exactly one tab, no focused field in the main frame (a field inside an iframe counts), wrong field type, page or field changed;
  - after writing: fill not verified, disabled submit button, or still filled 10 seconds after submit.
  On the after-writing refusals, it cleared the fields and verified them empty. Read the page if needed, then report.
- 6, `UNSAFE STATE`, page state unknown: it could not verify the page is free of the value (a page that refills the field, a hung tab, or a lost connection).
  - Normally it has closed that tab: do not snapshot, and reopen the page if needed.
  - If the line says it could not close the tab, close the whole browser session now without a snapshot, then report.
- Firefox and WebKit have no CDP fill: stop and report.

Remote debugging lets any local process drive that browser while it runs. Keep the profile in your own scratch folder, and close the session when the task is done.

## 4. Submit

- Path a: submit right after the paste.
- Path b: submit inside the paste call.
- Path c: `--submit` submits for you.

On every path, the section 2 length check comes after the submit, never between the fill and the submit.

## 5. CAPTCHA, 2FA, locked vault

- CAPTCHA: solve it yourself, whether it is a checkbox, an image grid, an audio challenge or a slider puzzle. If it expires or fails, reload and try again. Ask the owner only after 3 real attempts fail, or when it needs something you cannot do (a phone call or a hardware key). Then leave the page visible and say what blocked you.
- 2FA belongs to the owner: stop, leave the page visible, and ask.
- Vault locked (exit 3): ask the owner to run `bw-unlock`.
