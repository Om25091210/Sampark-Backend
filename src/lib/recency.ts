import { Prisma } from '@prisma/client';

// ADR-041/046/047. Reporting-recency tier → a Prisma where clause over each cadre's
// report windows. THE one place both the `/cadres?recency` list filter and the
// `/stats/dashboard` recency tiles call, so a tile's count always equals the length of
// the list its drill-down opens — the no-drift guarantee ADR-041 established with a
// single constant, now preserved across ADR-046/047's per-category cadence split.
//
// ADR-047 replaced ADR-046's "tiers are multiples of the cadence" rule with fixed,
// client-specified day caps per category (TIER_CAPS below) — NOT a formula, because
// the escalation windows are not proportional to the cadence (जोखिम is a flat +30-day
// band for every category, not a scaled one). jail/death carry no cadence — they never
// alarm and sit in `current` only.
//
// The four tiers partition every live cadre: each row matches exactly one branch by
// priorityCategory, and within a branch the windows are disjoint and exhaustive, so the
// counts sum to the total (ADR-041's invariant).

export type RecencyTier = 'current' | 'overdue1m' | 'overdue2m' | 'overdue3m';

const RECENCY_DAY_MS = 86_400_000;

interface TierCaps {
  /** सामान्य ends here (days since last report). */
  current: number;
  /** सतर्क ends here. */
  overdue1m: number;
  /** जोखिम ends here; उच्च जोखिम is everything beyond, open-ended. */
  overdue2m: number;
}

// ADR-047. Confirmed with the client (2026-07-24): A is unchanged from ADR-046's
// original 1×/2×/3× scheme (30/60/90, since its cadence already made those line up).
// B and C are NOT scaled the same way — जोखिम is capped at a flat +30 days past सतर्क
// for every category, not a third multiple of the cadence.
const TIER_CAPS: Record<'A' | 'B' | 'C', TierCaps> = {
  A: { current: 30, overdue1m: 60, overdue2m: 90 },
  B: { current: 60, overdue1m: 120, overdue2m: 150 },
  C: { current: 90, overdue1m: 180, overdue2m: 210 },
};

// The report-window clause for one category's caps and one tier.
function windowFor(caps: TierCaps, tier: RecencyTier, now: number): Prisma.CadreWhereInput {
  const d = (days: number) => new Date(now - days * RECENCY_DAY_MS);
  const some = (gte: Date): Prisma.CadreWhereInput => ({ reports: { some: { deletedAt: null, reportedAt: { gte } } } });
  const none = (gte: Date): Prisma.CadreWhereInput => ({ reports: { none: { deletedAt: null, reportedAt: { gte } } } });
  switch (tier) {
    case 'current':
      return some(d(caps.current));
    case 'overdue1m':
      return { AND: [some(d(caps.overdue1m)), none(d(caps.current))] };
    case 'overdue2m':
      return { AND: [some(d(caps.overdue2m)), none(d(caps.overdue1m))] };
    case 'overdue3m':
      return none(d(caps.overdue2m)); // beyond जोखिम's cap (includes never-reported)
  }
}

// The graded/default branches. `null` (ungraded, pre-backfill) uses A's caps — the
// same 30/60/90 the old REPORTING_CADENCE_DAYS default produced, so ungraded rows
// don't shift behaviour just because this file changed.
const CADENCE_BRANCHES: { match: Prisma.CadreWhereInput; caps: TierCaps }[] = [
  { match: { priorityCategory: 'A' }, caps: TIER_CAPS.A },
  { match: { priorityCategory: 'B' }, caps: TIER_CAPS.B },
  { match: { priorityCategory: 'C' }, caps: TIER_CAPS.C },
  { match: { priorityCategory: null }, caps: TIER_CAPS.A },
];

export function recencyTierWhere(tier: RecencyTier): Prisma.CadreWhereInput {
  const now = Date.now();
  const branches: Prisma.CadreWhereInput[] = CADENCE_BRANCHES.map((b) => ({
    AND: [b.match, windowFor(b.caps, tier, now)],
  }));
  // jail/death have no cadence, so they never go overdue — they belong to `current`
  // only. Adding them here (and nowhere else) keeps the four tiers summing to the total.
  if (tier === 'current') {
    branches.push({ priorityCategory: { in: ['jail', 'death'] } });
  }
  return { OR: branches };
}
