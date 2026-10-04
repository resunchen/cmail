import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseSecrets(env) {
	if (typeof env.JWT_SECRET !== 'string' || Buffer.byteLength(env.JWT_SECRET.trim()) < 32) {
		throw new Error('JWT signing secret must contain at least 32 bytes');
	}
	const secrets = { jwt_secret: env.JWT_SECRET };
	const enabled = env.LINUXDO_SWITCH?.toLowerCase() === 'true';
	const anyOAuth = env.LINUXDO_CLIENT_ID || env.LINUXDO_CLIENT_SECRET || env.LINUXDO_CALLBACK_URL;
	if ((enabled || anyOAuth) && (!env.LINUXDO_CLIENT_ID?.trim() || !env.LINUXDO_CLIENT_SECRET?.trim() || !env.LINUXDO_CALLBACK_URL?.trim())) {
		throw new Error('Incomplete OAuth configuration');
	}
	if (anyOAuth) secrets.linuxdo_client_secret = env.LINUXDO_CLIENT_SECRET;
	return secrets;
}

function runWrangler(args, options) {
	return new Promise((resolve, reject) => {
		// Raw child output is discarded, including errors which may echo credentials.
		const child = spawn('pnpm', args, { ...options, stdio: 'ignore' });
		child.once('error', () => reject(new Error('Wrangler deployment failed')));
		child.once('exit', code => code === 0 ? resolve() : reject(new Error('Wrangler deployment failed')));
	});
}

export async function deploy(env, run = runWrangler, configPath = 'wrangler-deploy.json') {
	const secrets = releaseSecrets(env);
	if (!env.CLOUDFLARE_API_TOKEN?.trim()) throw new Error('Missing deployment credential');
	const config = JSON.parse(await readFile(configPath, 'utf8'));
	if (config.keep_vars !== false || config.build || Object.keys(config.vars || {}).some(key => /secret|token|password/i.test(key))) {
		throw new Error('Unsafe deployment configuration');
	}
	const directory = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'cmail-release-'));
	try {
		// This is a private, temporary secret-upload payload, never a Wrangler config.
		const payload = join(directory, 'credentials.json');
		await writeFile(payload, JSON.stringify(secrets), { mode: 0o600 });
		const logPath = join(directory, 'wrangler.log');
		await symlink('/dev/null', logPath);
		// Do not pass JWT/OAuth/migration credentials to Wrangler or build subprocesses.
		const childEnv = { ...env };
		for (const key of ['JWT_SECRET', 'LINUXDO_CLIENT_SECRET', 'D1_MIGRATION_API_TOKEN']) delete childEnv[key];
		Object.assign(childEnv, { WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'none', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_LOG_PATH: logPath, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' });
		await run(['exec', 'wrangler', 'deploy', '--config', configPath, '--secrets-file', payload], { env: childEnv });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		if (process.argv.includes('--validate')) releaseSecrets(process.env);
		else await deploy(process.env);
		console.log(process.argv.includes('--validate') ? 'Release credentials validated.' : 'Worker deployed with secret bindings.');
	} catch {
		console.error('Release failed; deployment blocked.');
		process.exitCode = 1;
	}
}
