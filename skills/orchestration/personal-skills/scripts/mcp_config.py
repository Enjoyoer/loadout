"""Validate and select credential-free fleet Streamable HTTP MCP declarations."""
import json
import re
from urllib.parse import urlsplit

import fleet


def _check_url(url, where):
    try:
        parsed = urlsplit(url) if isinstance(url, str) else None
        valid = parsed and parsed.scheme in {'http', 'https'} and parsed.hostname and parsed.port != 0
    except ValueError:
        valid = False
    if not valid or parsed.username or parsed.password or parsed.query or parsed.fragment or re.search(r'\s|\$|[\x00-\x1f]', url):
        raise fleet.FleetError(where + ' must be an HTTP URL without credentials, query or fragment')


def _pi_gmail_hosts(providers_path, host_names):
    """Hosts whose effective Pi runtime in paseo-providers.json still has the built-in `gmail` block."""
    if providers_path is None or not providers_path.exists():
        return set()
    try:
        doc = json.loads(providers_path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise fleet.FleetError(f"cannot read {providers_path}: {error}") from error
    hosts = doc.get('hosts', {}) if isinstance(doc, dict) else {}
    found = set()
    for host in host_names:
        settings = hosts.get(host, {}) if isinstance(hosts.get(host), dict) else {}
        pi = settings.get('pi', doc.get('pi'))
        if isinstance(pi, dict) and isinstance(pi.get('runtime'), dict) and 'gmail' in pi['runtime']:
            found.add(host)
    return found


def validate(servers, fleet_doc, providers_path=None):
    if not isinstance(servers, dict):
        raise fleet.FleetError("mcpServers must be an object")
    hosts = {h['name']: h for h in fleet.hosts_for(fleet_doc, 'client-config')}
    names = set()
    for name, server in servers.items():
        normalized = name.lower().replace('-', '_')
        if not re.fullmatch(r'[A-Za-z0-9_-]+', name) or normalized in names | {'paseo'}:
            raise fleet.FleetError("invalid, duplicate or reserved mcpServers name: " + name)
        names.add(normalized)
        fleet._keys(server, {'url', 'bearerTokenEnvVar', 'envFile', 'hosts'}, 'mcpServers.' + name)
        _check_url(server.get('url'), 'mcpServers.' + name + '.url')
        if not isinstance(server.get('bearerTokenEnvVar'), str) or not re.fullmatch(r'[A-Z_][A-Z0-9_]*', server['bearerTokenEnvVar']):
            raise fleet.FleetError('mcpServers.' + name + '.bearerTokenEnvVar must be an env name')
        env_file = server.get('envFile', '~/.config/' + name + '/mcp.env')
        if not isinstance(env_file, str) or not env_file.startswith(('~/', '/')) or re.search(r'[\x00-\x1f]', env_file):
            raise fleet.FleetError('mcpServers.' + name + '.envFile must be an absolute or ~/ POSIX path')
        enabled = server.get('hosts')
        if not isinstance(enabled, dict) or not enabled:
            raise fleet.FleetError('mcpServers.' + name + '.hosts must map host names to booleans or {"url": ...}')
        for host, value in enabled.items():
            if isinstance(value, dict):
                fleet._keys(value, {'url'}, 'mcpServers.' + name + '.hosts.' + str(host))
                _check_url(value.get('url'), 'mcpServers.' + name + '.hosts.' + str(host) + '.url')
            if host not in hosts or not (type(value) is bool or isinstance(value, dict)):
                raise fleet.FleetError('mcpServers.' + name + '.hosts needs client-config hosts and boolean or {"url": ...} values')
            if hosts[host]['os'] != 'windows' and 'providers' not in hosts[host].get('sync', []):
                raise fleet.FleetError('POSIX MCP hosts need the providers scope for env-file launch wiring')
        if normalized == 'gmail':
            # Any listed host, even false, gets a Pi mcp.json entry that would replace the built-in server.
            clash = sorted(_pi_gmail_hosts(providers_path, enabled))
            if clash:
                raise fleet.FleetError('mcpServers.' + name + ' lists host(s) ' + ', '.join(clash) + ' that still have '
                                       'a Pi gmail block in paseo-providers.json; remove that block or the host entry')


def for_host(servers, host):
    # A host value is true, false, or {"url": ...}: enabled with that URL instead of the top-level one.
    return [dict(name=name, url=(s['hosts'][host['name']] if isinstance(s['hosts'][host['name']], dict) else s)['url'],
                 bearerTokenEnvVar=s['bearerTokenEnvVar'],
                 envFile=None if host['os'] == 'windows' else s.get('envFile', '~/.config/' + name + '/mcp.env'),
                 enabled=s['hosts'][host['name']] is not False)
            for name, s in servers.items() if host['name'] in s['hosts']]


def pi_servers(servers):
    return {s['name']: {'url': s['url'], 'headers': {'Authorization': 'Bearer ${' + s['bearerTokenEnvVar'] + '}'},
                        'enabled': s['enabled'], 'exposure': 'codemode'} for s in servers}
