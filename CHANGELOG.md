# Changelog

All notable changes are listed here. Loadout follows [semantic versioning](https://semver.org).

## Unreleased

### Changed
- OPC cloud briefs tell the session its container can restart and lose unpushed work: push a first small commit and open the draft PR before other work, then push after each completed step; the launcher follow-up says the same after a restart with nothing pushed.
- `frontend-design` is now Anthropic's official frontend-design skill, copied unmodified from the official Claude Code plugin; the skill name is unchanged.
- `merged-worker-archiver` caps archives per sweep again (`maxArchivesPerSweep`, default 5; the rest are deferred to the next sweep) and treats git-ignored files in a worktree as dirty, so an ignored `.env`, local notes, or `node_modules` now block archival.
- `cache-aware-autocompact`, `merged-worker-archiver`, `orphan-project-sweeper`, and `usage-limit-auto-resume` now share one fail-closed daemon endpoint resolver. Its canonical source is `plugins/_shared/daemon-target.ts`, each plugin vendors a byte-identical copy, and CI fails when a copy drifts. Endpoint resolution is unchanged.
- OPC test recovery records the cleanup of a test command whose pid another process now holds as `cleanup incomplete: PID reused` (was `incomplete: PID reused`).

### Fixed
- `usage-limit-auto-resume` rolls back a send refused with `Transport not connected` from the stored record, undoing only what the claim set. A turn that started during the send, even one the turn-start handler has not stored yet or one that arrives while the rollback is being written, turns the record `uncertain` with its turn ID, deadline and attempt kept, instead of re-arming a duplicate send.
- `orphan-project-sweeper` no longer treats a non-empty parent as proof of a mount. On Linux and macOS every mount point `/etc/fstab` declares over a project root must be mounted; on Windows no existing ancestor may be a junction, symlink, volume mount point or non-directory, and a parent or drive root that cannot be read, or is not a directory, is unverifiable rather than missing (`mount-absent` and `mount-unverifiable` skips). The root, parent and mount checks run again immediately before `removeProject`.
- OPC test recovery tells a reused pid from the recorded process by its exact start time, read in one fixed format, and stops the test command's process group, on POSIX even after its leader exited; a pid reused by another process is never signalled and the record says the cleanup is incomplete. Windows uses `taskkill /T /F`, which cannot reach a descendant orphaned after its parent exited. Task locks record their holder's start time; a live holder whose start time cannot be read keeps its lock.
- OPC relaunches a recorded Worker lane (repair, restart) after a class-table change. Given the task record, lane and lane class, the Worker request and brief take only the lane's recorded route and rebuild it while it keeps the owner's rules for that class, whatever its recorded source: code classes never run a GPT or web model, `ui` is exactly Opus xhigh with Fast off, and no route runs below its class minimum. A task default also keeps its class's model and Fast, at any effort up to the class ceiling that the Pi catalog still serves. An explicit provider must be the one the validated route maps to, and `route.mjs` refuses route flags that would select another route for a recorded lane.
- OPC records a cloud lane as launching before the session command runs, and `recordCloudLaunch` only completes that record. An uncertain launch is settled with `reconcileCloudLaunch` or `cloud-lane.mjs reconcile <task.json> --session <id> --url <url>` (running) or `--no-session --reason <text>`, which permits one relaunch.
- Fleet push, skills sync, and plugins sync share one destination path check. Plugins sync now also refuses a file path that leaves the plugin root, and all three refuse a dangling symlink among a destination's parent directories.
- Plugins sync records each staged plugin's check result on the host and runs a failed or missing check again, instead of reporting success on a rerun; a plugin whose re-check passes is reloaded. Files no longer published are removed from the staged plugin directory while unedited.
- Provider sync records a reload owed after a write and retries it on the next run; a retry that fails is `FAILED`, not a warning.
- Skills sync retires a skill it installed (per the host's sync record) once it is no longer published, keeping and reporting a locally edited one, and records an overlay hash only after a host accepts it.
- A failed shared preflight in `sync.py` stops the later scopes for that step's hosts.
- The skills, plugins, and client-config programs write through uniquely named temp files and rename one only while it is still the file they wrote.
- `cache-aware-autocompact` no longer lets two state stores in one process clobber one temp file or an old store write after a reload. Every store for a file shares one write queue; a newer store fences off older ones, and teardown waits for the write in flight.
- `cache-aware-autocompact`, `pm-native-worker-guard`, and `usage-limit-auto-resume` write their JSON state through one shared atomic writer, `plugins/_shared/atomic-json.ts`: a uniquely named, exclusively created temp file, flushed and renamed over the state file, with a brief retry when Windows reports the file busy. A temp file that cannot be removed after a failed write is reported with that write's error. The on-disk format is unchanged.
- Fleet sync on the source host drops an inherited `PASEO_HOST`, `PASEO_HOME`, and agent variables, so a provider reload, a plugin install, and their config reads all address the host's own daemon, never one the launching session named.
- Fleet push copies only `hosts.json`, `paseo-providers.json`, `client-config.json`, and `global/AGENTS.md`; token files, pairing offers, backups, and other files in the fleet directory stay on the source host, and a copy an earlier push left on a host is removed while unedited.
- Provider sync checks the host config and `required_env` before touching the Pi runtime, counts a Pi runtime change (or a runtime configuration that failed partway) as a write that owes a reload, and merges onto a config another writer changed during the merge instead of overwriting it.
- Client-config reads Codex TOML structure (headers with comments, array tables, quoted keys, multiline values) before merging and refuses a file it cannot read or a result that would define a table or key twice; both client files are replaced only while they still hold the revision the merge read.
- Provider and client-config backups get a unique name and are created new, so two updates in one second no longer overwrite the first backup.
- Pi deploy rollback checks every runtime file for edits, symlinks, and junctions before changing anything and restores atomically before the daemon config; apply merges onto a daemon config changed during the install instead of overwriting it.
- The Pi picker patch replaces its state, bundle, entry, and backups atomically and remembers the previous patch generation, so an interrupted write can still be checked, reapplied, and rolled back.
- The fleet docs no longer promise a no-fleet single-host sync; a one-host fleet does that.
- Fleet sync's remote programs travel on stdin with their payload in one SHA256-checked envelope, so the ssh command line is a short fixed boot and Windows hosts stay far below the `cmd.exe` length limit; a corrupted envelope runs nothing.

### Added
- `pi-fast-toggle`, a Paseo plugin with a per-agent composer pill that requests Fast on Pi agents whose model supports service tiers.
- OPC routes Pi Workers by task class. Code, code-bounded, test-fix, and automation start at Opus medium; reviews use Sol xhigh; browser uses Astra medium with Fast on; research is fixed at Luna xhigh; UI is fixed at Opus xhigh. Quota can raise an adjustable route but never lowers one; a `codexFallback` key in `routing.json` is accepted and ignored.
- OPC cloud lane: an owner toggle sends eligible editing lanes (`on`), or editing lanes and UI (`all`), to one Claude Code cloud session, always Opus 5.5 at xhigh on launch and follow-up, with an optional per-host cloud profile for a second claude.ai login that fails closed when unreadable. A dead cloud lane gets one local fallback Worker on its class route, the `ui` route for UI work.
- CI runs the repository tests on Ubuntu, macOS, and Windows, and plugin checks on Ubuntu and Windows.
- `cache-aware-autocompact` extends idle compaction to cold Claude-family recoveries and failed turns (`extendIdleCompaction`, default on).
- `pm-native-worker-guard`, a dry-run-first Paseo plugin that stops and archives native Codex or Claude Code agents created by a PM and tells the PM to use the Pi provider, with an owner allowlist.

### Removed
- OPC's direct native Codex CLI Worker (`worker.mjs`) and its `task.worker` record; a task file that still carries one is refused, and managed Paseo Workers are unchanged.

## 0.2.0 (2026-09-30)

### Fixed
- `cache-aware-autocompact` now restores idle compaction timers after restart or reload, preserves elapsed idle time with bounded overdue jitter, logs recovery counts, and uses durable checkpoints to prevent repeat sends.
- `cache-aware-autocompact` skips missing working directories before fetching recovery timelines, suppresses repeated per-agent recovery errors and unchanged recovery summaries, and reports unknown context usage as `context-unknown` while preserving terminal skip behavior.

### Changed
- `orphan-project-sweeper` now defaults to dry-run until `armed` is true, caps deletions per sweep (default 5), and provides a forced dry-run CLI, safeguard tests, and recovery instructions.

## 0.1.0 (2026-09-30)

First public release.

### Added
- 22 agent skills in six groups: engineering, orchestration, writing, research, web, and operations.
- Claude Code plugin marketplace (`claude plugin marketplace add Enjoyoer/loadout`) with six `loadout-*` plugins.
- Fleet sync (`sync.py`) for skills, Paseo plugins, Paseo provider pickers, and Codex and Claude Code settings, with SHA256 verification, local-edit protection, a private skill overlay, and `--migrate-path` for plugins.
- Four Paseo plugins: `usage-limit-auto-resume`, `merged-worker-archiver`, `cache-aware-autocompact`, and `orphan-project-sweeper`.
- An offline fleet sync demo (`examples/fleet_demo.py`), CI on Ubuntu and macOS, a contributing guide with a 7-day triage promise, a security policy, and a code of conduct.
- Skills adapted from Matt Pocock's skills and Context7 keep their upstream MIT licenses; see `THIRD_PARTY_NOTICES.md`.
