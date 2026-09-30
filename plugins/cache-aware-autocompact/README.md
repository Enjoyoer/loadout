# cache-aware-autocompact

Server-only Paseo 0.9.2 plugin. It starts one timer per completed Claude or Codex turn and, after a configurable cache-preserving delay, evaluates the latest idle snapshot. The default is **dry-run**: it logs `would-compact` decisions and never sends anything. Only `config.armed=true` permits a `/compact` send.

## Design

- Claude default delay: 50 minutes, based on the documented 1-hour subscription TTL with a 10-minute margin.
- Codex default delay: 22 minutes, based on the documented 30-minute cache lifetime with an 8-minute margin.
- The only boundary check is a running tool call. Open todos, a missing final answer, and open-ended or coordination wording never block compaction; the summary preserves open questions. `softThreshold` (300,000 tokens) now only labels the decision `safe-boundary-recall` in logs. `thresholdTokens` remains the minimum context usage for any compaction.
- Timers are canceled on `agent.turn_started`, an agent update showing a running/active turn, archive, cleanup, or a changed `lastUserMessageAt` at evaluation time.
- Guards fail closed: provider is exactly `claude` or `codex`; agent is idle with no active turn; no pending permissions; `attentionReason` `finished` or null is allowed, while `permission`, `error`, and unknown values block; context usage is at least 100,000 tokens by default via configurable `thresholdTokens`; label `autocompact=off` is absent; no tool call is still running. Failed or canceled tool calls never block compaction.
- A `running-tool` or `not-idle` evaluation skip is retried after two minutes, up to three retries, so a busy agent can compact after it settles.
- The safe-boundary classifier is deterministic and local. No transcript is sent to a classifier service.
- On startup, the plugin enumerates all agent directory pages and re-arms eligible idle agents. It repeats recovery on the first hook subscription and on connection snapshots, including reconnects. An existing timer is kept, so repeated snapshots do not postpone it.
- Recovery uses `max(0, configured delay - elapsed idle time)`. Timers already due use independent random jitter between **2 and 7 seconds**, defined by `REARM_JITTER_MIN_MS` and `REARM_JITTER_MAX_MS` in `server/recovery.ts`. Agents idle past the reference cache TTL (60 minutes for Claude subscriptions, 30 minutes for Codex) are evaluated with jitter even when a longer configured delay remains. Every recovered timer uses the normal evaluator and guards.
- Each observed turn end now persists its original checkpoint key, running-tool guard state, last user message timestamp, and exact end time. Full transcripts are not retained in this turn metadata. For turns completed before this version, Paseo 0.9.2 has no `lastTurnEndedAt` snapshot field: recovery uses the finished-attention timestamp, or the last persisted timeline timestamp if attention was cleared. The latter can precede the actual turn end. Empty history without stored turn metadata, or unavailable history, is skipped with a reason.
- Durable state is stored at `$PASEO_HOME/plugin-state/cache-aware-autocompact/state.json`. Checkpoint keys include agent and turn identity, so duplicate lifecycle delivery cannot send twice. Terminal decisions, including dry-run and failed sends, are not re-armed. Retry decisions retain the bounded retry count across restarts. State read errors fail closed. A `compact-requested` checkpoint is written before sending, so a restart cannot resend a reserved turn even if send acknowledgement was lost. A crash after reservation but before delivery can leave that turn unsent; recovery deliberately treats the reservation as handled.
- The action is `agent.send("/compact")` to the one freshly refreshed idle agent. Paseo 0.9.2 resolves this to Claude's root slash command or Codex's manual compaction path.

The safe-boundary ideas are informed by [kunchenguid/compact-adviser](https://github.com/kunchenguid/compact-adviser), which is MIT licensed: classify a finished unit and avoid open-ended coordination. This plugin uses a local rules implementation and does not copy its code or send data to its service.

## Restart logs

The plugin opens a persistent SDK connection at startup because Paseo 0.9.2 supplies the hook SDK only after a lifecycle event. It uses `PASEO_HOST`, then the local daemon listen address in `paseo.pid`, then the standard local CLI address. Cleanup aborts subscriptions, closes that connection, and cancels timers.

Each recovered timer emits one JSON log line with `action: "re-armed"`, `agentId`, `provider`, `idleSince` (UTC timestamp), `remainingMs` (delay before jitter), `delayMs` (scheduled delay), and `jitterApplied`.

Each completed recovery pass emits `action: "rearm-summary"` with `trigger`, `rearmed`, `skippedCount`, and `skipped` counts grouped by reason. Reasons include `not-idle`, `unsupported-provider`, `opted-out-label`, `archived`, `checkpointed`, `already-pending`, `no-ended-turn`, `timeline-unavailable`, `changed-during-recovery`, and `recovery-failed`. Connection or recovery failures emit `startup-rearm-failed`, `subscription-failed`, or `rearm-failed` with a reason. Re-armed timers still emit the existing evaluation, retry, and cancellation logs.

## Research sources

- Paseo 0.9.2 Claude provider: [`CLAUDE_ROOT_ONLY_COMMANDS` includes `compact`](https://github.com/getpaseo/paseo/blob/v0.9.2/packages/server/src/server/agent/providers/claude/agent.ts#L363-L374), and [`resolveSlashCommandInvocation`](https://github.com/getpaseo/paseo/blob/v0.9.2/packages/server/src/server/agent/providers/claude/agent.ts#L2799-L2810) recognizes `/compact`.
- Paseo 0.9.2 Codex provider: [`tryHandleOutOfBand("/compact")`](https://github.com/getpaseo/paseo/blob/v0.9.2/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L4975-L4995) calls [`thread/compact/start`](https://github.com/getpaseo/paseo/blob/v0.9.2/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L5012-L5037). The provider parses the [`thread/compacted` notification](https://github.com/getpaseo/paseo/blob/v0.9.2/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L2685-L2698) and correlates manual completion with `pendingManualCompactionStarts`.
- Paseo 0.9.2 lifecycle contract: [`agent.turn_started`, `agent.turn_ended`, and permission hooks](https://github.com/getpaseo/paseo/blob/v0.9.2/packages/plugin/src/server/lifecycle.ts#L47-L65).
- Claude Code costs: [prompt cache statistics and cache lifetime](https://code.claude.com/docs/en/costs). The current docs say the lifetime is **one hour on a subscription**, **five minutes when using usage credits**, and **five minutes by default on an API key or cloud provider**. The [Anthropic prompt caching API docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#ttl-support) document 5-minute default and optional 1-hour API TTL.
- Codex/OpenAI: [Prompt caching, cache lifetime](https://developers.openai.com/api/docs/guides/prompt-caching#cache-lifetime) documents a **30-minute** default minimum lifetime for current GPT-5.6-and-later models. CLIProxyAPI's [README](https://github.com/router-for-me/CLIProxyAPI) describes protocol-compatible routing but does not specify a separate cache TTL; the upstream Claude/OpenAI account and request options therefore govern TTL.
- Reference classifier: [compact-adviser README](https://github.com/kunchenguid/compact-adviser#how-it-works) and [MIT license](https://github.com/kunchenguid/compact-adviser/blob/main/LICENSE).

## Verify and install later

This work intentionally does not install, reload, enable, disable, arm, or restart anything.

```bash
cd plugins/cache-aware-autocompact
npm ci
npm run check
```

When the owner chooses to install in dry-run mode, use `paseo plugin install "$PWD"` and review `paseo plugin logs cache-aware-autocompact`. Leave the settings file absent or set:

```json
{"version":1,"values":{"armed":false}}
```

The plugin starts disarmed even when the settings file is absent. Do not write `armed: true` unless the owner separately approves arming.
