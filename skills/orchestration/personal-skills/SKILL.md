---
name: personal-skills
description: Sync selected skill packages from this repository into local Codex or Claude Code installations, with committed-blob verification and local-edit protection.
---

# Personal skills

Use the repository root `README.md` for the current manifest format, installation destinations, and validation steps. The user chooses the packages and target host. There is no built-in machine roster or automatic remote target.

## Source and selection

- Resolve an ordinary local Git checkout of this repository. Read `MANIFEST.json` from one immutable commit and its `source_commit` once. Require the documented schema and `hash_basis: git-blob`.
- Select package names from the manifest. Source files live at `skills/<category>/<skill-name>/<file>` and install flat at `<client-home>/skills/<skill-name>/<file>`.
- Read every selected file from the recorded `source_commit` with `git cat-file blob`. Verify the manifest byte count and SHA256 before considering a destination.

## Destinations

- Codex: `${CODEX_HOME:-$HOME/.codex}/skills/<skill-name>`.
- Claude Code: `~/.claude/skills/<skill-name>`.
- Resolve home directories and path syntax on the target host. A client is present when its binary or skills root exists; skip and report an absent client.
- This repository installs skill packages only. It does not install global instructions, credentials, model settings, or other agent-client configuration.

## Local-edit protection

Preflight every selected destination before writing any file on that host. Reject escaping or duplicate paths, symlink or junction ancestors, unexpected file types, and hash mismatches. An existing file may be replaced only if it matches a verified prior publication of the same source path or the desired blob. Preserve unknown local edits and stop the host without a partial package update. Leave unselected files untouched.

After a successful preflight, write verified bytes, verify every installed hash, and run the available package validators. Report selected packages, commit IDs, destinations, files written, files already current, skipped clients, and blockers. A host without its own checkout may receive verified bytes from another eligible checkout, but must reverify them before the same preflight and write.

## Publishing a package change

Commit package content first. Generate the manifest from that committed tree with `source_commit` equal to the content commit, then commit the manifest separately. Verify that the complete active `skills/` tree matches manifest paths, byte counts, and SHA256 values. Review the diff before publishing. The public repository has its own clean history; do not import another repository's history or machine-local state.
