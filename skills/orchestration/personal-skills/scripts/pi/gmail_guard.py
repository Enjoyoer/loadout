"""Stdio guard in front of the read-only Gmail MCP server: Worker agents get no Gmail.

JSON-RPC passes through unchanged. On the first tools/call the guard reads the calling agent's
labels from the loopback Paseo MCP (get_agent_status) and caches them for the process. A role=worker
agent gets a tool error for that call and every later one. A failed lookup forwards, as before,
with one stderr line. tools/list is unchanged; the server's allow-list and blocked tools still apply.
"""
import json, os, subprocess, sys, threading
from urllib.parse import urlparse, parse_qs
from mcp_bridge import forward

REFUSAL = 'Gmail is not available to Worker agents'


def caller_role(url, spec):
    caller = os.environ.get('PASEO_AGENT_ID') or (parse_qs(urlparse(url).query).get('callerAgentId') or [None])[0]
    if not caller: raise ValueError('caller identity unavailable')
    status = forward(url, {'jsonrpc':'2.0', 'id':'loadout-gmail-guard', 'method':'tools/call',
        'params':{'name':'get_agent_status', 'arguments':{'agentId':caller}}}, spec, timeout=5)
    if not status or 'error' in status or status.get('result', {}).get('isError'):
        raise ValueError('agent snapshot unavailable')
    labels = status['result']['structuredContent']['snapshot']['labels']
    return labels.get('role')


def refusal(request):
    return {'jsonrpc':'2.0', 'id':request.get('id'), 'result':{'content':[{'type':'text', 'text':REFUSAL}], 'isError':True}}


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(root, 'runtime.json')) as f: spec = json.load(f)
    url = os.environ.get('LOADOUT_PI_MCP_URL', '')
    env = {k: v for k, v in os.environ.items() if k != 'LOADOUT_PI_MCP_URL'}
    child = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    lock = threading.Lock()

    def write(data):
        with lock:
            sys.stdout.buffer.write(data); sys.stdout.buffer.flush()

    def pump():
        for line in child.stdout: write(line)
    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    role, checked = None, False
    for line in sys.stdin.buffer:
        try: request = json.loads(line)
        except ValueError: request = None
        if isinstance(request, dict) and request.get('method') == 'tools/call':
            if not checked:
                checked = True
                try:
                    role = caller_role(url, spec)
                except Exception as error:
                    # Never echo credentials, connection URLs, or request arguments.
                    print(f'Gmail guard forwarding: agent label lookup failed ({type(error).__name__})', file=sys.stderr, flush=True)
            if role == 'worker':
                if 'id' in request: write((json.dumps(refusal(request)) + '\n').encode())
                continue
        try:
            child.stdin.write(line); child.stdin.flush()
        except (BrokenPipeError, OSError):
            break
    try: child.stdin.close()
    except OSError: pass
    code = child.wait()
    reader.join(timeout=5)
    sys.exit(code)

if __name__ == '__main__': main()
