import { describe, it, expect, vi } from 'vitest';
import worker from '../../src/index.js';
import jwtUtils from '../../src/utils/jwt-utils.js';

describe('retired public bootstrap', () => {
	for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
		it(`${method} cannot initialize with a valid JWT secret or missing bindings`, async () => {
			const touched = vi.fn(() => { throw new Error('Bindings must not be touched'); });
			const env = new Proxy({}, { get: touched });
			for (const path of ['/api/init', '/api/init/signing-key', '/api/init/']) {
				const response = await worker.fetch(new Request(`https://mail.example${path}`, { method, headers: { Authorization: 'Bearer signing-key' } }), env, {});
				expect(response.status).toBe(404);
			}
			expect(touched).not.toHaveBeenCalled();
		});
	}
});

describe('fail-closed signing bindings', () => {
	for (const secret of [undefined, null, '', 'weak']) {
		it(`rejects absent or weak signing binding: ${String(secret)}`, async () => {
			const c = { env: { jwt_secret: secret } };
			await expect(jwtUtils.generateToken(c, { userId: 1 }, 60)).rejects.toThrow('not configured');
			expect(await jwtUtils.verifyToken(c, 'header.payload.signature')).toBeNull();
		});
	}
	it('retains normal JWT signing and verification with a secret binding', async () => {
		const c = { env: { jwt_secret: 'test-secret-binding-'.repeat(3) } };
		const token = await jwtUtils.generateToken(c, { userId: 17 }, 60);
		expect((await jwtUtils.verifyToken(c, token)).userId).toBe(17);
		const other = { env: { jwt_secret: 'different-secret-binding-'.repeat(3) } };
		expect(await jwtUtils.verifyToken(other, token)).toBeNull();
	});
});
