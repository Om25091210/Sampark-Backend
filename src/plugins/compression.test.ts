import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { testConfig } from '../test/helpers.js';
import { signAccessToken } from '../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();

// Response compression exists for the offline mirror: a first /sync/pull is tens of megabytes of
// near-identical JSON (presigned avatar URLs), which phones on EDGE abandon if it arrives
// uncompressed. These tests exercise the real /sync/pull, not a stand-in route.
const PHONE = '+919000000120';
const CADRE_NAME = 'TEST CADRE COMPRESSION';
// Enough rows that the body is comfortably over the compression threshold even if the other
// suites' fixtures are absent.
const EXTRA = 12;

let token = '';
const auth = () => ({ authorization: `Bearer ${token}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

interface Pull {
  cadres: { upserted: { id: number }[] };
}

async function cleanup(): Promise<void> {
  await prisma.cadre.deleteMany({ where: { name: { startsWith: CADRE_NAME } } });
  await prisma.user.deleteMany({ where: { phone: PHONE } });
}

beforeAll(async () => {
  await cleanup();
  const user = await prisma.user.create({ data: { phone: PHONE, name: 'Compression Super', role: 'super_admin' } });
  for (let i = 0; i < EXTRA; i++) {
    await prisma.cadre.create({
      data: {
        name: `${CADRE_NAME} ${i}`, phone: `+9100000001${String(i).padStart(2, '0')}`, thana: 'à¤¬à¥€à¤œà¤¾à¤ªà¥à¤°',
        currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
        alertLevel: 'normal', aliases: [], surrenderOrigin: 'district',
      },
    });
  }
  token = await signAccessToken({ sub: user.id, role: 'super_admin' }, config.jwtSecret, '15m');
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('response compression', () => {
  it('gzips /sync/pull when the client accepts gzip, and the body round-trips', async () => {
    const app = await makeApp();
    const plain = await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: auth() });
    const zipped = await app.inject({
      method: 'GET', url: '/api/v1/sync/pull', headers: { ...auth(), 'accept-encoding': 'gzip' },
    });
    expect(plain.statusCode).toBe(200);
    expect(zipped.statusCode).toBe(200);
    expect(zipped.headers['content-encoding']).toBe('gzip');

    const inflated = JSON.parse(gunzipSync(zipped.rawPayload).toString('utf8')) as Pull;
    const ids = (p: Pull) => p.cadres.upserted.map((c) => c.id).sort((a, b) => a - b);
    expect(ids(inflated)).toEqual(ids(plain.json() as Pull));
    expect(ids(inflated).length).toBeGreaterThanOrEqual(EXTRA);
    // Structured rows repeat the same keys over and over â€” exactly what gzip is for. If this
    // ratio ever collapses, the plugin is not doing its job.
    expect(zipped.rawPayload.length).toBeLessThan(plain.rawPayload.length / 3);
    await app.close();
  });

  it('sends /sync/pull uncompressed when the client does not ask for gzip', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/sync/pull', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    await app.close();
  });

  it('does not offer brotli (gzip only)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/sync/pull', headers: { ...auth(), 'accept-encoding': 'br' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    await app.close();
  });

  it('leaves a tiny response (healthz) alone even when gzip is accepted', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { 'accept-encoding': 'gzip' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    await app.close();
  });
});

