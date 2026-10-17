import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { fuzzyScores } from '../../lib/fuzzy-search.js';
import { cadreScopeWhere, type CadreScope } from '../../lib/scope.js';

// ADR-070. Fuzzy cadre search. The algorithm and its tuning live in lib/fuzzy-search.ts, shared
// with the officer / account / report searches (ADR-071); this file is the cadre-specific half.

/**
 * Cadre id -> relevance score for a free-text query, best first. Does NOT apply scope, category
 * or any facet filter — the caller ANDs those on afterwards — and skips soft-deleted rows.
 */
export function fuzzyCadreScores(prisma: PrismaClient, raw: string): Promise<Map<number, number>> {
  return fuzzyScores(prisma, 'cadres', raw, { nameBoost: true, liveOnly: true });
}

// ─── "Is this person already in the register?" ────────────────────────────────

/** Fuzzy candidates carried into the exact name re-rank. Name tokens can also match a father's
 *  name or an address, so this is a superset of the real answer. */
const SIMILAR_CANDIDATES = 150;
/** How many lookalikes the create form shows. */
const SIMILAR_LIMIT = 5;

export interface SimilarCadreQuery {
  name: string;
  fatherName?: string;
  thana?: string;
  phone?: string;
}

export interface SimilarCadre {
  id: number;
  name: string;
  fatherName?: string;
  thana: string;
  serialNumber?: string;
  designation: string;
  /** Why it looks like the same person, beyond the name. */
  matchedFather: boolean;
  sameThana: boolean;
  samePhone: boolean;
}

// Last ten digits — a phone typed with or without +91 / 0 must still compare equal.
const phoneTail = (p: string | null | undefined): string => (p ?? '').replace(/\D/g, '').slice(-10);

/**
 * Cadres whose NAME is a fuzzy match for `name` (spelling variants, Devanagari <-> Latin), most
 * likely first. The name must match on its own; father, thana and phone then raise the rank and
 * are reported back as the reasons. A one-word name matches too many people to be a warning on
 * its own, so it needs at least one of those corroborations. Respects the caller's scope.
 *
 * The same rules run offline in Sampark Mobile Application/src/db/cadreSearch.ts.
 */
export async function findSimilarCadres(
  prisma: PrismaClient,
  query: SimilarCadreQuery,
  scope: CadreScope,
): Promise<SimilarCadre[]> {
  const candidateIds = [...(await fuzzyCadreScores(prisma, query.name)).keys()].slice(0, SIMILAR_CANDIDATES);
  if (candidateIds.length === 0) return [];

  const visible = await prisma.cadre.findMany({
    where: { id: { in: candidateIds }, deletedAt: null, ...cadreScopeWhere(scope) },
    select: { id: true, name: true, fatherName: true, thana: true, phone: true, serialNumber: true, designation: true },
  });
  if (visible.length === 0) return [];

  // Exact re-rank of the survivors: the name alone (name + aliases), then the father alone.
  const father = query.fatherName?.trim() ?? '';
  const scored = await prisma.$queryRaw<
    { id: number; name_score: number | null; father_score: number | null; name_tokens: number }[]
  >`
    SELECT c.id,
           sampark_text_score(${query.name}, c.search_name, sampark_search_skel(c.search_name)) AS name_score,
           CASE WHEN ${father} <> '' AND c.father_name IS NOT NULL
                THEN sampark_text_score(${father}, k.fk, sampark_search_skel(k.fk)) END AS father_score,
           cardinality(string_to_array(sampark_search_key(${query.name}), ' ')) AS name_tokens
    FROM cadres c
    CROSS JOIN LATERAL (SELECT sampark_search_key(c.father_name) AS fk) k
    WHERE c.id IN (${Prisma.join(visible.map((v) => v.id))})
  `;
  const byId = new Map(scored.map((s) => [s.id, s]));

  const thana = query.thana?.trim() ?? '';
  const phone = phoneTail(query.phone);
  return visible
    .flatMap((c) => {
      const s = byId.get(c.id);
      if (s === undefined || s.name_score === null) return [];
      const matchedFather = s.father_score !== null;
      const sameThana = thana !== '' && c.thana.trim() === thana;
      const samePhone = phone.length >= 10 && phoneTail(c.phone) === phone;
      if (s.name_tokens < 2 && !matchedFather && !sameThana && !samePhone) return [];
      const rank = s.name_score + (matchedFather ? 0.2 : 0) + (sameThana ? 0.1 : 0) + (samePhone ? 0.3 : 0);
      return [{ rank, c, matchedFather, sameThana, samePhone }];
    })
    .sort((a, b) => b.rank - a.rank || a.c.id - b.c.id)
    .slice(0, SIMILAR_LIMIT)
    .map(({ c, matchedFather, sameThana, samePhone }) => ({
      id: c.id,
      name: c.name,
      fatherName: c.fatherName ?? undefined,
      thana: c.thana,
      serialNumber: c.serialNumber ?? undefined,
      designation: c.designation,
      matchedFather,
      sameThana,
      samePhone,
    }));
}
