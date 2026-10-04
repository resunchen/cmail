import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { MigrationDB, runMigrations, migrate, settingCache } from '../../scripts/migrate.mjs';
import { migrations, migrationOrder } from '../../scripts/migrations.mjs';

function localDB(fail = () => false) {
	const sqlite = new DatabaseSync(':memory:');
	const query = async statements => {
		sqlite.exec('BEGIN');
		try {
			const results = statements.map(({ sql, params }) => {
				if (fail(sql)) throw new Error('Injected D1 failure');
				return { success: true, results: sqlite.prepare(sql).all(...params) };
			});
			sqlite.exec('COMMIT');
			return results;
		} catch (error) {
			sqlite.exec('ROLLBACK');
			throw error;
		}
	};
	return { sqlite, db: new MigrationDB(query), query };
}

test('fresh bootstrap builds the runtime schema, seeds roles and cache, and journals 18 stages', async () => {
	const { sqlite, db } = localDB();
	await runMigrations(db);
	assert.equal(sqlite.prepare('SELECT count(*) AS n FROM cmail_schema_migrations').get().n, migrationOrder.length);
	assert.equal(sqlite.prepare('SELECT count(*) AS n FROM role').get().n, 1);
	assert.equal(sqlite.prepare('SELECT count(*) AS n FROM setting').get().n, 1);
	const row = sqlite.prepare('SELECT * FROM setting').get();
	const cache = JSON.parse(settingCache(row));
	const entity = await readFile(new URL('../../src/entity/setting.js', import.meta.url), 'utf8');
	for (const [, property, column] of entity.matchAll(/(\w+): (?:integer|text)\('([^']+)'\)/g)) {
		assert.ok(column in row, `Missing schema column: ${column}`);
		assert.ok(property in cache, `Missing cache property: ${property}`);
	}
	assert.deepEqual(cache.resendTokens, {});
	sqlite.close();
});

test('legacy receive_email and auto_refresh_time data survive adoption and upgrades', async () => {
	const { sqlite, db } = localDB();
	await migrations.intDB({ env: { db } });
	sqlite.exec(`ALTER TABLE email ADD COLUMN receive_email TEXT;
		ALTER TABLE setting RENAME COLUMN auto_refresh TO auto_refresh_time;
		UPDATE setting SET auto_refresh_time = 1, title = 'Existing site';
		INSERT INTO email (send_email, account_id, user_id, receive_email, content) VALUES ('sender@example.com', 1, 1, 'target@example.com', 'existing content');
		INSERT INTO account (email, user_id) VALUES ('target@example.com', 1);`);
	await runMigrations(db);
	const email = sqlite.prepare('SELECT * FROM email').get();
	assert.equal(email.to_email, 'target@example.com');
	assert.equal(email.to_name, '');
	assert.equal(email.name, 'sender');
	assert.equal(email.content, 'existing content');
	assert.equal(email.unread, 1);
	assert.equal(sqlite.prepare('SELECT name FROM account').get().name, 'target');
	assert.equal(sqlite.prepare('SELECT auto_refresh FROM setting').get().auto_refresh, 5);
	assert.equal(sqlite.prepare('SELECT title FROM setting').get().title, 'Existing site');
	assert.equal(await db.hasColumn('email', 'receive_email'), false);
	sqlite.close();
});

test('adopting a fully upgraded unjournaled database preserves mail read state and custom settings', async () => {
	const { sqlite, db } = localDB();
	for (const name of migrationOrder) await migrations[name]({ env: { db } });
	sqlite.exec(`INSERT INTO email (account_id, user_id, unread, code) VALUES (7, 8, 0, 'existing-code');
		UPDATE setting SET title = 'Custom', resend_tokens = '{"example.com":"private-provider-key"}';`);
	await runMigrations(db);
	assert.equal(sqlite.prepare('SELECT unread FROM email').get().unread, 0);
	assert.equal(sqlite.prepare('SELECT code FROM email').get().code, 'existing-code');
	assert.equal(sqlite.prepare('SELECT title FROM setting').get().title, 'Custom');
	assert.deepEqual(JSON.parse(settingCache(sqlite.prepare('SELECT * FROM setting').get())).resendTokens, { 'example.com': 'private-provider-key' });
	sqlite.close();
});

test('partial upgrades repair each missing column without overwriting existing recipients', async () => {
	const { sqlite, db } = localDB();
	for (const name of migrationOrder.slice(0, 3)) await migrations[name]({ env: { db } });
	sqlite.exec(`ALTER TABLE email ADD COLUMN to_email TEXT NOT NULL DEFAULT '';
		INSERT INTO email (account_id, user_id, recipient, to_email) VALUES (1, 1, '[{"address":"old@example.com","name":"Old name"}]', 'current@example.com');
		ALTER TABLE setting ADD COLUMN tg_msg_to TEXT NOT NULL DEFAULT 'show';`);
	await runMigrations(db);
	assert.equal(sqlite.prepare('SELECT to_email FROM email').get().to_email, 'current@example.com');
	assert.equal(sqlite.prepare('SELECT to_name FROM email').get().to_name, 'Old name');
	assert.ok(await db.hasColumn('setting', 'tg_msg_from'));
	sqlite.close();
});

test('retry is a no-op after completion and checksum drift fails closed', async () => {
	const { sqlite, db } = localDB();
	await runMigrations(db);
	const before = sqlite.prepare('SELECT total_changes() AS n').get().n;
	await runMigrations(db);
	assert.equal(sqlite.prepare('SELECT total_changes() AS n').get().n - before, 2); // Lock acquire/release only.
	sqlite.exec("UPDATE cmail_schema_migrations SET checksum = 'modified' WHERE name = 'v3_0DB'");
	await assert.rejects(runMigrations(db), /checksum/);
	sqlite.close();
});

test('D1 failure is propagated, uncompleted stage is not journaled, and a retry repairs it', async () => {
	let failed = false;
	const { sqlite, db } = localDB(sql => {
		if (!failed && sql.includes('ADD COLUMN ai_code_filter')) { failed = true; return true; }
		return false;
	});
	await assert.rejects(runMigrations(db), /Injected D1 failure/);
	assert.equal(await db.hasColumn('email', 'code'), false); // The whole batch rolled back.
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cmail_schema_migrations WHERE name = 'v3_0DB'").get().n, 0);
	await runMigrations(db);
	assert.ok(await db.hasColumn('setting', 'ai_code_filter'));
	sqlite.close();
});

test('uniqueness and permission failures cannot be treated as already upgraded', async () => {
	const { sqlite, db } = localDB();
	await migrations.intDB({ env: { db } });
	sqlite.exec(`INSERT INTO account (email, user_id) VALUES ('DUP@example.com', 1), ('dup@example.com', 2);`);
	await assert.rejects(runMigrations(db), /UNIQUE/);
	assert.equal(sqlite.prepare("SELECT count(*) AS n FROM cmail_schema_migrations WHERE name = 'v1_6DB'").get().n, 0);
	sqlite.close();
});

test('another runner cannot take an occupied persistent migration lock', async () => {
	const { sqlite, db } = localDB();
	sqlite.exec("CREATE TABLE cmail_schema_lock (id INTEGER PRIMARY KEY, owner TEXT NOT NULL); INSERT INTO cmail_schema_lock VALUES (1, 'operator-run');");
	await assert.rejects(runMigrations(db), /UNIQUE/);
	assert.equal(sqlite.prepare('SELECT owner FROM cmail_schema_lock').get().owner, 'operator-run');
	sqlite.close();
});

const ids = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), D1_DATABASE_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', KV_NAMESPACE_ID: 'b'.repeat(32) };

test('migration credential is independent, only in Authorization, with cache written through management API', async () => {
	const { sqlite, query } = localDB();
	const calls = [];
	const credential = 'migration-credential-sentinel';
	const fetcher = async (url, options) => {
		calls.push({ url, options });
		assert.equal(options.headers.Authorization, `Bearer ${credential}`);
		assert.equal(options.redirect, 'error');
		assert.ok(!url.includes(credential));
		assert.ok(!options.body.includes(credential));
		const result = options.method === 'POST' ? await query(JSON.parse(options.body).batch) : null;
		return Response.json({ success: true, result });
	};
	await migrate({ ...ids, D1_MIGRATION_API_TOKEN: credential }, fetcher);
	assert.ok(calls.at(-1).url.endsWith('/values/setting%3A'));
	assert.deepEqual(JSON.parse(calls.at(-1).options.body).resendTokens, {});
	sqlite.close();
});

test('missing migration token cannot fall back to deployment or JWT credentials', async () => {
	await assert.rejects(migrate({ ...ids, CLOUDFLARE_API_TOKEN: 'deployment', JWT_SECRET: 'signing' }, () => { throw new Error('Must not call network'); }), /Missing Cloudflare/);
});

test('KV refresh failure blocks release and retries without repeating completed D1 upgrades', async () => {
	const { sqlite, query } = localDB();
	let denyCache = true;
	let writes = 0;
	const fetcher = async (url, options) => {
		if (options.method === 'POST') return Response.json({ success: true, result: await query(JSON.parse(options.body).batch) });
		if (denyCache) return Response.json({ success: false }, { status: 403 });
		writes++;
		return Response.json({ success: true, result: null });
	};
	await assert.rejects(migrate({ ...ids, D1_MIGRATION_API_TOKEN: 'migration-token' }, fetcher), /management request failed/);
	assert.equal(sqlite.prepare('SELECT count(*) AS n FROM cmail_schema_migrations').get().n, 18);
	sqlite.exec("UPDATE setting SET title = 'Preserve on retry'");
	denyCache = false;
	await migrate({ ...ids, D1_MIGRATION_API_TOKEN: 'migration-token' }, fetcher);
	assert.equal(sqlite.prepare('SELECT title FROM setting').get().title, 'Preserve on retry');
	assert.equal(writes, 1);
	sqlite.close();
});

test('Cloudflare 403, logical API failures, malformed results and network errors remain sanitized', async () => {
	const sentinel = 'sensitive-error-sentinel';
	for (const response of [
		() => Response.json({ success: false, errors: [sentinel] }, { status: 403 }),
		() => Response.json({ success: false, errors: [sentinel] }),
		() => Response.json({ success: true, result: [{ success: false, results: [sentinel] }] }),
		() => { throw new Error(sentinel); }
	]) {
		await assert.rejects(migrate({ ...ids, D1_MIGRATION_API_TOKEN: sentinel }, response), error => !String(error).includes(sentinel));
	}
});
