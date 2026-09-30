# Changelog

All notable changes are listed here. Loadout follows [semantic versioning](https://semver.org).

## Unreleased

### Changed
- `orphan-project-sweeper` now defaults to dry-run until `armed` is true, caps deletions per sweep (default 5), and provides a forced dry-run CLI, safeguard tests, and recovery instructions.

## 0.1.0 (2026-09-30)

First release: 22 skills, 4 Paseo plugins, and the fleet sync tool.

### Added
- Claude Code plugin marketplace (`.claude-plugin/marketplace.json`) with six category plugins.
- README quickstart, supported-versions table, and `examples/fleet_demo.py`, an offline end-to-end fleet sync demo.
- CI on Ubuntu and macOS for repo tests, manifest verification, the `opc` validator, and plugin checks; Dependabot.
- Private skill overlay: the fleet sync also installs skills from `<fleet>/skills/<name>/`, never published.
- Contributing guide with a 7-day triage promise, security policy, code of conduct, issue and pull request templates.
- Fleet sync (`sync.py`) across skills, plugins, Paseo provider pickers, and client config; `--migrate-path` for plugins.
- Cloud offload: `owner/*` entries in the confirmed-repository list.

### Changed
- Skills adapted from Matt Pocock's skills and Context7 carry their upstream MIT licenses and notices.

### Removed
- `download-to-nas`, `todoist-api`, `gmail`, and `google-sheets` left the public collection; keep such skills in the private overlay.
