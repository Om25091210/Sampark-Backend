import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

// ADR-070 / ADR-071. Fuzzy text search over a table's derived keys.
//
// `sampark_search_key()` (migration 20261017081655_cadre_fuzzy_search) folds Devanagari and Latin
// spellings to one phonetic alphabet, and a per-table trigger keeps `search_text` / `search_skel`
// current on every write (`search_name` too, on cadres). This module only RANKS: it asks Postgres
// which rows' keys are close to the query's key and how close.
//
// A query token matches a row when ANY of these holds, and the row qualifies only if EVERY token
// matches (so "hidma podiyam" narrows, it does not widen):
//   - exact token            1.00
//   - token prefix           0.92   (typing "kunj" finds "kunjam" as you go)
//   - substring              0.80
//   - trigram word-similarity of the key            (a letter wrong / missing / doubled)
//   - 0.85 x trigram word-similarity of the vowel-free skeleton   (e/i, o/u, a/aa slips)
// The row's score is the mean over tokens (cadres: plus 0.15 per token that also hits the cadre's
// own name/aliases, so the person NAMED Hidma outranks the person whose FATHER is Hidma).
//
// Short tokens have too few trigrams to be meaningful. Under 3 folded characters they match by
// prefix only; at exactly 3 they match by prefix or substring but not by trigram similarity — a
// 3-letter key shares its first two trigrams with every word that starts with the same two
// letters, which scores a flat 0.5 ("Beta" would have matched "Bhairamgarh"). Measured on the 860
// real pairs, gating trigrams at 4+ cost 2 finds and trimmed the result lists.
// The same algorithm runs offline in Sampark Mobile Application/src/lib/searchKey.ts.

/** Minimum per-token score. 0.5 was the sweet spot on 860 real duplicate pairs: 0.4 doubled the
 *  result list for +4 finds, 0.45 changed nothing, 0.6 lost 10 correct finds. */
export const MIN_TOKEN_SCORE = 0.5;

/** Hard ceiling on fuzzy candidates carried into the caller's Prisma filter step. */
export const MAX_CANDIDATES = 2000;

/** Tables that carry `search_text` / `search_skel` (and, for cadres only, `search_name`). */
export type FuzzyTable = 'cadres' | 'users' | 'reports';

export interface FuzzyOptions {
  /** Cadres only: +0.15 per token that also matches `search_name`. */
  nameBoost?: boolean;
  /** Skip soft-deleted rows inside the query (tables whose caller does not filter them itself). */
  liveOnly?: boolean;
}

/**
 * Row id -> relevance score for a free-text query, best first. Does NOT apply scope, category or
 * any facet filter — the caller ANDs those on afterwards. Empty when the query folds to nothing
 * (e.g. only honorifics) or nothing is close enough.
 */
export async function fuzzyScores(
  prisma: PrismaClient,
  table: FuzzyTable,
  raw: string,
  opts: FuzzyOptions = {},
): Promise<Map<number, number>> {
  const threshold = Prisma.raw(String(MIN_TOKEN_SCORE));
  const from = Prisma.raw(table);
  const boost = opts.nameBoost
    ? Prisma.sql`+ CASE WHEN word_similarity(qt.t, c.search_name) >= ${threshold} THEN 0.15 ELSE 0 END`
    : Prisma.empty;
  const live = opts.liveOnly ? Prisma.sql`c.deleted_at IS NULL AND` : Prisma.empty;

  // set_config(..., true) is transaction-local, so this survives PgBouncer transaction pooling
  // and cannot leak the threshold to another request's connection.
  const [, rows] = await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(MIN_TOKEN_SCORE)}, true)`,
    prisma.$queryRaw<{ id: number; score: number }[]>`
      WITH qt AS (
        SELECT t, regexp_replace(t, '[aeiou]', '', 'g') AS sk
        FROM unnest(string_to_array(sampark_search_key(${raw}), ' ')) AS t
        WHERE t <> ''
      )
      SELECT c.id, avg(s.score ${boost})::float8 AS score
      FROM ${from} c
      CROSS JOIN qt
      CROSS JOIN LATERAL (
        SELECT GREATEST(
          CASE WHEN c.search_text ~ ('(^| )' || qt.t || '( |$)') THEN 1.0
               WHEN c.search_text ~ ('(^| )' || qt.t) THEN 0.92
               WHEN length(qt.t) >= 3 AND strpos(c.search_text, qt.t) > 0 THEN 0.8
               ELSE 0 END,
          CASE WHEN length(qt.t) >= 4 THEN word_similarity(qt.t, c.search_text) ELSE 0 END,
          CASE WHEN length(qt.sk) >= 3 THEN 0.85 * word_similarity(qt.sk, c.search_skel) ELSE 0 END
        ) AS score
      ) s
      WHERE ${live} (
          (length(qt.t) >= 4 AND qt.t <% c.search_text)
          OR (length(qt.t) >= 3 AND c.search_text LIKE '%' || qt.t || '%')
          OR (length(qt.t) >= 3 AND length(qt.sk) >= 3 AND qt.sk <% c.search_skel)
          OR (length(qt.t) < 3 AND c.search_text ~ ('(^| )' || qt.t))
        )
      GROUP BY c.id
      HAVING count(*) = (SELECT count(*) FROM qt) AND min(s.score) >= ${threshold}
      ORDER BY score DESC, c.id ASC
      LIMIT ${MAX_CANDIDATES}
    `,
  ]);
  return new Map(rows.map((r) => [r.id, r.score]));
}
