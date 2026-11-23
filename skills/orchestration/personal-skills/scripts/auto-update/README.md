# Fleet auto-update runner

One fixed-rule runner per host applies leaf-tool updates without an agent in the loop. A scheduler (launchd, a systemd user timer or Task Scheduler) starts `auto-update.mjs run`. It reads the registry, the kill switch and the available-versions feed, applies at most one component per run through a detached transaction, says nothing on success, and sends one line to the owning PM when it holds a version. Node is the one dependency, already on every host; adapters are bash or PowerShell.

Phase 0 is build only: nothing here is scheduled, and the example registry holds every component.

```
auto-update.mjs                 decision core, transaction and rollback watchdog
adapters/cli-posix.sh           Claude Code and Codex CLI, macOS and Linux (stage beside, symlink swap, re-point)
adapters/cli-windows.ps1        Claude Code and Codex CLI, Windows (file replace with kept binary, npm reinstall)
adapters/interactive-idle.ps1   precondition probe: interactive user idle and nothing full-screen
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
  - `preconditions[]`: `{name, argv, max_age_seconds, timeout_seconds?}`. The probe prints one JSON line `{"ok": bool, "observed_at": "<UTC>", "detail"?}`. A failing, unparseable, stale or `ok: false` reading skips the run without an attempt.
- `components[]`, one row each:
  - `component`, `tier` (1 or 2; nothing higher can be automatic), `mode` (`apply`, `hold`, `observe`), `hosts`.
  - `version_pattern`: anchored pattern the candidate must match. `bounds.max_bump` (`patch`, `minor`, `major`) and `bounds.deny[]` (anchored patterns, for example `^27\\..*$`). Downgrades are never applied.
  - `window` `{tz, days, start, end}`, DST-aware through the time zone, and `host_windows.<host>` to override it per host.
  - `soak_hours` from the feed's `first_seen_at`, and `security_soak_hours` for a release the feed marks `security`.
  - `canary` `{host, receipt, max_age_hours}`: on the canary host the transaction's `precheck` proves the exact staged version before the swap and the transaction writes the receipt; every other host needs a fresh `pass` receipt for exactly this component, version and canary host.
  - Tier 2 needs `exclusive_group` (at most one change per group per host per local day, failed attempts included) and `watchdog_seconds`.
  - `require_digest`: the feed must give an image digest (`{digest}` in argv), for digest-pinned containers.
  - `adapters.<os>`: `check` `{argv, regex}` (group 1 is the installed version), and `stage[]`, `precheck[]`, `apply`, `health[]`, `rollback`. A row in `mode apply` needs apply, health and rollback for every host's OS.
  - argv placeholders, whole or inside an element: `{version}`, `{installed}`, `{digest}`, `{adapters}` (this directory's `adapters/`), `{txn}` (the transaction directory), `{component}`, `{host}`. A leading `~` is the home directory. Commands run without a shell; `.cmd` and `.bat` files go through `powershell.exe -File`.

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

For each row on this host, in tier order, the first failing gate is the reason: OS adapter, `observe`, feed, candidate pattern, digest, installed check, equal versions, downgrade and bump bounds, deny list, an earlier attempt of this exact version, `hold`, soak, canary receipt, kill switch, blackout, window, tier-2 exclusivity, host preconditions. The first row that passes every gate is applied; the rest wait for later runs.

## Transaction

`run` takes the host lock (a `lock/` directory naming every live PID: runner, transaction, watchdog), records the attempt as `started` in `state.json`, starts `auto-update.mjs txn <dir>` detached, hands it the lock and exits. The transaction then:

1. runs `stage` and `precheck` (nothing has changed yet; a failure holds the version);
2. for a row with `watchdog_seconds`, starts the detached watchdog and waits until it has armed;
3. runs `apply`, every `health` command, and `check` again, which must read the new version;
4. confirms, or rolls back and checks that the old version is back. The transaction and the watchdog race for one exclusively created `decision` file, so exactly one of them confirms or rolls back.

Exit 75 from `stage`, `precheck` or `apply` means "not now, nothing changed" (for example a CLI process is running): the attempt is dropped without a hold or an alert, and a later scheduled run decides again.

Every other outcome is final for that exact host, component and version: `applied`, `failed`, `rolled-back`, `rolled-back-by-watchdog`, `rollback-failed`, or `interrupted` (found by a later run when no PID of the attempt is alive). The version is never attempted again; a newer feed version is a new attempt. Each held attempt sends one line, `auto-update HOLD <host>/<component>@<version>: <reason> (txn <id>)`; a line that could not be delivered is retried once per later run. A failing feed sends one line per distinct failure.

State lives in `${XDG_STATE_HOME:-~/.local/state}/loadout/auto-update/` (`%LOCALAPPDATA%\loadout\auto-update\` on Windows): `state.json` (attempts, applied log, alerts), `txn/<id>/` (plan, log, decision), `lock/`. An unreadable `state.json` stops the runner until it is repaired by hand.

## Schedulers

The templates in `scheduler/` fire at :15 from 01:00 to 04:00 local time, never in the Sunday 05:00 to 07:00 blackout, and are inert until Config installs them with real values. launchd runs a missed slot after wake, so the runner enforces every window and blackout itself. The systemd timer has `Persistent=false` and `KillMode=process` so the detached transaction outlives the oneshot. The Task Scheduler task runs only while the user is logged on (InteractiveToken), so the idle probe can see the session; it never wakes the PC or catches up.

## Gaps before any live apply

- Feed and canary receipts reach only the host that writes them. Every other host needs a transport for both (the fleet push, or a read-only pull from the publishing host); until then it reports `feed missing` and applies nothing.
- Homebrew: no proven rollback (Homebrew has no supported downgrade), so formula rows stay `hold`; `brew-formula.sh scope` already proves an upgrade touches exactly one formula.
- Tailscale and RustDesk: no apply adapter yet (vendor package per OS, kept installer for rollback). Health and serve-config preservation exist. The watchdog is a detached process and does not survive a reboot.
- Containers: `container-digest.sh` is a contract only (pull by digest beside the running image, recreate, origin and external health, recreate from the kept image on failure).
- Windows: check on each host that a process the task starts detached survives the task's end.
