import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { cloudflareClient, resourceIds } from './cloudflare.mjs';

export async function provision(env, fetcher = fetch) {
	if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '') || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.NAME || '')) {
		throw new Error('Invalid provisioning configuration');
	}
	const request = cloudflareClient(env.CLOUDFLARE_API_TOKEN, fetcher);
	const base = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
	async function find(path, key) {
		for (let page = 1; ; page++) {
			const rows = await request(`${base}${path}?page=${page}&per_page=100`);
			if (!Array.isArray(rows)) throw new Error('Resource lookup failed');
			const matches = rows.filter(row => row[key] === env.NAME);
			if (matches.length > 1) throw new Error('Ambiguous resource name');
			if (matches.length) return matches[0];
			if (rows.length < 100) return null;
		}
	}
	const result = { ...env };
	if (!result.KV_NAMESPACE_ID) {
		const namespace = await find('/storage/kv/namespaces', 'title') || await request(`${base}/storage/kv/namespaces`, { method: 'POST', body: JSON.stringify({ title: env.NAME }) });
		result.KV_NAMESPACE_ID = namespace.id;
	}
	if (!result.D1_DATABASE_ID) {
		const database = await find('/d1/database', 'name') || await request(`${base}/d1/database`, { method: 'POST', body: JSON.stringify({ name: env.NAME }) });
		result.D1_DATABASE_ID = database.uuid;
	}
	resourceIds(result);
	return { KV_NAMESPACE_ID: result.KV_NAMESPACE_ID, D1_DATABASE_ID: result.D1_DATABASE_ID };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const ids = await provision(process.env);
		await appendFile(process.env.GITHUB_ENV, Object.entries(ids).map(([key, value]) => `${key}=${value}\n`).join(''));
		console.log('D1 and KV resources ready.');
	} catch {
		console.error('Resource provisioning failed; deployment blocked.');
		process.exitCode = 1;
	}
}
