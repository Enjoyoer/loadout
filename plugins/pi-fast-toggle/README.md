# Pi Fast toggle

A per-agent composer pill for **Paseo >=0.10.3 <0.12.0**. It requests Fast for one Pi agent, not every agent or every model. It never changes the model, thinking setting, picker labels, daemon defaults, or another agent's labels.

## Behavior

- Eligible agents have provider `pi`, an active workspace, and a configured `openai-responses` model whose exact router catalog row advertises `service_tiers[].id = "priority"`. Web routes, Anthropic routes, native providers, missing models, and unavailable catalogs have no pill.
- The pill shows **Fast: Off** for an absent/empty `opc.service-tier` label or `standard`, `default`, or `inherit`; **Fast: On** for `fast`/`priority`; and **Fast: Ultrafast** for `ultrafast`. This is requested label state, not a promise about latency or the tier served upstream.
- Pressing Off writes `opc.service-tier=fast`. Pressing On (including Ultrafast) writes `opc.service-tier=standard`. Each press refreshes the agent and capability, writes only that label through Paseo's supported `update_agent` MCP tool, and verifies readback. Unrelated labels remain intact.
- Changes affect the **next Pi turn**. An already-started turn retains its routing decision. No Pi reload or agent restart is needed for label changes: `fleet-routing.mjs` reads labels in `before_agent_start`.
- Installation and opening the composer do not write agent labels. An absent label counts as Standard/Off **in the control**. The existing extension still resolves absent labels as `inherit` (or honors an explicit legacy `opc.fast-requested` label), so the router's inherited default must be Standard for an unlabeled turn to be served Standard. Pressing the toggle off writes an explicit Standard request and overrides both inheritance and the legacy label. This plugin intentionally does not rewrite fleet defaults or legacy routing behavior.
- Capability lookup uses the same `/models?client_version=0.160.0` endpoint, exact `slug ?? id` match, and `priority` catalog ID as the extension. Display discovery caches catalogs for ten minutes, including concurrent lookups; a press fetches a fresh catalog. Catalog errors hide the pill and block writes.
- The directory subscription handles existing agents, pagination, live label/model changes, reconnect snapshots, removals, and late async results after cleanup. The button uses Paseo's native icon, label, accessible title, pending state, and error toast on desktop and compact/mobile layouts.

There is no Command Center item: agent items in 0.10.3 and 0.11.1 have no per-model visibility predicate. An unconditional item would expose Fast for non-capable models, contrary to this plugin's scope.

## Configure and install, only on an authorized host

Plugins are trusted, unsandboxed code. This plugin reads the existing Pi runtime catalog and runs that runtime's credential helper to authenticate router catalog reads. It does not modify credentials or account settings. Do not point it at an untrusted runtime directory.

The host setting `runtimeRoot` is the directory containing the existing Loadout Pi `runtime.json`, `credential.py`, and `agent/models.json`. Those files remain private. No real runtime path or credential belongs in this public package. With no setting, the plugin remains hidden and cannot change labels.

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

4. Require `pi-fast-toggle` to be `running` in `paseo --host <daemon-endpoint> plugin ls`, with no load error in `plugin logs pi-fast-toggle`. Open a disposable Pi agent on a tier-capable catalog model. Verify the initial Off state, toggle On, and verify `opc.service-tier=fast`. Run one turn and inspect its private `route-evidence.jsonl` request for `tierSource=opc.service-tier`, `tierIntent=fast`, and `service_tier=priority`. Toggle Off and repeat for `standard`/`default` in the **same session and model**.
5. Verify an Anthropic/Web Pi model and a native provider have no pill. Verify desktop and compact/mobile appearance on the intended app. This package's action fixture exercises the actual client registration and callbacks against a disposable daemon, but it is not a rendered app screenshot test.

The runtime's `paseoMcp.url` must be a loopback endpoint for the **same daemon** as the plugin, and the plugin checks this before every write: the URL must be `http` on `127.0.0.1`, `[::1]`, or `localhost` (sent to `127.0.0.1`), with the host and port of the daemon the plugin resolves: a valid `PASEO_HOST`, else the listen address in `<PASEO_HOME>/paseo.pid`, else `127.0.0.1:6767` for the default home only. A mismatch or an unresolvable daemon fails before any request, and a redirect is refused rather than followed. No fallback daemon or external MCP destination is used. Failed capability, model recheck, update, or readback surfaces an error instead of claiming success. Paseo exposes no atomic expected-model/expected-label precondition for this update; selection is rechecked immediately before the label-only write, but a concurrent external model edit can still race it.

## Rollback

```bash
paseo --host <daemon-endpoint> plugin disable pi-fast-toggle
```

Disabling/removing the plugin removes the UI and pending registrations, but deliberately **does not erase agent labels**. If a disposable or explicitly authorized agent must return to Standard, first record its original label and then run:

```bash
paseo --host <daemon-endpoint> agent update <agent-id> --label opc.service-tier=standard
```

Restore an originally explicit tier verbatim instead when appropriate. For an originally absent label, Paseo's supported update cannot delete a key: `--label opc.service-tier=` restores the extension's inheritance/legacy fallback. Do not apply either command to unrelated or active business agents without separate authorization. Restore the settings backup if this installation changed existing settings, then optionally `plugin remove pi-fast-toggle`; directory sources are retained. No daemon/agent restart is part of installation or rollback.

## Verify

```bash
npm ci
npm run check
# Repository root:
python3 -m unittest discover -s tests
```

Unit tests cover label state, exact catalog capability, client action/cleanup/races/pagination, backend label-only writes/readback, the same-daemon and no-redirect write destination, and fail-closed gates. An isolated Paseo 0.10.3 daemon with the real Pi 1.0.0 CLI and a local fixture Responses router additionally verified the actual pill callback, preserved unrelated labels/session/model, and next-turn `priority` then `default` route evidence without a reload. Fixture responses are not evidence that a real upstream account will honor priority. The 0.11.1 build was later rerun on disposable 0.10.3 and 0.11.1 daemons with a credential-free Pi fixture and a loopback catalog: unconfigured it reported not capable and wrote nothing; configured, the real client callbacks wrote `fast` then `standard` through `update_agent` and kept the other labels and model. No live installation, settings edit, reload, or restart was performed.
