# Worker routing

## Resolve

An owner-named model, effort, or Fast wins and is never adjusted. Otherwise pick the task class below and resolve it with `resolveWorkerRoute` from `scripts/route.mjs`, or from a shell:

`node scripts/route.mjs --class <class> [--cloud-facts FILE] [--task TASK_JSON --lane SLUG]`

It prints one JSON object, `{route, reason}`. Add `--owner-model ID --owner-effort LEVEL [--owner-fast on|off]` for an owner-named route, `--pq-file FILE` to read a saved `pq --json` output, and `--catalog FILE` for saved Pi catalog rows (default: `paseo provider models pi --json`). With `--task` and `--lane` it records `{route, reason}` in the task's `routes` and returns an already recorded lane unchanged, so repairs and resumes keep their route; for a recorded lane it refuses `--class`, `--owner-model`, `--owner-effort`, or `--owner-fast` that would select another route, so resume it with no route flags or with the ones that selected it. A new route is checked against the class table once, when it is recorded; later reads check only its shape, so a later class change never strands a task. Pass `route` unchanged to `buildManagedWorkerRequest` and `reason` to `buildDelegatedBrief`. Give both builders the destination task as `task: readTask(taskPath)`, the lane (`buildDelegatedBrief` takes `lane` too; `buildManagedWorkerRequest` refuses a `taskId` other than the record's id), and the lane's class as `taskClass` (a UI task's lanes are `ui`); pass the same `taskClass` when recording, and the Pi catalog rows as `catalog` to `buildDelegatedBrief` and `recordWorkerRoute` where you have them. With a task, an explicit `provider` is checked after the route and must be exactly the provider the validated route maps to, with its settings. Task records are bookkeeping, not routing authority: the source a route records grants nothing. Every route, recorded or fresh, keeps the owner's hard rules for its lane's class: `code`, `code-bounded`, `test-fix`, and `automation` never run a GPT or web model, `ui` is exactly Opus xhigh, Fast off (without a catalog the model id must name Opus), and no route runs below its class minimum. Inside them an owner-named route keeps its model and effort. A task default runs its class's own model: with a catalog exactly the class's row, without one a model id that names the class's label. A lane with a recorded route takes only that route, on the request, brief, and recording paths. It rebuilds (repair, restart) as long as it still fits; a task default must also be the class's catalog label with the class's Fast, at any effort from the class minimum up to its ceiling (code classes medium..xhigh, so a pre-7.30 Opus xhigh lane rebuilds), which the Pi catalog must still serve. A fresh lane's route is checked as new against today's table and its class. Kinds outside the table go to the owner.

## Classes

Labels resolve through the target Pi catalog. Routes are the minimum (owner rule): every range starts at the class default, so the pace can raise an adjustable class within its range (medium < high < xhigh) but never lower it, and no quota mode lowers any route. Fixed classes never move.

| Class | Use for | Default | Range | Fast |
|---|---|---|---|---|
| `code` | multi-step, multi-file, money, auth, prod changes | Opus medium | medium..high | off |
| `code-bounded` | single file, clear spec | Opus medium | medium..high | off |
| `test-fix` | make CI green | Opus medium | medium..high | off |
| `review-critical` | read-only security, money, architecture review | Sol xhigh | fixed | off |
| `review-general` | other read-only review | Sol xhigh | fixed | off |
| `automation` | computer use that builds automation code | Opus medium | medium..high | off |
| `browser` | one-time browser or computer-use execution | Astra medium | medium..high | on |
| `research` | read-only lookup | Luna xhigh | fixed | on |
| `mechanical` | small mechanical edits, test removals, config syncs | Opus medium | fixed | off |
| `smoke` | smokes, canaries | Sonnet low | fixed | off |
| `watcher` | watchers, heartbeats | Luna xhigh | fixed | on |
| `ui` | design, build, style, or visually review interfaces, including UI checks in a browser | Opus xhigh | fixed, owner rule | off |

Local code lanes default to Opus medium; a cloud lane is always Opus xhigh, and `ui` stays Opus xhigh everywhere. Code and automation never run on a GPT model. The planner keeps its fixed role route: Web Pro, then Opus xhigh only after an owner yes following a Pro failure. Fast means Pi's Fast toggle on GPT routes, never native Codex `fast_mode`.

## Web reviewer

The `reviewer` fixed role is separate: it is the one ChatGPT web lane (Web Pro) for browser review of a task, not a Worker class, and the class table does not change it.

## UI work

UI work runs only on Opus xhigh, Fast off. The `ui` class resolves to an owner-explicit route with the reason `ui: owner rule, Opus xhigh, no GPT`; the pace never touches it, and the cloud lane takes it only when the toggle is `all`. UI work never uses a GPT or web model: no Sol, Luna, or Astra Worker, no Luna scouts, no web planner or fallback, and no web reviewer. Create its task with `createTask({..., ui: true})` and pass `ui: true` to `selectTopology`: the task refuses browser review, the planner refuses to launch, `recordWorkerRoute` and the Worker builders given the task refuse anything but Opus xhigh, Fast off, with an Opus model id, and the topology runs no scouts or planner. An owner-named route for UI work other than Opus xhigh, Fast off is refused; ask the owner to use the `ui` class instead.

## Cloud lane

For `code`, check the [cloud lane](cloud-lane.md "branch:cloud") first: pass `--cloud-facts` with the `checkCloudEligibility` facts, or `cloud: {toggle, eligibility}` to `resolveWorkerRoute`. An eligible lane gets the cloud route. Otherwise the local route applies, and the reason says why the cloud lane was not used. After a dead cloud lane, `resolveCloudFallback` (or `--cloud-fallback`) gives its one local fallback Worker that same local route, recorded under the lane `<slug>-fallback`.

## Pace

The pace reads Paceline's `pq --json` (schemaVersion 1) for the class's pool: Claude routes (Opus, Sonnet) read the claude accounts, GPT routes (Sol, Luna, Astra) the codex accounts.

- Weekly gap is the pool's `pools[].pace.gapPct`: positive means behind (quota going unused), negative means ahead.
- 5-hour use is the mean `five_hour` `usedPct` over the pool's fresh accounts.
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
- the pool has no fresh 5-hour reading.

Some stale accounts still adjust, and the reason shows "N of M stale".

## Settings

The optional owner file `~/.config/opc/routing.json` tunes `behindPoints` (default 10), `aheadPoints` (10), `resetSoonHours` (24), `resetSoonLeftPct` (15), `fiveHourNoUpPct` (75), `fiveHourDownPct` (90), and `pq`. `pq` is an argv array, default `["~/.local/bin/pq", "--json"]`; a leading `~` in its first element is expanded. A host without pq can name another host, for example `["ssh", "<alias>", "~/.local/bin/pq", "--json"]`. pq runs without a shell and has 15 seconds to answer. A file with unknown keys or bad values is ignored: the defaults apply and the reason names the error, for example `routing.json invalid (unknown key x), defaults used`. A `codexFallback` key left by OPC 7.30 is accepted and ignored. Fixed classes, `ui`, and the planner never read this file or the quota.

## Errors

Network and proxy errors, such as `Connection error` or a 502 `backend unavailable`, are retried on the same route by sending the same Worker a continue follow-up. They never change the model or effort. Rate limits and real launch failures still stop the lane.
