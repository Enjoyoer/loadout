"""Read existing host credentials on demand. Stdout is for Pi, never diagnostics."""
import json, os, re, subprocess, sys, tomllib
from pathlib import Path, PurePosixPath, PureWindowsPath

# The reference fields of each source kind. A source says where the value lives, never the value.
SOURCES = {"env": {"name"}, "text": {"path"}, "env-file": {"path", "name"}, "json": {"path", "keys"},
           "toml": {"path", "keys"}, "command": {"argv"}}
# A command source runs one allowlisted secret-store reader, matched by program file name with the subcommand
# it must run (systemd-creds must also decrypt to stdout, "-"), or Python with a helper script file (never -c
# or -m). argv runs as given, with no shell or PATH lookup, so the program is an absolute path. Its stdout
# must be one line; stderr is dropped. The provider sync checks every host's argv on the source host, so the
# shape check accepts POSIX and Windows paths alike; a wrong path fails on the target at request time.
COMMAND_HELPERS = {"security": "find-generic-password", "systemd-creds": "decrypt"}
PYTHON = re.compile(r"python(3(\.\d+)?)?|py")

def expand(value):
    return Path(os.path.expandvars(value)).expanduser()

def absolute(path):
    return PurePosixPath(path).is_absolute() or PureWindowsPath(path).is_absolute()

def command_argv(source):
    argv = source.get("argv")
    if not isinstance(argv, list) or not 2 <= len(argv) <= 16 or not all(isinstance(a, str) and a and a.isprintable() for a in argv):
        raise ValueError("command credential argv must be 2 to 16 printable strings")
    name = PureWindowsPath(argv[0]).name.lower().removesuffix(".exe")  # splits on / and \
    script = PYTHON.fullmatch(name) and argv[1].lower().endswith(".py") and absolute(argv[1])
    helper = COMMAND_HELPERS.get(name) == argv[1] and (name != "systemd-creds" or argv[-1] == "-")
    if not absolute(argv[0]) or not (script or helper):
        raise ValueError("command credential must run an allowlisted helper by absolute path")
    return argv

def check_source(source):
    """Refuse anything but an exact reference: a known kind with only its own fields, so no value rides along."""
    fields = SOURCES.get(source.get("kind")) if isinstance(source, dict) and isinstance(source.get("kind"), str) else None
    if fields is None or set(source) != fields | {"kind"}:
        raise ValueError("credential source needs a known kind and exactly its reference fields")
    if not all(isinstance(source[k], str) and source[k].strip() for k in fields & {"name", "path"}):
        raise ValueError("credential source name and path must be non-empty strings")
    if "keys" in fields and not (isinstance(source["keys"], list) and source["keys"] and all(isinstance(k, str) for k in source["keys"])):
        raise ValueError("credential source keys must be a non-empty list of strings")
    if "argv" in fields: command_argv(source)
    return source

def read_value(source):
    kind = source["kind"]
    if kind == "env":
        value = os.environ[source["name"]]
    elif kind == "command":
        done = subprocess.run(command_argv(source), stdin=subprocess.DEVNULL, capture_output=True,
                              encoding="utf-8", timeout=8)
        if done.returncode: raise ValueError("credential helper failed")
        value = done.stdout.strip()
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
        raise ValueError("invalid host credential")
    return source.get("prefix", "") + value.strip()

if __name__ == "__main__":
    # credential.py RUNTIME_JSON [KEY ...]: the source at that key path, by default the route's "credential".
    try:
        source = json.loads(expand(sys.argv[1]).read_text())
        for key in sys.argv[2:] or ["credential"]: source = source[key]
        print(read_value(source))
    except Exception:
        sys.stderr.write("existing host credential unavailable\n")
        sys.exit(1)
