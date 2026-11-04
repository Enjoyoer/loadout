#!/usr/bin/env bash
set -euo pipefail

if ! command -v npx >/dev/null 2>&1; then
  echo "Error: npx is required but not found on PATH." >&2
  exit 1
fi

has_session_flag="false"
for arg in "$@"; do
  case "$arg" in
    --session|--session=*)
      has_session_flag="true"
      break
      ;;
  esac
done

# The CLI that ships in the stable Playwright release. @playwright/cli releases pin pre-release
# Playwright builds, so the skill pins playwright-core itself.
package="playwright-core@1.64.1"
if [[ "${has_session_flag}" != "true" && -n "${PLAYWRIGHT_CLI_SESSION:-}" ]]; then
  set -- --session "${PLAYWRIGHT_CLI_SESSION}" "$@"
fi

# Windows: seed the profile's Local State before the CLI starts Chrome or Edge on it, so Chrome's
# blank-password check logs no failed Windows logon. windows_profile.cjs reads the arguments as the
# CLI does, does nothing for commands other than `open` (and refuses `show`), stops the launch when
# it cannot seed, and prints a `--profile=<dir>` argument to add when the launch does not name its
# profile itself.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    for arg in "$@"; do
      if [[ "$arg" == open || "$arg" == show ]]; then
        resolver="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/windows_profile.cjs"
        if command -v cygpath >/dev/null 2>&1; then
          resolver="$(cygpath -w "$resolver")"
        fi
        resolved="$(npx --yes --package "$package" node "$resolver" "$@")"
        profile_arg=""
        while IFS= read -r line; do
          line="${line%$'\r'}"
          if [[ "$line" == --profile=* ]]; then
            profile_arg="$line"
          fi
        done <<<"$resolved"
        if [[ -n "$profile_arg" ]]; then
          set -- "$profile_arg" "$@"
        fi
        break
      fi
    done
    ;;
esac

exec npx --yes --package "$package" playwright-core cli "$@"
