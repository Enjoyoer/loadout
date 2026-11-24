#!/bin/bash
# Tier 2 access-path checks (macOS, Linux), read-only:
#   access-health.sh tailscale-version | rustdesk-version     installed version, one line
#   access-health.sh snapshot <txn>                           save Tailscale state and serve config before a change
#   access-health.sh tailscale <txn>                          Tailscale up, same tailnet IP, serve config unchanged
#   access-health.sh rustdesk                                 RustDesk service running (the other path back in)
# The apply adapters for Tailscale and RustDesk do not exist yet; see README.md, gaps.
set -euo pipefail
umask 077
step=${1:?step}
ts() {
  if command -v tailscale >/dev/null; then tailscale "$@";
  elif [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then /Applications/Tailscale.app/Contents/MacOS/Tailscale "$@";
  else echo "tailscale not found" >&2; return 1; fi
}
rd() {
  if [[ -x /Applications/RustDesk.app/Contents/MacOS/RustDesk ]]; then /Applications/RustDesk.app/Contents/MacOS/RustDesk "$@"; else rustdesk "$@"; fi
}
self_ip() { ts status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.BackendState!=="Running")process.exit(1);process.stdout.write((j.Self.TailscaleIPs||[]).join(","))})'; }

case "$step" in
  tailscale-version) ts version | head -1 ;;
  rustdesk-version) rd --version | head -1 ;;
  snapshot)
    txn=${2:?txn}
    self_ip > "$txn/tailscale-ips"
    ts serve status --json > "$txn/tailscale-serve.json"
    ;;
  tailscale)
    txn=${2:?txn}
    for _ in 1 2 3 4 5 6; do ip=$(self_ip 2>/dev/null) && break; sleep 10; done
    [[ ${ip:-} == "$(<"$txn/tailscale-ips")" ]] || { echo "tailnet IPs changed or Tailscale not running" >&2; exit 1; }
    ts serve status --json > "$txn/tailscale-serve.after.json"
    cmp -s "$txn/tailscale-serve.json" "$txn/tailscale-serve.after.json" || { echo "serve config changed" >&2; exit 1; }
    ;;
  rustdesk)
    pgrep -x -i rustdesk >/dev/null || { echo "RustDesk not running" >&2; exit 1; }
    ;;
  *) echo "unknown step" >&2; exit 2 ;;
esac
