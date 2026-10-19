# Contributing to Loadout

Thanks for helping. Issues and pull requests are welcome.

## Response times

The maintainer triages every new issue and pull request within 7 days: it gets a label and either a reply, a fix, or a clear next step. Security reports follow [SECURITY.md](SECURITY.md).

## What belongs here

- Portable agent skills, the fleet sync tool, and Paseo plugins that work for anyone.
- No credentials, tokens, account IDs, private host names, IP addresses, personal paths, or personal voice samples. Host-specific settings go in an ignored `references/local.md` or your private fleet directory.
- Skills adapted from other projects need a compatible license, the upstream `LICENSE.txt` in the package directory, and an entry in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
- One change per pull request, with tests and docs for behavior changes.

## Set up and test

You need Python 3, Node 24 or newer, and Git.

```bash
python3 -m unittest discover -s tests          # repo tests, offline (fake ssh, paseo, npm)
node skills/orchestration/opc/scripts/validate-opc.mjs skills/orchestration/opc
(cd plugins/<id> && npm ci && npm run check)   # or npm run typecheck where there is no check
python3 examples/fleet_demo.py                 # end-to-end fleet sync against simulated hosts
python3 scripts/check_vendored.py && python3 scripts/check_io.py   # repo rule checks
```

CI runs these checks on every pull request (repository tests on Ubuntu, macOS, and Windows; plugin checks on Ubuntu and Windows), except the fleet demo, which stays a local end-to-end check.

## Scratch work

Throwaway work goes in one scratch root per machine, never inside a project folder: `~/.cache/fleet-scratch/<project>/<task>/` (Windows `%USERPROFILE%\.cache\fleet-scratch\<project>\<task>\`). Set `FLEET_SCRATCH` to use another root. The repo tests use the system temporary directory instead and clean up after themselves.

- An expiry job deletes any `<project>/<task>` whose newest file is older than 7 days and that nothing has open. A long task keeps itself alive by touching a file in it.
- Only small evidence (logs, reports, screenshots, a few MB) stays in the checkout.
- A scratch Paseo daemon gets its own `PASEO_HOME`, `HOME`, `TMPDIR`, and port, with `PASEO_HOST` pinned to that port and its plugins left unarmed. Set `features.dictation.enabled` and `features.voiceMode.enabled` to `false` in its `config.json` so it downloads no speech models.
- Reuse an existing Paseo install instead of a fresh `npm install`. When `HOME` is overridden, keep `npm_config_cache` on the shared npm cache, and prefer `npm ci --prefer-offline`.

## Changing a skill or plugin

`MANIFEST.json` records the size and SHA256 of every published file, and CI fails if it is stale:

1. Commit the package change.
2. Run `python3 scripts/generate_manifest.py`, then commit `MANIFEST.json` separately.
3. Run `python3 scripts/verify_manifest.py`.

If you would rather not regenerate the manifest, say so in the pull request and the maintainer will. Dependency update pull requests (Dependabot) always need this step.

Code that several plugins need, such as the daemon endpoint resolver and the atomic JSON state writer, lives once in `plugins/_shared/`. It is not a plugin and is never published, staged, or installed. Each plugin is staged on its own and cannot import it at runtime, so every plugin that uses a shared file carries a byte-identical copy in `plugins/<id>/server/vendor/`. `CONSUMERS` in `scripts/check_vendored.py` names those plugins; add or remove a plugin there when it starts or stops vendoring a file. Change the file in `plugins/_shared/`, copy it over every vendored copy, and run `python3 scripts/check_vendored.py`, which fails on a missing, differing, or unlisted copy; CI runs it on every push.

Rules that a check enforces, run locally exactly as CI runs them. A line that must break a rule carries an inline exception with a reason and an expiry date, in the form the check names.

| Rule | Check |
| --- | --- |
| Plugin code gets the Paseo home and daemon address only from `paseoHome()` and `resolveDaemonTarget()` in `plugins/_shared/daemon-target.ts`, so state and calls follow the daemon the plugin runs in. | `python3 scripts/check_daemon_env.py` |

A new skill also needs a row in the [README Skills table](../README.md#skills) and, if it is portable, a place in a `.claude-plugin/marketplace.json` plugin.

## Rules CI enforces

Each rule has a check that fails on the mistake it names. An exception goes on the offending line with a reason and an expiry date, for example `// raw-write-ok: <reason>; expires YYYY-MM-DD` or `# probe-ok: <reason>; expires YYYY-MM-DD`; an expired exception fails the check.

| Rule | Check |
| --- | --- |
| Plugins write state only through `plugins/_shared/atomic-json.ts`, and remote programs write and delete only through `replaceFile()` and `removeFile()` in `remote_common.js` (existing raw writes may only shrink). | `python3 scripts/check_io.py raw-write` |
| An error is not absence: only ENOENT or ENOTDIR mean a path is absent, and any other error propagates. Probe with `probe()` or `isAbsent()` from `plugins/_shared/fs-probe.ts` (vendored) or `remote_common.js`, or `probe()` and `ABSENT` from `personal-skills/scripts/probe.py`, never `existsSync`, a catch or `except OSError` that only returns a default, or `if not p.is_dir(): return {}`. Existing probes are counted per file and may only shrink against the merge base. Review still covers the cases no pattern sees: incomplete pagination, a broken toggle read as its default, a fallback profile. | `python3 scripts/check_io.py fail-open-probe` (CI passes `--base`) |

## Releases

Loadout uses [semantic versioning](https://semver.org). Changes are listed under "Unreleased" in [CHANGELOG.md](../CHANGELOG.md) and move to a version heading at release, which also bumps the marketplace plugin versions and tags `vX.Y.Z`.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
