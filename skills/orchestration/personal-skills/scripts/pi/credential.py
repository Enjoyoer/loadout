"""Read existing host credentials on demand. Stdout is for Pi, never diagnostics."""
import json, os, sys, tomllib
from pathlib import Path

def expand(value):
    return Path(os.path.expandvars(value)).expanduser()

def read_value(source):
    kind = source["kind"]
    if kind == "env":
        value = os.environ[source["name"]]
    else:
        path = expand(source["path"])
        if kind == "text":
            value = path.read_text().strip()
        elif kind == "env-file":
            rows = dict(line.split("=", 1) for line in path.read_text().splitlines()
                        if "=" in line and not line.lstrip().startswith("#"))
            value = rows[source["name"]].strip().strip('"').strip("'")
        else:
            value = (tomllib.loads(path.read_text()) if kind == "toml" else json.loads(path.read_text()))
            for key in source["keys"]:
                value = value[key]
    if not isinstance(value, str) or not value.strip() or "\n" in value or "\r" in value:
        raise ValueError("invalid route credential")
    return source.get("prefix", "") + value.strip()

if __name__ == "__main__":
    try:
        spec = json.loads(expand(sys.argv[1]).read_text())
        print(read_value(spec[sys.argv[2] if len(sys.argv) > 2 else "credential"]))
    except Exception:
        sys.stderr.write("existing host route credential unavailable\n")
        sys.exit(1)
