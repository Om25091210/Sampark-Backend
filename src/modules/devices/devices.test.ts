import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';
import { MockPushProvider } from '../../lib/push.js';

const prisma = new PrismaClient();
const config = testConfig();

// Free block per cadre-changes.test.ts's bookkeeping comment: this file uses 63-64.
const PHONES = ['+919000000063', '+919000000064'];

let officerAId = 0;
let officerBId = 0;
let officerAToken = '';
let officerBToken = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const makeApp = (): Promise<FastifyInstance> =>
  buildApp({ config, prisma, logger: false, pushProvider: new MockPushProvider() });

beforeAll(async () => {
  const mk = async (phone: string, name: string) =>
    prisma.user.upsert({
      where: { phone },
      update: { deletedAt: null, role: 'officer', name, thana: 'बीजापुर' },
      create: { phone, name, role: 'officer', thana: 'बीजापुर' },
    });

  officerAId = (await mk(PHONES[0]!, 'Device Officer A')).id;
  officerBId = (await mk(PHONES[1]!, 'Device Officer B')).id;

  officerAToken = await signAccessToken({ sub: officerAId, role: 'officer' }, config.jwtSecret, '15m');
  officerBToken = await signAccessToken({ sub: officerBId, role: 'officer' }, config.jwtSecret, '15m');
});

afterEach(async () => {
  await prisma.deviceToken.deleteMany({ where: { userId: { in: [officerAId, officerBId] } } });
});

afterAll(async () => {
  await prisma.deviceToken.deleteMany({ where: { userId: { in: [officerAId, officerBId] } } });
  await prisma.$disconnect();
});

describe('devices (ADR-048 FCM token registration)', () => {
  it('401s with no Authorization header', async () => {
    const app = await makeApp();
    const register = await app.inject({ method: 'POST', url: '/api/v1/devices/register', payload: { token: 'x' } });
    expect(register.statusCode).toBe(401);
    const unregister = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/unregister',
      payload: { token: 'x' },
    });
    expect(unregister.statusCode).toBe(401);
  });

  it('400s when token is missing/empty', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/register',
      headers: auth(officerAToken),
      payload: { token: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('registers a device, then re-registering the same token refreshes it (not a duplicate row)', async () => {
    const app = await makeApp();
    const token = 'fcm-token-device-test-1';

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/register',
      headers: auth(officerAToken),
      payload: { token },
    });
    expect(first.statusCode).toBe(204);

    const row1 = await prisma.deviceToken.findUniqueOrThrow({ where: { token } });
    expect(row1.userId).toBe(officerAId);
    expect(row1.endpointArn).toBeTruthy();

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/register',
      headers: auth(officerAToken),
      payload: { token },
    });
    expect(second.statusCode).toBe(204);

    const rows = await prisma.deviceToken.findMany({ where: { token } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.endpointArn).toBe(row1.endpointArn); // MockPushProvider is deterministic per token
  });

  it('registering the same token under a different user REASSIGNS the row (handset handed to a new officer)', async () => {
    const app = await makeApp();
    const token = 'fcm-token-device-test-2';

    await app.inject({
      method: 'POST',
      url: '/api/v1/devices/register',
      headers: auth(officerAToken),
      payload: { token },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/devices/register',
      headers: auth(officerBToken),
      payload: { token },
    });

    const rows = await prisma.deviceToken.findMany({ where: { token } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(officerBId);
  });

  it('unregister soft-deletes the row; unregistering a token belonging to someone else is a no-op', async () => {
    const app = await makeApp();
    const token = 'fcm-token-device-test-3';

    await app.inject({
      method: 'POST',
      url: '/api/v1/devices/register',
      headers: auth(officerAToken),
      payload: { token },
    });

    // Belongs to officer A — officer B's unregister call must not touch it.
    const wrongUser = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/unregister',
      headers: auth(officerBToken),
      payload: { token },
    });
    expect(wrongUser.statusCode).toBe(204); // silent no-op, never reveals ownership
    const stillThere = await prisma.deviceToken.findUniqueOrThrow({ where: { token } });
    expect(stillThere.deletedAt).toBeNull();

    const rightUser = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/unregister',
      headers: auth(officerAToken),
      payload: { token },
    });
    expect(rightUser.statusCode).toBe(204);
    const gone = await prisma.deviceToken.findUniqueOrThrow({ where: { token } });
    expect(gone.deletedAt).not.toBeNull();
  });
});
