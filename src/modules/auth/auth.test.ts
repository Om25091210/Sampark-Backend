import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { CapturingSmsProvider, testConfig } from '../../test/helpers.js';

// Integration tests run against the real database (a dedicated test user that is
// created here and cleaned up), matching the "against a test DB" guidance.
const prisma = new PrismaClient();
const PHONE = '+919000000001';
const UNKNOWN_PHONE = '+919111111112';
let userId: number;

beforeAll(async () => {
  const user = await prisma.user.upsert({
    where: { phone: PHONE },
    update: { deletedAt: null, role: 'officer', name: 'Test Officer' },
    create: { phone: PHONE, name: 'Test Officer', role: 'officer', thana: 'बीजापुर सदर' },
  });
  userId = user.id;
});

afterEach(async () => {
  await prisma.otpChallenge.deleteMany({ where: { phone: { in: [PHONE, UNKNOWN_PHONE] } } });
  await prisma.refreshToken.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId } });
  await prisma.otpChallenge.deleteMany({ where: { phone: { in: [PHONE, UNKNOWN_PHONE] } } });
  await prisma.user.deleteMany({ where: { phone: PHONE } });
  await prisma.$disconnect();
});

async function makeApp(sms: CapturingSmsProvider): Promise<FastifyInstance> {
  return buildApp({ config: testConfig(), prisma, sms, logger: false });
}

async function login(
  app: FastifyInstance,
  sms: CapturingSmsProvider,
): Promise<{ access: string; refresh: string }> {
  await app.inject({ method: 'POST', url: '/api/v1/auth/otp/send', payload: { phone: PHONE } });
  const code = sms.last(PHONE);
  expect(code).toBeDefined();
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { phone: PHONE, otp: code },
  });
  const body = res.json() as { access_token: string; refresh_token: string };
  return { access: body.access_token, refresh: body.refresh_token };
}

describe('auth — officer SMS-OTP', () => {
  it('rejects a malformed phone with 400 VALIDATION_ERROR', async () => {
    const app = await makeApp(new CapturingSmsProvider());
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/send', payload: { phone: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' } });
    await app.close();
  });

  it('sends an OTP for a provisioned number (200 + expires_in)', async () => {
    const sms = new CapturingSmsProvider();
    const app = await makeApp(sms);
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/send', payload: { phone: PHONE } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ expires_in: 300 });
    expect(sms.last(PHONE)).toMatch(/^\d{6}$/);
    await app.close();
  });

  it('rejects an unprovisioned number with 403 PHONE_NOT_REGISTERED', async () => {
    const sms = new CapturingSmsProvider();
    const app = await makeApp(sms);
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/send', payload: { phone: UNKNOWN_PHONE } });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe('PHONE_NOT_REGISTERED');
    expect(sms.last(UNKNOWN_PHONE)).toBeUndefined();
    await app.close();
  });

  it('rejects a wrong OTP with 401 INVALID_OTP', async () => {
    const sms = new CapturingSmsProvider();
    const app = await makeApp(sms);
    await app.inject({ method: 'POST', url: '/api/v1/auth/otp/send', payload: { phone: PHONE } });
    const actual = sms.last(PHONE);
    const wrong = actual === '000000' ? '111111' : '000000';
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone: PHONE, otp: wrong } });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_OTP');
    await app.close();
  });

  it('verifies a correct OTP and returns tokens + a camelCase user with lowercase role', async () => {
    const sms = new CapturingSmsProvider();
    const app = await makeApp(sms);
    await app.inject({ method: 'POST', url: '/api/v1/auth/otp/send', payload: { phone: PHONE } });
    const code = sms.last(PHONE);
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/otp/verify', payload: { phone: PHONE, otp: code } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      user: { id: number; phone: string; role: string };
    };
    expect(body.token_type).toBe('bearer');
    expect(body.access_token.split('.')).toHaveLength(3); // JWT
    expect(body.refresh_token.length).toBeGreaterThan(20);
    expect(body.user).toMatchObject({ id: userId, phone: PHONE, role: 'officer' });
    await app.close();
  });

  it('rejects /auth/me without a token (401)', async () => {
    const app = await makeApp(new CapturingSmsProvider());
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns the current user from /auth/me with a valid token', async () => {
    const sms = new CapturingSmsProvider();
    const app = await makeApp(sms);
    const { access } = await login(app, sms);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: userId, phone: PHONE, role: 'officer' });
    await app.close();
  });

  it('rotates tokens on refresh and revokes the old refresh token', async () => {
    const sms = new CapturingSmsProvider();
    const app = await makeApp(sms);
    const { refresh } = await login(app, sms);

    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: refresh } });
    expect(ok.statusCode).toBe(200);
    const rotated = ok.json() as { access_token: string; refresh_token: string };
    expect(rotated.refresh_token).not.toBe(refresh);

    // Reusing the old (now revoked) refresh token must fail.
    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: refresh } });
    expect(reuse.statusCode).toBe(401);
    await app.close();
  });

  it('logs out (204) and invalidates the session refresh token', async () => {
    const sms = new CapturingSmsProvider();
    const app = await makeApp(sms);
    const { access, refresh } = await login(app, sms);

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${access}` },
    });
    expect(out.statusCode).toBe(204);

    const afterLogout = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: refresh } });
    expect(afterLogout.statusCode).toBe(401);
    await app.close();
  });
});
