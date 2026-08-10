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

  // Regression: @fastify/cors defaults `methods` to 'GET,HEAD,POST' when not set
  // explicitly, so a PATCH preflight (e.g. the web app's direct alias write,
  // PATCH /cadres/:id) 200'd here but silently omitted PATCH from
  // Access-Control-Allow-Methods -- a browser blocks the real request on that,
  // even though this same inject() call reports success either way.
  it('lists PATCH (and PUT/DELETE) in Access-Control-Allow-Methods on preflight', async () => {
    const app = await buildApp({ config, prisma: dbUp(), logger: false });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/cadres/1',
      headers: {
        origin: 'https://sampark-web-pied.vercel.app',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type,authorization',
      },
    });
    expect(res.statusCode).toBe(204);
    const allowed = (res.headers['access-control-allow-methods'] as string).split(',').map((m) => m.trim());
    expect(allowed).toEqual(expect.arrayContaining(['PATCH', 'PUT', 'DELETE']));
    await app.close();
  });
});
