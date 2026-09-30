# Security policy

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

You will get an acknowledgement within 7 days. Fixes are released as a new version and noted in [CHANGELOG.md](CHANGELOG.md).

## Scope

- The fleet sync scripts under `skills/orchestration/personal-skills/scripts/`, which copy files and run commands on hosts over SSH.
- The Paseo plugins under `plugins/`. They are trusted, unsandboxed code that runs inside a Paseo daemon; each README lists what it can change.
- Any skill that tells an agent to run commands, handle credentials, or change files.

Supported versions: the latest release on `main`.

## Handling secrets

The repository must never contain credentials, tokens, or private host data. If you find any, report it privately as above.
