"""Fail closed on forbidden secret and public bootstrap deployment patterns."""
import argparse
import json
from pathlib import Path
import re
import sys
import tomllib

SENSITIVE = ('JWT_SECRET', 'LINUXDO_CLIENT_SECRET', 'CLOUDFLARE_API_TOKEN', 'D1_MIGRATION_API_TOKEN')
PLAIN_SECRET = re.compile(r'secret|token|password', re.I)


def inspect_config(config):
    if config.get('keep_vars', False):
        raise ValueError('Inherited plaintext variables are forbidden')
    for key in config.get('vars', {}):
        if PLAIN_SECRET.search(key):
            raise ValueError('Sensitive values in plain variables are forbidden')
    text = json.dumps(config)
    if any('${' + key + '}' in text for key in SENSITIVE):
        raise ValueError('Credential placeholder in configuration is forbidden')


def check(root, generated=None):
    for path in (root / 'mail-worker').glob('wrangler*.toml'):
        inspect_config(tomllib.loads(path.read_text()))
    for path in (root / '.github/workflows').glob('*.y*ml'):
        text = path.read_text()
        for key in SENSITIVE:
            if re.search(r'\bvars\s*(?:\.\s*' + key + r'\b|\[\s*[\'"]' + key + r'[\'"]\s*\])', text, re.I):
                raise ValueError('GitHub Variables cannot supply credentials')
            for line in text.splitlines():
                if re.match(r'\s*' + key + r'\s*:', line) and not re.fullmatch(r'\s{10,}' + key + r':\s*\$\{\{\s*secrets\.' + key + r'\s*\}\}\s*', line):
                    raise ValueError('Credentials must use step-scoped GitHub Secrets')
                if key in line and re.search(r'\b(?:sed|curl|echo|printf|tee)\b', line):
                    raise ValueError('Credential interpolation into URLs, logs or configuration is forbidden')
        if re.search(r'/api/init|\bset\s+-[^\n]*x|\btee\s+.*\.log', text):
            raise ValueError('Public bootstrap or raw deployment logging is forbidden')
        if re.search(r'continue-on-error:\s*true|\|\|\s*true|(?:run:|^\s+)\s*printenv\b', text, re.M):
            raise ValueError('Ignoring deployment errors or dumping environments is forbidden')
        if path.name == 'deploy-cloudflare.yml':
            migration = text.find('run: pnpm db:migrate')
            publish = text.find('run: node scripts/deploy.mjs\n')
            if migration < 0 or publish < 0 or migration >= publish:
                raise ValueError('D1 migration must precede publishing')
    runtime = root / 'mail-worker/src'
    for path in runtime.rglob('*.js'):
        text = path.read_text()
        if re.search(r'\bdbInit\b|api/init-api|(?:from|import).*scripts/(?:migrat|deploy)', text):
            raise ValueError('Deployment migration imported into runtime')
        if re.search(r'app\.(?:get|post|put|all|use)\(\s*[\'"][^\'"]*(?:/init|/bootstrap|:secret|:jwt)', text, re.I):
            raise ValueError('Public bootstrap or credential path parameter is forbidden')
        if re.search(r'(?:fetch|new URL|searchParams\.set)\([^;]*\b(?:jwt_secret|linuxdo_client_secret)\b', text, re.S):
            raise ValueError('Runtime secret in URL is forbidden')
    if (runtime / 'api/init-api.js').exists() or (runtime / 'init/init.js').exists():
        raise ValueError('Runtime bootstrap module still exists')
    sources = list(runtime.rglob('*.js')) + list((root / 'mail-worker/scripts').glob('*.mjs'))
    for path in sources:
        if re.search(r'console\.(?:log|error|warn|debug)\([^;]*(?:\benv\.|\bsecrets\b|\btoken\b|\bheaders\b)', path.read_text()):
            raise ValueError('Logging credential-bearing objects is forbidden')
    if generated:
        config = json.loads(generated.read_text())
        inspect_config(config)
        if config.get('build') or config.get('keep_vars') is not False:
            raise ValueError('Unsafe generated release configuration')
        if 'jwt_secret' not in config.get('secrets', {}).get('required', []):
            raise ValueError('Required JWT secret binding missing')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--config', type=Path)
    args = parser.parse_args()
    try:
        check(args.root, args.config)
        print('Secret and bootstrap static gates passed.')
    except Exception as error:
        # Gate errors are controlled strings; never echo file contents or secrets.
        print('Security gate failed: ' + (str(error) if isinstance(error, ValueError) and type(error) is ValueError else 'invalid configuration'), file=sys.stderr)
        sys.exit(1)
