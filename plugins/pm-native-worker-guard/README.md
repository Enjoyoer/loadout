# pm-native-worker-guard

Server-only Paseo plugin for Paseo >=0.10.3 <0.12.0, built against the exact 0.11.1
`@getpaseo/*` packages. It enforces one owner rule: **agents created by a PM run on the
Pi provider**. When a PM creates a native Codex or native Claude Code agent, the plugin
stops and archives that agent and tells the PM why. It is **dry-run by default**: it only
logs what it would do until `armed` is set in its settings.

## Limitation: the agent exists before it is stopped

Paseo 0.10.3 and 0.11.1 give `before("agent.create")` hooks only `{ config, env }`, with no parent
agent, so a before-create hook cannot tell a PM's worker from an agent the owner created.
The plugin therefore acts on `agent.created`, after Paseo has created the agent. By then
the agent exists and may have begun its first turn (the initial prompt), so it can run
briefly, call tools, or change files before it is stopped. Check what it did if that
matters. This is a guard rail for PMs that follow the rule, not a security boundary.

Other gaps, all in Paseo 0.10.3 and 0.11.1:

- Only agents with a parent are covered. Paseo sets the parent (the
  `paseo.parent-agent-id` label) for MCP `create_agent` children and for `paseo run`
  called from an agent. A legacy detached create, or an agent the PM starts some other
  way without its caller identity, has no parent and is left alone.
- The check runs once, at creation. Sending a message to an archived agent restores it in
  Paseo; the plugin does not re-archive a restored agent.
- A PM is recognized by its label. A PM without the label is not one to this plugin.

## What it checks

On every `agent.created` event:

1. The provider must be native: by default `codex` or `claude`, or a value starting with
   `codex/` or `claude/` (`nativeProviders`). Pi agents report `pi` and are ignored
   without any further call. The match ignores case.
2. The agent must have a parent (`parentAgentId`). Agents with no parent were not created
   by an agent and are left alone.
3. The owner allowlist in the settings file (`allowAgentIds`, `allowParentIds`) wins.
   Labels are never consulted for approval, so a PM cannot self-approve with labels it
   sets on the child.
4. The parent and child are read fresh through the hook's Paseo SDK, in parallel
   (`paseo.agents.ref(id).refresh()`). The parent must exist and carry the PM label
   (`role=pm` by default; `pmLabelKey`, `pmLabelValue`; the value ignores case and
   surrounding spaces). The child must exist, not be archived, still be native, and
   carry the same parent label.

Anything else is a `skip` with a reason, and the agent is left alone.

| Reason | Meaning |
|---|---|
| `no-parent` | Native agent with no parent (owner-created). |
| `allowlisted-agent` / `allowlisted-parent` | The owner pre-approved this child or this PM. |
| `parent-not-pm` | The parent does not carry the PM label. |
| `parent-not-found` / `child-not-found` | The daemon has no such agent. |
| `child-already-archived` | Someone archived it first. |
| `parent-label-mismatch` | The child's parent label does not match the event. |
| `child-not-native` | The child's fresh snapshot is not a native provider. |
| `sdk-error(parent): ...` / `sdk-error(child): ...` | An SDK read failed. Never act on uncertain data. |
| `state-unreadable` | The state file cannot be read; nothing acts until it is fixed. |
| `state-write-failed` | The decision could not be recorded before acting, so nothing was done. |

Pi agents produce no log line. Native agents produce one line each.

## What it does when armed

1. **Stop and archive**: `paseo.agents.ref(childId).archive()`, the SDK's
   `archive_agent_request`. The public 0.10.3 SDK has no separate cancel call. In the
   0.10.3 daemon, `archiveAgentCommand` cancels the agent's in-flight run first and waits
   for it to settle, then archives the agent and closes its session. The pending initial
   prompt, if not yet started, then fails to start. Archiving does not delete the
   workspace, worktree, or branch. Paseo also archives the child's own children.
2. **Notify the PM** with one short message:

   ```
   pm-native-worker-guard archived <child id> (<provider>): PM-created workers must use the Pi provider, e.g. provider pi/fleet/claude-opus-5-5 for code changes or pi/fleet/gpt-6.1-sol for browser work. Ask the owner if a native worker is really needed.
   ```

   The part after the colon is the `notice` setting. The parent's status is read first.
   Paseo has no queued send: a prompt to a mid-turn agent interrupts that turn. So:
   - an idle PM gets the message now, with `paseo.agents.ref(parentId).send(text)`, which
     resolves when the daemon accepts it, not when the PM's turn ends;
   - a mid-turn PM (status `running` or `initializing`, or an active turn) is not
     interrupted. The plugin appends a plugin timeline row on the PM
     (`paseo.agents.ref(parentId).timeline.append(...)`, kind `native-worker-archived`)
     and sends the message when that PM's `agent.turn_ended` arrives and it is idle.
     Several waiting notices for one PM go out as one message. This plugin is
     server-only and registers no renderer, so the app draws the row as Paseo's
     "Plugin timeline item unavailable" placeholder. Rows live in the daemon's memory
     and do not survive a daemon restart; the waiting notice does, in the state file;
   - if the PM's status cannot be read, the notice waits for its next turn end;
   - an archived or missing PM gets nothing (`notify-dropped`). A failed send is logged
     and not retried.

The plugin never deletes anything, never edits `~/.paseo/config.json`, and never acts
on the PM itself.

## Settings

Host-scoped plugin settings (`server.registerSettings`), stored by Paseo at
`<PASEO_HOME>/plugin-settings/pm-native-worker-guard/config.json` as
`{"version":1,"values":{...}}`. A missing file means all defaults, which is dry-run.
Unknown keys or wrong types make the settings invalid, and invalid settings do nothing
(`config-invalid` in the log). Settings are read on every event, so edits apply to the
next agent creation without a reload.

| Key | Default | Meaning |
|---|---|---|
| `armed` | `false` | `true` allows stopping, archiving, and notifying. Anything else is dry-run. |
| `allowAgentIds` | `[]` | Child agent ids the owner pre-approved (exact, full ids). |
| `allowParentIds` | `[]` | PM agent ids allowed to create native workers (exact, full ids). |
| `pmLabelKey` | `"role"` | Parent label key that marks a PM. |
| `pmLabelValue` | `"pm"` | Parent label value that marks a PM (case-insensitive). |
| `nativeProviders` | `["codex", "claude"]` | Provider ids treated as native; `<id>/...` also matches. |
| `notice` | the guidance above | Text sent after `pm-native-worker-guard archived <id> (<provider>): `. |
| `maxStateEntries` | `2000` | Bound on remembered per-child decisions (100 to 10000). |

The allowlist lets the owner permit a native worker without disarming. A child id is
usually known only once the agent exists, so `allowParentIds` is the practical way to let
one PM use native workers; remove the id afterwards. `allowAgentIds` covers creators that
choose the agent id up front and children already handled in dry-run.

## State and idempotency

Every decision past the provider and parent checks is recorded once per child id at
`$PASEO_HOME/plugin-state/pm-native-worker-guard/state.json` (written atomically, mode
0600, newest `maxStateEntries` kept). On Linux and macOS a write completes only after the
state directory is flushed, so it survives a host crash; on Windows the rename is not
flushed, and a host crash soon after a write can bring back the previous state. A repeated event for the same child, in the same
process or after a reload, does nothing and logs nothing. An SDK error is therefore
logged once and the child is never retried. A dry-run decision is not replayed when the
plugin is armed later. When armed, the decision is recorded before the archive call; if
that write fails, nothing is done. An unreadable or invalid state file stops all action
and is logged once per process.

## Logs

One stdout line per decision (`paseo plugin logs pm-native-worker-guard`):

```
[pm-native-worker-guard] {"action":"would-archive","childId":"...","parentId":"...","provider":"codex","reason":"pm-created-native-worker"}
```

| `action` | Meaning |
|---|---|
| `started` | Loaded; `mode` is `armed`, `dry-run`, or `config-invalid`, with the settings and state path. |
| `skip` | Left alone; `reason` from the table above. |
| `would-archive` | Dry-run: an armed plugin would have stopped and archived this child. |
| `archived` | Stopped and archived (`childStatus` is the status read just before). |
| `archive-failed` | The archive call failed; the PM is not notified. |
| `notify-sent` / `notify-deferred` / `notify-dropped` / `notify-failed` | Notice to the PM. |
| `timeline-row-failed` | The timeline row on a mid-turn PM could not be appended. |
| `state-unreadable` / `state-write-failed` / `config-invalid` / `config-unreadable` | Fail-safe conditions. |

## Daemon access and version bound

The plugin is purely event-driven and uses only the `PaseoApi` handed to its hooks, the
subprocess-wide plugin session. It opens no connection of its own. Timeline rows can only
be appended from a plugin session. Hooks start the work and return; the API outlives the
hook.

`paseo-plugin.json` pins `"paseo": ">=0.10.3 <0.12.0"` and `package.json` pins
`@getpaseo/client`, `@getpaseo/plugin`, and `@getpaseo/protocol` to exactly `0.11.1`. The
behavior above was read from the installed 0.10.3 plugin and client type declarations and
the 0.10.3 daemon source: the `agent.created` payload and where it is emitted, the parent
label, archive cancelling the run, `send` interrupting a busy agent, and plugin-only
timeline append. The 0.11.1 declarations and daemon source were re-checked: the hook
payload and parent label are unchanged, and `before("agent.create")` still receives no
parent agent, so the check stays on `agent.created`. 0.11 adds an `agent.closed` event,
which this plugin does not use. The same build was proven on disposable 0.10.3 and 0.11.1
daemons: unarmed it logged `would-archive` for a fixture PM's child, and armed it archived
the next child and sent the PM its notice.

## Develop and verify

```bash
npm ci
npm run check    # typecheck + unit tests (node:test, fake SDK) + esbuild bundle (to node_modules/.cache)
```

## Install and arm (after owner approval)

```bash
cd "<this folder>" && npm ci && npm run check
paseo plugin install "$PWD"                      # starts in dry-run
paseo plugin ls                                  # expect: pm-native-worker-guard running
paseo plugin logs pm-native-worker-guard         # review would-archive / skip lines
```

Arm only after reviewing dry-run output, by writing the plugin settings file (not
`~/.paseo/config.json`):

```bash
mkdir -p ~/.paseo/plugin-settings/pm-native-worker-guard
printf '%s\n' '{"version":1,"values":{"armed":true}}' > ~/.paseo/plugin-settings/pm-native-worker-guard/config.json
```

Allow one PM to create native workers while armed:

```json
{"version":1,"values":{"armed":true,"allowParentIds":["<full PM agent id>"]}}
```

Disarm by setting `armed` to `false` (applies to the next creation) or
`paseo plugin disable pm-native-worker-guard`.
