# Usage limit auto resume

Startup endpoint resolution uses explicit `PASEO_HOST`, then `$PASEO_HOME/paseo.pid` runtime listen metadata. An explicit non-default `PASEO_HOME` without valid endpoint metadata refuses to connect instead of falling back to another daemon. Invalid explicit hosts also fail closed. The standard local endpoint is a fallback only for an unset home or `~/.paseo`.

This server plugin keeps the existing usage-limit resume path (five-hour default) and adds a separate retry path for completed turns whose final assistant message is a transient provider error. Both paths obey the host `armed` setting and the `noresume=true` label. The plugin does not send while unarmed.

## Transient retry

The final assistant text must start with `API Error:` and contain `rate limit`, `rate_limit`, `temporarily limiting requests`, `overloaded`, `429`, or `529`. The exact final text `Selected model is at capacity` also qualifies. A normal answer that discusses these terms does not qualify. Explicit usage-limit failures retain the five-hour path.

Every turn that ends as `failed` (not `completed`) is resumed, whatever the error, unless it is an explicit usage limit (five-hour path) or the agent is opted out. The resume is a pure `continue` sent to the same session, never a replay, and it may be sent while the agent is in `error` status. Failed-turn resumes have no attempt cap: they retry immediately, then after 2, 5, and every 15 minutes until a turn completes, a newer user message arrives, or the session changes. Interrupted or cancelled turns are not resumed. The capacity match on completed turns also accepts Codex's `[System Error]` prefix and trailing `Please try a different model.`

The first retry is sent to the same agent immediately, then after 2, 5, and 15 minutes, at most three sends by default for completed-turn errors. If the agent has not settled yet, the immediate retry waits for the next sweep (30 seconds). `transientMaxAttempts` and `transientBackoffSeconds` configure these independently of `maxAttempts` and `baseDelaySeconds`. The plugin resends the last timeline user text exactly. If that text is empty, it asks the agent to continue the last request. It verifies a fresh timeline and agent snapshot before every send, including idle state, permission state, latest user message, model, and session. Ambiguous records become `uncertain` and receive no further automatic sends. A successful retry removes its record.

## Pattern evidence

- Claude has emitted `API Error: Server is temporarily limiting requests (not your usage limit) · This request would exceed your account's rate limit. Please try again later.` as a synthetic assistant message with `apiErrorStatus: 429`.
- Claude has also emitted `API Error: Request rejected (429)` with `rate_limit_error`.
- Codex has recorded `Selected model is at capacity`.
- Anthropic documents `529 overloaded_error` as temporary overload and `429 rate_limit_error` as a rate limit: <https://docs.anthropic.com/en/api/errors>. A 429 can also indicate a spend cap, so explicit usage-limit text takes priority and unknown messages are not retried.

Paseo's [`agent.turn_ended` event](https://paseo.sh/docs/plugins/reference.md#lifecycle-hooks) supplies a complete timeline snapshot and a completed outcome. The SDK's timeline `refetch()` supplies the fresh page used for the final send check.

## Settings and install

Host-scoped settings are stored by Paseo at `<PASEO_HOME>/plugin-settings/usage-limit-auto-resume/auto-resume-config.json` as `{"version":2,"values":{...}}`. A missing file means defaults, and the default is `armed: false`, so a fresh install observes and records but sends nothing. Arm a host only after reviewing `paseo plugin logs usage-limit-auto-resume`, by writing `{"version":2,"values":{"armed":true}}` to that file.

Resume records live in `<PASEO_HOME>/plugin-state/usage-limit-auto-resume/state.json`. A missing file means no records. If the file is unreadable, corrupt, or from another state version, the plugin logs one `state-unreadable` error line and changes nothing until the file is fixed or moved aside. It never renames or replaces the file itself.

A send that fails with `Transport not connected` never reached the daemon, so the record stays parked and the next sweep retries on a fresh connection. That rollback starts from the stored record and undoes only what the send claim set (state, send time, deadline, and the new attempt). If a turn started on the agent after the claim, the message may have arrived after all, so the record becomes `uncertain` with its turn identity and deadline kept, and nothing is sent again. The turn start is noted in memory the moment the event arrives, before the plugin writes it to the state file. A turn that arrives while the rollback itself is being written restores the claim's attempt, send time and deadline with the turn ID, again as `uncertain`, before the sweep moves on; a terminal state another event wrote meanwhile is kept. Any other send error marks the record `uncertain`.

A send claims its record only while the record is still in the state the send checks passed on, unchanged since, and at the same attempt. A permission request or archive that arrives first keeps its `uncertain` or `superseded` decision and nothing is sent. Such an event is noted on the pending send the moment it arrives, so one that lands while the claim is being written also stops the send. A send receipt moves only that live claim on to verification. A terminal state stored while the send was in flight is kept.

The resume or retry is itself a user message, so the agent's latest user time moves past the record's. Verification accepts the newer time only when the newest user row in a complete timeline page carries the attempt's stable message ID and exact prompt, and then stores it. Any other newer message still supersedes the record, as does a page that is incomplete.

The state file keeps every record that can still send or is verifying a send, and at most the 200 most recently updated terminal records. Each sweep reads the file once and reads it again only for records that can still act. A failed-turn record keeps its 20 newest attempts in full; older ones are counted, so message IDs and backoff continue from the full count.

```bash
npm ci
npm run check
paseo plugin install "$PWD"
```

## Pi coverage

Paseo 0.10.3 and 0.11.1 Pi failures are not ordinary completed assistant finals. Pi emits an assistant message with `stopReason: "error"` and `errorMessage`; Paseo's `latestPiErrorMessage` formats the error with `(stopReason=error, model=<provider>/<model>)`, then `completeTurn` emits `turn_failed`. The daemon timeline displays a `[System Error]` row, and the plugin receives `outcome.kind: "failed"` with `outcome.error.message`. Detection therefore uses the failed outcome, not `turnText()` or the display prefix.

A credential-free Pi RPC fixture on a disposable Paseo 0.10.3 daemon emitted `You've hit your usage limit. Try again in 1 second.` and verified detection as **usage**, no immediate generic retry, a delayed same-session/model continuation, and a completed resume. This wording (including the typographic apostrophe variant) is now recognized alongside `usage_limit_exceeded`, `out of credits`, and existing explicit quota patterns. Generic 429/rate limits remain on the failed-turn path, not the five-hour usage path. Normal completed answers remain `not-resumable/unrecognized-final`. The plugin is pinned to `>=0.10.3 <0.12.0` and built against the exact 0.11.1 `@getpaseo/*` packages; the same fixture was rerun with that build on disposable 0.10.3 and 0.11.1 daemons: unarmed it logged `would-resume`, and armed (60-second test delay) it sent one continuation that completed.

Usage records originating from a failed outcome now carry `usageFailedOutcome`, allowing a due continuation from `error` status and its error attention marker. This is separate from generic `failedOutcome`: usage failures retain `baseDelaySeconds` (five hours by default), reset buffer, and `maxAttempts`, rather than uncapped transient retries. Completed usage records do not gain this error-status exception. Permissions, active turns, identity/model/thinking/session changes, opt-outs, and newer user messages still block sends.

Model tests cover Pi snapshots with high and medium reasoning, formatted quota errors, default five-hour timing, attempt caps, same-session verification, and resume gates. The daemon action fixture used a 60-second test delay; actual provider quota resets and live retry timing were not measured. A Pi failure that does not emit a recognized usage-limit signal may follow the generic failed-turn path instead. Keep existing host settings unchanged. If automatic resume is unavailable, send one explicit `continue` to the same Pi agent and verify its session/model/thinking; use an explicitly selected native Codex or Claude route if a new fallback session is needed. This package does not select or substitute models.
