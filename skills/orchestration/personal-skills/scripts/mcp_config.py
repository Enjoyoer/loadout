"""Validate and select credential-free fleet Streamable HTTP MCP declarations."""
import re
from urllib.parse import urlsplit

import fleet


def validate(servers, fleet_doc):
    if not isinstance(servers, dict):
        raise fleet.FleetError("mcpServers must be an object")
    hosts = {h['name']: h for h in fleet.hosts_for(fleet_doc, 'client-config')}
    names = set()
    for name, server in servers.items():
        normalized = name.lower().replace('-', '_')
        if not re.fullmatch(r'[A-Za-z0-9_-]+', name) or normalized in names | {'gmail', 'paseo'}:
            raise fleet.FleetError("invalid, duplicate or reserved mcpServers name: " + name)
        names.add(normalized)
        fleet._keys(server, {'url', 'bearerTokenEnvVar', 'envFile', 'hosts'}, 'mcpServers.' + name)
        url = server.get('url')
        try:
            parsed = urlsplit(url) if isinstance(url, str) else None
            valid = parsed and parsed.scheme in {'http', 'https'} and parsed.hostname and parsed.port != 0
        except ValueError:
            valid = False
        if not valid or parsed.username or parsed.password or parsed.query or parsed.fragment or re.search(r'\s|\$|[\x00-\x1f]', url):
            raise fleet.FleetError('mcpServers.' + name + '.url must be an HTTP URL without credentials, query or fragment')
        if not isinstance(server.get('bearerTokenEnvVar'), str) or not re.fullmatch(r'[A-Z_][A-Z0-9_]*', server['bearerTokenEnvVar']):
            raise fleet.FleetError('mcpServers.' + name + '.bearerTokenEnvVar must be an env name')
        env_file = server.get('envFile', '~/.config/' + name + '/mcp.env')
        if not isinstance(env_file, str) or not env_file.startswith(('~/', '/')) or re.search(r'[\x00-\x1f]', env_file):
            raise fleet.FleetError('mcpServers.' + name + '.envFile must be an absolute or ~/ POSIX path')
        enabled = server.get('hosts')
        if not isinstance(enabled, dict) or not enabled:
            raise fleet.FleetError('mcpServers.' + name + '.hosts must map host names to booleans')
        for host, value in enabled.items():
            if host not in hosts or type(value) is not bool:
                raise fleet.FleetError('mcpServers.' + name + '.hosts needs client-config hosts and boolean values')
            if hosts[host]['os'] != 'windows' and 'providers' not in hosts[host].get('sync', []):
                raise fleet.FleetError('POSIX MCP hosts need the providers scope for env-file launch wiring')


def for_host(servers, host):
    return [dict(name=name, url=s['url'], bearerTokenEnvVar=s['bearerTokenEnvVar'],
                 envFile=None if host['os'] == 'windows' else s.get('envFile', '~/.config/' + name + '/mcp.env'),
                 enabled=s['hosts'][host['name']])
            for name, s in servers.items() if host['name'] in s['hosts']]


def pi_servers(servers):
    return {s['name']: {'url': s['url'], 'headers': {'Authorization': 'Bearer ${' + s['bearerTokenEnvVar'] + '}'},
                        'enabled': s['enabled'], 'exposure': 'codemode'} for s in servers}
