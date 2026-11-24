#!/bin/bash
# Claude Code and Codex CLI adapter for macOS and Linux: stage the exact version beside the current one, keep the
# old one, swap one symlink atomically, roll back by re-pointing it.
#
#   cli-posix.sh claude|codex stage    --version V --txn DIR --link PATH --store DIR [--npm PATH]
#   cli-posix.sh claude|codex precheck --version V --txn DIR --store DIR [--smoke-node PATH --smoke-wrapper PATH
#                                      --smoke-base-url URL --smoke-model ID]
#   cli-posix.sh claude|codex apply    --version V --txn DIR --link PATH --store DIR
#   cli-posix.sh claude|codex rollback --txn DIR --link PATH
#
# The store layout is the one already on the hosts: Claude <store>/<V> (a native binary), Codex
# <store>/<V>/node_modules/@openai/codex/bin/codex.js. Exit 75 means "not now, nothing changed".
set -euo pipefail
umask 077

tool=${1:?tool}; step=${2:?step}; shift 2
version='' txn='' link='' store='' npm=npm smoke_node='' smoke_wrapper='' smoke_base_url='' smoke_model=''
while (($#)); do
  case "$1" in
    --version) version=$2 ;; --txn) txn=$2 ;; --link) link=$2 ;; --store) store=$2 ;; --npm) npm=$2 ;;
    --smoke-node) smoke_node=$2 ;; --smoke-wrapper) smoke_wrapper=$2 ;;
    --smoke-base-url) smoke_base_url=$2 ;; --smoke-model) smoke_model=$2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift 2
done
[[ $tool == claude || $tool == codex ]] || { echo "tool must be claude or codex" >&2; exit 2; }
[[ -z $version || $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version" >&2; exit 2; }
[[ -n $txn && -d $txn ]] || { echo "--txn must be the transaction directory" >&2; exit 2; }

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;; Darwin-x86_64) platform=darwin-x64 ;;
  Linux-x86_64) platform=linux-x64 ;; Linux-aarch64) platform=linux-arm64 ;;
  *) echo "unsupported platform" >&2; exit 2 ;;
esac

target_for() {  # the store path a version runs from
  if [[ $tool == claude ]]; then printf '%s/%s' "$store" "$1"; else printf '%s/%s/node_modules/@openai/codex/bin/codex.js' "$store" "$1"; fi
}
expect_version() {  # exact --version line of a version
  if [[ $tool == claude ]]; then printf '%s (Claude Code)' "$1"; else printf 'codex-cli %s' "$1"; fi
}
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
link_to() { local tmp="$2.autoupdate.$$"; ln -s "$1" "$tmp"; if [[ $(uname -s) == Darwin ]]; then /bin/mv -fh "$tmp" "$2"; else mv -Tf "$tmp" "$2"; fi; }
# Refuse to swap while a CLI turn of this tool runs; the caller retries at the next scheduled run.
busy() {
  local names
  if [[ $tool == claude ]]; then names='claude|[0-9]+\.[0-9]+\.[0-9]+'; else names='codex|codex-send'; fi
  ps -axo pid=,comm= 2>/dev/null | awk -v re="(^|/)(${names})\$" '$2 ~ re { found=1 } END { exit !found }'
}

stage_claude() {
  # Vendor stable channel only: the candidate must be what the vendor's stable pointer names right now. If the
  # pointer cannot be read or names another version, nothing changes and the attempt is dropped (not now).
  local stable
  stable=$(curl -fsS --retry 2 --max-time 30 "https://downloads.claude.ai/claude-code-releases/stable") || { echo "vendor stable pointer unreadable; not now" >&2; exit 75; }
  stable=${stable//[$'\r\n\t ']/}
  [[ $stable == "$version" ]] || { echo "candidate is not the vendor stable release; not now" >&2; exit 75; }
  local dest; dest=$(target_for "$version")
  if [[ -x $dest ]]; then "$dest" --version | grep -qxF "$(expect_version "$version")"; return; fi
  local base="https://downloads.claude.ai/claude-code-releases/$version"
  curl -fsS --retry 2 --max-time 30 -o "$txn/manifest.json" "$base/manifest.json"
  local want; want=$(node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const p = m.platforms && m.platforms[process.argv[2]];
    if (m.version !== process.argv[3] || !p || !/^[0-9a-f]{64}$/.test(p.checksum)) process.exit(1);
    process.stdout.write(p.checksum);' "$txn/manifest.json" "$platform" "$version")
  curl -fsS --retry 2 --max-time 600 -o "$txn/claude.part" "$base/$platform/claude"
  [[ $(sha256 "$txn/claude.part") == "$want" ]] || { echo "checksum mismatch" >&2; exit 1; }
  chmod 755 "$txn/claude.part"
  "$txn/claude.part" --version | grep -qxF "$(expect_version "$version")"
  mkdir -p "$store"
  [[ ! -e $dest ]]
  mv "$txn/claude.part" "$dest"
}

stage_codex() {
  local dest="$store/$version"
  if [[ -x $(target_for "$version") ]]; then "$(target_for "$version")" --version | grep -qxF "$(expect_version "$version")"; return; fi
  "$npm" install --no-audit --no-fund --save-exact --prefix "$txn/codex-$version" "@openai/codex@$version"
  "$txn/codex-$version/node_modules/@openai/codex/bin/codex.js" --version | grep -qxF "$(expect_version "$version")"
  mkdir -p "$store"
  [[ ! -e $dest ]]
  mv "$txn/codex-$version" "$dest"
}

precheck() {
  local bin; bin=$(target_for "$version")
  [[ -x $bin ]]
  "$bin" --version | grep -qxF "$(expect_version "$version")"
  if [[ $tool == codex ]]; then "$bin" exec --help >/dev/null; fi
  [[ -z $smoke_model ]] && return 0
  # Smoke: one no-tools turn of the staged binary through the configured provider path, with MCP
  # servers connected, before anything is swapped.
  [[ $tool == claude && -n $smoke_node && -n $smoke_wrapper && -n $smoke_base_url ]] || { echo "smoke needs node, wrapper and base URL" >&2; exit 2; }
  ANTHROPIC_BASE_URL=$smoke_base_url DISABLE_AUTOUPDATER=1 "$smoke_node" "$smoke_wrapper" --provider claude -- \
    "$bin" --model "$smoke_model" -p 'Do not call tools. Reply with exactly: ok' --max-turns 1 \
    --output-format stream-json --verbose --no-session-persistence > "$txn/smoke.jsonl" 2> "$txn/smoke.err"
  node -e '
    const rows = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const init = rows.find((r) => r.type === "system" && r.subtype === "init");
    const done = rows.find((r) => r.type === "result");
    const mcpOk = init && Array.isArray(init.mcp_servers) && init.mcp_servers.every((s) => s.status === "connected");
    process.exit(init && mcpOk && done && done.is_error === false && done.result === "ok" ? 0 : 1);' "$txn/smoke.jsonl"
}

apply() {
  local new; new=$(target_for "$version")
  [[ -L $link && -x $new ]] || { echo "link or staged target missing" >&2; exit 1; }
  local old; old=$(readlink "$link")
  if busy; then echo "CLI process running; not now" >&2; exit 75; fi
  printf '%s\n' "$old" > "$txn/previous-target"
  link_to "$new" "$link"
  [[ $(readlink "$link") == "$new" ]]
  "$link" --version | grep -qxF "$(expect_version "$version")"
}

rollback() {
  [[ -s $txn/previous-target ]] || { echo "no previous target recorded; nothing was swapped" >&2; exit 0; }
  local old; old=$(<"$txn/previous-target")
  [[ -L $link ]]
  [[ $(readlink "$link") == "$old" ]] && exit 0
  link_to "$old" "$link"
  [[ $(readlink "$link") == "$old" ]]
}

case "$step" in
  stage) [[ -n $version && -n $store ]]; if [[ $tool == claude ]]; then stage_claude; else stage_codex; fi ;;
  precheck) [[ -n $version && -n $store ]]; precheck ;;
  apply) [[ -n $version && -n $store && -n $link ]]; apply ;;
  rollback) [[ -n $link ]]; rollback ;;
  *) echo "unknown step $step" >&2; exit 2 ;;
esac
