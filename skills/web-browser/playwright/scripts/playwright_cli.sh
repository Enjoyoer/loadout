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

# Windows: Chrome or Edge may start only on a profile whose Local State was just seeded, so Chrome's
# blank-password check logs no failed Windows logon. windows_profile.cjs reads the arguments as the
# CLI does, checks `open`, `attach` and `show`, stops any of them that could start Chrome on a
# profile it cannot seed, and prints a `--profile=<dir>` argument to add when the launch does not
# name its profile itself. PW_CODEGEN_NO_INSPECTOR keeps a paused headed session from opening the
# Playwright Inspector, which would start Chrome on a temporary profile.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    export PW_CODEGEN_NO_INSPECTOR=1
    for arg in "$@"; do
      if [[ "$arg" == open || "$arg" == attach || "$arg" == show ]]; then
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
