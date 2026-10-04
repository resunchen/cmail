"""Render only non-secret settings. Secret values never enter this process."""
import json
import os
from pathlib import Path
import re
import sys
import tomllib

KEYS = (
    'NAME', 'CUSTOM_DOMAIN', 'DOMAIN', 'ADMIN', 'AI_MODEL', 'ANALYSIS_CACHE',
    'D1_DATABASE_ID', 'KV_NAMESPACE_ID', 'R2_BUCKET_NAME', 'PROJECT_LINK',
    'LINUXDO_CLIENT_ID', 'LINUXDO_CALLBACK_URL', 'LINUXDO_SWITCH',
)


def render(env, template):
    name = env.get('NAME', '')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}', name):
        raise ValueError('Invalid Worker name')
    if not env.get('ADMIN', '').strip():
        raise ValueError('Missing administrator')
    domains = json.loads(env.get('DOMAIN', ''))
    if not isinstance(domains, list) or not domains or not all(isinstance(x, str) and x.strip() for x in domains):
        raise ValueError('Invalid mail domains')
    for key, pattern in [('D1_DATABASE_ID', r'[a-fA-F0-9-]{36}'), ('KV_NAMESPACE_ID', r'[a-fA-F0-9]{32}')]:
        if not re.fullmatch(pattern, env.get(key, '')):
            raise ValueError('Invalid resource identifier')
    values = {key: env.get(key, '') for key in KEYS}
    values['DOMAIN'] = domains
    for key, value in values.items():
        template = template.replace('"${' + key + '}"', json.dumps(value, ensure_ascii=False))
    if '${' in template:
        raise ValueError('Unresolved configuration setting')
    config = tomllib.loads(template)
    # Build before credentials are made available; Wrangler must not run build hooks.
    config.pop('build', None)
    config['keep_vars'] = False
    config['d1_databases'][0]['database_name'] = name
    if not values['CUSTOM_DOMAIN']:
        config.pop('routes', None)
    if not values['R2_BUCKET_NAME']:
        config.pop('r2_buckets', None)
    if env.get('CF_EMAIL', '').lower() == 'true':
        config['send_email'] = [{'name': 'email'}]
    if not values['PROJECT_LINK']:
        config['vars'].pop('project_link', None)
    enabled = values['LINUXDO_SWITCH'].lower() == 'true'
    config['vars']['linuxdo_switch'] = enabled
    if not enabled:
        for key in ('linuxdo_client_id', 'linuxdo_callback_url'):
            config['vars'].pop(key, None)
    config['secrets'] = {'required': ['jwt_secret'] + (['linuxdo_client_secret'] if enabled else [])}
    return config


if __name__ == '__main__':
    try:
        config = render(os.environ, Path('wrangler-action.toml').read_text())
        Path('wrangler-deploy.json').write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
        print('Non-secret deployment configuration prepared.')
    except Exception:
        print('Deployment configuration invalid; deployment blocked.', file=sys.stderr)
        sys.exit(1)
