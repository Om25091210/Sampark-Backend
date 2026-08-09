import { describe, it, expect } from 'vitest';
import { buildApp } from './app.js';
import { fakeDbProbe, testConfig } from './test/helpers.js';

// A curl/server-side request never triggers CORS -- only a real browser fetch from a
// different origin does, which is why a missing allowlist entry went unnoticed until
// someone actually tried the web app in a browser. These tests exercise the same
// preflight + response-header path a browser relies on.
describe('CORS (web app is a separate browser origin from this API)', () => {
  const config = testConfig({ allowedOrigins: ['https://sampark-web-pied.vercel.app'] });
  const dbUp = () => fakeDbProbe(async () => [{ ok: 1 }]);

  it('reflects an allowed origin on a real request', async () => {
    const app = await buildApp({ config, prisma: dbUp(), logger: false });
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://sampark-web-pied.vercel.app' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://sampark-web-pied.vercel.app');
    await app.close();
  });

  it('does not reflect a disallowed origin', async () => {
    const app = await buildApp({ config, prisma: dbUp(), logger: false });
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('answers an OPTIONS preflight for an allowed origin (not a 404)', async () => {
    const app = await buildApp({ config, prisma: dbUp(), logger: false });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: {
        origin: 'https://sampark-web-pied.vercel.app',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://sampark-web-pied.vercel.app');
    await app.close();
  });
});
