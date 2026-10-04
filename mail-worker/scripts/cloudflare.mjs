// Management-plane calls only. Never log request headers, bodies, or API errors.
export function cloudflareClient(token, fetcher = fetch) {
	if (!token?.trim()) throw new Error('Missing Cloudflare management credential');
	return async (path, options = {}) => {
		try {
			const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
				...options,
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				redirect: 'error',
				signal: AbortSignal.timeout(30_000)
			});
			const body = await response.json();
			if (!response.ok || body.success !== true) throw new Error();
			return body.result;
		} catch {
			throw new Error('Cloudflare management request failed');
		}
	};
}

export function resourceIds(env) {
	if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || '') ||
		! /^[a-f0-9-]{36}$/i.test(env.D1_DATABASE_ID || '') ||
		! /^[a-f0-9]{32}$/i.test(env.KV_NAMESPACE_ID || '')) {
		throw new Error('Invalid Cloudflare resource identifiers');
	}
	return { account: env.CLOUDFLARE_ACCOUNT_ID, database: env.D1_DATABASE_ID, kv: env.KV_NAMESPACE_ID };
}
