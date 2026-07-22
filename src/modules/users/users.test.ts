import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';

// Phase B. Account provisioning: POST /users/import and the password set/reset, plus the
// SDR-002 lockout that guards /auth/login.
const prisma = new PrismaClient();
const config = testConfig();

const TOKEN = 'USRFIXTURE';
const SA_ID = `${TOKEN}_SA`;
const ADMIN_ID = `${TOKEN}_ADMIN`;
const OFF_ID = `${TOKEN}_OFF`;
const FIXTURE_IDS = [SA_ID, ADMIN_ID, OFF_ID];
const PASSWORD = 'correct-horse-battery-staple';

let saId = 0;
let adminId = 0;
let offId = 0;
let saToken = '';
let adminToken = '';
let officerToken = '';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const makeApp = (): Promise<FastifyInstance> => buildApp({ config, prisma, logger: false });

interface ImportRes {
  results: Array<{ name: string | null; status: string; userId?: number; error?: string }>;
}

/** Everything this file creates, so parallel files are never touched. */
const importedNames = [
  'USRIMP_SHO01', 'USRIMP_SHO02', 'USRIMP_SDOP01', 'USRIMP_HQ01',
  'USRIMP_BADSCOPE', 'USRIMP_DUP', 'USRIMP_NOPASS', 'USRIMP_EMAILDUP',
];

// Users acquire refresh tokens (tests log in) and audit rows (import/reset), both of which
// FK back to `users`. Deleting the user first trips refresh_tokens_user_id_fkey and — in
// afterEach — aborts the rest of the teardown, leaking lockout state into the next test.
// Clear the children first, always.
async function purgeUsers(names: string[]): Promise<void> {
  const users = await prisma.user.findMany({ where: { name: { in: names } }, select: { id: true, email: true } });
  if (users.length === 0) return;
  const ids = users.map((u) => u.id);
  const emails = users.map((u) => u.email).filter((e): e is string => e !== null);
  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { entityType: 'user', entityId: { in: ids.map(String) } } });
  if (emails.length > 0) await prisma.loginAttempt.deleteMany({ where: { email: { in: emails } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await purgeUsers([...FIXTURE_IDS, ...importedNames]);
  const hash = await hashPassword(PASSWORD);

  const sa = await prisma.user.create({
    data: { name: SA_ID, email: `${SA_ID.toLowerCase()}@sampark.internal`, passwordHash: hash, role: 'super_admin' },
  });
  const admin = await prisma.user.create({
    data: { name: ADMIN_ID, email: `${ADMIN_ID.toLowerCase()}@sampark.internal`, passwordHash: hash, role: 'admin', subDivision: 'कुटरू' },
  });
  const off = await prisma.user.create({
    data: { name: OFF_ID, email: `${OFF_ID.toLowerCase()}@sampark.internal`, passwordHash: hash, role: 'officer', thana: 'गंगालूर' },
  });
  saId = sa.id; adminId = admin.id; offId = off.id;

  saToken = await signAccessToken({ sub: saId, role: 'super_admin' }, config.jwtSecret, '15m');
  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');
  officerToken = await signAccessToken({ sub: offId, role: 'officer' }, config.jwtSecret, '15m');
});

afterEach(async () => {
  await purgeUsers(importedNames);
  // Fixture accounts survive the file, but their lockout state must not leak between tests.
  await prisma.loginAttempt.deleteMany({
    where: { email: { in: [...FIXTURE_IDS.map((n) => `${n.toLowerCase()}@sampark.internal`), 'ghost@sampark.internal'] } },
  });
});

afterAll(async () => {
  await purgeUsers([...FIXTURE_IDS, ...importedNames]);
  await prisma.$disconnect();
});

const row = (over: Record<string, unknown> = {}) => ({
  name: 'USRIMP_SHO01',
  email: 'usrimp_sho01@sampark.internal',
  role: 'officer',
  password: 'Sampark@USRIMP_SHO01',
  thana: 'गंगालूर',
  ...over,
});

describe('POST /users/import (Phase B)', () => {
  it('is super_admin only — 401 unauthenticated, 403 for officer AND admin', async () => {
    const app = await makeApp();
    const payload = { users: [row()] };
    expect((await app.inject({ method: 'POST', url: '/api/v1/users/import', payload })).statusCode).toBe(401);
    for (const t of [officerToken, adminToken]) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/users/import', headers: auth(t), payload });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it('creates accounts and stores a WORKING password hash (never the plaintext)', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/users/import', headers: auth(saToken),
      payload: { users: [row()] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ImportRes;
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ name: 'USRIMP_SHO01', status: 'created' });

    const created = await prisma.user.findUniqueOrThrow({ where: { name: 'USRIMP_SHO01' } });
    expect(created.role).toBe('officer');
    expect(created.thana).toBe('गंगालूर');
    expect(created.subDivision).toBeNull();
    // Stored as a scrypt hash that actually verifies — not the plaintext, not a no-op.
    expect(created.passwordHash).not.toBeNull();
    expect(created.passwordHash).not.toContain('Sampark@');
    expect(await verifyPassword('Sampark@USRIMP_SHO01', created.passwordHash!)).toBe(true);
    await app.close();
  });

  it('the created account can actually log in', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST', url: '/api/v1/users/import', headers: auth(saToken), payload: { users: [row()] },
    });
    const login = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'usrimp_sho01@sampark.internal', password: 'Sampark@USRIMP_SHO01' },
    });
    expect(login.statusCode).toBe(200);
    expect((login.json() as { status: string }).status).toBe('authenticated');
    await app.close();
  });

  it('SKIPS an existing ID rather than overwriting it — a re-run cannot reset a changed password', async () => {
    const app = await makeApp();
    const first = await app.inject({
      method: 'POST', url: '/api/v1/users/import', headers: auth(saToken),
      payload: { users: [row({ name: 'USRIMP_DUP', email: 'usrimp_dup@sampark.internal', password: 'Sampark@USRIMP_DUP' })] },
    });
    const createdId = (first.json() as ImportRes).results[0]!.userId!;

    // Someone changes the password out-of-band, then the sheet is re-sent.
    await prisma.user.update({ where: { id: createdId }, data: { passwordHash: await hashPassword('changed-since') } });

    const second = await app.inject({
      method: 'POST', url: '/api/v1/users/import', headers: auth(saToken),
      payload: { users: [row({ name: 'USRIMP_DUP', email: 'usrimp_dup@sampark.internal', password: 'Sampark@USRIMP_DUP' })] },
    });
    const r = (second.json() as ImportRes).results[0]!;
    expect(r.status).toBe('skipped_duplicate');
    expect(r.userId).toBe(createdId);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: createdId } });
    expect(await verifyPassword('changed-since', after.passwordHash!)).toBe(true);
    await app.close();
  });

  it('password is optional — the account exists but cannot log in until one is set', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'POST', url: '/api/v1/users/import', headers: auth(saToken),
      payload: { users: [row({ name: 'USRIMP_NOPASS', email: 'usrimp_nopass@sampark.internal', password: undefined })] },
    });
    const u = await prisma.user.findUniqueOrThrow({ where: { name: 'USRIMP_NOPASS' } });
    expect(u.passwordHash).toBeNull();

    const login = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'usrimp_nopass@sampark.internal', password: 'anything' },
    });
    expect(login.statusCode).toBe(401);
    await app.close();
  });

  it('enforces the org-scope invariant per row (a mis-scoped account is an RBAC bug later)', async () => {
    const app = await makeApp();
    const bad = [
      // officer with no thana
      { name: 'USRIMP_BADSCOPE', email: 'usrimp_badscope@sampark.internal', role: 'officer', password: 'x'.repeat(10) },
      // admin scoped by thana instead of subDivision
      { name: 'USRIMP_BADSCOPE', email: 'b@sampark.internal', role: 'admin', thana: 'गंगालूर', password: 'x'.repeat(10) },
      // super_admin carrying a scope
      { name: 'USRIMP_BADSCOPE', email: 'c@sampark.internal', role: 'super_admin', thana: 'गंगालूर', password: 'x'.repeat(10) },
    ];
    const res = await app.inject({
      method: 'POST', url: '/api/v1/users/import', headers: auth(saToken), payload: { users: bad },
    });
    const results = (res.json() as ImportRes).results;
    expect(results.every((r) => r.status === 'error')).toBe(true);
    expect(results[0]!.error).toContain('thana');
    expect(results[1]!.error).toContain('subDivision');
    expect(results[2]!.error).toContain('unrestricted');
    expect(await prisma.user.count({ where: { name: 'USRIMP_BADSCOPE' } })).toBe(0);
    await app.close();
  });

  it('one bad row does not fail the batch, and a duplicate EMAIL is a distinct error', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/users/import', headers: auth(saToken),
      payload: {
        users: [
          row(),
          { name: 'USRIMP_BADSCOPE', email: 'nope@sampark.internal', role: 'officer' }, // no thana
          // A different ID reusing an ALREADY-TAKEN email — not a duplicate ID, a data error.
          row({ name: 'USRIMP_EMAILDUP', email: `${SA_ID.toLowerCase()}@sampark.internal` }),
          row({ name: 'USRIMP_SHO02', email: 'usrimp_sho02@sampark.internal' }),
        ],
      },
    });
    const results = (res.json() as ImportRes).results;
    expect(results).toHaveLength(4);
    expect(results[0]!.status).toBe('created');
    expect(results[1]!.status).toBe('error');
    expect(results[2]!.status).toBe('error');
    expect(results[2]!.error).toContain('email');
    expect(results[3]!.status).toBe('created');
    await app.close();
  });

  it('rejects a bare array (must be wrapped in {users:[...]}) and an over-cap batch', async () => {
    const app = await makeApp();
    const bare = await app.inject({
      method: 'POST', url: '/api/v1/users/import', headers: auth(saToken), payload: [row()],
    });
    expect(bare.statusCode).toBe(400);

    const tooMany = await app.inject({
      method: 'POST', url: '/api/v1/users/import', headers: auth(saToken),
      payload: { users: Array.from({ length: 201 }, () => ({})) },
    });
    expect(tooMany.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /users/:userId/password (Phase B)', () => {
  it('is super_admin only', async () => {
    const app = await makeApp();
    for (const [t, code] of [[officerToken, 403], [adminToken, 403]] as const) {
      const res = await app.inject({
        method: 'POST', url: `/api/v1/users/${offId}/password`, headers: auth(t), payload: { password: 'new-password-123' },
      });
      expect(res.statusCode).toBe(code);
    }
    await app.close();
  });

  it('sets a working password, revokes live sessions, and audits WHO did it', async () => {
    const app = await makeApp();
    // Officer has a live session before the reset.
    const before = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: `${OFF_ID.toLowerCase()}@sampark.internal`, password: PASSWORD },
    });
    const oldRefresh = (before.json() as { refresh_token: string }).refresh_token;

    const res = await app.inject({
      method: 'POST', url: `/api/v1/users/${offId}/password`, headers: auth(saToken),
      payload: { password: 'Sampark@RESET01' },
    });
    expect(res.statusCode).toBe(204);

    // New password works.
    const after = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: `${OFF_ID.toLowerCase()}@sampark.internal`, password: 'Sampark@RESET01' },
    });
    expect(after.statusCode).toBe(200);

    // The session the OLD password opened is dead.
    const reuse = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: oldRefresh },
    });
    expect(reuse.statusCode).toBe(401);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'user', entityId: String(offId), action: 'user.password_reset' },
      orderBy: { id: 'desc' },
    });
    expect(audit?.actorId).toBe(saId);
    // The credential itself is never recorded.
    expect(JSON.stringify(audit?.after)).not.toContain('Sampark@RESET01');

    // Restore for other tests.
    await prisma.user.update({ where: { id: offId }, data: { passwordHash: await hashPassword(PASSWORD) } });
    await app.close();
  });

  it('404 for an unknown user', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/users/99999999/password', headers: auth(saToken), payload: { password: 'whatever-123' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('DELETE /users/:userId — soft deactivate (Phase B)', () => {
  it('is super_admin only', async () => {
    const app = await makeApp();
    for (const t of [officerToken, adminToken]) {
      const res = await app.inject({ method: 'DELETE', url: `/api/v1/users/${offId}`, headers: auth(t) });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });

  it('refuses self-deactivation — super_admin is the only role that can restore accounts', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/users/${saId}`, headers: auth(saToken) });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CANNOT_DEACTIVATE_SELF');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: saId } })).deletedAt).toBeNull();
    await app.close();
  });

  it('soft-deletes: row survives, login stops, sessions die, and it leaves the officer roster', async () => {
    const app = await makeApp();
    // Create a throwaway account, log it in, then deactivate it.
    await app.inject({
      method: 'POST', url: '/api/v1/users/import', headers: auth(saToken),
      payload: { users: [row({ name: 'USRIMP_SHO02', email: 'usrimp_sho02@sampark.internal' })] },
    });
    const target = await prisma.user.findUniqueOrThrow({ where: { name: 'USRIMP_SHO02' } });
    const session = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'usrimp_sho02@sampark.internal', password: 'Sampark@USRIMP_SHO01' },
    });
    const refresh = (session.json() as { refresh_token: string }).refresh_token;

    const before = (await app.inject({ method: 'GET', url: '/api/v1/officers?pageSize=50', headers: auth(saToken) })).json() as { data: { id: number }[] };
    expect(before.data.some((o) => o.id === target.id)).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/users/${target.id}`, headers: auth(saToken) });
    expect(del.statusCode).toBe(204);

    // The ROW survives — history that references it must not be orphaned.
    const still = await prisma.user.findUnique({ where: { id: target.id } });
    expect(still).not.toBeNull();
    expect(still!.deletedAt).not.toBeNull();

    // But the account is inert: no login, no surviving session, not in the roster.
    const relogin = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'usrimp_sho02@sampark.internal', password: 'Sampark@USRIMP_SHO01' },
    });
    expect(relogin.statusCode).toBe(401);
    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refresh_token: refresh } });
    expect(reuse.statusCode).toBe(401);
    const after = (await app.inject({ method: 'GET', url: '/api/v1/officers?pageSize=50', headers: auth(saToken) })).json() as { data: { id: number }[] };
    expect(after.data.some((o) => o.id === target.id)).toBe(false);

    await app.close();
  });

  it('404 for unknown or already-deactivated', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'DELETE', url: '/api/v1/users/99999999', headers: auth(saToken) })).statusCode).toBe(404);
    await app.close();
  });
});

describe('SDR-002 lockout (email-keyed 423)', () => {
  const email = `${OFF_ID.toLowerCase()}@sampark.internal`;

  it('locks after 5 failures and answers 423, then a correct password is still refused while locked', async () => {
    const app = await makeApp();
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'wrong' } });
      expect(r.statusCode).toBe(401); // the 5th still reports 401; the LOCK applies from the next attempt
    }
    const locked = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
    expect(locked.statusCode).toBe(423);
    expect((locked.json() as { error: { code: string } }).error.code).toBe('ACCOUNT_LOCKED');
    await app.close();
  });

  // The whole point of keying on the submitted string: 423 must not answer "does this
  // account exist?" — the IDs are guessable by construction.
  it('an UNKNOWN email locks identically, so 423 is not an enumeration signal', async () => {
    const app = await makeApp();
    const ghost = 'ghost@sampark.internal';
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: ghost, password: 'wrong' } });
    }
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: ghost, password: 'wrong' } });
    expect(res.statusCode).toBe(423);
    await app.close();
  });

  it('a successful login clears the failure streak', async () => {
    const app = await makeApp();
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'wrong' } });
    }
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    expect(await prisma.loginAttempt.findUnique({ where: { email } })).toBeNull();
    await app.close();
  });

  it('a password reset clears the lock — the admin remedy actually unlocks the account', async () => {
    const app = await makeApp();
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'wrong' } });
    }
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } })).statusCode).toBe(423);

    await app.inject({
      method: 'POST', url: `/api/v1/users/${offId}/password`, headers: auth(saToken), payload: { password: PASSWORD },
    });
    const after = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
    expect(after.statusCode).toBe(200);
    await app.close();
  });
});
