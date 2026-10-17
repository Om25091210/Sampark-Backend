import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

// ADR-070. Fuzzy GET /cadres?search=. Own fixtures under a file-unique thana and phone — see
// stats.test.ts for why parallel test files must not share either. Every request below is
// ANDed with that thana so rows other files put in the table cannot leak into an assertion.
const prisma = new PrismaClient();
const config = testConfig();
const PHONE = '+919000000190';
const THANA = 'फज़ी-सर्च';

let token = '';
const ids: Record<string, number> = {};
let app: FastifyInstance;

const auth = () => ({ authorization: `Bearer ${token}` });

interface Page {
  data: { id: number; name: string }[];
  total: number;
  hasMore: boolean;
}

async function search(term: string, extra = '', pageSize = 50): Promise<Page> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/cadres?pageSize=${pageSize}&thana=${encodeURIComponent(THANA)}&search=${encodeURIComponent(term)}${extra}`,
    headers: auth(),
  });
  expect(res.statusCode).toBe(200);
  return res.json() as Page;
}

// Fixture letters, in the order the search returned them.
async function hits(term: string, extra = ''): Promise<string[]> {
  const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  return (await search(term, extra)).data.map((c) => byId[c.id]!);
}

async function key(text: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ k: string }[]>`SELECT sampark_search_key(${text}) AS k`;
  return rows[0]!.k;
}

beforeAll(async () => {
  const hq = await prisma.user.upsert({
    where: { phone: PHONE }, update: { deletedAt: null, role: 'super_admin', name: 'Fuzzy Search HQ' },
    create: { phone: PHONE, name: 'Fuzzy Search HQ', role: 'super_admin' },
  });
  token = await signAccessToken({ sub: hq.id, role: 'super_admin' }, config.jwtSecret, '15m');
  app = await buildApp({ config, prisma, logger: false });

  await prisma.cadre.deleteMany({ where: { thana: THANA } });
  const base = { phone: '+910000000401', thana: THANA, currentAddress: 'x', designation: 'x', category: 'thana' as const, alertLevel: 'normal' as const };

  // A: the person NAMED Hidma Podiyam.
  ids.A = (await prisma.cadre.create({ data: { ...base, name: 'हिड़मा पोडियाम', fatherName: 'मुका', aliases: [] } })).id;
  // B: Kunjam Lakhma.
  ids.B = (await prisma.cadre.create({ data: { ...base, name: 'कुंजाम लखमा', aliases: [] } })).id;
  // C: Mahendra Karma, with a Latin alias (the "@" convention).
  ids.C = (await prisma.cadre.create({ data: { ...base, name: 'महेन्द्र कर्मा', aliases: ['Mahendra Ji'] } })).id;
  // D: someone else whose FATHER is Hidma — must rank BELOW A for the query "hidma".
  ids.D = (await prisma.cadre.create({ data: { ...base, name: 'रामेश्वर नेताम', fatherName: 'हिड़मा नेताम', aliases: [] } })).id;
  // E: soft-deleted Hidma — must never come back.
  ids.E = (await prisma.cadre.create({ data: { ...base, name: 'हिडमा मरकाम', aliases: [], deletedAt: new Date() } })).id;
});

afterAll(async () => {
  await prisma.cadre.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.notification.deleteMany({ where: { user: { phone: PHONE } } });
  await prisma.user.deleteMany({ where: { phone: PHONE } });
  await app.close();
  await prisma.$disconnect();
});

describe('sampark_search_key — one alphabet for both scripts', () => {
  it.each([
    ['हिड़मा', 'हिडमा', 'Hidma', 'Hidama'],
    ['पोडियाम', 'Podiyam', 'Podiiyam', 'Podiyaam'],
    ['सिंह', 'Singh', 'Sinh', 'सिन्ह'],
    ['महेन्द्र', 'Mahendra', 'Mahendr', 'महेंद्र'],
    ['कुंजाम', 'Kunjam', 'Kujam', 'कुन्जाम'],
    ['सम्पत', 'संपत', 'Sampat', 'Sanpat'],
  ])('%s collapses to one key across spellings', async (...variants) => {
    const keys = await Promise.all(variants.map(key));
    expect(new Set(keys).size).toBe(1);
  });

  it('keeps a leading nasal that has no cluster (मड़कम is not डकम)', async () => {
    expect(await key('मड़कम')).toBe(await key('Madkam'));
    expect(await key('Madkam')).toMatch(/^m/);
  });

  it('drops honorifics in both scripts, and keeps register serials searchable', async () => {
    expect(await key('स्व. श्री रमेश कुमार')).toBe(await key('Late Shri Ramesh Kumar'));
    expect(await key('BJP/2025/0001')).toContain('0001');
  });

  it('is empty for null / only-noise input instead of throwing', async () => {
    expect(await key('')).toBe('');
    expect(await key('श्री.')).toBe('');
  });
});

describe('GET /cadres?search= — fuzzy', () => {
  it('finds a Devanagari record from a Latin query', async () => {
    expect(await hits('Hidma Podiyam')).toEqual(['A']);
  });

  it.each(['Hidma', 'Hidama', 'Hedma', 'hidmaa', 'हिडमा', 'हिड़मा'])('tolerates the spelling "%s"', async (term) => {
    expect(await hits(term)).toContain('A');
  });

  it('ranks the person NAMED Hidma above the person whose father is', async () => {
    expect(await hits('hidma')).toEqual(['A', 'D']);
  });

  it('is multi-token AND: a second word narrows, it does not widen', async () => {
    expect(await hits('hidma podiam')).toEqual(['A']);
    expect(await hits('hidma lakhma')).toEqual([]);
  });

  it('ignores honorifics in the query', async () => {
    expect(await hits('Late Shri Hidma Podiyam')).toEqual(['A']);
  });

  it('matches by prefix while the officer is still typing', async () => {
    expect(await hits('kunj')).toEqual(['B']);
    expect(await hits('पोडि')).toEqual(['A']);
  });

  it('copes with a vowel slip and a missing nasal', async () => {
    expect(await hits('Kujam Lakhma')).toEqual(['B']);
    expect(await hits('Mahindra Karma')).toEqual(['C']);
  });

  it('returns nothing for something that is not there', async () => {
    expect(await hits('zzzxqv')).toEqual([]);
  });

  it('never returns a soft-deleted cadre', async () => {
    expect(await hits('hidma markam')).toEqual([]);
    expect(await hits('markam')).toEqual([]);
  });

  it('keeps working for a query that is only honorifics (falls back to the literal match)', async () => {
    const res = await search('श्री');
    expect(res.data).toEqual([]);
  });

  it('pages in ranked order with a truthful total / hasMore', async () => {
    const p1 = await search('hidma', '&page=1', 1);
    expect(p1.total).toBe(2);
    expect(p1.hasMore).toBe(true);
    expect(p1.data.map((c) => c.id)).toEqual([ids.A]);
    const p2 = await search('hidma', '&page=2', 1);
    expect(p2.hasMore).toBe(false);
    expect(p2.data.map((c) => c.id)).toEqual([ids.D]);
  });

  it('still ANDs with the other filters', async () => {
    expect(await hits('hidma', '&category=jail')).toEqual([]);
    expect(await hits('hidma', '&category=thana')).toEqual(['A', 'D']);
  });

  it('leaves the "@" alias search exactly as it was', async () => {
    expect(await hits('@Mahendra Ji')).toEqual(['C']);
    expect(await hits('@mahendra ji')).toEqual([]);
  });

  it('requires a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres?search=hidma' });
    expect(res.statusCode).toBe(401);
  });
});

describe('the cadres_search_keys trigger', () => {
  it('re-keys on an edit of a searched column, whichever code path made it', async () => {
    expect(await hits('lakhama')).toEqual(['B']);
    await prisma.cadre.update({ where: { id: ids.B! }, data: { name: 'सुखराम पोयाम' } });
    expect(await hits('lakhma')).toEqual([]);
    expect(await hits('Sukhram Poyam')).toEqual(['B']);
  });

  it('finds a cadre by an alias added later', async () => {
    await prisma.cadre.update({ where: { id: ids.C! }, data: { aliases: ['Bhima Dada'] } });
    expect(await hits('Bheema Dada')).toEqual(['C']);
  });

  it('does not touch the keys when an unrelated column changes', async () => {
    const before = await prisma.cadre.findUniqueOrThrow({ where: { id: ids.A! }, select: { searchText: true } });
    await prisma.cadre.update({ where: { id: ids.A! }, data: { phone: '+910000000402' } });
    const after = await prisma.cadre.findUniqueOrThrow({ where: { id: ids.A! }, select: { searchText: true } });
    expect(after.searchText).toBe(before.searchText);
    expect(before.searchText).toBeTruthy();
  });

  it('never exposes the derived columns on the wire', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${ids.A}`, headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('searchText');
    expect(body).not.toHaveProperty('searchName');
    expect(body).not.toHaveProperty('searchSkel');
  });
});
