# Fleet auto-update runner

One fixed-rule runner per host applies leaf-tool updates without an agent in the loop. A scheduler (launchd, a systemd user timer or Task Scheduler) starts `auto-update.mjs run`. It reads the registry, the kill switch and the available-versions feed, applies at most one component per run through a detached transaction, says nothing on success, and sends one line to the owning PM when it holds a version. Node is the one dependency, already on every host; adapters are bash or PowerShell.

Phase 0 is build only: nothing here is scheduled, and the example registry holds every component.

```
auto-update.mjs                 decision core, transaction and rollback watchdog
adapters/cli-posix.sh           Claude Code and Codex CLI, macOS and Linux (stage beside, symlink swap, re-point)
adapters/cli-windows.ps1        Claude Code and Codex CLI, Windows (file replace with kept binary, npm reinstall)
adapters/interactive-idle.ps1   precondition probe: interactive user idle and nothing full-screen
adapters/host-idle.mjs          precondition probes: no active Paseo turn, below-normal load, model traffic quiet
adapters/brew-formula.sh        Homebrew formula version and scoped-upgrade proof (read-only)
adapters/access-health.sh       Tailscale and RustDesk versions, serve-config snapshot and health (read-only)
scheduler/                      inert launchd, systemd and Task Scheduler templates
```

## Commands

- `node auto-update.mjs plan --host <name> [--now <ISO>]`: one JSON line per component for this host, `decision` `would-apply`, `current`, `observe` or `skip` with its `reason`; `next: true` marks the one a run would apply. It runs only the read-only `check` commands and precondition probes and writes nothing.
- `node auto-update.mjs run --host <name>`: what the scheduler runs.
- `node auto-update.mjs validate`: checks the registry for every host, on the source host before a push.

`--host` is the host's name in the registry; the scheduler template carries it. A host missing from the registry, or whose `os` differs from the machine, stops with exit 2 and changes nothing.

## Inputs

All inputs are JSON files that must be regular files (no links), owned by the runner's user and not writable by group or other (POSIX), and small. Unknown keys are errors everywhere.

### Registry: `<fleet>/auto-update/registry.json`

Config owns it, in the private fleet directory (see `fleet/README.md`); the fleet push copies it to every host. `../../fleet/example/auto-update/registry.json` shows every field with made-up hosts.

- `feed`: `path` of the available-versions file on this host, `max_age_hours`.
- `notify`: `command` (argv prefix of the Paseo CLI), `labels` that resolve the owning PM at send time (`role=pm`, `project=config`), optional `host` (`ssh://<alias>`). A host's `notify_host` overrides it. Exactly one matching agent or nothing is sent.
- `blackouts[]`: windows `{tz, days, start, end}` in which nothing applies, whatever a row says.
- `hosts.<name>`: `os`, `tz` (for the per-day exclusivity date), `allow` (component ids this host may run at all), optional `deny_tiers`, `preconditions[]` and `notify_host`. A row naming a host that does not allow it, or a denied tier, fails validation.
  - `preconditions[]`: `{name, argv, max_age_seconds, timeout_seconds?, quiet?}`, the host's idle gates. The probe prints one JSON line `{"ok": bool, "observed_at": "<UTC>", "detail"?}`. A failing, unparseable, stale or `ok: false` reading is busy or unknown: the run skips without an attempt, and every later tick decides again (no daily cap). Every gate is evaluated at each tick and again right before apply.
  - `quiet` `{min_seconds, max_gap_seconds, max_per_minute: {counter: limit}}`: the probe also prints `counters` (cumulative, never decreasing) and `identity` (which processes they belong to). The gate is open only when the previous tick's reading of the same processes is between `min_seconds` and `max_gap_seconds` old and every counter grew at most `limit` per minute since; the first reading, a restarted process, a counter that went back or a gap after sleep keeps it closed. One reading never proves quiet. Right before apply the counters are compared with the run's own reading, judged over at least `min_seconds`.
- `components[]`, one row each:
  - `component`, `tier` (1 or 2; nothing higher can be automatic), `mode` (`apply`, `hold`, `observe`), `hosts`.
  - `version_pattern`: anchored pattern the candidate must match. `bounds.max_bump` (`patch`, `minor`, `major`) and `bounds.deny[]` (anchored patterns, for example `^27\\..*$`). Downgrades are never applied.
  - `window` `{tz, days, start, end}`, DST-aware through the time zone (`end` may be `24:00`), and `host_windows.<host>` to override it per host. Idle-gated hosts use an all-day window and rely on their preconditions; a daily-use PC keeps a fixed window.
  - `soak_hours` from the feed's `first_seen_at`, and `security_soak_hours` for a release the feed marks `security`.
  - `canary` `{host, receipt, max_age_hours}`: on the canary host the transaction's `precheck` proves the exact staged version before the swap and the transaction writes the receipt; every other host needs a fresh `pass` receipt for exactly this component, version and canary host.
  - Tier 2 needs `exclusive_group` (at most one change per group per host per local day, failed attempts included) and `watchdog_seconds`.
  - `require_digest`: the feed must give an image digest (`{digest}` in argv), for digest-pinned containers.
  - `adapters.<os>`: `check` `{argv, regex}` (group 1 is the installed version; it may carry a Homebrew revision such as `15.2.0_1`, compared as one more part; `check` and precondition argv may use only `{adapters}`, `{component}` and `{host}`), and `stage[]`, `precheck[]`, `apply`, `health[]`, `rollback`. A row in `mode apply` needs apply, health and rollback for every host's OS.
  - argv placeholders, whole or inside an element: `{version}`, `{installed}`, `{digest}`, `{adapters}` (this directory's `adapters/`), `{node}` (the Node running the runner), `{txn}` (the transaction directory), `{component}`, `{host}`. A leading `~` is the home directory. Commands run without a shell; `.cmd` and `.bat` files go through `powershell.exe -File`. The skills sync installs these scripts without the executable bit, so run each adapter through its interpreter (`/bin/bash {adapters}/cli-posix.sh ...`, `powershell.exe -File {adapters}/cli-windows.ps1 ...`).

### Kill switch: `<fleet>/auto-update/switch.json`

`{"schema": "loadout.auto-update.switch/1", "apply": "allowed"}` allows applies. Any other value, a missing or unreadable file, or a `STOP` file in the host's state directory stops every apply on that host, silently. Edit it on the source host and push, or touch `STOP` on one host for an immediate local stop.

### Available-versions feed

Data only: no URL, command, path or checksum in it is ever used. Download sources and checksums come from the adapters (for Claude Code the vendor's signed-release manifest).

```json
{
  "schema": "loadout.auto-update.available/1",
  "generated_at": "2026-01-05T16:00:00Z",
  "publisher": "version-watch",
  "components": {
    "claude-code": {"version": "2.1.331", "first_seen_at": "2026-01-03T10:00:00Z", "security": false},
    "tailscale": {"version": "1.104.6", "first_seen_at": "2025-12-30T00:00:00Z", "security": false,
                  "by_os": {"macos": "1.104.6", "linux": "1.104.6", "windows": "1.104.6"}},
    "example-tunnel": {"version": "2026.1.0", "first_seen_at": "2026-01-01T00:00:00Z", "security": true,
                       "digest": "sha256:<64 hex>"}
  }
}
```

- Times are UTC `YYYY-MM-DDTHH:MM:SSZ`; `first_seen_at` is when this exact version was first seen as latest stable and stays fixed until the version changes; it is not after `generated_at`.
- The whole file is rejected when it is older than `feed.max_age_hours`, more than 5 minutes in the future, larger than 64 KiB, or has any structural error. Component ids match `^[a-z0-9][a-z0-9.@+-]{0,63}$` (Homebrew formulae as `brew.<formula>`); versions match `^[0-9][0-9A-Za-z.+-]{0,63}$` and then the row's `version_pattern`; `digest` matches `^sha256:[0-9a-f]{64}$`.
- The publisher writes it atomically (temp file in the same directory, then rename), mode 0600, only after a complete run; a component it could not read is left out.

### Canary receipt

`{"schema": "loadout.auto-update.canary/1", "component", "version", "host", "result": "pass"|"fail", "finished_at"}`, written by the canary host's transaction.

## Decisions

For each row on this host, in tier order, the first failing gate is the reason: OS adapter, `observe`, feed, candidate pattern, digest, installed check, equal versions, downgrade and bump bounds, deny list, an earlier attempt of this exact version, `hold`, soak, canary receipt, kill switch, blackout, window, tier-2 exclusivity, host idle gates. The first row that passes every gate is applied; the rest wait for later runs.

## Transaction

`run` takes the host lock (a `lock/` directory naming every live PID: runner, transaction, watchdog), records the attempt as `started` in `state.json`, starts `auto-update.mjs txn <dir>` detached, hands it the lock and exits. The transaction then:

1. runs `stage` and `precheck` (nothing has changed yet; a failure holds the version);
2. for a row with `watchdog_seconds`, starts the detached watchdog and waits until it has armed;
3. checks the blackouts, the window and every host idle gate again (a long stage must not carry the change into a blackout or a busy host; if any is closed, the attempt is dropped as "not now" and a later tick decides again), then runs `apply`, every `health` command, and `check` again, which must read the new version;
4. confirms, or rolls back and checks that the old version is back. The transaction and the watchdog race for one exclusively created `decision` file, so exactly one of them confirms or rolls back.

Exit 75 from `stage`, `precheck` or `apply` means "not now, nothing changed" (for example a CLI process is running): the attempt is dropped without a hold or an alert, and a later scheduled run decides again.

Every other outcome is final for that exact host, component and version: `applied`, `failed`, `rolled-back`, `rolled-back-by-watchdog`, `rollback-failed`, or `interrupted` (found by a later run when no PID of the attempt is alive). The version is never attempted again; a newer feed version is a new attempt. Each held attempt sends one line, `auto-update HOLD <host>/<component>@<version>: <reason> (txn <id>)`; a line that could not be delivered is retried once per later run. A failing feed sends one line per distinct failure.

State lives in `${XDG_STATE_HOME:-~/.local/state}/loadout/auto-update/` (`%LOCALAPPDATA%\loadout\auto-update\` on Windows): `state.json` (attempts, applied log, alerts), `txn/<id>/` (plan, log, decision), `lock/`, and `gates.json`: the previous quiet readings and, per local day for 31 days, the gate samples (ticks, open ticks, closed-to-open and open-to-closed transitions, blocker counts by gate and short code, and a compact `[HH:MM, open, blockers]` list). Samples hold gate names and codes only, no agent names, processes or values; one day of samples needs a day of ticks. An unreadable `state.json` stops the runner until it is repaired by hand.

## Schedulers

The templates in `scheduler/` are periodic ticks, inert until Config installs them with real values: every 10 minutes on idle-gated hosts (`com.loadout.auto-update.plist`, `loadout-auto-update.timer`, `loadout-auto-update.xml`), and every 10 minutes from Sunday 03:00 to 05:00 on a daily-use PC (`loadout-auto-update-pc.xml`). No watcher, daemon or sleep loop: each tick samples the gates, applies at most one change and exits. A tick inside a blackout or window that is closed only samples; launchd runs a missed tick after wake, so the runner enforces every window and blackout itself. The systemd timer has `Persistent=false` and `KillMode=process` so the detached transaction outlives the oneshot. The Task Scheduler task runs only while the user is logged on (InteractiveToken), so the idle probe can see the session; it never wakes the PC or catches up.

## Gaps before any live apply

- Feed and canary receipts reach only the host that writes them. Every other host needs a transport for both (the fleet push, or a read-only pull from the publishing host); until then it reports `feed missing` and applies nothing.
- Homebrew: no proven rollback (Homebrew has no supported downgrade), so formula rows stay `hold`; `brew-formula.sh scope` already proves an upgrade touches exactly one formula.
- Tailscale and RustDesk: no apply adapter yet (vendor package per OS, kept installer for rollback). Health and serve-config preservation exist. The watchdog is a detached process and does not survive a reboot.
- Containers: `container-digest.sh` is a contract only (pull by digest beside the running image, recreate, origin and external health, recreate from the kept image on failure).
- Windows: check on each host that a process the task starts detached survives the task's end.
- Idle thresholds are provisional until a few days of gate samples exist: 5-minute load at most 1 per core (half the existing Mac load alarm of 2 per core), memory floors from the existing policies (the same alarm's 15% free on macOS, `heavy`'s 3072 MB available on Linux, 15% on Windows), Windows CPU at most 50% over a 1 s sample, and model traffic at most 30 centiseconds of proxy or bridge CPU per minute over at least 5 minutes. The `quiet` probe reads launchd jobs, so it exists for macOS only.
- The daily-use PC template starts Node through `conhost.exe --headless` so no console window appears over a game; check that on the PC before registering it.
