---
name: bw-login
description: Log in to a website with Bitwarden without ever seeing the values, and save or update that site's login. Use when an owner task reaches a sign-in or sign-up page, or the owner says "use bw" or "sign into X".
---

# bw-login

Sign in with the `bw-paste` helper. Values never appear in output, logs, files, screenshots or tool arguments.

## Pick the path

| Browser | Method |
| --- | --- |
| Paseo `browser_*` tools | Path a only when the checks below pass; otherwise a Playwright browser on your host with path c, or stop |
| Codex app Browser Use | Path b |
| Desktop browser (Chrome, Edge, Safari) | Path a only when the checks below pass; otherwise stop |
| Playwright, `playwright-cli` or another Chromium this task launched | Path c |
| Firefox or WebKit automation | Stop |

A browser's paste reads the clipboard of the desktop it runs on; a Paseo tab runs in the owner's Paseo desktop app, which may be another machine. `bw-paste` copies elsewhere in two cases: on Linux it always copies to the Mac's clipboard, and over SSH on Windows to that SSH logon's clipboard, not the desktop's. Path a is allowed only when all of these hold:

1. Your shell is on Mac or Windows. On Linux, never use path a, even for a browser on the same Linux host: use path c or stop.
2. You know independently that your shell runs on the browser's machine, in the desktop session the owner is logged into, not over SSH (for example, the owner told you, or the app and your shell share the hostname and `SSH_CONNECTION` is unset).
3. For a Paseo tab, `browser_evaluate` of `navigator.platform` matches your OS (`MacIntel` for Mac, `Win32` for Windows). This only filters out a mismatch; it never proves the same machine, since every Windows PC says `Win32`.

If any check fails or you are unsure, do not paste: open the site in a Playwright browser on your own host and use path c, or stop.

## Hard stop: never submit an unproven fill

Never click submit or press Enter on a login form unless every credential field's length is above 0 and grew by your paste. A prefilled field (the browser remembered the email) never counts. Measure each field's length (a number only) before and after its paste. If any field did not grow: clear it, stop and report.

On path c, a successful `bw-paste` call for each credential field replaces the growth check: run it for the username too, even when it looks prefilled. The password call's exit 0 alone does not vouch for the username.

## 1. Pick the login

- Run `bw-paste <site>`, which prints one JSON line per matching login (`id`, `name`, `uris`, `username`; never passwords), and choose the item matching the account the owner named or the task implies. If more than one fits, ask.
- Get only that site's login. Never look up any other item.
- Never use the raw `bw` CLI or `bw-paste --raw`, and never type a password into any tool (no `fill`, `type` or `eval` with a value).

## 2. Never look at the page while it holds a password

Browser snapshots can contain field values: Playwright's aria snapshot, `playwright-cli` snapshots (printed and saved as `.playwright-cli/*.yml`), Paseo `browser_snapshot` for a field without a label or placeholder, and Codex Browser Use's `domSnapshot`/`ariaSnapshot`. So, on every path below:

- Snapshot the sign-in form once, before filling, and take the field and submit refs from it.
- From the password fill until the submit, nothing else touches the browser: no snapshot, screenshot, eval, console or network listing (`requests`, `request-body`), tracing or video. The only exceptions are the length-only checks of the hard stop, the checks inside `bw-paste` itself (path c) and the length check inside the single paste-and-submit REPL call (path b). Do not start tracing or video at all during sign-in.
- After submitting, and after any failure, run one length check before anything else reads the page: an expression that returns only the number of password inputs with a non-empty value, never a value. Path c does this check itself.
  - If it returns 0, or the sign-in page is gone, you may take a fresh snapshot.
  - If it is above 0, set each password input to an empty string (an empty `fill`, never a value) and check again.
  - If it still is not 0, or the check fails, close that tab without a snapshot or screenshot, then report.
- Never snapshot a page whose password fields you have not just verified empty.

## 3. Fill, by environment

Use only these paths. For anything else, stop and report the exact error line.

### a. Desktop browser, or a tool that sends real OS keys

Only when the Pick the path checks pass. Before the first real paste, probe with no secret: clear the username field and check its length is 0; put `probe123` on the clipboard with the OS command; paste it into that field; return only whether its value equals `probe123` (`field.value === 'probe123'`); then clear it and check its length is 0 again. If the probe returns false, stop and use path c. A passing probe shows the clipboard reaches the field; it does not replace the checks above.

For each field: clear a prefilled value with an empty fill and check its length is 0. Run `bw-paste <id> username` or `bw-paste <id> password`. It copies the value to the OS clipboard and clears it after 20 seconds. Click the field and press Cmd+V on Mac or Ctrl+V elsewhere within 20 seconds, then check its length is above 0 (hard stop). Then submit (Enter, or the submit ref from your pre-fill snapshot) and run the section 2 length check.

Paseo `browser_*` tools expose no DevTools endpoint, so path c does not apply to them. If a paste fills nothing, clear the field, stop and report.

### b. Codex app Browser Use (its own virtual clipboard)

The error `Browser Use virtual clipboard has no data to paste` means this path. Bridge the OS clipboard into the tab clipboard inside the node REPL, and never print, log, return or screenshot the value.

- Run `bw-paste` with the agent's shell tool (`exec_command`), never inside the REPL: the REPL may not be able to start it.
- Read the OS clipboard in the REPL with `execFileSync` from `node:child_process`: on Windows `execFileSync('powershell',['-NoProfile','-Command','Get-Clipboard -Raw']).toString().replace(/\r?\n$/,'')`, on Mac `pbpaste`.
- Probe first with no secret: set the clipboard to `probe123`. In one REPL call, read it as above into `v`, run `tab.clipboard.writeText(v)`, and output only whether `readText()` equals `probe123`.
- Then for real: run `bw-paste`, then in one REPL call bridge, clear the field and check length 0, click it, `pressKey` `Control_L+v` (`Meta+v` on Mac), check its length is above 0, and output only `pasted` or `empty` (on `empty`, stop and report).
- For the password, do the whole sequence in that one call, so no other call sees the filled field: bridge, clear the field and check length 0, click, paste, check that the password and username lengths are above 0 and the password grew (numbers only), then press Enter or click the submit locator.
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
3. Click the username field, then run `bw-paste <id> username --cdp-profile <dir>/profile`, even if the field looks prefilled. When the username is on its own page (two-step sign-in), add `--submit`.
4. Click the password field, then run `bw-paste <id> password --cdp-profile <dir>/profile --submit`. `--submit` is required for passwords.
5. Expect `filled username for <name>`, then `filled password for <name>; submitted`. Exit 0 after `--submit` means `bw-paste` already verified that no password field in the page still holds a value, so a fresh snapshot is allowed.

What `bw-paste` does:
- Tab: it needs exactly one open http(s) tab. Pass `--target-url-prefix <login-url-prefix>` or close the other tabs; it never guesses by focus.
- Origin: the page URL must match one of the item's saved URIs under that URI's Bitwarden match mode.
  - Domain (the default) matches the same site, including subdomains.
  - Host matches host and port.
  - Starts with and Exact compare the full URL, including port, path and the `#` route of single-page apps.
  - Regular expression and Never never authorize.
- Field: the focused field in the page's main frame must fit (a password needs a password input; a username a text-like input or textarea). That field and the full page URL, `#` route included, are pinned. The value is written into the pinned field itself, never into whatever has focus, and the field is checked again in the same step.
- Submit: it uses the pinned field's own form, and only a form that sends by POST to the page's own origin submits normally: it clicks that form's default submit button, as Enter does, or submits the form if it has no button. For a GET form (a form without a method is GET) or an action on another site, it only clicks the form's own submit button and blocks the browser's own submission, so the value can never go into a URL; if the page does not sign in by itself, that is exit 5. With no form, it sends Enter to the field. It then waits up to 10 seconds until no password field in the page holds a value, and checks the tab's URL and history for the value after every step.

Exit codes:
- 5, one fixed line, value not in the page:
  - before writing: wrong origin, not exactly one tab, no focused field in the main frame (a field inside an iframe counts), wrong field type, page or field changed;
  - after writing: fill not verified, disabled submit button, a form that would send the value in a URL or to another site (`would send it in the page URL`), or still filled 10 seconds after submit.
  On the after-writing refusals, it cleared the fields and verified them empty. Read the page if needed, then report.
- 6, `UNSAFE STATE, CREDENTIAL LEAKED`: the value showed up in the page URL or the tab's history after the submit. It closed the tab (or tells you to close the session). The credential is leaked: never print, snapshot or list that tab, the tab list or the history, stop, and ask the owner to rotate it now.
- 6, `UNSAFE STATE`, page state unknown: it could not verify the page is free of the value (a page that refills the field, a hung tab, or a lost connection).
  - Normally it has closed that tab: do not snapshot, and reopen the page if needed.
  - If the line says it could not close the tab, close the whole browser session now without a snapshot, then report.
- Firefox and WebKit have no CDP fill: stop and report.

Remote debugging lets any local process drive that browser while it runs. Keep the profile in your own scratch folder, and close the session when the task is done.

## 4. Submit

- Path a: submit right after the hard-stop length check.
- Path b: submit inside the paste call.
- Path c: `--submit` submits for you.

On every path, the section 2 length check comes after the submit, never between the fill and the submit.

## 5. CAPTCHA, 2FA, locked vault

- CAPTCHA: solve it yourself, whether it is a checkbox, an image grid, an audio challenge or a slider puzzle. If it expires or fails, reload and try again. Ask the owner only after 3 real attempts fail, or when it needs something you cannot do (a phone call or a hardware key). Then leave the page visible and say what blocked you.
- 2FA belongs to the owner: stop, leave the page visible, and ask.
- Vault locked (exit 3): ask the owner to run `bw-unlock`. Never run `bw-unlock` or `bw-lock` yourself, not even with `--help`.

## 6. Save or update a login

Only for the site of the current task. `bw-paste` enforces this: the item's saved URIs must match the site or page. Never touch any other item, and never delete one.

- **New account (sign-up):** use `bw-paste add <site-url> --username <u> [--name <n>]`. It generates a strong password inside the helper; the login goes into the Bitwarden folder `Agents`.
  - Path c browser (preferred): fill every other sign-up field first, click the new-password field, then add `--cdp-profile <dir>`. It fits the password to the field's `minlength`/`maxlength` and `pattern`, writes it into that field and its confirmation, and submits. Nothing is saved yet: it prints `submitted the sign-up ...; nothing is saved yet (pending <pending-id>)`. Then, within 10 minutes:
    1. If the site shows the sign-up form again with an error, run `bw-paste add <pending-id> --discard --cdp-profile <dir>` (same browser). Nothing is saved. Fix the cause and start again.
    2. Otherwise open the site's sign-in page in a fresh browser session (a new `--profile` folder and a new `playwright-cli` session), type the username (it is not secret, and the login is not in the vault yet), click the password field, and run `bw-paste add <pending-id> --signin --cdp-profile <new dir>`.
    3. Then run `bw-paste add <pending-id> --commit --cdp-profile <new dir>`. Signed in: `saved <name> (<id>)`. Not signed in (for example the site wants an e-mail confirmation first): it still saves, prints `... marked unconfirmed` and exits 9, with the notes `unconfirmed: verify by sign-in`.
    If you do neither within 10 minutes, it is saved marked unconfirmed. Never run `add` again for the same account.
  - Paths a and b: run `add` without a browser flag, then paste `bw-paste <id> password` into each password field as in section 3. This saves at once, marked unconfirmed (exit 9), because no site has accepted the password yet. Use `--length <n>` when the field has a `maxlength`.
  - `--no-symbols` or `--length <12-64>` only when the site rejects the default (exit 5 with `pattern`, or an error page).
- **Change non-secret fields:** use `bw-paste update <id> --site <url> [--username <u>] [--uri-add <url>]... [--notes-append <text>]`. `--uri-add` may be given up to 10 times in one call; every new URI must be on the same site, and if one is not, nothing changes. It prints the changed field names.
- **Change the password (rotate):** only when the owner asked for a password change in this task. Never on your own initiative, never because a site suggests it. It is two-phase, and the vault changes only after you sign in with the new password:
  1. Path c only. Open the site's change-password page, click the new-password field, and run `bw-paste rotate <id> --cdp-profile <dir>`. It fills the current password (if the form has that field), the new one and its confirmation, and submits. The vault is not updated yet. It prints `submitted the password change ...; the vault is NOT updated`.
  2. Within 10 minutes, open the site's sign-in page in a fresh browser session (new profile folder, new session), fill the username, click the password field, and run `bw-paste rotate <id> --signin --cdp-profile <new dir>`.
  3. Look at the page (section 2 rules first). If the site shows you signed in, run `bw-paste rotate <id> --commit --cdp-profile <new dir>`: `rotated password for <name>; saved to the vault (old password kept in its history)`. If not, run `bw-paste rotate <id> --discard`; the vault keeps the old password.
  - `--commit` on a page that still has a password field, or is off the site, discards the new password (exit 5, `rotate not confirmed`). If the site did take the new password anyway, tell the owner: the account needs a reset.
  - Exit 7 (`VAULT NOT UPDATED`): the site took the new password but saving failed. Tell the owner at once.
  - One pending change per item; `--signin` in the browser that made the change is refused.
- **Exit 9 (`marked unconfirmed`):** the login is saved with the note `unconfirmed: verify by sign-in`. Report it as saved but unconfirmed.
- **Exit 8 (`saved remotely, local sync failed`):** the change is in Bitwarden, but the local copy is stale for up to 10 minutes, so a fill right away may use the old values. Do not save again; report it as saved, with that warning.
- **Never save a password a website shows you** (a temporary or generated one): it is already in the transcript. Stop and tell the owner.
- **Run each command once.** Never retry in a loop. Wait at least 5 seconds between vault commands. On `rate-limiting`, stop and report.
- **Refusals (exit 5):**
  - existing login for that username (use `update`);
  - site or page not on the item;
  - wrong field focused or more than one form;
  - the field's length limits leave no room for a 12-64 character password (`length limits`): tell the owner;
  - nothing pending under that id (discarded, or past its 10 minutes);
  - an item `bw-paste` cannot change safely: tell the owner.
- **Report every add, update and rotate in your reply:** item name, site, which fields changed (for example `password`, `username, uris`), and for add whether it was saved confirmed, saved unconfirmed or discarded. Never include values.
