# Usage limit auto resume

This server plugin resumes an agent in the same session after a usage limit (five-hour default path) and retries completed turns whose final assistant message is a transient provider error, plus every failed turn. Both paths obey the host `armed` setting and the `noresume=true` label. The plugin does not send while unarmed.

Requires Paseo 0.15.

Startup endpoint resolution uses explicit `PASEO_HOST`, then `$PASEO_HOME/paseo.pid` runtime listen metadata. An explicit non-default `PASEO_HOME` without valid endpoint metadata refuses to connect instead of falling back to another daemon. Invalid explicit hosts also fail closed. The standard local endpoint is a fallback only for an unset home or `~/.paseo`.

Completed heartbeat timeline rows also count as turn inputs. Their stable system IDs bind recovery to the scheduled turn and let newer scheduled work supersede an older input.

## Daemon config requirement

Set `agents.idleRuntimeCleanup` to `false` in the daemon's `config.json` to preserve parked retries: merge `{"agents":{"idleRuntimeCleanup":false}}` into the existing config before starting the daemon with this plugin. Its default is `true` when unset ([default](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/config.ts#L687)), and its one-hour collector emits the same `agent.closed` event as an intentional close or kill, so a quota retry parked for five hours can be canceled before its attempt. The plugin cannot tell these closes apart or exempt a session from collection.

The plugin never edits daemon config. At startup it reads the effective config once and logs one loud warning if cleanup is enabled, including when the key is unset; a failed read warns that the condition could not be verified; explicit `false` is quiet. Later config changes need an operator check or a plugin reload to repeat the check.

## Daemon restart recovery

Paseo's `agents.resumeOnStartup` (default `false`) and `agents.resumePrompt` (default `Resume working.`) ([defaults](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/config.ts#L842)) make the daemon send that prompt at startup to each unarchived, ownerless agent that was running when it stopped ([candidates](https://github.com/getpaseo/paseo/blob/v0.15.0/packages/server/src/server/agent/restart-recovery/index.ts#L23)). The plugin does not read the setting. A parked retry is never a candidate, since its turn had ended. An agent the daemon resumes gets a newer user message, so any record for it ends `superseded newer-user-message`; a failure of the resumed turn gets its own record.

At a graceful stop the daemon resumes no Pi turn (the close fails it and clears the restart marker); it does after a crash. A provider whose close cancels the turn keeps the marker, and the daemon resumes that agent when `agents.resumeOnStartup` is on. The plugin resumes any cut-off turn after the next start ([Daemon stop or crash](#daemon-stop-or-crash)), waiting at least 60 seconds so the daemon's own recovery goes first.

## Transient retry

A completed turn qualifies when its final assistant text starts with `API Error:` and contains `rate limit`, `rate_limit`, `temporarily limiting requests`, `overloaded`, `429`, or `529`, or when it is exactly `Selected model is at capacity` (Codex's `[System Error]` prefix and trailing `Please try a different model.` are accepted). A normal answer that discusses these terms does not qualify.

Every turn that ends as `failed` is resumed, whatever the error, unless it is an explicit usage limit (five-hour path) or the agent is opted out. The resume is a pure `continue` to the same session, never a replay ([Pi prompt timeouts](#pi-prompt-timeouts) are the exception), and may be sent while the agent is in `error` status.

No retry is given up for its attempt count or for failing the same way again. Every retry follows one schedule, `transientBackoffSeconds` (default `[0, 120, 300, 900, 1800]`; the last step repeats), measured from the failure it retries. If the agent has not settled yet, the immediate retry waits for the next sweep (30 seconds). A repeated 429 or 402 keeps retrying; while pq shows the whole pool out it is held until the reset instead ([Quota awareness](#quota-awareness)). A record ends only when:

- a retry succeeds;
- a newer user message arrives (`superseded`, `newer-user-message`), or the user cancels the retry turn (a daemon stop or crash does not count);
- the agent is opted out (`noresume=true` or an excluded provider);
- the agent is archived (`agent-archived`) or deleted (`agent-missing`, on the second sweep that finds no agent);
- the agent is explicitly closed or killed (`superseded agent-closed`).

### Closes

A plugin reload keeps every record. A `closed` status alone ends nothing: Paseo marks every agent `closed` at shutdown, with the same `agent.closed` event as an explicit close. The plugin stores the close per agent, with the daemon run that saw it, whether or not the agent has a record yet; later records of that agent are held by it too. Until the close is decided the plugin sends nothing for the agent and reads none of its timelines. If the same daemon run outlives the close by 60 seconds, the records end. A new daemon run clears it (`agent-close-cleared`) and the retry goes on. Work begun with a user message newer than the close is unaffected. Limits: a restart within 60 seconds of an explicit close keeps the record, and a close caused by the plugin's own PM fallback reload is ignored.

Every timeline read loads an unloaded agent, so each of the plugin's reads is watched from its start for a close or archive that would be undone. If the plugin sees a close or archive meanwhile, or a fetch after the read (a fetch never loads an agent) shows it archived, deleted, or closed when it was open before, the read ends and the agent is put back as the user left it: archived again, or killed again with the daemon's Agent MCP `kill_agent`, unless a running turn or a newer user message shows someone opened it since. Log: `read-raced-end agentId=<id> read=<turn-end|turn-end-bind|transient|usage-input|verify> end=<closed|archived|gone> restored=<closed|archived|none|skipped-active|failed>` (plus `reason=` when there is one); nothing is sent for that read. Limits: an agent reopened without a new message during a read (`paseo agent reload`, or the app showing it) is killed again; a read of an agent already `closed` beforehand is deliberate and not undone; the agent is still loaded for a moment; a daemon whose Agent MCP is disabled or needs a password refuses the kill (`restored=failed`).

### Binding and inputs

A record's work is the failed turn it came from, bound by identity to the user row of its `turn_ended` event (or, if the event has none, to the predecessor record's last send). The work's origin is that row's daemon timestamp, carried by every successor. After its awaits, the turn-end handler reads the timeline back to the bound row. The failure is stale (`stale-failure`) only if the latest user row is a different message, later in the daemon's timeline and stamped no earlier, and not the bound row rebuilt with a new ID. A stale failure creates no record and ends the record it would have handed off from. Only daemon evidence decides this, never the plugin's clock. When nothing can be bound (missing ID, failed read), the failure is not stale and the snapshot's `lastUserMessageAt` is the origin. A closed agent's timeline is never read (including one whose close landed during the snapshot read); the failure is then not stale and gets no origin, so the close ends its record. The same holds when the bound row is gone from the timeline.

After a daemon restart Paseo rebuilds the timeline, and native user rows get new IDs and no `clientMessageId`. A user row with the record's expected text (the original message, or the record's own last send) still counts as expected while `lastUserMessageAt` is unchanged, on every path: send checks, `uncertain` re-verification and the prompt-timeout check. So a waiting retry survives a plugin reload and a daemon restart. An identity or session change ends the record (`identity-changed`); a PM fallback swap is not one. A pending permission or attention request holds a send; on a record that has not sent, it leaves the record waiting on its schedule.

A prompt from another agent (`create_agent` initial prompt, `send_agent_prompt`) or an agent notification arrives as a completed `tool_call` row named `agent_message`, not a user row, and does not move `lastUserMessageAt`. Wherever this README says user row or user message, the plugin takes the turn's input: a user row or that row, with the ID from its `callId` and its text. No other tool row is an input. Agent-message rows keep their IDs across daemon restarts. So agent-prompted workers get both resume paths, a transient retry resends the failed turn's own input, and a newer agent message supersedes a waiting record. A usage record names its input, and each send first checks it is still the newest input or the record's own last send (`send-skipped ... reason=newer-user-message` otherwise); an unreadable timeline holds the send (`input-unverified`). The detection log adds `input=agent-message` or `input=agent-notification`.

The turn-end read keeps only the ended turn's rows (by turn ID), and the turn's work runs only while no newer turn of the agent has begun: a turn start seen before or during the read drops the old turn (`stale-turn-end ... reason=newer-turn`). A turn with no rows of its own (a heartbeat or schedule prompt ending in an error row without a turn ID) takes the tail up to the newest input.

### Sends and verification

The plugin resends the last timeline user text exactly; if it is empty, it asks the agent to continue the last request. Before every send it verifies a fresh timeline and agent snapshot: idle state, permission state, latest user message, model and session. Transient records follow older timeline pages until the newest user row, so a long turn cannot hide its prompt behind the 200-row tail page. Transient `uncertain` records, including `retry-turn-ambiguous` and `user-prompt-missing`, are re-verified every sweep: a live failed turn with no newer human message is re-armed on the backoff, a running turn is left alone, and missing evidence is checked again, never terminal. The latest user must match the original row or the retry's stable message ID and exact prompt. Usage-limit records keep their reset timing and terminal uncertainty for ambiguous deliveries.

A usage resume whose turn fails hands the work to a new record for that turn (`resume-failed-rescheduled`): another usage limit waits for its reset, any other failure retries on the schedule. The handoff is one store write made only while the old record still waits on that turn, so a duplicate end event cannot reset or resend a successor. A successful retry removes its record or settles it as done.

One poll sweeps all records; there is no timer per record. Logs are one set per retry: `retry-sent`, `retry-scheduled` (with `attempts` and the next `notBefore`), and one `send-skipped ... reason=not-due notBefore=...` while it waits; an unarmed host's `would-resume` and a PM's `send-deferred` are logged once per attempt.

### Daemon stop or crash

A graceful stop (`paseo daemon stop`, a restart, an upgrade) first stops answering plugins, then closes every agent: a running turn ends canceled, or for Pi failed (`Pi RPC process exited ...`), and the plugin can read neither its timeline nor the agent. A crash or `kill -9` ends no turn at all. Each such turn is resumed once the daemon is back: the plugin's own retry, usage resume or prompt-timeout resend, and any other turn of any agent.

- Turn notes. When a turn starts, the plugin notes it in `<PASEO_HOME>/plugin-state/usage-limit-auto-resume/turns.json`: agent, turn, daemon run, and the agent's latest user message time, read at that moment and again each sweep while the turn runs (some messages are recorded only after their turn began). When the turn completes, or ends while the daemon still answers, the note goes. A turn that ends while the daemon does not answer keeps its note, with the latest user message time from the daemon's stored agent record. A turn a crash cut off keeps its last note without that refresh.
- Does the daemon answer? When a turn ends canceled or failed, the plugin asks the daemon for the agent, waiting at most 1 second. No answer means it is stopping.
- The plugin's own send. If it ends canceled, or failed with nothing to read, and the daemon does not answer, the record does not settle: it logs `retry-interrupted ... kind=<transient|usage> reason=<...>` with `probe=`, sends nothing, and stores the turn, end time, daemon run and the latest user message time from the daemon's stored record (`<PASEO_HOME>/agents`), the only way to recognize its send on the rebuilt timeline. If that cannot be read the record ends (`retry-interruption-unread`). If the daemon answers, the record ends normally: a canceled retry `superseded retry-turn-canceled`, a canceled usage resume `uncertain resumed-turn-canceled`, a failed retry `uncertain retry-turn-ambiguous` (re-verified), a failed usage resume handed off.
- A later daemon run reads earlier runs' notes before any record acts.
  - The plugin's own send is parked again (`retry-scheduled ... reason=daemon-restarted`, or `reason=turn-cut-off` when only the note shows it). A retry or prompt-timeout resend sends a pure `continue`; a usage resume resends its continuation prompt with no new reset wait. Each counts the cut-off turn as the next attempt.
  - Any other turn gets a failed-turn record (`detected kind=transient ... reason=turn-cut-off`) resumed with `continue`, if the agent is idle and not archived, its latest user message is still the noted one, and the newest timeline input is readable. Otherwise the plugin sends nothing (`turn-not-resumed ... reason=<why>`). An older record of the agent ends `superseded newer-user-message`.
  - The first send waits 60 seconds after each restart; the usual pre-send checks apply.
- If the same daemon run answers again (it only answered slowly), a sweep follows 3 seconds later, the note goes and the record ends as if the daemon had answered at once (`retry-interruption-dismissed`); a failed usage resume is parked again.

After a `kill -9` of the daemon worker, its plugin process lives a few seconds beside the new one, but acts no more once its parent is gone: it watches for its parent pid changing (Linux, macOS) or its IPC channel closing (every host, including Windows). The daemon run is the parent pid plus its start where the host shows it: boot id and start tick from `/proc` on Linux, the `ps` start time on macOS. On Windows it is the pid alone, so a reboot that reuses the pid counts as the same run. A run stored as a pid alone matches the same pid.

Limits:

- A user's cancel, kill or close whose daemon does not answer within 1 second, followed by a restart within the 3 seconds before the next sweep, is resumed after the restart.
- A turn the plugin did not see start (during a plugin reload, or with no daemon answer) has no note. A crash within one poll (30 seconds) of a message recorded after its turn began leaves an older time in the note, so that turn is not resumed (`turn-not-resumed ... reason=newer-user-message`).
- With `agents.resumeOnStartup` on, the daemon's recovery goes first only if it loads the agent within the 60-second wait.

### Pi prompt timeouts

A failed `pi` turn whose error starts with `Pi RPC request timed out phase=prompt` takes its own path; other providers (OMP) keep the ordinary path. Pi acknowledges a prompt only after its threshold compaction, so Paseo's `rpcTimeoutMs` (60 s default) can expire while the prompt is still pending in Pi and will run by itself. An immediate `continue` would time out too.

- No immediate send. The record waits until the agent is `idle` or `error` with no active turn, no compaction is in progress, and nothing new has appeared for 60 seconds after the failure or the end of compaction.
- Compaction shows on the timeline as a `compaction` row with status `loading` and no later `completed` row since the original message. The check runs again on the final read after the claim (compaction rows do not change `updatedAt`); a wait found there puts the record back, a stop ends it.
- Only execution evidence counts as the agent resuming by itself: reasoning, a tool call or a real answer after the original message, a running turn, or an `agent.turn_started` / `agent.turn_ended` hook for another turn. The record then ends `superseded` (`agent-resumed-itself`); a newer user message ends it as `newer-user-message`. Any other row proves nothing (`unproven-activity`).
- Then the original message is resent once, text only (attachments are not resent; a message with no text gets no resend), with the stable message ID and pre-send checks. If the resend fails or the record turns `uncertain`, it ends `exhausted` (`rpc-timeout-resend-failed`, `rpc-timeout-<reason>`) and is never sent again.
- Every turn the plugin starts is marked handled, and a turn whose newest user row is the plugin's own send is never a new failure.
- The wait is bounded at 30 minutes from the failure, then `exhausted` with `rpc-timeout-wait-expired`.
- Logs: `rpc-timeout-waiting` (once per reason: `compaction-in-progress`, `settling`, `unproven-activity`, `agent-status=...`, `timeline-unavailable`), `rpc-timeout-no-resend`, `rpc-timeout-gave-up`, `send-skipped`, `retry-sent`.

Raising Pi `rpcTimeoutMs` (personal-skills `pi.options`, see `fleet/README.md`) avoids most of these timeouts.

## Quota awareness

Before it schedules a usage-limit resume, and before every send, the plugin reads Paceline's quota CLI (`pq --json`, schemaVersion 1), the source OPC's route pace uses (`skills/orchestration/opc/references/routing.md`). The argv is the `pq` key of `~/.config/opc/routing.json` when it is a nonempty string array, else `["~/.local/bin/pq", "--json"]`; a leading `~` is expanded and pq runs without a shell. The pool follows the agent's model as in OPC: Claude models (Opus, Sonnet, Fable, Haiku) read the claude accounts, GPT models (Sol, Luna, Astra) the codex accounts. Web and local models have no pool.

Only the `five_hour` and `seven_day` windows count. An account is out while one of them shows 0% left (or pq marks it blocking) and its reset plus the buffer is ahead; it frees when its last out window resets. An account has quota only on a fresh reading whose windows all show some left. Any other account keeps the pool from reading as out.

- Usage limit: the resume is due `quotaResetBufferSeconds` (60) after the pool's earliest real reset instead of the flat `baseDelaySeconds`, never earlier than a reset the error names. While another account has quota, the reset only brings the resume earlier.
- Transient and failed turns: while some account has quota, retries run as usual. If every account is out, the send is held until the earliest reset plus the buffer, consuming no attempt. A weekly-out pool is held until the weekly reset. Each hold is logged once as `quota-hold ... reason="quota-blocked pool=<pool> weekly accounts=<n> until=<iso>"` (or `window=five_hour`) and stored as `quotaHold`. Each due sweep re-reads quota, so an early reset releases the hold (`quota-released`). No PM is notified.
- Quota refusals: after a turn the provider refused for quota (usage limit, 429, or a 402 "credit balance is too low"), an account pq cannot show with quota left (stale or rolled-over) counts as out too. The retry is held as above (reason adds `unproven=<n>`), and a PM may swap ([PM quota fallback](#pm-quota-fallback)). This applies only to the refusing pool: the pool of the model Pi names in the error, else the turn's model. A 429 while pq shows quota left stays a transient retry.
- Quota evidence is read on the raw error text in three forms:
  - a structured code: `429`, `402`, `rate_limit*`, or `insufficient_credit(s)`;
  - a standalone phrase: `rate limit`, `rate_limit_error`, `rate limited`, `credit balance is too low`, `insufficient credit(s)`, or `Too Many Requests`. Not inside a path, URL or ID: no word character, slash, backslash, `.`, `-` or drive-letter colon right before it, and no word character, slash, backslash, `-` or `.` plus a word character right after it (a sentence-ending `.` counts);
  - a status at the very start of the error, after an optional `[System Error]` or `API Error:`: 429 or 402 followed by a JSON body, its reason phrase (`Too Many Requests`, `Payment Required`), `status code`, `:` and text, or nothing (`429 {...}`, `402 Payment Required`, `API Error: 429`); also a quoted `"status":429`, `"status_code":429` or `"code":429`, and `rejected (429)`.
  - A status anywhere else does not count (a request ID, path, URL, `429 files processed`, a mid-error `HTTP 429` with no phrase or code). An error that also names an overloaded, context-length or cooldown error (with or without `_error` or `_exceeded`) is never a quota refusal.
  - Re-verification sees only live error text, so it recognizes no new refusal and a repeated failure keeps the record's evidence. A record that follows its PM to another profile drops the evidence.
- Unknown quota keeps plain behavior: pq missing, erroring, slower than `pqTimeoutSeconds` (5), unparseable, another schemaVersion, a stale snapshot, or a pool pq does not list.

One pq reading is shared for `quotaCacheSeconds` (60). `quotaAware: false` turns this off.

## PM quota fallback

Off by default (`pmFallback: false`). When on, a live Pi agent labelled `role=pm` on a Claude model moves to an exact catalog profile while its Claude pool is out, and returns to its original profile once Claude is usable. Workers, watchers and agents without `role=pm` never change model; no label opts a PM out. Every write goes through one gate that first carries out a pending owner cancel.

- Swap: after a PM turn fails with a quota refusal (a completed reply never swaps), or a sweep finds its record on a quota hold, pq must show no Claude account with quota left (stale or rolled-over counts as out) and must not show the fallback pool out; otherwise `pm-fallback-held ... claude-pool-has-capacity`, or no swap on stale or missing quota. The plugin first stores the exact original model, thinking option and `opc.service-tier` label, then sends one `agent.config.apply` with `pmFallbackModel` (`fleet/gpt-6.1-sol`) and `pmFallbackThinking` (`medium`), sets `opc.service-tier=fast` (`pmFallbackServiceTier`), and reads the agent back. Both values must be listed verbatim in the Pi catalog; an unset original thinking option is stored as the model's catalog default. An unapplied swap intent (after a crash or restart) is decided again: the agent must still be an eligible PM on its original model and fresh pq must still show Claude out, or the intent is dropped. Once the fallback model is in place the swap is finished regardless of quota (a partial swap is repaired, the record confirmed and the PM's resume record moved to the new profile), and only then is it a return.
- Return: the obligation lives in `<PASEO_HOME>/plugin-state/usage-limit-auto-resume/pm-return.json`, apart from resume records, and survives record changes, plugin reload, daemon restart and idle periods. It is due when either holds:
  - fresh pq shows a Claude account whose five-hour and weekly readings are both fresh with quota left (`reason=pq-capacity`); stale, missing or unknown readings do not count, and an earlier due reading never authorizes a restore by itself;
  - this daemon saw a Pi agent finish a turn on a Claude subscription model with a normal final reply (not a failed turn, an `API Error:` or `[System Error]` reply, a transient error or a usage-limit text) after the swap was verified (`reason=claude-success agent=<8> at=<iso>`). API-billed models (`fleet/api/...`) and turns of agents with a return of their own do not count. The proof is kept in memory, so a plugin reload waits for the next such turn or for pq.

  While it is not due, the plugin logs `pm-return-waiting ... reason=no-claude-proof pq=<summary>` once per change of reason or reading.
- Applying: an outstanding swap or due return is applied on `agent.turn_ended` and on the poll sweep. A PM mid-turn is changed too; Paseo applies the settings to its next turn. A change counts only once the daemon's stored record (`<PASEO_HOME>/agents/`) holds it. A read-back mismatch, an unpersisted change or a rejected update keeps the obligation for the next try. While a swap or due return is unverified, the resume engine sends nothing for that PM.
- An explicit owner cancel ends a return early, and so does an explicit model change: once the PM is on the fallback profile, a live model, thinking option or `opc.service-tier` that matches neither the fallback nor the original profile drops the return (`pm-return-dropped ... reason=profile-changed live=<profile>`) and nothing is written over it. A restore of the plugin's own that landed only partly (original model and thinking, label not yet written) is finished, not dropped. A PM already back on its original profile settles as restored. A PM whose return was dropped is not swapped again while it stays on that changed profile. A lost `role=pm` label or turning `pmFallback` off does not end a return. An archived PM is never changed or resumed; its obligation waits.
- Sol also out: no swap, ordinary hold. On Sol and Sol runs out: hold on Sol until Claude returns. No ping-pong. A PM refused while its pool has capacity keeps retrying on the schedule and swaps once pq shows the pool out.
- Logs: `pm-swap-start`, `pm-swap-apply`, `pm-swap-verified`, `pm-restore-due`, `pm-restore-apply`, `pm-restore-verified`, `pm-*-failed`, `pm-*-mismatch`, `pm-*-unpersisted`, `pm-swap-dropped`, `pm-swap-not-completed`, `pm-return-waiting`, `pm-return-dropped`, `pm-fallback-held`, `pm-fallback-skipped`, `pm-enrolled`, `pm-return-cancelled`. At startup the plugin logs `started version=<version> armed=<bool> pmFallback=<bool>`.

Limits. Paseo has no idle-only settings barrier, so a message landing between the return becoming due and the write can run one more turn on Sol. Paseo labels cannot be deleted, so an originally absent `opc.service-tier` is restored as an empty value, which fleet routing treats as absent. The settings writes use the daemon client that `@getpaseo/client` wraps (`applyAgentConfig`, `updateAgent`), since the public agent handle has no setter for them.

### Enroll a PM that already fell back, or cancel a return

Both go through the host settings file, which the plugin re-reads every sweep. Back it up first and keep its other values. Copy the original model ID verbatim from `paseo provider models pi --thinking`; `serviceTier` is the PM's original `opc.service-tier` label, or `null` if it had none.

```bash
f="${PASEO_HOME:-$HOME/.paseo}/plugin-settings/usage-limit-auto-resume/auto-resume-config.json"
cp "$f" "$f.bak-$(date -u +%Y%m%dT%H%M%SZ)"
jq --arg id "<agent-id>" --arg model "<original-model-id>" --arg thinking "<original-thinking-id>" \
  '.values.pmFallbackEnroll += [{agentId: $id, model: $model, thinkingOptionId: $thinking, serviceTier: null}]' \
  "$f" > "$f.tmp" && mv "$f.tmp" "$f"
```

The entry is applied once (`pm-enrolled`, or `pm-enroll-rejected` with a reason): the agent must be a live Pi `role=pm` agent not already on that profile, and the original must be a Claude model in the catalog. To cancel one return, add its `obligationId` (from `pm-swap-start`, `pm-enrolled` or `pm-return.json`) to `pmFallbackCancel`: `jq --arg id "<obligation-id>" '.values.pmFallbackCancel += [$id]'`.

## Pattern evidence

- Claude: `API Error: Server is temporarily limiting requests (not your usage limit) · This request would exceed your account's rate limit. Please try again later.` (synthetic message with `apiErrorStatus: 429`), and `API Error: Request rejected (429)` with `rate_limit_error`.
- Codex: `Selected model is at capacity`.
- Pi with every Claude account out: `429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. ..."}}`, and on an API-key route `402 ... Your credit balance is too low to access the Anthropic API.` Both are quota refusals only while pq shows no account with quota left.
- Anthropic documents `529 overloaded_error` and `429 rate_limit_error`: <https://docs.anthropic.com/en/api/errors>. A 429 can also mean a spend cap, so explicit usage-limit text takes priority.

Paseo's [`agent.turn_ended` event](https://paseo.sh/docs/plugins/reference.md#lifecycle-hooks) supplies an empty timeline, so the handler reads the tail with `refetch({direction: "before", limit: 200})` back to the newest user row, before any other await. A canceled turn is never read (a kill, delete, archive or shutdown cancels the turn just before unloading the agent). Each page is read only right after a fetch shows the agent loaded (`activeTurn`), neither closed nor archived, and while no close or archive was seen since the event; otherwise the turn is handled as if its event had no timeline.

## Settings and install

Host-scoped settings are stored at `<PASEO_HOME>/plugin-settings/usage-limit-auto-resume/auto-resume-config.json` as `{"version":2,"values":{...}}`. A missing file means defaults, and the default is `armed: false`: a fresh install observes and records but sends nothing. Arm a host only after reviewing `paseo plugin logs usage-limit-auto-resume`, by writing `{"version":2,"values":{"armed":true}}` to that file.

Resume records live in `<PASEO_HOME>/plugin-state/usage-limit-auto-resume/state.json`, and turn notes in `turns.json` beside it. A missing file means no records. If `state.json` is unreadable, corrupt, from another state version, or holds a malformed record (missing id, unknown state, unparseable time such as `notBefore`), the plugin logs one `state-unreadable` error and changes nothing until the file is fixed or moved aside; it never renames or replaces it. An unreadable `turns.json` logs one `turns-unreadable` line: records keep working, but cut-off turns are not resumed until it is fixed or moved aside. On Linux and macOS a state write completes only after the directory is flushed, so a record written before a send survives a host crash; on Windows the rename is not flushed, and a host crash soon after a write can restore the previous state.

A send failing with `Transport not connected` never reached the daemon: the record stays parked and the next sweep retries on a fresh connection, undoing only what the claim set (state, send time, deadline, attempt). If a turn started after the claim, the message may have arrived, so the record becomes `uncertain` with turn identity and deadline kept (the turn start is noted in memory on arrival, also during the rollback write); a terminal state written meanwhile is kept. Usage-limit records then send nothing further; transient ones take live re-verification. Any other send error marks the record `uncertain`. If the retry's user row has not appeared yet, its verification window is kept before another send.

A send claims its record only while it is unchanged since the send checks and at the same attempt count. Until the message is handed to the daemon, a permission request, an archive, or any turn start or end on the agent cancels the claim, and that turn is never taken as the resume's. Right before sending, the plugin reads the agent again and sends only if every check passes and the latest user message time, running turn and last-change time match the claim's snapshot. A cancelled claim leaves no attempt. A permission request puts the record back to waiting (one after a send makes delivery ambiguous, `uncertain`); an archive or another turn ends it `superseded`. A send receipt moves only the live claim to verification; a terminal state stored meanwhile is kept.

The resume is itself a user message. Verification accepts the newer user time only when the newest user row in a complete page carries the attempt's stable message ID and exact prompt; any other newer message supersedes the record. When that message's turn fails, its distinct turn ID gets a fresh record; identical error text does not deduplicate different turns. Usage-limit verification fails closed on incomplete pages; transient verification defers and rechecks.

The state file keeps every record that can still send, is verifying, or is `uncertain`, plus the 200 most recently updated settled records (done, exhausted, opted out or superseded). Each pruned record leaves a guard (agent, source turn, persistence session); the newest 2000 guards are kept. A repeated event for a turn with a record or guard is a duplicate, even after a configuration change. A failed-turn record keeps its 20 newest attempts in full; older ones are counted, so message IDs and backoff continue from the full count.

```bash
npm ci
npm run check
paseo plugin install "$PWD"
```

## Pi coverage

Pi reports a failure as an assistant message with `stopReason: "error"` and `errorMessage`, which Paseo formats with `(stopReason=error, model=<provider>/<model>)` and ends as `turn_failed`. The timeline shows a `[System Error]` row, and the plugin receives `outcome.kind: "failed"` with `outcome.error.message`, so detection uses the failed outcome, not `turnText()` or the display prefix.

`You've hit your usage limit. Try again in 1 second.` (including the typographic apostrophe) is a usage limit, alongside `usage_limit_exceeded`, `out of credits` and the other explicit quota patterns. Generic 429s and rate limits stay on the failed-turn path. Normal completed answers stay `not-resumable/unrecognized-final`. Usage records from a failed outcome carry `usageFailedOutcome`, which allows a due continuation from `error` status and its error attention marker; completed usage records get neither exception. Unlike `failedOutcome` they keep `baseDelaySeconds` (five hours) and the reset buffer. Permissions, active turns, identity, model, thinking or session changes, opt-outs and newer user messages still block sends.

Keep existing host settings unchanged. If automatic resume is unavailable, send one explicit `continue` to the same Pi agent and verify its session, model and thinking; use an explicitly selected native Codex or Claude route if a new fallback session is needed. This package does not select or substitute models.
