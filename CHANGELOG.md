# Changelog

All notable changes are listed here. Loadout follows [semantic versioning](https://semver.org).

## Unreleased

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
