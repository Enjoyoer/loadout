# Example global instructions

- Keep answers short.
- Ask before publishing or deleting anything.

## Execution
- Preserve unrelated working behavior.

## Secrets
- API keys and tokens live in the team secrets manager (project <project-name>). Run commands that need them with `secret-run -- "<command>"` (keys arrive as env vars, output is hidden); add new ones with `secret-load`. Never print, paste, commit or save key values.
- Website logins: `bw-login --list <site>`, then `bw-login <id>`. Use the password only to sign in; never repeat or store it. 2FA belongs to the owner: stop and ask.
