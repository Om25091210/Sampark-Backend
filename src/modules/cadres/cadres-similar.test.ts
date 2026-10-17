import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';

// ADR-071. GET /cadres/similar — "is this person already in the register?", asked from the
// create form. Own fixtures under file-unique thanas and phones (see stats.test.ts for why
// parallel test files must not share them).
const prisma = new PrismaClient();
const config = testConfig();
const HQ_PHONE = '+919000000191';
const SHO_PHONE = '+919000000192';
const THANA_A = 'सिमिलर-ए';
const THANA_B = 'सिमिलर-बी';

let hqToken = '';
let shoToken = '';
const ids: Record<string, number> = {};
let app: FastifyInstance;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

interface Similar {
  id: number;
  name: string;
  matchedFather: boolean;
  sameThana: boolean;
  samePhone: boolean;
}

async function similar(qs: Record<string, string>, token = hqToken): Promise<Similar[]> {
  const res = await app.inject({
    method: 'GET', url: `/api/v1/cadres/similar?${new URLSearchParams(qs).toString()}`, headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { data: Similar[] }).data;
}

const letters = (rows: Similar[]): string[] => {
  const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  return rows.map((r) => byId[r.id] ?? `?${r.id}`);
};

beforeAll(async () => {
  const hq = await prisma.user.upsert({
    where: { phone: HQ_PHONE }, update: { deletedAt: null, role: 'super_admin', name: 'Similar HQ' },
    create: { phone: HQ_PHONE, name: 'Similar HQ', role: 'super_admin' },
  });
  const sho = await prisma.user.upsert({
    where: { phone: SHO_PHONE }, update: { deletedAt: null, role: 'officer', thana: THANA_A, name: 'Similar SHO' },
    create: { phone: SHO_PHONE, name: 'Similar SHO', role: 'officer', thana: THANA_A },
  });
  hqToken = await signAccessToken({ sub: hq.id, role: 'super_admin' }, config.jwtSecret, '15m');
  shoToken = await signAccessToken({ sub: sho.id, role: 'officer' }, config.jwtSecret, '15m');
  app = await buildApp({ config, prisma, logger: false });

  await prisma.cadre.deleteMany({ where: { thana: { in: [THANA_A, THANA_B] } } });
  const base = { currentAddress: 'x', designation: 'x', category: 'thana' as const, alertLevel: 'normal' as const, aliases: [] as string[] };

  // A: Hidma Podiyam, father Muka, in THANA_A.
  ids.A = (await prisma.cadre.create({ data: { ...base, name: 'हिड़मा पोडियाम', fatherName: 'मुका', thana: THANA_A, phone: '+919100000001' } })).id;
  // C: Rameshwar Netam, in the OTHER thana — outside the SHO's scope.
  ids.C = (await prisma.cadre.create({ data: { ...base, name: 'रामेश्वर नेताम', thana: THANA_B, phone: '+919100000002' } })).id;
  // D: a soft-deleted Hidma Podiyam — must never be offered.
  ids.D = (await prisma.cadre.create({ data: { ...base, name: 'हिडमा पोडियाम', thana: THANA_A, phone: '+919100000003', deletedAt: new Date() } })).id;
});

afterAll(async () => {
  await prisma.cadre.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.notification.deleteMany({ where: { user: { phone: { in: [HQ_PHONE, SHO_PHONE] } } } });
  await prisma.user.deleteMany({ where: { phone: { in: [HQ_PHONE, SHO_PHONE] } } });
  await app.close();
  await prisma.$disconnect();
});

describe('GET /cadres/similar', () => {
  it('finds the Devanagari record from a Latin spelling', async () => {
    expect(letters(await similar({ name: 'Hidma Podiyam' }))).toEqual(['A']);
  });

  it.each(['Hidama Podiam', 'हिडमा पोडियाम', 'Hedma Podyam'])('tolerates the spelling "%s"', async (name) => {
    expect(letters(await similar({ name }))).toContain('A');
  });

  it('reports why it matched: father, thana, phone', async () => {
    const [hit] = await similar({ name: 'Hidma Podiyam', fatherName: 'Muka', thana: THANA_A, phone: '9100000001' });
    expect(hit).toMatchObject({ matchedFather: true, sameThana: true, samePhone: true });
    const [bare] = await similar({ name: 'Hidma Podiyam' });
    expect(bare).toMatchObject({ matchedFather: false, sameThana: false, samePhone: false });
  });

  it('a different father does not hide the match — it is just not corroborated', async () => {
    const [hit] = await similar({ name: 'Hidma Podiyam', fatherName: 'Somaru Kashyap' });
    expect(hit).toMatchObject({ matchedFather: false });
  });

  it('a one-word name is not enough on its own, but father / thana / phone corroborate it', async () => {
    expect(await similar({ name: 'Hidma' })).toEqual([]);
    expect(letters(await similar({ name: 'Hidma', thana: THANA_A }))).toEqual(['A']);
    expect(letters(await similar({ name: 'Hidma', fatherName: 'Muka' }))).toEqual(['A']);
    expect(letters(await similar({ name: 'Hidma', phone: '+91 91000 00001' }))).toEqual(['A']);
  });

  it('respects the caller\'s scope, like the list', async () => {
    expect(letters(await similar({ name: 'Rameshwar Netam' }))).toEqual(['C']);
    expect(await similar({ name: 'Rameshwar Netam' }, shoToken)).toEqual([]);
    expect(letters(await similar({ name: 'Hidma Podiyam' }, shoToken))).toEqual(['A']);
  });

  it('never offers a soft-deleted cadre', async () => {
    expect(letters(await similar({ name: 'हिडमा पोडियाम' }))).not.toContain('D');
  });

  it('returns an empty list for a name that is not there', async () => {
    expect(await similar({ name: 'Zzzxqv Qwxzy' })).toEqual([]);
  });

  it('requires a name (400) and a token (401)', async () => {
    const noName = await app.inject({ method: 'GET', url: '/api/v1/cadres/similar', headers: auth(hqToken) });
    expect(noName.statusCode).toBe(400);
    const anon = await app.inject({ method: 'GET', url: '/api/v1/cadres/similar?name=x' });
    expect(anon.statusCode).toBe(401);
  });
});
