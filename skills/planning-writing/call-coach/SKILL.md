---
name: call-coach
description: 'Coach the owner live during a phone or video call: a prep page he keeps open, plus one-line prompts as the transcript arrives. Use when he says "coach me on this call" or "live edit" a call page.'
metadata:
  version: "1.1.0"
---

# Call coach

Coach the owner while he is on a call. He keeps a prep page open on the tailnet. You read the live transcript and put one coaching line at a time in a red bar at the bottom of that page.

Everything runs through one script, `scripts/call-coach.mjs`, with Node. Run it with `--help` for every option. Each command takes `--call <name>` (the folder `call-coach/<name>` under `$FLEET_SCRATCH`, else under `.cache` in your home folder) or `--dir <folder>`. Pick one name per call and use it every time. State stays in that folder, never in this skill folder or the project. The folder is owner-only; the script refuses a symlink, a folder another user owns, or one that group or others can write.

| Command | What it does |
|---|---|
| `page <source.md>` | Writes the prep page. The live bar is part of the template, so a rewrite never drops it. Open pages reload within 1 s. |
| `serve` | Serves the page on the host's tailnet address only (`tailscale ip -4`), on a free port, and prints the URL. It refuses to start without a tailnet address. |
| `live -` / `live --clear` | Sets the bar from stdin, or clears it. The page checks it every 0.5 s and turns the bar grey with "OFFLINE" after 4 s without an answer from the server. It prints the line back; check it before you move on. |
| `poll` | Takes the live-share link from `link.txt` in the call folder, moves it into the private state, deletes `link.txt`, starts the transcript poller in the background, and waits up to 60 s for the first lines. |
| `next` | Waits until new transcript lines exist or 20 s pass, then lets them settle: it returns once the text has not grown for 1 s (`--settle`), at most 3 s after the first new words and never past `--wait`. It prints only the new lines as `m:ss text`. Empty output means nothing new. A line that grew prints as `m:ss ... added words`. |
| `stop --project <dir>` | Stops the poller and the server, saves `<dir>/calls/<date>/transcript.txt`, and removes the share link from state and any leftover `link.txt`. It kills only processes whose command line names this call's folder and says so when a saved process ID now belongs to something else. |

## Page source

A small text file, one item per line:

- `# Title` once at the top.
- `## Section` for each numbered part, for example `## 2. Price`. A section whose title starts with "Don't" shows its bullets in red.
- `> "exact words"` is a yellow box with what to say. `**bold**` works in any line.
- `- item` is a bullet. `! text` is a red line, for example `! Then stop talking.`
- Any other line is a paragraph.

## Steps

1. **Before the call.** Confirm with the owner the goal, his limits (price floor, what he will not agree to) and the facts. Write the source file and run `page`, then `serve`, and give him the URL. Run one full dry cycle: set a `live` test line, check it shows on the page, then `live --clear`. Tell him it worked. End your turn there and let his reply start the next one. That proves a turn completes on your current model route before the call depends on it.
2. **Call started.** Ask for the live transcript link (an Otter live-share link). Write the link with your file-write tool to `link.txt` in the call folder, then run `poll`. Never put the link in any shell command, heredoc or echo: the shell's own command line is visible to other users on the host. Confirm the first line arrived. If `poll` says the link went to a sign-in page, the share was revoked or is private: ask for a new link.
3. **During the call.** Loop: run `next`, read the new lines, decide. Write a `live` line only when it changes what the owner should say or do in the next 30 seconds. Format: the trigger in bold, then the exact words in quotes, about 30 words at most. Pass the line on stdin through a quoted heredoc, so `$`, quotes and apostrophes arrive unchanged, and run `next` in the same command, so writing a line costs no extra model step:

   ```bash
   node call-coach.mjs live --call <name> - <<'EOF' && node call-coach.mjs next --call <name>
   <b>He asked "what's your fixed price?" Say it now:</b> "$2,700 total."
   EOF
   ```

   Say when to stop talking and when to let the deal go. Answer what the other side is doing, not only what they said. Never invent a fact, a price or a concession the owner did not give you, and never put his floor or limits in the words he says; if unsure, write the question he should ask. Keep each turn short: no reasoning in the chat, only the line. When the deal changes, rewrite the page sections and run `page` again. Put each line in the chat too.
4. **The one loop exception.** The fleet rule against holding a turn open in a sleep or poll loop has one exception: this loop, only between "call started" and "call ended", and only through `next`. Never use a fixed sleep instead.
5. **Who runs it.** The agent that holds the project's context runs the call. It starts no workers and sends no messages to other agents during the call.
   - If the owner asks for a separate coaching worker, start it on Pi with `fleet/claude-opus-5-5` at high thinking and use low thinking for the live loop below. Never use the native `claude` provider or a `[1m]` model variant.
   - **Fast lane for the live loop.** Each line waits on one model step, so run the call turn at low thinking. On Paseo, end the dry-run turn (step 1) with `paseo agent update "$PASEO_AGENT_ID" --thinking low`; the setting takes effect from the next turn, the one the owner's "call started" opens. After `stop`, set it back the same way (for example `--thinking high`). Prep and notes are not on the clock and keep the normal setting. Measured on Claude Opus 5.5 (Nov 2026), 15 live-line steps each: low took 5.9 s median and 10 s at worst, high 7.4 s median and 33 s at worst, with lines of the same quality. With about 60k tokens of project context already in the session, low took 6.3 s median.
6. **Nothing goes to the other party.** Never join, speak on or record the call yourself. The owner starts the transcription.
7. **Call ended.** Run `stop --project <project dir>`. Write notes into the project: what was agreed, what the owner promised, follow-ups. Offer the follow-up as a numbered decision.

## Poller and browser

- `poll` reads the share page with a headless browser through `playwright-core`, found at run time: `--playwright <dir>` or `CALL_COACH_PLAYWRIGHT` first, then a normal `require` from the current folder, then the npm global root, then the newest copy in the npx cache. It is never bundled here. If none is found it says so and how to install it.
- The browser: `--browser <path or channel>` or `CALL_COACH_BROWSER` first, then Playwright's own build, then installed Chrome, then Edge. The error names each one tried.
- If your fleet rules send browser launches through a wrapper, pass it: `poll --wrap "<wrapper command>"`. The poller holds that wrapper, and whatever lock or slot it takes, for the whole call, until `stop`.
- The poller reads what the share page itself receives: the transcript response when the page loads, then the live word updates the page gets over its WebSocket, about every half second while someone talks. Otter shows words about 2 to 3 s after they are spoken; the poller has them within a few milliseconds of the page. It skips updates it already applied (by message index, as the page does) and holds any that arrive before the transcript, then applies them on top of it. It reloads the page when an update does not fit the words it holds, and after 45 quiet seconds (`--stale`) as a fallback. `poll --status` shows its state. `next` exits with an error if the poller stopped or the link was revoked.
- Test hook: `poll --replay <file>` feeds one saved transcript response, or JSON lines of responses and WebSocket messages, through the source without a browser.
- The transcript source sits behind one small interface (`SOURCES` in the script). Otter is the only source.

## Limits

- No new service and nothing that starts at boot. The server and poller run only for the call; `stop` ends them, and they end on their own after 6 hours.
- The page is reachable on the tailnet only.
- Do not keep the live-share link after the call. `stop` removes it from state.
- No tests beyond the fleet rule. Verify with one live dry run: a short Otter recording. Without the model, a line written right after `next` shows on the page 1.5 to 3.5 s after Otter shows the words, the 1 s settle included (target: under 5 s). With the model step (Opus low, about 6 s median at a PM's context size), expect about 7 to 10 s from Otter to the page.
