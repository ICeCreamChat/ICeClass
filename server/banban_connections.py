"""Account-owned OpenAI-compatible connections and public-only upstream access."""
from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlsplit, urlunsplit

from aiohttp import TCPConnector
from aiohttp.abc import AbstractResolver
from aiohttp.resolver import DefaultResolver

DEFAULT_BASE_URL = 'https://api.deepseek.com'
DEFAULT_MODEL = 'deepseek-flash'


def public_address(address):
    try:
        ip = ipaddress.ip_address(address)
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if isinstance(ip, ipaddress.IPv6Address):
            if ip.sixtofour or ip.teredo:
                return False
            if ip in ipaddress.ip_network('64:ff9b::/96') and not public_address(str(ipaddress.IPv4Address(int(ip) & 0xffffffff))):
                return False
        return ip.is_global and not ip.is_multicast and not ip.is_unspecified
    except ValueError:
        return False


def normalize_base_url(value):
    if not isinstance(value, str) or len(value) > 1000 or re.search(r'[\s\\\x00-\x1f\x7f]', value):
        raise ValueError('服务地址格式不正确，请填写完整的 HTTPS Base URL。')
    try:
        parts = urlsplit(value.strip())
        host, port = parts.hostname, parts.port
        if parts.scheme != 'https' or not host or parts.username is not None or parts.password is not None or parts.query or parts.fragment:
            raise ValueError()
        host = host.rstrip('.').lower().encode('idna').decode('ascii')
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if '.' not in host or host.endswith(('.localhost', '.local', '.internal', '.test', '.invalid')):
                raise ValueError()
            if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', host):
                raise ValueError()
        else:
            if not public_address(host):
                raise ValueError()
        if port is not None and not 1 <= port <= 65535:
            raise ValueError()
        authority = f'[{host}]' if ':' in host else host
        if port and port != 443:
            authority += f':{port}'
        path = parts.path.rstrip('/')
        # Accept a pasted full completion endpoint without appending it twice.
        if path.endswith('/chat/completions'):
            path = path[:-len('/chat/completions')].rstrip('/')
        return urlunsplit(('https', authority, path, '', ''))
    except (ValueError, UnicodeError):
        raise ValueError('请使用公网 HTTPS 服务地址，不支持本机、内网地址或带有密钥的链接。') from None


def completion_url(cfg):
    return normalize_base_url(cfg.get('baseUrl', DEFAULT_BASE_URL)) + '/chat/completions'


def provider_options(cfg):
    # Provider-specific extensions must not break other compatible services.
    host = urlsplit(cfg.get('baseUrl', DEFAULT_BASE_URL)).hostname or ''
    model = cfg.get('model', '').lower()
    if host == 'api.deepseek.com' or (
            host == 'ark.cn-beijing.volces.com' and model == 'doubao-seed-2-1-pro-260915') or (
            host in {'api.moonshot.cn', 'api.moonshot.ai'} and model in {'kimi-k2.5', 'kimi-k2.6'}) or (
            host == 'open.bigmodel.cn' and model.startswith(('glm-4.5', 'glm-4.6', 'glm-4.7'))):
        return {'thinking': {'type': 'disabled'}}
    if is_bailian(host) and model in {'qwen-plus', 'qwen-flash'}:
        return {'enable_thinking': False}
    return {}


def is_bailian(host):
    return host in {'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'} or host.endswith('.maas.aliyuncs.com')


def required_tool_choice(cfg):
    # These services do not consistently support OpenAI's "required" enum.
    # The agent still refuses to answer data questions without a tool result.
    host = urlsplit(cfg.get('baseUrl', DEFAULT_BASE_URL)).hostname or ''
    if is_bailian(host) or host in {'open.bigmodel.cn', 'api.moonshot.cn', 'api.moonshot.ai'}:
        return 'auto'
    return 'required'


class PublicResolver(AbstractResolver):
    """Check the actual DNS result at connection time, including DNS rebinding."""
    def __init__(self):
        self.resolver = DefaultResolver()

    async def resolve(self, host, port=0, family=socket.AF_INET):
        addresses = await self.resolver.resolve(host, port, family)
        if not addresses or any(not public_address(item['host']) for item in addresses):
            raise ValueError('该服务地址解析到了本机或内网，无法连接。请检查 Base URL。')
        return addresses

    async def close(self):
        await self.resolver.close()


def upstream_connector():
    return TCPConnector(resolver=PublicResolver(), use_dns_cache=False)


def validate_config(body, previous):
    if type(body.get('enabled')) is not bool:
        raise ValueError('请选择是否启用智能分析。')
    base = body.get('baseUrl', previous.get('baseUrl', DEFAULT_BASE_URL))
    if base:
        base = normalize_base_url(base)
    elif not isinstance(base, str):
        raise ValueError('请填写服务地址 Base URL。')
    model = body.get('model', previous.get('model', ''))
    if not isinstance(model, str) or (model and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:@+\-]{0,199}', model)):
        raise ValueError('模型名称格式不正确，请填写服务商提供的模型 ID。')
    key = body.get('apiKey', '')
    if not isinstance(key, str) or (key and not re.fullmatch(r'[\x21-\x7e]{1,4096}', key)):
        raise ValueError('API Key 格式不正确，请检查是否完整复制。')
    if not key and previous.get('apiKey') and base != previous.get('baseUrl', DEFAULT_BASE_URL) and body.get('clearKey') is not True:
        raise ValueError('服务地址已更改，请重新填写与该地址对应的 API Key。')
    key = '' if body.get('clearKey') is True else key or previous.get('apiKey', '')
    if body['enabled'] and not (base and model):
        raise ValueError('请填写服务地址和模型名称。')
    return {'enabled': body['enabled'], 'baseUrl': base, 'model': model, 'apiKey': key}


def public_config(cfg):
    return {key: cfg[key] for key in ('enabled', 'baseUrl', 'model')} | {'configured': bool(cfg['apiKey'])}


class AccountConnections:
    def __init__(self, db, school_config):
        self.db, self.school_config = db, school_config
        db.run('''CREATE TABLE IF NOT EXISTS banban_connections(
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            source TEXT NOT NULL CHECK(source IN ('school','personal')),
            enabled INTEGER NOT NULL DEFAULT 1, base_url TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '')''')

    def own(self, user):
        row = self.db.one('SELECT * FROM banban_connections WHERE user_id=?', (user['id'],))
        if not row:
            return 'school', {'enabled': True, 'baseUrl': '', 'model': '', 'apiKey': ''}
        return row['source'], {'enabled': bool(row['enabled']), 'baseUrl': row['base_url'], 'model': row['model'], 'apiKey': row['api_key']}

    def effective(self, user):
        source, personal = self.own(user)
        return {**(personal if source == 'personal' else self.school_config()), 'source': source}

    def public(self, user):
        source, personal = self.own(user)
        school = self.school_config()
        cfg = personal if source == 'personal' else school
        return {'source': source, 'configured': bool(cfg['apiKey']), 'enabled': cfg['enabled'],
                'personal': public_config(personal),
                'school': {'configured': bool(school['apiKey']), 'enabled': school['enabled']},
                'canManageSchool': user['role'] == 'superadmin'}

    def save(self, user, body):
        if not isinstance(body, dict) or body.get('source') not in {'school', 'personal'}:
            raise ValueError('请选择学校连接或自己的连接。')
        if set(body) - {'source', 'enabled', 'baseUrl', 'model', 'apiKey', 'clearKey'}:
            raise ValueError('连接设置包含无法识别的字段。')
        _, cfg = self.own(user)
        if body['source'] == 'personal':
            cfg = validate_config(body, cfg)
            if cfg['enabled'] and not cfg['apiKey']:
                raise ValueError('请填写您自己的 API Key，再保存并测试。')
        self.db.run('''INSERT INTO banban_connections VALUES(?,?,?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET source=excluded.source,enabled=excluded.enabled,
            base_url=excluded.base_url,model=excluded.model,api_key=excluded.api_key''',
                    (user['id'], body['source'], int(cfg['enabled']), cfg['baseUrl'], cfg['model'], cfg['apiKey']))
        return self.public(user)
