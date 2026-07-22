import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

// ADR-044 end-to-end. The unit tests in lib/scope.test.ts prove the TABLE is right; this
// proves the table is actually consulted on the wire, which is the part that can silently
// regress — a service that forgets to pass `scope` still compiles fine at the route layer.
//
// Fixture: three stations in TWO different sub-divisions, so "same sub-division" and
// "different sub-division" are both real cases rather than one station tested twice.
//   भैरमगढ़ (sub-division भैरमगढ़)  <- officer's own station
//   जांगला  (sub-division भैरमगढ़)  <- same SDOP, different station
//   कुटरू   (sub-division कुटरू)    <- a different SDOP entirely

const prisma = new PrismaClient();
const config = testConfig();
const TOKEN = 'SCOPEFX';
const PHONES = ['+919000000090', '+919000000091', '+919000000092', '+919000000093'];

let officerToken = '';
let sdopToken = '';
let otherSdopToken = '';
let hqToken = '';
let officerId = 0;
const cadre: Record<string, number> = {};

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const makeApp = () => buildApp({ config, prisma, logger: false });

async function ids(url: string, token: string): Promise<number[]> {
  const app = await makeApp();
  const res = await app.inject({ method: 'GET', url, headers: auth(token) });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { data: { id: number }[] };
  await app.close();
  return body.data.map((c) => c.id);
}

beforeAll(async () => {
  await prisma.cadre.deleteMany({ where: { name: { startsWith: TOKEN } } });
  await prisma.user.deleteMany({ where: { phone: { in: PHONES } } });

  const mk = async (phone: string, role: string, name: string, scope: object) =>
    (await prisma.user.create({ data: { phone, name, role: role as 'officer', ...scope } })).id;

  officerId = await mk(PHONES[0]!, 'officer', `${TOKEN} SHO`, { thana: 'भैरमगढ़' });
  const sdopId = await mk(PHONES[1]!, 'admin', `${TOKEN} SDOP`, { subDivision: 'भैरमगढ़' });
  const otherId = await mk(PHONES[2]!, 'admin', `${TOKEN} SDOP2`, { subDivision: 'कुटरू' });
  const hqId = await mk(PHONES[3]!, 'super_admin', `${TOKEN} HQ`, {});

  const sign = (sub: number, role: string) => signAccessToken({ sub, role }, config.jwtSecret, '15m');
  officerToken = await sign(officerId, 'officer');
  sdopToken = await sign(sdopId, 'admin');
  otherSdopToken = await sign(otherId, 'admin');
  hqToken = await sign(hqId, 'super_admin');

  for (const [key, thana] of [['own', 'भैरमगढ़'], ['sibling', 'जांगला'], ['foreign', 'कुटरू']] as const) {
    cadre[key] = (
      await prisma.cadre.create({
        data: {
          name: `${TOKEN} ${key}`, phone: '', thana, currentAddress: 'x',
          designation: 'y', category: 'surrendered', alertLevel: 'normal', aliases: [],
        },
      })
    ).id;
  }
});

afterAll(async () => {
  await prisma.cadre.deleteMany({ where: { name: { startsWith: TOKEN } } });
  await prisma.user.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.$disconnect();
});

describe('ADR-044 scope enforcement over HTTP', () => {
  it('GET /cadres — officer sees only their station', async () => {
    const seen = await ids(`/api/v1/cadres?search=${TOKEN}&pageSize=50`, officerToken);
    expect(seen).toEqual([cadre.own]);
  });

  it('GET /cadres — an SDOP sees every station in their sub-division, and no others', async () => {
    const seen = await ids(`/api/v1/cadres?search=${TOKEN}&pageSize=50`, sdopToken);
    expect(seen.sort()).toEqual([cadre.own, cadre.sibling].sort());
    expect(seen).not.toContain(cadre.foreign);
  });

  it('GET /cadres — HQ sees all three', async () => {
    const seen = await ids(`/api/v1/cadres?search=${TOKEN}&pageSize=50`, hqToken);
    expect(seen.sort()).toEqual([cadre.own, cadre.sibling, cadre.foreign].sort());
  });

  it('GET /cadres/:id — an out-of-scope cadre is 404, not 403', async () => {
    // 403 would confirm the id exists, letting anyone map the register by probing ids.
    const app = await makeApp();
    for (const [token, id] of [
      [officerToken, cadre.sibling!],
      [officerToken, cadre.foreign!],
      [sdopToken, cadre.foreign!],
      [otherSdopToken, cadre.own!],
    ] as const) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${id}`, headers: auth(token) });
      expect(res.statusCode).toBe(404);
    }
    // ...and the same ids ARE reachable by someone who should have them.
    expect((await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadre.foreign}`, headers: auth(otherSdopToken) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadre.sibling}`, headers: auth(sdopToken) })).statusCode).toBe(200);
    await app.close();
  });

  it('a filter cannot be used to reach outside the scope', async () => {
    // The scope is ANDed, so asking for another station's thana narrows to nothing rather
    // than overriding the boundary. This is the obvious first thing an attacker tries.
    const seen = await ids(
      `/api/v1/cadres?search=${TOKEN}&thana=${encodeURIComponent('कुटरू')}&pageSize=50`,
      officerToken,
    );
    expect(seen).toEqual([]);
  });

  it('reports and their media inherit the cadre boundary', async () => {
    const app = await makeApp();
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadre.foreign}/reports`, headers: auth(officerToken) })).statusCode,
    ).toBe(404);
    // The PDF export is admin+ by role, so an officer is stopped by the ROLE gate (403)
    // before scope is ever consulted. Prove the scope layer with a caller who passes the
    // role gate: an SDOP asking for a cadre outside their own sub-division.
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadre.own}/reports/export`, headers: auth(otherSdopToken) })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadre.own}/reports/export`, headers: auth(sdopToken) })).statusCode,
    ).toBe(200);
    // Writing a report about an out-of-scope cadre is refused too — otherwise the boundary
    // would be read-only, and an officer could still attach evidence to another district.
    const post = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadre.foreign}/reports`, headers: auth(officerToken),
      payload: {
        cadre_id: cadre.foreign, reporting_place: 'village', specific_location: 'x',
        person_status: 'alive', current_phone: '+919812345678', current_activity: 'x',
        gps_coords: { latitude: 18.79, longitude: 80.9, address: 'x' }, is_home_address: true,
        idempotency_key: '11111111-1111-4111-8111-111111111111',
      },
    });
    expect(post.statusCode).toBe(404);
    await app.close();
  });

  it('the dashboard counts only what the caller may see', async () => {
    const app = await makeApp();
    const read = async (token: string) => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/stats/dashboard', headers: auth(token) });
      return (res.json() as { totalCadres: number }).totalCadres;
    };
    // An unscoped total would tell a single SDOP exactly how large the whole register is.
    expect(await read(sdopToken)).toBeLessThan(await read(hqToken));
    await app.close();
  });

  it('deactivating an account kills its ALREADY-ISSUED access token on the next request', async () => {
    // Revoking refresh tokens alone would leave this token working for up to 15 minutes.
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/cadres', headers: auth(officerToken) })).statusCode).toBe(200);
    await prisma.user.update({ where: { id: officerId }, data: { deletedAt: new Date() } });
    const after = await app.inject({ method: 'GET', url: '/api/v1/cadres', headers: auth(officerToken) });
    expect(after.statusCode).toBe(401);
    expect((after.json() as { error: { code: string } }).error.code).toBe('ACCOUNT_INACTIVE');
    await prisma.user.update({ where: { id: officerId }, data: { deletedAt: null } });
    await app.close();
  });
});
