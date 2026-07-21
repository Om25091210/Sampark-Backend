-- Phase 0 — canonicalise cadre location text so scope filtering can compare it.
--
-- Phase C makes `thana`/`sub_division` an AUTHORISATION boundary: a thana account sees its
-- own station's cadres, an SDOP account its sub-division's. That turns every spelling
-- inconsistency in the imported register into a silent access-control failure — the wrong
-- rows are hidden, no error is raised, and the screen looks perfectly normal. So the data is
-- canonicalised BEFORE the filter that depends on it ships, not after.
--
-- Two distinct problems, fixed in that order:
--
--   1. CODEPOINT. Devanagari nukta letters have two canonically-equivalent encodings, e.g.
--      ड़ as U+095C or as U+0921 U+093C. They render identically and compare unequal.
--      `भैरमगढ़` existed in `cadres.sub_division` as BOTH: 209 rows one way, 138 the other.
--      An SDOP filtering on their own value would have matched 209 and hidden 138.
--      NFC is the canonical form (the precomposed nukta letters are composition-EXCLUDED,
--      so NFC produces the two-codepoint sequence — which is what the 74 real accounts
--      already hold, verified by codepoint dump before writing this).
--
--   2. SPELLING. Genuinely different spellings of the same station. Fixed by an EXPLICIT
--      map, never by fuzzy matching: every pair below was ruled on individually by the
--      client against the source register. `मिरतूर`→`मिरतुर` and the four `जगरगुण्डा`
--      forms are their rulings, not inferences.
--
-- Both steps are idempotent and safe to re-run.
--
-- NOT DONE HERE: re-deriving `sub_division` from `thana`. The plan assumed sub_division was
-- a function of thana with dirty spelling; the data says otherwise (see the thesis note for
-- ADR-043) and overwriting 1,482 client rows on a guess would destroy register content.

-- 1. NFC. Applies to users too: they are the other side of every scope comparison.
UPDATE "cadres" SET "thana"        = normalize("thana", NFC)        WHERE "thana"        IS NOT NULL AND "thana"        <> normalize("thana", NFC);
UPDATE "cadres" SET "sub_division" = normalize("sub_division", NFC) WHERE "sub_division" IS NOT NULL AND "sub_division" <> normalize("sub_division", NFC);
UPDATE "cadres" SET "district"     = normalize("district", NFC)     WHERE "district"     IS NOT NULL AND "district"     <> normalize("district", NFC);
UPDATE "users"  SET "thana"        = normalize("thana", NFC)        WHERE "thana"        IS NOT NULL AND "thana"        <> normalize("thana", NFC);
UPDATE "users"  SET "sub_division" = normalize("sub_division", NFC) WHERE "sub_division" IS NOT NULL AND "sub_division" <> normalize("sub_division", NFC);

-- 2. Explicit variant map. Compared through normalize() on BOTH sides so the encoding of
-- the literals in this file cannot affect whether a row matches.
UPDATE "cadres" AS c
SET "thana" = normalize(v.canonical, NFC)
FROM (VALUES
    ('बासागुडा', 'बासागुड़ा'),
    ('भैरमगढ', 'भैरमगढ़'),
    ('नैमेड', 'नैमेड़'),
    ('मद्देड', 'मद्देड़'),
    ('मिरतूर', 'मिरतुर'),
    ('जगरगुड़ा', 'जगरगुण्डा'),
    ('कैम्प सिलगेर थाना जगरगुण्डा', 'जगरगुण्डा'),
    ('थाना जगरगुड़ा', 'जगरगुण्डा')
) AS v(variant, canonical)
WHERE normalize(c."thana", NFC) = normalize(v.variant, NFC)
  AND c."thana" <> normalize(v.canonical, NFC);
