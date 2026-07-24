import { Prisma } from '@prisma/client';
import { cadenceDaysFor, REPORTING_CADENCE_DAYS } from './serialize.js';

// ADR-041/046. Reporting-recency tier → a Prisma where clause over each cadre's report
// windows. THE one place both the `/cadres?recency` list filter and the
// `/stats/dashboard` recency tiles call, so a tile's count always equals the length of
// the list its drill-down opens — the no-drift guarantee ADR-041 established with a
// single constant, now preserved across ADR-046's per-category cadence split.
//
// Each tier's window scales as a multiple of the CADRE'S OWN cadence (cadenceDaysFor):
// so a grade-A cadre 35 days dark reads `overdue1m` while a grade-C cadre at 35 days
// still reads `current`. jail/death carry no cadence — they never alarm and sit in
// `current` only.
//
// The four tiers partition every live cadre: each row matches exactly one branch by
// priorityCategory, and within a branch the windows are disjoint and exhaustive, so the
// counts sum to the total (ADR-041's invariant).

export type RecencyTier = 'current' | 'overdue1m' | 'overdue2m' | 'overdue3m';

const RECENCY_DAY_MS = 86_400_000;

// The report-window clause for one cadence and one tier. Same 1×/2×/3× boundaries the
// dashboard counts use, expressed as multiples of `cadence` rather than a fixed 30/60/90.
function windowFor(cadence: number, tier: RecencyTier, now: number): Prisma.CadreWhereInput {
  const d = (mult: number) => new Date(now - cadence * mult * RECENCY_DAY_MS);
  const some = (gte: Date): Prisma.CadreWhereInput => ({ reports: { some: { deletedAt: null, reportedAt: { gte } } } });
  const none = (gte: Date): Prisma.CadreWhereInput => ({ reports: { none: { deletedAt: null, reportedAt: { gte } } } });
  switch (tier) {
    case 'current':
      return some(d(1)); // reported within 1× the cadence
    case 'overdue1m':
      return { AND: [some(d(2)), none(d(1))] }; // within [2×, 1×)
    case 'overdue2m':
      return { AND: [some(d(3)), none(d(2))] }; // within [3×, 2×)
    case 'overdue3m':
      return none(d(3)); // nothing within 3× (includes never-reported)
  }
}

// The graded/default branches: each priorityCategory matched with a window scaled to
// its own cadence. `null` (ungraded, pre-backfill) uses the 30d default. Cadences come
// from cadenceDaysFor so they are defined exactly once (serialize.ts) — A/B/C/null all
// yield a concrete number there.
const CADENCE_BRANCHES: { match: Prisma.CadreWhereInput; cadence: number }[] = [
  { match: { priorityCategory: 'A' }, cadence: cadenceDaysFor('A')! },
  { match: { priorityCategory: 'B' }, cadence: cadenceDaysFor('B')! },
  { match: { priorityCategory: 'C' }, cadence: cadenceDaysFor('C')! },
  { match: { priorityCategory: null }, cadence: REPORTING_CADENCE_DAYS },
];

export function recencyTierWhere(tier: RecencyTier): Prisma.CadreWhereInput {
  const now = Date.now();
  const branches: Prisma.CadreWhereInput[] = CADENCE_BRANCHES.map((b) => ({
    AND: [b.match, windowFor(b.cadence, tier, now)],
  }));
  // jail/death have no cadence, so they never go overdue — they belong to `current`
  // only. Adding them here (and nowhere else) keeps the four tiers summing to the total.
  if (tier === 'current') {
    branches.push({ priorityCategory: { in: ['jail', 'death'] } });
  }
  return { OR: branches };
}
