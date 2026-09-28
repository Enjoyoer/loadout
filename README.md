# Loadout Skills

A public collection of 25 agent skills for coding, research, writing, browser work, integrations, and orchestration. Each package lives at `skills/<category>/<name>` and installs flat as `<client skills directory>/<name>`. The repository has its own history and contains no machine credentials or private fleet configuration.

## Install

Clone this repository to a local filesystem, then verify its committed publication:

```bash
python3 scripts/verify_manifest.py
```

Choose the packages you want and follow the `personal-skills` skill or the manifest-based install instructions below. Codex uses `${CODEX_HOME:-$HOME/.codex}/skills/<name>` on Unix and `%USERPROFILE%\.codex\skills\<name>` on Windows. Claude Code uses `~/.claude/skills/<name>` on Unix and `%USERPROFILE%\.claude\skills\<name>` on Windows. Install only into clients present on the host. This repository does not install global agent instructions, provider settings, or credentials.

For a manual install, resolve the `source_commit` in `MANIFEST.json`, verify each selected committed blob's byte count and SHA256, then copy it to the flat destination after checking for local edits and symlink or junction ancestors. `skills/orchestration/personal-skills/SKILL.md` describes the full preflight. A changed installed file that matches no verified prior publication is a conflict; leave it untouched.

Some packages need an external CLI, connected service, or local credential. Read each `SKILL.md` before using it. The `sample` package learns style from examples supplied by the user; this public version contains no personal voice profile.

## Packages

See [SKILLS_CATALOG.md](SKILLS_CATALOG.md) for all 25 active packages. There are no archived packages in this public repository.

## Publication integrity

`MANIFEST.json` records committed Git-blob sizes and SHA256 values for every active skill file. Commit package content first, run `python3 scripts/generate_manifest.py`, then commit the manifest separately. `scripts/verify_manifest.py` checks the complete committed tree. The working tree, generated files, local secrets, and another repository's history are not publication sources.

## License

Original material is licensed under [MIT](LICENSE). `frontend-design` and `playwright` retain their bundled Apache-2.0 licenses; `playwright` also retains its upstream notice. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). These package-level terms take precedence for those files.
