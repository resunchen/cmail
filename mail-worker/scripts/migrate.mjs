import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { cloudflareClient, resourceIds } from './cloudflare.mjs';
import { migrations, migrationOrder } from './migrations.mjs';

// A minimal D1 adapter keeps legacy SQL outside the public Worker bundle.
export class MigrationDB {
	constructor(query) { this.query = query; }
	prepare(sql) {
		const statement = { sql, params: [] };
		statement.bind = (...params) => { statement.params = params; return statement; };
		statement.all = async () => (await this.query([statement]))[0];
		statement.first = async () => (await statement.all()).results[0] ?? null;
		statement.run = async () => (await this.batch([statement]))[0];
		return statement;
	}
	async hasColumn(table, column) {
		return !!await this.prepare('SELECT name FROM pragma_table_info(?) WHERE name = ?').bind(table, column).first();
	}
	async batch(statements) {
		const pending = [];
		for (const statement of statements) {
			const add = statement.sql.match(/^\s*ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
			if (add && await this.hasColumn(add[1], add[2])) continue;
			const rename = statement.sql.match(/^\s*ALTER TABLE (\w+) RENAME COLUMN (\w+) TO (\w+)/i);
			if (rename && !await this.hasColumn(rename[1], rename[2]) && await this.hasColumn(rename[1], rename[3])) continue;
			pending.push({ sql: statement.sql, params: statement.params });
		}
		return pending.length ? this.query(pending) : [];
	}
}

export async function runMigrations(db) {
	const owner = randomUUID();
	await db.prepare(`CREATE TABLE IF NOT EXISTS cmail_schema_lock (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL)`).run();
	// No expiring lease: an interrupted runner requires an operator to release it.
	await db.prepare('INSERT INTO cmail_schema_lock (id, owner) VALUES (1, ?)').bind(owner).run();
	try {
		await db.prepare(`CREATE TABLE IF NOT EXISTS cmail_schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
		for (const name of migrationOrder) {
			const checksum = createHash('sha256').update(migrations[name].toString()).digest('hex');
			const applied = await db.prepare('SELECT checksum FROM cmail_schema_migrations WHERE name = ?').bind(name).first();
			if (applied) {
				if (applied.checksum !== checksum) throw new Error('Migration checksum mismatch');
				continue;
			}
			await migrations[name]({ env: { db } });
			await db.prepare('INSERT INTO cmail_schema_migrations (name, checksum) VALUES (?, ?)').bind(name, checksum).run();
		}
	} finally {
		await db.prepare('DELETE FROM cmail_schema_lock WHERE owner = ?').bind(owner).run();
	}
}

export function settingCache(row) {
	if (!row) throw new Error('Settings row missing');
	const setting = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()), value]));
	setting.resendTokens = JSON.parse(setting.resendTokens);
	return JSON.stringify(setting);
}

export async function migrate(env, fetcher = fetch) {
	const { account, database, kv } = resourceIds(env);
	// Deliberately no fallback to the deployment token or a JWT/OAuth secret.
	const request = cloudflareClient(env.D1_MIGRATION_API_TOKEN, fetcher);
	const db = new MigrationDB(async statements => {
		const result = await request(`/accounts/${account}/d1/database/${database}/query`, {
			method: 'POST', body: JSON.stringify({ batch: statements })
		});
		if (!Array.isArray(result) || result.length !== statements.length || result.some(item => item.success !== true || !Array.isArray(item.results))) {
			throw new Error('D1 migration query failed');
		}
		return result;
	});
	await runMigrations(db);
	// Preserve settingService.refresh behavior without importing runtime services.
	const row = await db.prepare('SELECT * FROM setting LIMIT 1').first();
	await request(`/accounts/${account}/storage/kv/namespaces/${kv}/values/setting%3A`, {
		method: 'PUT', body: settingCache(row)
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		await migrate(process.env);
		console.log('Database migration and settings cache refresh completed.');
	} catch {
		console.error('Database migration failed; deployment blocked.');
		process.exitCode = 1;
	}
}
