"""Stage or apply the pinned Pi agent home. No credential contents are written."""
import argparse, copy, csv, io, json, os, re, shutil, subprocess, sys, tomllib
from datetime import datetime, timezone
from pathlib import Path
from credential import expand

FILES = ("credential.py", "launch.mjs", "mcp_bridge.py", "fleet-routing.mjs")

# Optional read-only Gmail (workspace-mcp). Read-only is enforced three times: the
# server's --read-only mode (gmail.readonly scope, write tools removed), an explicit
# --disabled-tools list, and a Pi allowlist on a hidden server. Only `email`, `home`
# and `port` are configurable; the token and client JSON stay in `home`, owner-only.
GMAIL_READ_TOOLS = ("search_gmail_messages", "get_gmail_message_content", "get_gmail_messages_content_batch",
                    "get_gmail_thread_content", "get_gmail_threads_content_batch", "get_gmail_attachment_content",
                    "list_gmail_labels")
GMAIL_BLOCKED_TOOLS = ("start_google_auth", "send_gmail_message", "draft_gmail_message", "modify_gmail_message_labels",
                       "batch_modify_gmail_message_labels", "manage_gmail_label", "manage_gmail_filter")

def gmail_server(cfg):
    if not isinstance(cfg, dict) or not {"email", "home"} <= cfg.keys() or cfg.keys() - {"email", "home", "port"}:
        raise ValueError("gmail needs exactly email, home and optional port")
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", cfg["email"]): raise ValueError("gmail email invalid")
    port = cfg.get("port", 47863)
    if not isinstance(port, int) or not 1024 < port < 65536: raise ValueError("gmail port invalid")
    home = expand(cfg["home"])
    exe = home / "venv" / ("Scripts/workspace-mcp.exe" if os.name == "nt" else "bin/workspace-mcp")
    return {"command": str(exe),
            "args": ["--single-user", "--tools", "gmail", "--read-only", "--disabled-tools", *GMAIL_BLOCKED_TOOLS],
            "exposure": "hidden", "toolExposure": {name: "codemode" for name in GMAIL_READ_TOOLS},
            "description": "Read-only Gmail for " + cfg["email"] + ": search and read messages, threads, attachments and labels. Cannot send, draft, label or delete.",
            "env": {"GOOGLE_CLIENT_SECRET_PATH": str(home / "client_secret.json"), "WORKSPACE_MCP_CREDENTIALS_DIR": str(home / "credentials"),
                    "USER_GOOGLE_EMAIL": cfg["email"], "WORKSPACE_MCP_HOST": "127.0.0.1", "WORKSPACE_MCP_PORT": str(port)}}

# Optional direct providers: unauthenticated OpenAI-compatible endpoints (for example a
# local model gate) that bypass the router. Each model is listed once here; the Paseo
# picker rows derive from the same list. No credentials, headers or compat flags.
DIRECT_API = "openai-completions"
DIRECT_NO_AUTH_KEY = "local-no-auth"  # dummy key Pi needs to list the model; the endpoint ignores it
LEVELS = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
DIRECT_MODEL_KEYS = {"id", "name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "thinkingLevelMap"}
RESERVED_PROVIDERS = {"fleet", "opencode", "llama.cpp", "llama-cpp", "llamacpp"}

def direct_providers(spec):
    providers = spec.get("directProviders", {})
    if not isinstance(providers, dict): raise ValueError("directProviders must be an object")
    out = {}
    for name, cfg in providers.items():
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", name) or name in RESERVED_PROVIDERS | {spec.get("modelProvider", "fleet")}:
            raise ValueError("direct provider name invalid or reserved: " + name)
        if not isinstance(cfg, dict) or set(cfg) != {"baseUrl", "api", "auth", "models"}:
            raise ValueError("direct provider needs exactly baseUrl, api, auth and models")
        if not re.fullmatch(r"https?://[^\s/]+(/\S*)?", cfg["baseUrl"]): raise ValueError("direct provider baseUrl invalid")
        if cfg["api"] != DIRECT_API: raise ValueError("direct provider api must be " + DIRECT_API)
        if cfg["auth"] != "none": raise ValueError("direct provider auth must be none")
        models = cfg["models"]
        if not isinstance(models, list) or not models: raise ValueError("direct provider models required")
        rows = []
        for model in models:
            if not isinstance(model, dict) or set(model) != DIRECT_MODEL_KEYS:
                raise ValueError("direct model needs exactly " + ", ".join(sorted(DIRECT_MODEL_KEYS)))
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", model["id"]) or not model["name"].strip():
                raise ValueError("direct model id or name invalid")
            levels = model["thinkingLevelMap"]
            if not isinstance(levels, dict) or set(levels) != set(LEVELS) or not all(v is None or isinstance(v, str) for v in levels.values()):
                raise ValueError("direct model thinkingLevelMap must map every level to a string or null")
            if bool(model["reasoning"]) != any(levels[l] for l in LEVELS if l != "off"):
                raise ValueError("direct model reasoning must match its thinking levels")
            rows.append(copy.deepcopy(model))
        if len({m["id"] for m in rows}) != len(rows): raise ValueError("duplicate direct model id")
        out[name] = {"baseUrl": cfg["baseUrl"], "api": DIRECT_API, "apiKey": DIRECT_NO_AUTH_KEY, "models": rows}
    return out

def validate_settings(settings):
    if settings.get('codemode') != {'mode': 'on'} or settings.get('defaultTools') != ['+codemode']:
        raise ValueError('Pi requires fixed Codemode on and defaultTools +codemode')

def quote(value):
    # Pi runs !commands in the host shell. Reject shell expansions rather than guess.
    if any(char in value for char in "\n\r`$%!"):
        raise ValueError("unsafe helper command path")
    return '"' + value.replace('"', '\\"') + '"'

def build(spec, root):
    credential = spec["credential"]
    if "value" in credential or "apiKey" in spec:
        raise ValueError("credentials must reference existing sources")
    base = spec.get("baseUrl")
    if not base:
        route = spec["route"]
        doc = tomllib.loads(expand(route["path"]).read_text())
        for key in route["keys"]: doc = doc[key]
        base = doc
    if not isinstance(base, str) or not base.startswith(("http://", "https://")):
        raise ValueError("route base URL required")
    helper = "!" + " ".join(quote(v) for v in [spec.get("python", sys.executable), str(root / "credential.py"), str(root / "runtime.json")])
    if {'codemode', 'defaultTools', 'extensions', 'skills'} & spec.get('settings', {}).keys():
        raise ValueError('Codemode and its runtime check are fixed, not overridable settings')
    settings = {"codemode": {"mode": "on"}, "defaultTools": ["+codemode"], "enableInstallTelemetry": False,
                "defaultProjectTrust": "never", "cacheWarming": "off", "extensions": [str(root / "fleet-routing.mjs")],
                "skills": [str(root / 'agent/skills')]}
    settings.update(spec.get("settings", {}))
    validate_settings(settings)
    required_settings = {"defaultProvider", "defaultModel", "defaultThinkingLevel"}
    if not required_settings <= settings.keys():
        raise ValueError("existing model and thinking defaults must be supplied")
    models = copy.deepcopy(spec["models"])
    if not models or any("apiKey" in model for model in models):
        raise ValueError("host model catalog required without embedded credentials")
    if settings["defaultModel"] not in {row["id"] for row in models}:
        raise ValueError("inherited default absent from host catalog")
    for row in models:
        # Anthropic's SDK appends /v1/messages, unlike the Responses client.
        if row.get("api") == "anthropic-messages": row["baseUrl"] = base.rstrip('/').removesuffix('/v1')
    headers = {name: helper for name in spec.get("credentialHeaders", [])}
    model = {"providers": {spec.get("modelProvider", "fleet"): {"baseUrl": base, "apiKey": helper,
        "headers": headers, "api": "openai-responses", "models": models}}}
    model["providers"].update(direct_providers(spec))
    mcp = {"autoEnableCodemode": True, "mcpServers": {"paseo": {
           "command": spec.get("python", sys.executable), "args": [str(root / "mcp_bridge.py")], "exposure": "codemode",
           "env": {"LOADOUT_PI_MCP_URL": "${LOADOUT_PI_MCP_URL}", "LOADOUT_PI_PARENT_MODEL": "${LOADOUT_PI_PARENT_MODEL}", "LOADOUT_PI_PARENT_THINKING": "${LOADOUT_PI_PARENT_THINKING}"}}}}
    if "gmail" in spec: mcp["mcpServers"]["gmail"] = gmail_server(spec["gmail"])
    return {"runtime.json": spec, "agent/models.json": model, "agent/settings.json": settings, "agent/mcp.json": mcp}

def safe_target(root, target):
    for part in (target, *target.parents):
        if part.is_symlink() or getattr(part, "is_junction", lambda: False)():
            raise ValueError("symlink or junction runtime target")
        if part == root: break


def secure_windows_user(root):
    if os.name != 'nt': return
    # Elevated SSH creates mode-0700 directories owned by Administrators. The
    # daemon's normal token needs its own SID, rather than an owner-group grant.
    identity = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'],
                              capture_output=True, text=True, check=True)
    sid = next(csv.reader(io.StringIO(identity.stdout)))[1].strip()
    if not re.fullmatch(r'S-1-5-(?:\d+-)*\d+', sid): raise ValueError('Windows user SID unavailable')
    backup = root / ('acl-before-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.txt')
    subprocess.run(['icacls', str(root), '/save', str(backup), '/T', '/Q'],
                   capture_output=True, text=True, check=True)
    subprocess.run(['icacls', str(root), '/grant', '*' + sid + ':(OI)(CI)F', '/T', '/Q'],
                   capture_output=True, text=True, check=True)


def configure(spec, root, dry_run=False):
    contents = {name: (json.dumps(value, indent=2) + "\n").encode() for name, value in build(spec, root).items()}
    contents.update({name: (Path(__file__).parent / name).read_bytes() for name in FILES})
    for name in contents: safe_target(root, root / name)
    changed = [name for name, data in contents.items() if not (root / name).exists() or (root / name).read_bytes() != data]
    # Back up all affected files before the first write. Caller provides a new root for install.
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    if not dry_run:
        for name in changed:
            target = root / name
            safe_target(root, target)
            if target.exists(): shutil.copy2(target, target.with_name(target.name + ".bak-" + stamp))
        for name in changed:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            temp = target.with_name(target.name + ".next")
            safe_target(root, temp)
            temp.write_bytes(contents[name]); temp.chmod(0o600); temp.replace(target)
            if target.read_bytes() != contents[name]: raise ValueError("Pi write verification failed")
        secure_windows_user(root)
        validate_settings(json.loads((root / 'agent/settings.json').read_text()))
    return {"changed": changed, "dry_run": dry_run, "root": str(root)}

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--spec", required=True); p.add_argument("--root", required=True)
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()
    print(json.dumps(configure(json.loads(expand(a.spec).read_text()), expand(a.root), a.dry_run)))
