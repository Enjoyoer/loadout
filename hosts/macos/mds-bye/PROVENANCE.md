# Provenance

- Upstream: https://github.com/rayhanadev/mds-bye
- Commit: `18a3adad80ed76820df0067b3279d08f8e3dc788` (18a3ada, committed 2026-08-23)
- Vendored: 2026-10-16, unmodified. Every other file in this directory is the upstream file at that commit, byte for byte; only `.gitignore` is left out.
- License: MIT, Copyright (c) 2026 Ray Arayilakath; see `LICENSE`.

This is a macOS-only host component. Updates land only after Config review: the system LaunchDaemon runs `disable-indexers-system.sh` as root.

Loadout never installs it. An owner installs it on a Mac by hand with `install.sh`, which uses `sudo`. The fleet sync's opt-in `mds-bye` scope only verifies that the four installed files still match these committed files; see the personal-skills `fleet/README.md`.
