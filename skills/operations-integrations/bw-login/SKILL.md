---
name: bw-login
description: Log in to a website with Bitwarden without ever seeing the values. Use when an owner task reaches a sign-in page, or the owner says "use bw" or "sign into X".
---

# bw-login

Sign in with the `bw-paste` helper. Values never appear in output, logs, screenshots or tool arguments.

## 1. Pick the login

- Run `bw-paste <site>`, which prints one JSON line per matching login (`id`, `name`, `uris`, `username`; never passwords), and choose the item matching the account the owner named or the task implies. If more than one fits, ask.
- Get only that site's login. Never look up any other item.
- Never use the raw `bw` CLI or `bw-paste --raw`, and never type a password into any tool.

## 2. Fill

Run `bw-paste <id> username` or `bw-paste <id> password`. This copies the value to the OS clipboard and clears it after 20 seconds, so paste within 20 seconds.

## 3. Paste, by environment

a. Normal desktop browser, or a browser tool that sends real OS keys: click the field, press Cmd+V on Mac or Ctrl+V elsewhere.

b. Codex app Browser Use, which has its own virtual clipboard (error `Browser Use virtual clipboard has no data to paste`): bridge the OS clipboard into the tab clipboard inside the node REPL. Never print, log, return or screenshot the value.
   - Run `bw-paste` with the agent's shell tool (`exec_command`), never inside the REPL: the REPL may not be able to start it.
   - Read the OS clipboard in the REPL with `execFileSync` from `node:child_process`: on Windows `execFileSync('powershell',['-NoProfile','-Command','Get-Clipboard -Raw']).toString().replace(/\r?\n$/,'')`, on Mac `pbpaste`.
   - Probe first with no secret: set the clipboard to `probe123`. In one REPL call, read it as above into `v`, run `tab.clipboard.writeText(v)`, and output only whether `readText()` equals `probe123`.
   - Then for real: run `bw-paste`, then in one REPL call bridge, click the field, `pressKey` `Control_L+v` (`Meta+v` on Mac), and output only `pasted`. Wrap the bridge, click and paste in `try` with `tab.clipboard.writeText('')` in `finally`, so the tab clipboard is cleared even if a step throws.
   - Verified live on Windows on 2026-10-17 and again on 2026-10-18 (lengths matched, clipboard empty after 20 seconds).

c. Any other environment where paste comes up empty: stop and report the exact error line. Do not improvise another path.

## 4. Submit

Check that each field is not empty (length only, never the value), then submit.

## 5. CAPTCHA, 2FA, locked vault

- CAPTCHA: solve it yourself, whether it is a checkbox, an image grid, an audio challenge or a slider puzzle. If it expires or fails, reload and try again. Ask the owner only after 3 real attempts fail, or when it needs something you cannot do (a phone call or a hardware key). Then leave the page visible and say what blocked you.
- 2FA belongs to the owner: stop, leave the page visible, and ask.
- Vault locked: ask the owner to run `bw-unlock`.
