import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { authenticator } from 'otplib';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { hashPassword } from '../../lib/password.js';

// ADR-042. Email+password for every account; TOTP as a second factor for
// admin/super_admin only. The SMS-OTP flow these tests used to drive is gone.
const prisma = new PrismaClient();
const config = testConfig();

// This file's own institutional IDs / emails. Test files run in parallel against one
// DB and clean up their own fixtures, so these must be unique to this file.
const OFFICER_ID = 'AUTHTEST_SHO01';
const ADMIN_ID = 'AUTHTEST_SDOP01';
const NOPASS_ID = 'AUTHTEST_NOPASS01';
const OFFICER_EMAIL = 'authtest_sho01@sampark.internal';
const ADMIN_EMAIL = 'authtest_sdop01@sampark.internal';
const NOPASS_EMAIL = 'authtest_nopass01@sampark.internal';
const PASSWORD = 'correct-horse-battery-staple';
const IDS = [OFFICER_ID, ADMIN_ID, NOPASS_ID];

let officerId = 0;
let adminId = 0;

// TOTP off — the current production default (ADR-042 amended).
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });
// TOTP on — the ADR-042 design, kept fully covered so re-enabling is a config flip and
// not a rediscovery of whether the second factor still works.
const makeTotpApp = (): Promise<FastifyInstance> =>
  buildApp({ config: testConfig({ totpEnabled: true }), prisma, logger: false });

interface LoginRes {
  status: string;
  access_token?: string;
  refresh_token?: string;
  challenge_token?: string;
  totp_secret?: string;
  totp_uri?: string;
  user?: { id: number; name: string; role: string };
}

async function login(app: FastifyInstance, email: string, password = PASSWORD) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  return { status: res.statusCode, body: res.json() as LoginRes };
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { name: { in: IDS } } });
  const hash = await hashPassword(PASSWORD);

  const officer = await prisma.user.create({
    data: { name: OFFICER_ID, email: OFFICER_EMAIL, passwordHash: hash, role: 'officer', thana: 'गंगालूर' },
  });
  const admin = await prisma.user.create({
    data: { name: ADMIN_ID, email: ADMIN_EMAIL, passwordHash: hash, role: 'admin', subDivision: 'कुटरू' },
  });
  // An imported-but-not-yet-provisioned account: exists, has no password (Phase B sets it).
  await prisma.user.create({
    data: { name: NOPASS_ID, email: NOPASS_EMAIL, role: 'officer', thana: 'पामेड़' },
  });
  officerId = officer.id;
  adminId = admin.id;
});

afterEach(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: { in: [officerId, adminId] } } });
  // Reset the admin's enrolment so each TOTP test starts from a known state.
  await prisma.user.update({
    where: { id: adminId },
    data: { totpSecret: null, totpConfirmedAt: null },
  });
});

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: { in: [officerId, adminId] } } });
  await prisma.user.deleteMany({ where: { name: { in: IDS } } });
  await prisma.$disconnect();
});

describe('auth (ADR-042 — email + password)', () => {
  // ── The removed track ──────────────────────────────────────────────────────

  it('the SMS-OTP endpoints are gone (404)', async () => {
    const app = await makeApp();
    for (const url of ['/api/v1/auth/otp/send', '/api/v1/auth/otp/verify']) {
      const res = await app.inject({ method: 'POST', url, payload: { phone: '+919000000001' } });
      expect(res.statusCode).toBe(404);
    }
    await app.close();
  });

  // ── Credential failures all look identical ─────────────────────────────────

  it('unknown email, wrong password, and password-less account are ALL 401 INVALID_CREDENTIALS', async () => {
    const app = await makeApp();
    const cases = [
      ['nobody@sampark.internal', PASSWORD],
      [OFFICER_EMAIL, 'wrong-password'],
      [NOPASS_EMAIL, PASSWORD], // exists, but no password set yet
    ] as const;
    for (const [email, password] of cases) {
      const { status, body } = await login(app, email, password);
      expect(status).toBe(401);
      expect((body as unknown as { error: { code: string } }).error.code).toBe('INVALID_CREDENTIALS');
    }
    await app.close();
  });

  it('a soft-deleted account cannot log in', async () => {
    const app = await makeApp();
    await prisma.user.update({ where: { id: officerId }, data: { deletedAt: new Date() } });
    try {
      const { status } = await login(app, OFFICER_EMAIL);
      expect(status).toBe(401);
    } finally {
      await prisma.user.update({ where: { id: officerId }, data: { deletedAt: null } });
      await app.close();
    }
  });

  // ── Officer: one factor ────────────────────────────────────────────────────

  it('an officer logs in with email+password alone — no second factor', async () => {
    const app = await makeApp();
    const { status, body } = await login(app, OFFICER_EMAIL);
    expect(status).toBe(200);
    expect(body.status).toBe('authenticated');
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    // `name` is the institutional ID, not a person.
    expect(body.user?.name).toBe(OFFICER_ID);
    expect(body.user?.role).toBe('officer');
    await app.close();
  });

  it('email is case-insensitive', async () => {
    const app = await makeApp();
    const { status, body } = await login(app, OFFICER_EMAIL.toUpperCase());
    expect(status).toBe(200);
    expect(body.status).toBe('authenticated');
    await app.close();
  });

  // ── admin/super_admin: TOTP enrolment then challenge ───────────────────────

  it('an admin’s FIRST login returns a TOTP enrolment (secret + provisioning URI), not tokens', async () => {
    const app = await makeTotpApp();
    const { status, body } = await login(app, ADMIN_EMAIL);
    expect(status).toBe(200);
    expect(body.status).toBe('totp_enrollment');
    expect(typeof body.totp_secret).toBe('string');
    expect(body.totp_uri).toContain('otpauth://');
    expect(body.totp_uri).toContain(ADMIN_ID); // keyed by the institutional ID
    // Crucially: no tokens yet.
    expect(body.access_token).toBeUndefined();
    await app.close();
  });

  it('a valid code completes enrolment and issues tokens; the next login then DEMANDS a code', async () => {
    const app = await makeTotpApp();
    const first = await login(app, ADMIN_EMAIL);
    const secret = first.body.totp_secret!;

    const verify = await app.inject({
      method: 'POST', url: '/api/v1/auth/2fa/verify',
      payload: { challenge_token: first.body.challenge_token, otp: authenticator.generate(secret) },
    });
    expect(verify.statusCode).toBe(200);
    const vb = verify.json() as LoginRes;
    expect(vb.status).toBe('authenticated');
    expect(typeof vb.access_token).toBe('string');

    // Enrolment is now recorded — the second login must not hand out a fresh secret.
    const second = await login(app, ADMIN_EMAIL);
    expect(second.body.status).toBe('totp_required');
    expect(second.body.totp_secret).toBeUndefined();
    await app.close();
  });

  it('a wrong TOTP code is refused', async () => {
    const app = await makeTotpApp();
    const first = await login(app, ADMIN_EMAIL);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/2fa/verify',
      payload: { challenge_token: first.body.challenge_token, otp: '000000' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_TOTP');
    await app.close();
  });

  // The two token kinds must not be interchangeable in either direction.
  it('a 2FA challenge token is NOT usable as an access token', async () => {
    const app = await makeTotpApp();
    const first = await login(app, ADMIN_EMAIL);
    const res = await app.inject({
      method: 'GET', url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${first.body.challenge_token}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('an access token is NOT usable as a 2FA challenge', async () => {
    const app = await makeTotpApp();
    const { body } = await login(app, OFFICER_EMAIL);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/2fa/verify',
      payload: { challenge_token: body.access_token, otp: '123456' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_CHALLENGE');
    await app.close();
  });

  // ── ADR-042 amended: TOTP disabled ─────────────────────────────────────────

  it('with TOTP disabled, an admin logs in with email+password alone — no challenge', async () => {
    const app = await makeApp(); // totpEnabled: false
    const { status, body } = await login(app, ADMIN_EMAIL);
    expect(status).toBe(200);
    expect(body.status).toBe('authenticated');
    expect(typeof body.access_token).toBe('string');
    // No challenge, and crucially no secret handed out.
    expect(body.challenge_token).toBeUndefined();
    expect(body.totp_secret).toBeUndefined();
    await app.close();
  });

  it('with TOTP disabled, /auth/2fa/verify refuses even a well-formed challenge', async () => {
    // A challenge minted while the flag was on must not stay usable after it is off.
    const totpApp = await makeTotpApp();
    const enrol = await login(totpApp, ADMIN_EMAIL);
    const challenge = enrol.body.challenge_token!;
    const secret = enrol.body.totp_secret!;
    await totpApp.close();

    const app = await makeApp(); // flag now off
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/2fa/verify',
      payload: { challenge_token: challenge, otp: authenticator.generate(secret) },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_CHALLENGE');
    await app.close();
  });

  // ── Session lifecycle (unchanged by ADR-042) ───────────────────────────────

  it('refresh rotates the pair and revokes the used token', async () => {
    const app = await makeApp();
    const { body } = await login(app, OFFICER_EMAIL);
    const first = body.refresh_token!;

    const r1 = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: first } });
    expect(r1.statusCode).toBe(200);
    const rotated = (r1.json() as { refresh_token: string }).refresh_token;
    expect(rotated).not.toBe(first);

    // The consumed token is dead.
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: first } });
    expect(r2.statusCode).toBe(401);
    await app.close();
  });

  it('GET /auth/me returns the institutional ID; logout revokes refresh tokens', async () => {
    const app = await makeApp();
    const { body } = await login(app, OFFICER_EMAIL);
    const auth = { authorization: `Bearer ${body.access_token}` };

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { name: string }).name).toBe(OFFICER_ID);

    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth, payload: {} });
    expect(out.statusCode).toBe(204);

    const after = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: body.refresh_token },
    });
    expect(after.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a malformed login body with 400', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'not-an-email' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
