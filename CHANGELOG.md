# Changelog

All notable changes are listed here. Loadout follows [semantic versioning](https://semver.org).

## Unreleased

### Changed
- `frontend-design` is now Anthropic's official frontend-design skill, copied unmodified from the official Claude Code plugin; the skill name is unchanged.

### Added
- `pi-fast-toggle`, a Paseo plugin with a per-agent composer pill that requests Fast on Pi agents whose model supports service tiers.
- OPC routes Pi Workers by task class, with quota-paced effort for adjustable classes and a fixed Opus route for UI work.
- OPC cloud lane: an owner toggle sends eligible editing lanes to one Claude Code cloud session, always Opus 5.5 at xhigh, with an optional per-host cloud profile for a second claude.ai login.
- `cache-aware-autocompact` extends idle compaction to cold Claude-family recoveries and failed turns (`extendIdleCompaction`, default on).
- `pm-native-worker-guard`, a dry-run-first Paseo plugin that stops and archives native Codex or Claude Code agents created by a PM and tells the PM to use the Pi provider, with an owner allowlist.

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
