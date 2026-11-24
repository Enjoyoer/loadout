#!/bin/bash
# Homebrew formula adapter (macOS), read-only parts only:
#   brew-formula.sh version <formula>           installed version, one line
#   brew-formula.sh scope <formula> <version>   exit 0 only when upgrading changes exactly this formula, to exactly
#                                               this version, and it is not a cask, a service or a denied name
# Apply and rollback are not provided: Homebrew has no supported downgrade, so a rollback is unproven and rows stay
# mode hold (see README.md, gaps).
set -euo pipefail
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_ANALYTICS=1
step=${1:?step}; formula=${2:?formula}
[[ $formula =~ ^[a-z0-9][a-z0-9@+._-]{0,63}$ ]] || { echo "bad formula name" >&2; exit 2; }
# Never automatic, whatever the registry says: OS-adjacent tools, shared fleet services and their runtimes.
deny='^(cliproxyapi|cloudflared|tailscale|syncthing|node(@[0-9]+)?|python(@[0-9.]+)?|openssl(@[0-9]+)?|ca-certificates|bash|zsh|git|gh|jq|coreutils|mas|softwareupdate|docker|colima|postgresql(@[0-9]+)?|redis|php)$'

case "$step" in
  version)
    brew list --formula --versions "$formula" | awk 'NR==1 { print $NF }'
    ;;
  scope)
    version=${3:?version}
    [[ ! $formula =~ $deny ]] || { echo "denied formula" >&2; exit 1; }
    brew list --formula "$formula" >/dev/null 2>&1 || { echo "not an installed formula" >&2; exit 1; }
    if brew list --cask "$formula" >/dev/null 2>&1; then echo "cask" >&2; exit 1; fi
    if brew services list 2>/dev/null | awk -v f="$formula" '$1 == f && $2 != "none" { found=1 } END { exit !found }'; then
      echo "runs as a brew service" >&2; exit 1
    fi
    stable=$(brew info --formula --json=v2 "$formula" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s).formulae[0];process.stdout.write(f.versions.stable)})')
    [[ $stable == "$version" ]] || { echo "tap has $stable, not $version" >&2; exit 1; }
    # The dry run lists every formula the upgrade would touch, dependencies and dependents included, each section
    # under a "==> Would ..." header. Scoped means one header, for one requested package, naming only this formula.
    out=$(brew upgrade --formula --dry-run "$formula" 2>&1) || { echo "dry run failed" >&2; exit 1; }
    headers=$(printf '%s\n' "$out" | grep -c '^==> ' || true)
    header=$(printf '%s\n' "$out" | grep '^==> ' || true)
    changed=$(printf '%s\n' "$out" | grep -v '^==> ' | awk 'NF { print $1 }' | sort -u)
    [[ $headers == 1 && $header == '==> Would upgrade 1 requested outdated package' && $changed == "$formula" ]] || {
      echo "upgrade is not scoped to $formula: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)" >&2; exit 1; }
    ;;
  *) echo "unknown step" >&2; exit 2 ;;
esac
