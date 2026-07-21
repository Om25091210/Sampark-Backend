/**
 * Unicode normalisation for Devanagari text (Phase 0).
 *
 * Hindi has look-alike codepoint sequences that are canonically EQUIVALENT but not
 * byte-equal, so `=` in Postgres and `===` in JS treat them as different values:
 *
 *   ड़  =  U+095C                 (precomposed DEVANAGARI LETTER DDDHA)
 *   ड़  =  U+0921 U+093C          (DDA + NUKTA — what NFC produces)
 *
 * NFC does NOT compose the second form into the first: the precomposed nukta letters
 * (U+0929, U+0931, U+0934, U+095C..U+095F) are on Unicode's composition-exclusion list,
 * so NFC decomposes them instead. The canonical stored form is therefore the two-codepoint
 * sequence — matching what Android and most Hindi IMEs already emit.
 *
 * This is not theoretical. Before Phase 0, `भैरमगढ़` existed as BOTH forms in `cadres`:
 * 209 rows decomposed, 138 rows precomposed. A sub-division scope filter comparing the
 * SDOP's own (decomposed) value would have matched 209 and silently hidden the other 138 —
 * an access-control failure that looks exactly like "those cadres don't exist", with no
 * error and nothing visibly wrong in either string.
 *
 * The rule (client instruction, 2026-07-22): normalise at the POINT OF COMPARISON,
 * everywhere. That means write-time (here, at the Zod boundary), the one-off data fix
 * (the Phase 0 migration), and any future scope-filter comparison — not just the instances
 * we happened to find.
 */

/** Canonical NFC form. Idempotent; safe to apply to already-normalised text. */
export function nfc(value: string): string {
  return value.normalize('NFC');
}

/** NFC, tolerant of the null/undefined an optional field may carry. */
export function nfcOrNull<T extends string | null | undefined>(value: T): T {
  return (typeof value === 'string' ? (value.normalize('NFC') as T) : value);
}
