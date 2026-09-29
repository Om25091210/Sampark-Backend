import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

// जेल/जमानत master-filter (FIR search, has-FIR, crime thana, case stage, flags) and the
// excludeJail flag on GET /cadres. Own fixtures under a file-unique thana and phone —
// see stats.test.ts for why parallel test files must not share either.
const prisma = new PrismaClient();
const config = testConfig();
const PHONE = '+919000000100';
const TOKEN = 'JAILFILT';
const THANA = 'जेल-फिल्टर';

let token = '';
const ids: Record<string, number> = {};
let app: FastifyInstance;

const auth = () => ({ authorization: `Bearer ${token}` });

// Names of the fixtures a request returned, ignoring anything other files put in the table.
async function names(qs: string): Promise<string[]> {
  const res = await app.inject({
    method: 'GET', url: `/api/v1/cadres?pageSize=50&thana=${encodeURIComponent(THANA)}&${qs}`, headers: auth(),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { data: { name: string }[] }).data.map((c) => c.name.replace(`${TOKEN}-`, '')).sort();
}

beforeAll(async () => {
  const hq = await prisma.user.upsert({
    where: { phone: PHONE }, update: { deletedAt: null, role: 'super_admin', name: 'Jail Filter HQ' },
    create: { phone: PHONE, name: 'Jail Filter HQ', role: 'super_admin' },
  });
  token = await signAccessToken({ sub: hq.id, role: 'super_admin' }, config.jwtSecret, '15m');
  app = await buildApp({ config, prisma, logger: false });

  await prisma.cadreCase.deleteMany({ where: { cadre: { name: { startsWith: TOKEN } } } });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: TOKEN } } });
  const base = { phone: '+910000000400', thana: THANA, currentAddress: 'x', designation: 'x', aliases: [] as string[], alertLevel: 'normal' as const };

  // A: FIR 101/2024 at Bijapur, in jail, UAPA.
  ids.A = (await prisma.cadre.create({
    data: {
      ...base, name: `${TOKEN}-A`, category: 'jail',
      cases: { create: [{ crimeNumber: '101/2024', crimeThana: 'बीजापुर', inJail: true, uapaApplied: true, underTrial: true }] },
    },
  })).id;
  // B: FIR 202/2023 at Usoor, on bail, concluded, public harm.
  ids.B = (await prisma.cadre.create({
    data: {
      ...base, name: `${TOKEN}-B`, category: 'jail',
      cases: { create: [{ crimeNumber: '202/2023', crimeThana: 'उसूर', bailGranted: true, publicHarmOccurred: true }] },
    },
  })).id;
  // C: jail cadre with NO case at all.
  ids.C = (await prisma.cadre.create({ data: { ...base, name: `${TOKEN}-C`, category: 'jail' } })).id;
  // D: a Maoist cadre — must never match a jail filter, and is what excludeJail keeps.
  ids.D = (await prisma.cadre.create({ data: { ...base, name: `${TOKEN}-D`, category: 'thana' } })).id;
  // E: jail cadre whose only case is soft-deleted — a deleted case must not count as an FIR.
  ids.E = (await prisma.cadre.create({
    data: {
      ...base, name: `${TOKEN}-E`, category: 'jail',
      cases: { create: [{ crimeNumber: '303/2022', deletedAt: new Date() }] },
    },
  })).id;
});

afterAll(async () => {
  await prisma.cadreCase.deleteMany({ where: { cadreId: { in: Object.values(ids) } } });
  await prisma.cadre.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.notification.deleteMany({ where: { user: { phone: PHONE } } });
  await prisma.user.deleteMany({ where: { phone: PHONE } });
  await app.close();
  await prisma.$disconnect();
});

describe('GET /cadres — jail master filter', () => {
  it('firSearch matches अपराध क्रमांक as a substring', async () => {
    expect(await names('firSearch=2024')).toEqual(['A']);
    expect(await names('firSearch=202')).toEqual(['A', 'B']);
  });

  it('hasFir=yes / no splits on a live case with a crime number', async () => {
    expect(await names('category=jail&hasFir=yes')).toEqual(['A', 'B']);
    expect(await names('category=jail&hasFir=no')).toEqual(['C', 'E']);
  });

  it('crimeThana matches the thana the FIR is registered at', async () => {
    expect(await names(`crimeThana=${encodeURIComponent('उसूर')}`)).toEqual(['B']);
  });

  it('caseStage ORs stages together; uapaApplied / publicHarm narrow', async () => {
    expect(await names('caseStage=in_jail')).toEqual(['A']);
    expect(await names('caseStage=on_bail')).toEqual(['B']);
    expect(await names('caseStage=in_jail&caseStage=on_bail')).toEqual(['A', 'B']);
    expect(await names('uapaApplied=true')).toEqual(['A']);
    expect(await names('publicHarm=true')).toEqual(['B']);
    expect(await names('caseStage=on_bail&uapaApplied=true')).toEqual([]);
  });

  it('a Maoist cadre never matches a jail filter', async () => {
    expect(await names('category=jail&caseStage=under_trial')).toEqual(['A']);
  });
});

describe('GET /cadres — excludeJail', () => {
  it('drops the jail register, keeps the Maoist one', async () => {
    expect(await names('excludeJail=true')).toEqual(['D']);
  });

  it('is opt-in: without it jail cadres are still listed (report picker, web)', async () => {
    expect(await names('')).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});

describe('GET /cadres/facets — crimeThanas', () => {
  it('lists distinct FIR thanas for the jail register only, ignoring deleted cases', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres/facets?category=jail', headers: auth() });
    const jail = res.json() as { crimeThanas: string[] };
    expect(jail.crimeThanas).toEqual(expect.arrayContaining(['बीजापुर', 'उसूर']));
    const all = (await app.inject({ method: 'GET', url: '/api/v1/cadres/facets?category=thana', headers: auth() })).json() as { crimeThanas: string[] };
    expect(all.crimeThanas).toEqual([]);
  });
});