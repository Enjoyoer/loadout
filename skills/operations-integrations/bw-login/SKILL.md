---
name: bw-login
description: Log in to a website with Bitwarden without ever seeing the values. Use when an owner task reaches a sign-in page, or the owner says "use bw" or "sign into X".
---

# bw-login

Sign in with the `bw-login` and `bw-paste` helpers. Values never appear in output, logs, screenshots or tool arguments.

## 1. Pick the login

- Run `bw-login --list <site>` and choose the item matching the account the owner named or the task implies. If more than one fits, ask.
- Get only that site's login. Never look up any other item.
- Never use the raw `bw` CLI or `bw-paste --raw`, and never type a password into any tool.

## 2. Fill

Run `bw-paste <id> username` or `bw-paste <id> password`. This copies the value to the OS clipboard and clears it after 20 seconds, so paste within 20 seconds.

## 3. Paste, by environment

a. Normal desktop browser, or a browser tool that sends real OS keys: click the field, press Cmd+V on Mac or Ctrl+V elsewhere.

b. Codex app Browser Use, which has its own virtual clipboard (error `Browser Use virtual clipboard has no data to paste`): bridge the OS clipboard into the tab clipboard inside the node REPL. Never print, log, return or screenshot the value.
   - Probe first with no secret: set the clipboard to `probe123`. In one REPL call, read it with `execFileSync` from `node:child_process` (Windows: `powershell -NoProfile -Command Get-Clipboard -Raw`; Mac: `pbpaste`), strip the trailing newline, run `tab.clipboard.writeText(v)`, and output only whether `readText()` equals `probe123`.
   - Then for real: run `bw-paste`, then in one REPL call bridge, click the field, `pressKey` `Control_L+v` (`Meta+v` on Mac), run `tab.clipboard.writeText('')`, and output only `pasted`.
   - The owner verified this live on Windows on 2026-10-17.

c. Any other environment where paste comes up empty: stop and report the exact error line. Do not improvise another path.

## 4. Submit

Check that each field is not empty (length only, never the value), then submit.

## 5. Stop and ask

- CAPTCHA and 2FA belong to the owner: stop, leave the page visible, and ask.
- Vault locked: ask the owner to run `bw-unlock`.
