# Changelog

All notable changes are listed here. Loadout follows [semantic versioning](https://semver.org).

## Unreleased

### Changed
- `frontend-design` is now Anthropic's official frontend-design skill, copied unmodified from the official Claude Code plugin; the skill name is unchanged.
- `merged-worker-archiver` caps archives per sweep again (`maxArchivesPerSweep`, default 5; the rest are deferred to the next sweep) and treats git-ignored files in a worktree as dirty, so an ignored `.env`, local notes, or `node_modules` now block archival.
- `cache-aware-autocompact`, `merged-worker-archiver`, `orphan-project-sweeper`, and `usage-limit-auto-resume` now share one fail-closed daemon endpoint resolver. Its canonical source is `plugins/_shared/daemon-target.ts`, each plugin vendors a byte-identical copy, and CI fails when a copy drifts. Endpoint resolution is unchanged.

### Fixed
- Fleet push, skills sync, and plugins sync share one destination path check. Plugins sync now also refuses a file path that leaves the plugin root, and all three refuse a dangling symlink among a destination's parent directories.
- Plugins sync records each staged plugin's check result on the host and runs a failed or missing check again, instead of reporting success on a rerun; a plugin whose re-check passes is reloaded. Files no longer published are removed from the staged plugin directory while unedited.
- Provider sync records a reload owed after a write and retries it on the next run; a retry that fails is `FAILED`, not a warning.
- Skills sync retires a skill it installed (per the host's sync record) once it is no longer published, keeping and reporting a locally edited one, and records an overlay hash only after a host accepts it.
- A failed shared preflight in `sync.py` stops the later scopes for that step's hosts.
- The skills, plugins, and client-config programs write through uniquely named temp files and rename one only while it is still the file they wrote.
- `cache-aware-autocompact` no longer lets two state stores in one process clobber one temp file or an old store write after a reload. Every store for a file shares one write queue; a newer store fences off older ones, and teardown waits for the write in flight.
- `cache-aware-autocompact`, `pm-native-worker-guard`, and `usage-limit-auto-resume` write their JSON state through one shared atomic writer, `plugins/_shared/atomic-json.ts`: a uniquely named, exclusively created temp file, flushed and renamed over the state file, with a brief retry when Windows reports the file busy. A temp file that cannot be removed after a failed write is reported with that write's error. The on-disk format is unchanged.
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
