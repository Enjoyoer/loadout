# Pi Fast toggle

Per-agent composer controls for **Paseo >=0.11.1 <0.14.0**. Fast requests a service tier for eligible Pi agents. Effort offers the selected model's advertised thinking levels for any provider. Neither changes models, global provider defaults, prompts, or other agents. Fast never changes thinking; Effort never changes labels.

## Keyboard shortcuts: desktop and web only

**Before using the Fast shortcut, clear or rebind Toggle focus mode in Settings > Keyboard shortcuts.** Paseo 0.11.1 binds that action to the same keys and its earlier window-capture listener wins. This plugin does not change settings or override that router. Click **Fast** when the prerequisite is not met.

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Toggle Fast for the focused composer | Ctrl+Shift+F | Cmd+Shift+F |
| Open the plugin-owned Thinking level menu | Ctrl+Shift+M | Cmd+Shift+M |

Use exactly these modifiers, without Alt or an additional Ctrl/Cmd. Focus the composer input or its Effort pill first. A visible agent, transcript, body, or last-used pane is not a keyboard target. Hidden tabs, terminals, editors, unrelated fields, menus and dialogs do not qualify. Plain Ctrl/Cmd+F is unchanged. Repeated owned presses do not start another action.

The new shortcuts and Effort UI are desktop/browser only; the existing mobile Fast pill is unchanged. Browser chrome or DevTools can consume shortcuts before the page sees them, including Chromium profile switching and Firefox responsive design mode on Ctrl+Shift+M. Custom Paseo bindings may also conflict. Clickable pills remain the fallback.

## Thinking level

- Effort is a stable pill for each non-archived workspace agent, including providers without Fast. The menu opens immediately with **Loading effort...**, then uses that agent's provider catalog and working directory on the same host. It is not Paseo's built-in effort picker.
- Model IDs match exactly, or by a unique advertised alias. An unset model uses only a unique explicit catalog default. Missing/ambiguous models or empty options show an unavailable state without writing anything. Option IDs, labels and ordering come from the catalog, not a fixed low/medium/high list.
- A check marks the requested level. With no requested level, the effective level or explicit catalog default is marked **default**. Unknown current levels get no invented checkmark. A different effective level is shown separately. One-option catalogs remain visible.
- Up/Down wrap, Home/End jump and Enter applies the highlighted row. Selecting an already requested level closes without a write. During **Applying...**, options cannot write again. Escape dismisses without interrupting the agent, including while a write is pending; dismissal cannot cancel an already sent write.
- Writes use only `update_agent` with `settings.thinkingOptionId`. The server refreshes the agent, validates its provider/model and catalog membership, rechecks after catalog work, then verifies requested-state readback. This is not atomic compare-and-set: external model changes can race, and changed/unconfirmed outcomes are reported, not silently retried. Changes apply to subsequent turns, not retroactively to an in-progress turn.
- Failures retain the previous check and offer **Refresh / retry**. An uncertain write must be inspected before another selection is enabled. Errors are sanitized; daemon addresses, paths and backend bodies are not shown.
- Effort derives its MCP endpoint independently from the plugin daemon's recorded listen address. It does not require a Pi runtime. Missing metadata, non-loopback endpoints, redirects and timeouts fail closed. If MCP is disabled or requires authorization, use the built-in thinking picker and ask the operator to check MCP availability. The plugin has no HTTP authorization capability through its borrowed SDK and never disables daemon authentication.

### Verified 0.11.1 limits

The installed `@getpaseo/plugin` client contracts expose neither keybindings, focused-pane lookup, an imperative popover opener, nor shell layout/focus overrides. The web bundle confirms `workspace-pane-*`, `message-input-root` and `data-composer-input`: the adapter derives one pressable from its own icon, finds the smallest shared ancestor with one visible composer inside that pane, and requires both keyboard target and active element to belong to it. Missing or ambiguous DOM evidence disables keyboard actions, not composer editing or clickable controls.

The supported shell imposes these deviations from the intended menu design:

- The plugin body is 232 px wide with 8 px padding, 32 px rows and a six-row scroll area. The host adds its own padding, a 280 px minimum shell width and a 12 px composer anchor gap, rather than a 232 px shell and 6 px gap. Placement, viewport clamping and compact browser sheets remain host-owned. No private styles or stores are patched.
- The host consumes Escape and traps boundary Tab before plugin listeners. Escape safely closes the host overlay. **Tab retains the host's menu focus behavior instead of dismissing into composer tab navigation**; use Escape to return. The plugin restores a captured composer selection after keyboard selection/Escape only while the original input and pane remain valid. Outside pointer dismissal disables plugin restoration; the shell's own focus behavior remains host-owned.
- The host shares a pill's open state across all mounts of the same host/workspace/agent registration. **M fails closed for duplicate visible panes of the same agent**, and ambiguous clickable menus disable choices. Close the duplicate pane before using Effort. F still resolves exactly one focused instance and serializes on the shared host/agent action.

These markers and overlay behaviors are implementation details, not public focus contracts. The native shell, authentication and duplicate-pane constraints are intentionally not bypassed.

## Behavior

- Eligible agents have provider `pi`, an active workspace, and a configured `openai-responses` model whose exact router catalog row advertises `service_tiers[].id = "priority"`. Web routes, Anthropic routes, native providers, missing models, and unavailable catalogs have no pill.
- The pill shows what `fleet-routing.mjs` requests on these routes: **Fast: On** for `fast`/`priority`, for `inherit`, and for no choice (an absent or empty `opc.service-tier` label without a legacy `opc.fast-requested=false`), since Fast is the fleet default there; **Fast: Off** for `standard`/`default` (or a legacy `opc.fast-requested=false` with no tier label); and **Fast: Ultrafast** for `ultrafast`. This is requested label state, not a promise about latency or the tier served upstream.
- Pressing Off writes `opc.service-tier=fast`. Pressing On (including Ultrafast) writes `opc.service-tier=standard`. Each press refreshes the agent and capability, writes only that label through Paseo's supported `update_agent` MCP tool, and verifies readback. Unrelated labels remain intact.
- Changes affect the **next Pi turn**. An already-started turn retains its routing decision. No Pi reload or agent restart is needed for label changes: `fleet-routing.mjs` reads labels in `before_agent_start`.
- Installation and opening the composer do not write agent labels. An unlabeled agent shows Fast: On, matching the request the extension sends. Turning Fast on writes an explicit `fast` rather than removing the label: Paseo's `update_agent` cannot delete a label, an explicit value is confirmed by readback, and it keeps Fast if the fleet default changes. Turning Fast off writes `standard`, which overrides both the default and a legacy label. This plugin does not rewrite fleet defaults or legacy routing behavior.
- Capability lookup uses the same `/models?client_version=0.160.0` endpoint, exact `slug ?? id` match, and `priority` catalog ID as the extension. Display discovery caches catalogs for ten minutes, including concurrent lookups; a press fetches a fresh catalog. Catalog errors hide the pill and block writes.
- The directory subscription handles existing agents, pagination, live label/model changes, reconnect snapshots, removals, and late async results after cleanup. The button uses Paseo's native icon, label, accessible title, pending state, and error toast on desktop and compact/mobile layouts.

There is no Command Center item: agent items in 0.10.3 and 0.11.1 have no per-model visibility predicate. An unconditional item would expose Fast for non-capable models, contrary to this plugin's scope.

## Configure and install, only on an authorized host

Plugins are trusted, unsandboxed code. This plugin reads the existing Pi runtime catalog and runs that runtime's credential helper to authenticate router catalog reads. It does not modify credentials or account settings. Do not point it at an untrusted runtime directory.

The host setting `runtimeRoot` is the directory containing the existing Loadout Pi `runtime.json`, `credential.py`, and `agent/models.json`. Those files remain private. No real runtime path or credential belongs in this public package. With no setting, Fast remains hidden and cannot change labels. Effort does not use this setting.

1. Confirm the selected daemon and app are inside the pinned range and `pluginsEnabled` is already true. If not, obtain permission to enable trusted plugins first. Do not restart a daemon.
2. Prepare a source directory on that host:

   ```bash
   cd <plugin-directory>
   npm ci
   npm run check
   paseo --host <daemon-endpoint> plugin install "$PWD"
   ```

3. Set `<PASEO_HOME>/plugin-settings/pi-fast-toggle/routing.json` to:

   ```json
   {"version":1,"values":{"runtimeRoot":"<existing-pi-runtime-root>"}}
   ```

   Preserve an existing settings file before editing it. Settings are read per inspection/press. A newly configured runtime may need one agent update or composer/client reconnect to discover the pill; changing an existing agent's label takes effect at its next turn without a reload.

4. Require `pi-fast-toggle` to be `running` in `paseo --host <daemon-endpoint> plugin ls`, with no load error in `plugin logs pi-fast-toggle`. Open a disposable Pi agent on a tier-capable catalog model. Verify the initial On state with no label; one turn's private `route-evidence.jsonl` request shows `tierSource=fleet-default`, `tierStatus=fleet-default-fast`, and `service_tier=priority`. Toggle Off, verify `opc.service-tier=standard`, and check the next turn for `tierSource=opc.service-tier`, `tierIntent=standard`, and `service_tier=default`. Toggle On and repeat for `fast`/`priority` in the **same session and model**.
5. Verify an Anthropic/Web Pi model and a native provider have no Fast pill. Verify desktop and compact/mobile appearance on the intended app. This package's action fixture exercises the actual client registration and callbacks against a disposable daemon, but it is not a rendered app screenshot test.

The runtime's `paseoMcp.url` must be a loopback endpoint for the **same daemon** as the plugin, and the plugin checks this before every write: the URL must be `http` on `127.0.0.1`, `[::1]`, or `localhost` (sent to `127.0.0.1`), with the host and port that the daemon's own `<PASEO_HOME>/paseo.pid` records for the plugin's home. `PASEO_HOST` and the default address do not count: if that file is missing, unreadable, or has no valid listen address, the toggle writes nothing and reports the error. A mismatch fails before any request, and a redirect is refused rather than followed. No fallback daemon or external MCP destination is used. Failed capability, model recheck, update, or readback surfaces an error instead of claiming success. Paseo exposes no atomic expected-model/expected-label precondition for this update; selection is rechecked immediately before the label-only write, but a concurrent external model edit can still race it.

## Rollback

```bash
paseo --host <daemon-endpoint> plugin disable pi-fast-toggle
```

Disabling/removing the plugin removes the UI, keyboard listeners and pending registrations, but deliberately **does not erase agent labels or requested thinking levels**. If a disposable or explicitly authorized agent must return to Standard, first record its original label and then run:

```bash
paseo --host <daemon-endpoint> agent update <agent-id> --label opc.service-tier=standard
```

Restore an originally explicit tier verbatim instead when appropriate. For an originally absent label, Paseo's supported update cannot delete a key: `--label opc.service-tier=` restores the extension's inheritance/legacy fallback. Do not apply either command to unrelated or active business agents without separate authorization. Restore the settings backup if this installation changed existing settings, then optionally `plugin remove pi-fast-toggle`; directory sources are retained. No daemon/agent restart is part of installation or rollback.

## Post-deploy acceptance (operator only)

This change was not installed or reloaded on a host during implementation, and no user settings were edited. Installed 0.11.1 types and the shipped web bundle were inspected; rendered desktop/browser acceptance remains a deployment gate.

1. Demonstrate the default Focus mode conflict, then manually clear/rebind it. Verify F toggles exactly once, leaves layout unchanged, retains Ultrafast semantics, and does not affect plain Find. Test Mac and Windows/Linux modifiers.
2. Use two distinct agents in split panes, hidden tabs, duplicate-agent panes and two hosts. Verify only the focused composer changes; unrelated fields, transcript/body, terminals, editors and dialogs remain untouched. Verify duplicate-agent Effort fails closed.
3. Verify menu current/default/effective markers, one option, empty options, catalog failure and retry; arrows, Home/End, Enter, Escape, native Tab trapping, outside click and caret restoration. Confirm backend `thinkingOptionId` and the built-in picker agree.
4. Check light/dark themes, narrow/wide windows, browser interception, clickable fallbacks and mobile no-op. Check the host-owned shell width/gap and compact sheet behavior.
5. Exercise model/provider changes, archive, disconnect/reconnect, plugin reload, MCP disabled/auth rejection, slow writes and repeated presses. Confirm no extra listeners, stale updates, changes to labels/defaults or other agents, and no retroactive claim for an active turn.

## Verify

```bash
npm ci
npm run check
# Repository root:
python3 -m unittest discover -s tests
```

Unit tests cover label state, exact catalog capability, client action/cleanup/races/pagination, backend label-only writes/readback, the same-daemon and no-redirect write destination, and fail-closed gates. An isolated Paseo 0.10.3 daemon with the real Pi 1.0.0 CLI and a local fixture Responses router additionally verified the actual pill callback, preserved unrelated labels/session/model, and next-turn `priority` then `default` route evidence without a reload. Fixture responses are not evidence that a real upstream account will honor priority. The 0.11.1 build was later rerun on disposable 0.10.3 and 0.11.1 daemons with a credential-free Pi fixture and a loopback catalog: unconfigured it reported not capable and wrote nothing; configured, the real client callbacks wrote `fast` then `standard` through `update_agent` and kept the other labels and model. No live installation, settings edit, reload, or restart was performed.
