# Contributing to Loadout

Thanks for helping. Issues and pull requests are welcome.

## Response times

The maintainer triages every new issue and pull request within 7 days: it gets a label and either a reply, a fix, or a clear next step. Security reports follow [SECURITY.md](SECURITY.md).

## What belongs here

- Portable agent skills, the fleet sync tool, and Paseo plugins that work for anyone.
- No credentials, tokens, account IDs, private host names, IP addresses, personal paths, or personal voice samples. Host-specific settings go in an ignored `references/local.md` or your private fleet directory.
- Skills adapted from other projects need a compatible license, the upstream `LICENSE.txt` in the package directory, and an entry in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- One change per pull request, with tests and docs for behavior changes.

## Set up and test

You need Python 3, Node 24 or newer, and Git.

```bash
python3 -m unittest discover -s tests          # repo tests, offline (fake ssh, paseo, npm)
node skills/orchestration/opc/scripts/validate-opc.mjs skills/orchestration/opc
(cd plugins/<id> && npm ci && npm run check)   # or npm run typecheck where there is no check
python3 examples/fleet_demo.py                 # end-to-end fleet sync against simulated hosts
```

CI runs the same checks on every pull request.

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

Code that several plugins need, such as the daemon endpoint resolver, lives once in `plugins/_shared/`. It is not a plugin and is never published, staged, or installed. Each plugin is staged on its own and cannot import it at runtime, so every plugin that uses a shared file carries a byte-identical copy in `plugins/<id>/server/vendor/`. Change the file in `plugins/_shared/`, copy it over every vendored copy, and run `python3 scripts/check_vendored.py`; CI runs it on every push.

A new skill also needs a row in [SKILLS_CATALOG.md](SKILLS_CATALOG.md) and, if it is portable, a place in a `.claude-plugin/marketplace.json` plugin.

## Releases

Loadout uses [semantic versioning](https://semver.org). Changes are listed under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) and move to a version heading at release, which also bumps the marketplace plugin versions and tags `vX.Y.Z`.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
