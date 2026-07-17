import type { AlertLevel } from '@prisma/client';

// ─── Alert tag catalogue (ADR-033) ────────────────────────────────────────────
//
// The clients are canonical: this list is lifted verbatim from the mobile card's
// picker (`src/components/CadreCard.tsx`). It lives here too because `alertLevel`
// is now DERIVED from the tag (ADR-033) — the mapping has to be enforced where the
// write happens, not merely mirrored in the UI that requests it.
//
// There is deliberately no `normal` tag. `normal` is the absence of an alert, so
// `alertTag == null ⟺ alertLevel == 'normal'`. Adding a "सामान्य" tag would make
// two states mean the same thing.

export const CRITICAL_TAGS = ['उल्लंघन', 'तत्काल', 'लापता', 'सक्रिय अलर्ट'] as const;
export const WARNING_TAGS = ['निगरानी', 'सतर्क', 'संदिग्ध', 'नज़र रखें'] as const;

export const ALERT_TAGS = [...CRITICAL_TAGS, ...WARNING_TAGS] as const;

export type AlertTag = (typeof ALERT_TAGS)[number];

/**
 * The whole point of ADR-033: one function, on the server, that decides what a tag
 * means. A tag outside the catalogue cannot reach here — the Zod enum rejects it at
 * the edge — so an unknown string can never silently become `normal`.
 */
export function tagToLevel(tag: AlertTag | null): AlertLevel {
  if (tag === null) return 'normal';
  return (CRITICAL_TAGS as readonly string[]).includes(tag) ? 'critical' : 'warning';
}
