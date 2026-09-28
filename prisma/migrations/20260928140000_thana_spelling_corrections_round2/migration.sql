-- Round 2 of thana/district spelling canonicalisation (client-ruled, 2026-09-28 — see
-- BC-THESIS-SAMPARK.md for the ADR). Same reasoning and mechanism as Phase 0
-- (20260722120000_phase0_canonicalise_location_text): a spelling split makes one real
-- station's data appear as two-or-more distinct filter/facet entries, and — since
-- ADR-044 — a silent authorisation split too. Fixed by an EXPLICIT map, never fuzzy
-- matching, compared through normalize() on both sides so literal-file encoding can't
-- affect matches. Idempotent and safe to re-run.
--
-- New this round: फरसेगढ़/पामेड़ (not covered by Phase 0), चिंतागुफा's three spellings
-- (चिन्तागुफा / चिंतागुफा / चितांगुफा — the last a matra-order typo).
-- मद्देड़/भैरमगढ़/बासागुड़ा/नैमेड़ pairs from Phase 0 are repeated here defensively
-- (harmless no-op if already fixed) in case any import since Phase 0 reintroduced the
-- old spelling.
--
-- दंतेवाड़ा/दन्तेवाड़ा (district, not thana — confirmed) is DELIBERATELY left out of
-- this migration: the source register only ever has दन्तेवाड़ा/दन्तेवाडा, never the
-- दंतेवाड़ा spelling from the original request, so which form is canonical is pending
-- client confirmation. Tracked as a GitHub issue; do not add it here without a ruling.

-- 1. NFC, re-applied defensively (imports/backfills since Phase 0 may have written
-- non-NFC codepoints again).
UPDATE "cadres" SET "thana"        = normalize("thana", NFC)        WHERE "thana"        IS NOT NULL AND "thana"        <> normalize("thana", NFC);
UPDATE "cadres" SET "district"     = normalize("district", NFC)     WHERE "district"     IS NOT NULL AND "district"     <> normalize("district", NFC);
UPDATE "cadres" SET "sub_division" = normalize("sub_division", NFC) WHERE "sub_division" IS NOT NULL AND "sub_division" <> normalize("sub_division", NFC);
UPDATE "users"  SET "thana"        = normalize("thana", NFC)        WHERE "thana"        IS NOT NULL AND "thana"        <> normalize("thana", NFC);
UPDATE "users"  SET "sub_division" = normalize("sub_division", NFC) WHERE "sub_division" IS NOT NULL AND "sub_division" <> normalize("sub_division", NFC);

-- 2. Explicit thana variant map.
UPDATE "cadres" AS c
SET "thana" = normalize(v.canonical, NFC)
FROM (VALUES
    ('मद्देड',    'मद्देड़'),
    ('भैरमगढ',    'भैरमगढ़'),
    ('बासागुडा',  'बासागुड़ा'),
    ('फरसेगढ',    'फरसेगढ़'),
    ('पामेड',     'पामेड़'),
    ('नैमेड',     'नैमेड़'),
    ('नेमेड',     'नैमेड़'),
    ('नेमेड़',    'नैमेड़'),
    ('चिन्तागुफा', 'चिंतागुफा'),
    ('चितांगुफा', 'चिंतागुफा')
) AS v(variant, canonical)
WHERE normalize(c."thana", NFC) = normalize(v.variant, NFC)
  AND c."thana" <> normalize(v.canonical, NFC);

UPDATE "users" AS u
SET "thana" = normalize(v.canonical, NFC)
FROM (VALUES
    ('मद्देड',    'मद्देड़'),
    ('भैरमगढ',    'भैरमगढ़'),
    ('बासागुडा',  'बासागुड़ा'),
    ('फरसेगढ',    'फरसेगढ़'),
    ('पामेड',     'पामेड़'),
    ('नैमेड',     'नैमेड़'),
    ('नेमेड',     'नैमेड़'),
    ('नेमेड़',    'नैमेड़')
) AS v(variant, canonical)
WHERE normalize(u."thana", NFC) = normalize(v.variant, NFC)
  AND u."thana" <> normalize(v.canonical, NFC);
