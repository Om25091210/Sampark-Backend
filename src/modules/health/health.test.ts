import { describe, it, expect } from 'vitest';
import { buildApp } from '../../app.js';
import { fakeDbProbe, testConfig } from '../../test/helpers.js';

const dbUp = () => fakeDbProbe(async () => [{ ok: 1 }]);
const dbDown = () =>
  fakeDbProbe(async () => {
    throw new Error('connection refused');
  });

describe('health probes', () => {
  it('GET /healthz returns 200 with { status: "ok" }', async () => {
    const app = await buildApp({ config: testConfig(), prisma: dbUp(), logger: false });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /readyz returns 200 ready when the database responds', async () => {
    const app = await buildApp({ config: testConfig(), prisma: dbUp(), logger: false });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('GET /readyz returns 503 not_ready when the database is unreachable', async () => {
    const app = await buildApp({ config: testConfig(), prisma: dbDown(), logger: false });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready' });
    await app.close();
  });

  it('unknown route returns 404 in the { error: { code, message } } shape', async () => {
    const app = await buildApp({ config: testConfig(), prisma: dbUp(), logger: false });
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
    await app.close();
  });
});
