# Playwright CLI Workflows

Use the wrapper script and snapshot often.
Assume `PWCLI` is set and `pwcli` is an alias for `bash "$PWCLI"`.
In this repo, run commands from `output/playwright/<label>/` to keep artifacts contained.

## Standard interaction loop

```bash
pwcli open https://example.com
pwcli snapshot
pwcli click e3
pwcli snapshot
```

## Form submission

```bash
pwcli open https://example.com/form --headed
pwcli snapshot
pwcli fill e1 "user@example.com"
pwcli fill e2 "password123"
pwcli click e3
pwcli snapshot
pwcli screenshot
```

## Data extraction

```bash
pwcli open https://example.com
pwcli snapshot
pwcli eval "document.title"
pwcli eval "el => el.textContent" e12
```

## Debugging and inspection

Capture console messages and network activity after reproducing an issue:

```bash
pwcli console warning
pwcli network
```

Record a trace around a suspicious flow:

```bash
pwcli tracing-start
# reproduce the issue
pwcli tracing-stop
pwcli screenshot
```

## Sessions

Use sessions to isolate work across projects:

```bash
pwcli --session marketing open https://example.com
pwcli --session marketing snapshot
pwcli --session checkout open https://example.com/checkout
```

Or set the session once:

```bash
export PLAYWRIGHT_CLI_SESSION=checkout
pwcli open https://example.com/checkout
```

## Configuration file

The CLI reads the global config `~/.playwright/cli.config.json` first, then `.playwright/cli.config.json` in the current directory, or the file given with `--config`. Keep the sandbox settings from the skill's "Browser sandbox" section; the example below only adds to them. On Windows, leave `browser.isolated` unset: the wrapper then seeds whatever profile the session uses (`browser.userDataDir` included), as the skill's "Windows: seeded profiles" section describes.

Minimal example:

```json
{
  "browser": {
    "launchOptions": {
      "headless": false
    },
    "contextOptions": {
      "viewport": { "width": 1280, "height": 720 }
    }
  }
}
```

## Troubleshooting

- If an element ref fails, run `pwcli snapshot` again and retry.
- If the page looks wrong, re-open with `--headed` and resize the window.
- If a flow depends on prior state, use a named `--session`.
- On Windows, if the wrapper stops with exit 2, nothing was started. Fix what the message names (often an unreadable `Local State` in that profile, or a refused option) and run the command again.
