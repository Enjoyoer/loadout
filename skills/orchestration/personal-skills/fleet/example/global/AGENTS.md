# Example global instructions

- Keep answers short.
- Ask before publishing or deleting anything.

## Execution
- Preserve unrelated working behavior.

## Secrets
- API keys and tokens live in the team secrets manager (project <project-name>). Run commands that need them with `secret-run -- "<command>"` (keys arrive as env vars, output is hidden); add new ones with `secret-load`. Never print, paste, commit or save key values.
- Website logins: when a task the owner gave you hits a sign-in page, or the owner asks you to sign in, log in yourself instead of asking the owner to or stopping. Get only the login for that site: `bw-paste <site>`, pick the item for the account the owner named or the task implies (ask if more than one fits), then fill each field with `bw-paste <id> username` and `bw-paste <id> password` and paste. Values never print. Never look up or paste any other login, and never type a password into any tool. 2FA belongs to the owner: stop and ask.
