# Worker routing

## Resolve

An owner-named model, effort, or Fast wins and is never adjusted. An owner-named model or a burn route holds only for that task or burn. When it ends, launch new workers on the OPC default route. Pi has Fast on GPT routes: `--owner-fast on` records it, and the Worker builder sets the `opc.service-tier` label that the composer's Fast pill shows. On Pi, Fast is the agent label `opc.service-tier=fast`, not a catalog model or thinking level, so the model catalog never lists it; outside the builder set it with `labels:{"opc.service-tier":"fast"}` on `create_agent` or `update_agent`, or on the CLI with `paseo run --label opc.service-tier=fast` or `paseo agent update <id> --label opc.service-tier=fast`, and read it back with `get_agent_status`. A Pi GPT route with no label runs Standard (Fast is off by default fleet-wide); the builder still writes an explicit `opc.service-tier=standard` for a Fast-off GPT route. pi-fast-toggle applies the same label. Verify the label (`get_agent_status` or the Fast pill) before reporting a route. Never report Fast as unavailable on Pi, and never skip the builder with a raw `create_agent` for a Worker. Otherwise pick the task class below and resolve it with `resolveWorkerRoute` from `scripts/route.mjs`, or from a shell:

`node scripts/route.mjs --class <class> [--task TASK_JSON --lane SLUG]`

It prints one JSON object, `{route, reason}` (also `provider` for browser defaults). Add `--owner-model ID --owner-effort LEVEL [--owner-fast on|off]` for an owner-named route, `--pq-file FILE` to read a saved `pq --json` output, and `--catalog FILE` for saved Pi catalog rows (default: `paseo provider models pi --json`). With `--task` and `--lane` it records `{route, reason}` in the task's `routes` and returns an already recorded lane unchanged, so repairs and resumes keep their route; for a recorded lane it refuses `--class`, `--owner-model`, `--owner-effort`, or `--owner-fast` that would select another route, so resume it with no route flags or with the ones that selected it. A new route is checked against the class table once, when it is recorded; later reads check only its shape, so a later class change never strands a task. Pass `route` unchanged to `buildManagedWorkerRequest` and `reason` to `buildDelegatedBrief`. Give both builders the destination task as `task: readTask(taskPath)`, the lane (`buildDelegatedBrief` takes `lane` too; `buildManagedWorkerRequest` refuses a `taskId` other than the record's id), and the lane's class as `taskClass` (a UI task's lanes are `ui-design`, the default, or `ui-check`); pass the same `taskClass` when recording, and the Pi catalog rows as `catalog` to `buildDelegatedBrief` and `recordWorkerRoute` where you have them. With a task, an explicit `provider` is checked after the route and must be exactly the provider the validated route maps to, with its settings. Task records are bookkeeping, not routing authority: the source a route records grants nothing. Every route, recorded or fresh, keeps the owner's hard rules for its lane's class: `code` and its aliases never run a GPT or web model, `ui-design` and `ui-check` are exactly Fable high, Fast off (without a catalog the model id must name Fable), Fable never runs at another level in any lane, and no route runs below its class minimum. Inside them an owner-named route keeps its model and effort. A task default runs its class's own model: with a catalog exactly the class's row, without one a model id that names the class's label. A lane with a recorded route takes only that route, on the request, brief, and recording paths. It rebuilds (repair, restart) as long as it still fits; a task default must also be the class's catalog label with the class's Fast (a GPT class lane recorded with Fast on before Fast went off by default keeps it), at any effort from the class minimum up to its ceiling (code medium..xhigh, so a pre-7.30 Opus xhigh lane rebuilds), which the Pi catalog must still serve. A fresh lane's route is checked as new against today's table and its class. Kinds outside the table go to the owner.

## Classes

Labels resolve through the target Pi catalog; browser classes launch with native Codex catalog IDs (`gpt-6.1-sol`, `gpt-6-astra`). Routes are the minimum (owner rule): every range starts at the class default, so the pace can raise an adjustable class within its range (medium < high < xhigh) but never lower it, and no quota mode lowers any route. Fixed classes never move.

| Class | Use for | Default | Range | Fast |
|---|---|---|---|---|
| `code` | implementation, bounded edits, CI fixes, automation code, mechanical edits | Opus medium | medium..xhigh | off |
| `ui-design` | read-only, at most one per task: design spec and static mockup for a new screen, layout change, or new component | Fable high | fixed, owner rule | off |
| `ui-check` | read-only, optional, one pass: compare after-screenshots to the mockup, return a fix list | Fable high | fixed, owner rule | off |
| `plan` | read-only root cause, specs, implementation plans, research, scouting | Sol xhigh | fixed | off |
| `review` | read-only simplifier review | Sol xhigh | fixed | off |
| `review-security` | read-only correctness review of a security-sensitive diff: one touching auth, secrets or credentials, permissions or sandboxing, firewall or network exposure, backups, or deletion and archive paths | Opus xhigh | fixed, owner rule | off |
| `browser` | routine website navigation, data entry, repetitive and high-volume browser automation, ordinary computer use | native Codex Sol medium | medium..high | off |
| `browser-hard` | complex desktop application workflows; fragile, ambiguous or repeatedly failing browser workflows | native Codex Astra medium | medium..high | off |
| `smoke` | smokes, canaries | Luna low | fixed | off |
| `watcher` | watchers, heartbeats | Luna xhigh | fixed | off |

Owner 2026-10-14 grants standing native Codex authorization only to `browser` and `browser-hard`, without per-task `nativeAuthorization`; other classes stay on Pi unless explicitly authorized per task.

Browser Worker briefs must say: "Use the Paseo MCP server's browser_* tools (discover them if deferred), not cua_repl or native Chrome computer control. Before pressing Enter or clicking Send or Submit in any web form or chat composer, take a fresh browser_snapshot and check the field holds exactly the text you typed; if it holds anything else, clear it, report it, and do not send. Prefer clicking the Send button over pressing Enter." Reason: the Paseo browser tab lives inside the owner's desktop app, and an agent's click can move keyboard focus into the page, so the owner's typing lands in the field.

The PM picks `browser-hard` and records why for complex desktop application workflows or browser work that is fragile, ambiguous or failing repeatedly on `browser`; raise to high for difficult multi-app work or troubleshooting using `node scripts/route.mjs --class browser-hard --owner-model <Astra catalog id> --owner-effort high` (the resolver has no class-effort override, so this records the owner-authorized high route).

Aliases: `code-bounded`, `test-fix`, `automation`, `mechanical` resolve to `code`; `research` to `plan`; `review-critical`, `review-general` to `review`; `security` to `review-security`; `ui` (compatibility) to `ui-design`, with new routes and reasons naming the canonical class.

Local code lanes default to Opus medium, and `ui-design` and `ui-check` stay Fable high everywhere. Code, `review-security` and their aliases never run on a GPT model, and an owner-named GPT or web route for them is refused. Planning and investigation use the read-only `plan` Worker class on Sol xhigh; Opus implements the returned plan. The `scout` fixed role uses Sol xhigh. Every class and fixed role runs Fast off by default (owner 2026-11-07: Fast costs far more than the time it saves). Fast is an owner-named exception for one task, such as the owner's 3D work on Astra: record it with `--owner-fast on`. PMs stay on Opus and delegate all browser, computer-use, research and scouting work to these GPT lanes, never doing it themselves on Opus; UI design goes to `ui-design` under the UI rule below. Default review uses `review` as a read-only Pi lane on the exact PR head, with [Simplifier remit](simplifier-review.md "runtime") as its brief. Pick `review-security` instead for a diff touching auth, secrets or credentials, permissions or sandboxing, firewall or network exposure, backups, or deletion and archive paths (owner rule: GPT trips the provider's cyber-safety filter on that work); its brief asks for a correctness review, and the builder prefixes that wording. Fast means Pi's Fast toggle on Pi GPT routes; native Codex browser lanes set `settings.features.fast_mode` from the route (false unless the owner named Fast) and an explicit unattended `settings.modeId`. A lane recorded with Fast on before this default changed keeps Fast on through repairs and resumes.

## Web reviewer

The `reviewer` fixed role is separate: it is the one ChatGPT web lane (Web Pro) only for browser review explicitly enabled by the owner, not a Worker class, and the class table does not change it.

## Fable

Fable fits only the PM's planning and orchestration, deep-audit reviews, and the `ui-design` and `ui-check` lanes below. Implementers and routine reviewers use Opus or Sol, and no lane inherits Fable from its PM. At most 2 Fable agents run at once across the fleet; before starting one, count the running Fable agents on every host.

## UI work

Fable designs and checks; Opus builds. Fable is only for real visual design: a new screen, a layout change, or a new component. Copy, labels, states, error text, renames, and guards with no layout change are `code` only, with no Fable lane.

1. `ui-design` (Fable high, Fast off, read-only) takes the current screens, as screenshots and code, and returns a short design spec plus a static mockup (HTML/CSS or images) at a scratch path the PM names. It makes no repository edits and opens no PR. At most one per task; a second needs the owner's OK.
2. A normal `code` lane (Opus medium) builds: it implements the spec and mockup exactly, plus the logic, and opens the PR with [before and after screenshots](pr-evidence.md "branch:evidence").
3. `ui-check` (Fable high, Fast off, read-only) is optional and runs one pass: it compares the after-screenshots to the mockup and returns a fix list. The code lane applies the fixes.

The Fable lanes run in a UI task, created with `createTask({..., ui: true})`; pass `ui: true` to `selectTopology`. Its lanes take only `ui-design` (the default when no `taskClass` is given) or `ui-check`, and the build runs in a separate normal `code` task. Both classes resolve to owner-explicit routes with reasons `ui-design: owner rule, Fable high, no GPT, read-only` `ui-check: owner rule, Fable high, no GPT, read-only`; the pace never touches them, and `buildDelegatedBrief` marks them read-only. UI work never uses a GPT or web model: no Sol, Luna, or Astra Worker, no Sol scouts, and no web reviewer in `ui-design` or `ui-check`. The UI task refuses browser review, `recordWorkerRoute` and the Worker builders given the task refuse any other class and anything but Fable high, Fast off, with a Fable model id, and the topology runs no scouts. An owner-named route still wins inside these rules; one for `ui-design` or `ui-check` other than Fable high, Fast off is refused, so ask the owner to use the class instead. The old `ui` class name is an alias of `ui-design`.

## Pace

The pace reads Paceline's `pq --json` (schemaVersion 1) for the class's pool: Claude routes (Opus, Fable) read the claude accounts, GPT routes (Sol, Luna, Astra) the codex accounts.

- Weekly gap is the pool's `pools[].pace.gapPct`: positive means behind (quota going unused), negative means ahead.
- 5-hour use is the mean `five_hour` `usedPct` over the pool's fresh accounts. When no fresh pool account reports a `five_hour` window at all (weekly-only plans), the 5-hour window is unconstrained: step 2 is skipped and the reason says "no 5h window".
- Reset-soon means a fresh pool account's `seven_day` window resets within `resetSoonHours` with more than `resetSoonLeftPct` left.

Steps:

1. Weekly: a gap at or above `behindPoints`, or reset-soon, gives +1. A gap at or below minus `aheadPoints` gives -1, and wins when both apply.
2. 5-hour: use at or above `fiveHourDownPct` gives -1 whatever weekly said. Otherwise use at or above `fiveHourNoUpPct` turns +1 into 0.
3. Apply the step to the class default and clamp it to the class range.

There is no adjustment, and the reason says why, when:

- pq is missing, errors, times out, prints unparseable output, or has another schemaVersion;
- `snapshotStale` is true;
- the pool is missing, counts no accounts, or has no pace;
- more than half the pool's accounts are stale;
- the pool reports a `five_hour` window but none of it is fresh.

Some stale accounts still adjust, and the reason shows "N of M stale".

## Settings

The optional owner file `~/.config/opc/routing.json` tunes `behindPoints` (default 10), `aheadPoints` (10), `resetSoonHours` (24), `resetSoonLeftPct` (15), `fiveHourNoUpPct` (75), `fiveHourDownPct` (90), and `pq`. `pq` is an argv array, default `["~/.local/bin/pq", "--json"]`; a leading `~` in its first element is expanded. A host without pq can name another host, for example `["ssh", "<alias>", "~/.local/bin/pq", "--json"]`. pq runs without a shell and has 15 seconds to answer. A file with unknown keys or bad values is ignored: the defaults apply and the reason names the error, for example `routing.json invalid (unknown key x), defaults used`. A `codexFallback` key left by OPC 7.30 is accepted and ignored. Fixed classes, `ui-design`, and `ui-check` never read this file or the quota.

## Errors

Network and proxy errors, such as `Connection error` or a 502 `backend unavailable`, are retried on the same route by sending the same Worker a continue follow-up. They never change the model or effort. Rate limits, unavailable capabilities, and real launch failures still stop the lane; substitution requires a new explicit owner decision.
