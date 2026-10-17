import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

// ADR-071. The SQL functions behind fuzzy search have a TypeScript twin on the phone
// (Sampark Mobile Application/src/lib/searchKey.ts) that answers the same queries offline. This
// file pins the SQL to a fixture generated from it; the mobile repo's `npm run check:search-key`
// pins the twin to the SAME fixture (src/lib/searchKey.parity.json there). If you change a rule
// in the migration, this test fails — regenerate the fixture and port the rule to the phone.
const prisma = new PrismaClient();
afterAll(async () => {
  await prisma.$disconnect();
});

const fixture = JSON.parse(readFileSync(new URL('./search-key-parity.json', import.meta.url), 'utf8')) as {
  keys: [string, string, string][];
  wordSimilarity: [string, string, number][];
  textScore: [string, string, number | null][];
};

describe('fuzzy-search SQL vs the shared parity fixture', () => {
  it.each(fixture.keys)('sampark_search_key(%j) = %j', async (input, key, skel) => {
    const rows = await prisma.$queryRaw<{ k: string; s: string }[]>`
      SELECT sampark_search_key(${input}) AS k, sampark_search_skel(sampark_search_key(${input})) AS s`;
    expect(rows[0]!.k).toBe(key);
    expect(rows[0]!.s).toBe(skel);
  });

  it.each(fixture.wordSimilarity)('word_similarity(%j, %j) = %d', async (q, t, expected) => {
    const rows = await prisma.$queryRaw<{ v: number }[]>`SELECT word_similarity(${q}, ${t})::float8 AS v`;
    expect(rows[0]!.v).toBeCloseTo(expected, 5);
  });

  it.each(fixture.textScore)('sampark_text_score(%j, %j) = %s', async (q, hay, expected) => {
    const rows = await prisma.$queryRaw<{ v: number | null }[]>`
      SELECT sampark_text_score(${q}, ${hay}, sampark_search_skel(${hay}))::float8 AS v`;
    if (expected === null) expect(rows[0]!.v).toBeNull();
    else expect(rows[0]!.v).toBeCloseTo(expected, 5);
  });
});
