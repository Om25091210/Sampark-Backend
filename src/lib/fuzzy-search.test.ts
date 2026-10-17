import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { testConfig } from '../test/helpers.js';
import { signAccessToken } from './tokens.js';

// ADR-071. Fuzzy `search` on GET /officers, GET /users and GET /reports (the cadre list is
// covered by cadres-search.test.ts). Fixtures carry a file-unique token (FZYSRCH) in a name, so
// every query below can AND it on and ignore whatever other test files left in the tables.
const prisma = new PrismaClient();
const config = testConfig();
const HQ_PHONE = '+919000000193';
const TOKEN = 'FZYSRCH';

let token = '';
let hqId = 0;
const userIds: number[] = [];
const cadreIds: number[] = [];
const reportIds: number[] = [];
const ids: Record<string, number> = {};
let app: FastifyInstance;

const auth = () => ({ authorization: `Bearer ${token}` });

async function get<T>(url: string): Promise<T> {
  const res = await app.inject({ method: 'GET', url, headers: auth() });
  expect(res.statusCode).toBe(200);
  return res.json() as T;
}

const nameOf = (id: number): string => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? `?${id}`;

beforeAll(async () => {
  const hq = await prisma.user.upsert({
    where: { phone: HQ_PHONE }, update: { deletedAt: null, role: 'super_admin', name: `${TOKEN}-HQ` },
    create: { phone: HQ_PHONE, name: `${TOKEN}-HQ`, role: 'super_admin' },
  });
  hqId = hq.id;
  token = await signAccessToken({ sub: hq.id, role: 'super_admin' }, config.jwtSecret, '15m');
  app = await buildApp({ config, prisma, logger: false });

  await prisma.report.deleteMany({ where: { cadre: { name: { startsWith: TOKEN } } } });
  await prisma.cadre.deleteMany({ where: { name: { startsWith: TOKEN } } });
  await prisma.user.deleteMany({ where: { name: { in: [`${TOKEN}-O1`, `${TOKEN}-O2`] } } });

  // Officers: a Devanagari thana + designation to be found by their Latin spelling.
  const o1 = await prisma.user.create({
    data: { name: `${TOKEN}-O1`, role: 'officer', thana: 'गंगालूर', designation: 'उपनिरीक्षक', phone: '+919200000001' },
  });
  const o2 = await prisma.user.create({
    data: { name: `${TOKEN}-O2`, role: 'officer', thana: 'बीजापुर', designation: 'थानाप्रभारी', phone: '+919200000002' },
  });
  ids.O1 = o1.id; ids.O2 = o2.id;
  userIds.push(o1.id, o2.id);

  // Cadre + reports for the aggregate feed.
  const cadre = await prisma.cadre.create({
    data: {
      name: `${TOKEN} हिड़मा`, phone: '+919200000010', thana: 'बीजापुर', currentAddress: 'x', designation: 'x',
      category: 'thana', alertLevel: 'normal', aliases: [],
    },
  });
  cadreIds.push(cadre.id);
  const other = await prisma.cadre.create({
    data: {
      name: `${TOKEN} सुखराम`, phone: '+919200000011', thana: 'बीजापुर', currentAddress: 'x', designation: 'x',
      category: 'thana', alertLevel: 'normal', aliases: [],
    },
  });
  cadreIds.push(other.id);
  const mk = async (key: string, cadreId: number, specificLocation: string, currentActivity: string) => {
    const r = await prisma.report.create({
      data: {
        cadreId, reportingPlace: 'village', personStatus: 'alive', reportedById: hqId,
        specificLocation, currentActivity, currentPhone: '9300000001',
      },
    });
    ids[key] = r.id; reportIds.push(r.id);
  };
  await mk('R1', cadre.id, 'छोटेकरकेली बाजार', 'खेती');
  await mk('R2', other.id, 'उसूर', 'मजदूरी');
  await mk('R3', other.id, 'गंगालूर', 'दुकान');
});

afterAll(async () => {
  await prisma.report.deleteMany({ where: { id: { in: reportIds } } });
  await prisma.cadre.deleteMany({ where: { id: { in: cadreIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: [...userIds, hqId] } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.user.deleteMany({ where: { phone: HQ_PHONE } });
  await app.close();
  await prisma.$disconnect();
});

describe('GET /officers?search= — fuzzy', () => {
  const find = async (term: string): Promise<string[]> => {
    const page = await get<{ data: { id: number }[] }>(`/api/v1/officers?pageSize=50&search=${encodeURIComponent(term)}`);
    return page.data.map((o) => nameOf(o.id)).sort();
  };

  it('finds an officer by the Latin spelling of their Devanagari thana', async () => {
    expect(await find(`Gangalur ${TOKEN}`)).toEqual(['O1']);
    expect(await find(`Gangaloor ${TOKEN}`)).toEqual(['O1']);
    expect(await find(`Bijapur ${TOKEN}`)).toEqual(['O2']);
  });

  it('finds an officer by the Latin spelling of their designation', async () => {
    expect(await find(`Upnirikshak ${TOKEN}`)).toEqual(['O1']);
  });

  it('still matches the literal ID and the phone number', async () => {
    expect(await find(`${TOKEN}-O2`)).toEqual(['O2']);
    expect(await find('+919200000001')).toEqual(['O1']);
  });

  it('is multi-word AND: a second word narrows', async () => {
    expect(await find(`Gangalur Bijapur ${TOKEN}`)).toEqual([]);
  });

  it('never exposes the derived columns on the wire', async () => {
    const page = await get<{ data: Record<string, unknown>[] }>(`/api/v1/officers?search=${TOKEN}-O1`);
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data[0]).not.toHaveProperty('searchText');
    expect(page.data[0]).not.toHaveProperty('searchSkel');
  });
});

describe('GET /users?search= — fuzzy', () => {
  it('finds an account by its thana spelled in Latin', async () => {
    const page = await get<{ data: { id: number }[] }>(`/api/v1/users?pageSize=50&search=${encodeURIComponent(`Gangalur ${TOKEN}`)}`);
    expect(page.data.map((u) => nameOf(u.id))).toEqual(['O1']);
  });

  it('keeps the original substring match on the institutional ID', async () => {
    const page = await get<{ data: { id: number }[] }>(`/api/v1/users?pageSize=50&search=${TOKEN}-O`);
    expect(page.data.map((u) => nameOf(u.id)).sort()).toEqual(['O1', 'O2']);
  });
});

describe('the users / reports search-key triggers', () => {
  it('re-key an officer when their thana is edited', async () => {
    await prisma.user.update({ where: { id: ids.O2! }, data: { thana: 'उसूर' } });
    const page = await get<{ data: { id: number }[] }>(`/api/v1/officers?pageSize=50&search=${encodeURIComponent(`Usoor ${TOKEN}`)}`);
    expect(page.data.map((o) => nameOf(o.id))).toEqual(['O2']);
  });
});

describe('GET /reports?search= — fuzzy', () => {
  const find = async (term: string, extra = ''): Promise<string[]> => {
    const page = await get<{ data: { id: number }[] }>(
      `/api/v1/reports?pageSize=50&reportedBy=${hqId}&search=${encodeURIComponent(term)}${extra}`,
    );
    return page.data.map((r) => nameOf(r.id)).sort();
  };

  it('finds a report by a place spelled in Latin', async () => {
    expect(await find('Chotekarkeli Bazar')).toEqual(['R1']);
    expect(await find('Usoor')).toContain('R2');
  });

  it('finds a report by the activity, spelled in Latin', async () => {
    expect(await find('Majdoori')).toContain('R2');
  });

  it('finds every report about a cadre by the cadre\'s name — which the old search could not do', async () => {
    expect(await find(`Hidma ${TOKEN}`)).toEqual(['R1']);
    expect(await find(`Sukhram ${TOKEN}`)).toEqual(['R2', 'R3']);
  });

  it('still matches the phone number literally', async () => {
    expect(await find('9300000001')).toEqual(['R1', 'R2', 'R3']);
  });

  it('keeps ANDing with the other filters', async () => {
    expect(await find(`Hidma ${TOKEN}`, '&reportedAfter=2999-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('never exposes the derived columns on the wire', async () => {
    const page = await get<{ data: Record<string, unknown>[] }>(`/api/v1/reports?reportedBy=${hqId}&search=${TOKEN}`);
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data[0]).not.toHaveProperty('searchText');
  });
});
