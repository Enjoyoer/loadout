"""Stateless MCP stdio proxy to the stock daemon, scoped to the launching Pi agent.

Stock 0.10.3 requires create_agent.provider. The exposed tool permits omission,
then forwards the parent's exact catalog model and thinking. Explicit routes pass through.
"""
import copy, json, os, sys, urllib.request
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from credential import read_value


def forward(url, payload, spec):
    parsed = urlparse(url)
    if parsed.scheme != 'http' or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
        raise ValueError('Paseo MCP requires local HTTP')
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
               'MCP-Protocol-Version': '2025-03-26'}
    if 'mcpCredential' in spec:
        headers['Authorization'] = read_value(spec['mcpCredential'])
    request = urllib.request.Request(url, json.dumps(payload).encode(), headers, method='POST')
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=120) as response:
        raw = response.read().decode()
        if not raw: return None
        if response.headers.get_content_type() == 'text/event-stream':
            values = [json.loads(line[5:].strip()) for line in raw.splitlines() if line.startswith('data:')]
            return next((item for item in values if item.get('id') == payload.get('id')), None)
        return json.loads(raw)


def transform_list(response):
    if response and 'result' in response:
        for tool in response['result'].get('tools', []):
            if tool['name'] == 'create_agent':
                schema = tool['inputSchema']
                schema['required'] = [key for key in schema.get('required', []) if key != 'provider']
                schema['properties']['provider']['description'] = 'Optional explicit provider/model. Omit to inherit this Pi parent exact catalog model and thinking.'
                tool['description'] = 'Create a child in your workspace. Omitted provider inherits this Pi parent model and thinking. Explicit providers are preserved.'
    return response


def inherit(request, model, thinking):
    result = copy.deepcopy(request)
    if result.get('method') == 'tools/call' and result.get('params', {}).get('name') == 'create_agent':
        args = result['params'].setdefault('arguments', {})
        if 'provider' not in args:
            if not model: raise ValueError('parent route unavailable')
            args['provider'] = 'pi/' + model
            if thinking: args.setdefault('settings', {}).setdefault('thinkingOptionId', thinking)
    return result


def main():
    root = Path(__file__).parent
    spec = json.loads((root / 'runtime.json').read_text())
    url = os.environ['LOADOUT_PI_MCP_URL']
    model = os.environ.get('LOADOUT_PI_PARENT_MODEL')
    thinking = os.environ.get('LOADOUT_PI_PARENT_THINKING')
    verified = False
    for line in sys.stdin:
        request = json.loads(line)
        try:
            if request.get('method') == 'tools/call' and request.get('params', {}).get('name') == 'create_agent' and 'provider' not in request['params'].get('arguments', {}) :
                caller = parse_qs(urlparse(url).query).get('callerAgentId', [])
                if len(caller) != 1: raise ValueError('caller identity unavailable')
                status = forward(url, {'jsonrpc':'2.0','id':'loadout-parent','method':'tools/call',
                    'params':{'name':'get_agent_status','arguments':{'agentId':caller[0]}}}, spec)
                snapshot = status['result']['structuredContent']['snapshot']
                if snapshot['provider'] != 'pi': raise ValueError('caller provider changed')
                model = snapshot['model']
                thinking = snapshot.get('effectiveThinkingOptionId') or snapshot.get('runtimeInfo', {}).get('thinkingOptionId') or snapshot.get('thinkingOptionId')
                catalog = forward(url, {'jsonrpc':'2.0', 'id':'loadout-catalog', 'method':'tools/call',
                    'params':{'name':'list_models', 'arguments':{'provider':'pi'}}}, spec)
                value = catalog.get('result', {}).get('structuredContent', {})
                if not value:
                    value = json.loads(next(x['text'] for x in catalog['result']['content'] if x['type']=='text'))
                if not any(row['id'] == model for row in value.get('models', [])):
                    raise ValueError('parent model not present in Pi catalog')
                verified = True
            response = forward(url, inherit(request, model, thinking), spec)
            if request.get('method') == 'tools/list': response = transform_list(response)
        except Exception:
            # Never echo credentials, connection URLs, or request arguments.
            response = {'jsonrpc':'2.0', 'id':request.get('id'),
                        'error':{'code':-32603, 'message':'scoped Paseo MCP bridge request failed'}}
        if response is not None and 'id' in request:
            print(json.dumps(response), flush=True)

if __name__ == '__main__': main()
