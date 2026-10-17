-- ADR-070. Fuzzy cadre search: one phonetic alphabet for Devanagari AND Latin spellings.
--
-- Officers type "Hidma", the register holds "हिड़मा"; they type "Podiam", it holds "पोडियाम".
-- The old `contains` match found neither, so they concluded the person was missing and
-- created a duplicate. sampark_search_key() folds both scripts to the same skeleton
-- (हिड़मा / हिडमा / Hidma / Hidama -> "hidm"); GET /cadres?search= ranks on it with pg_trgm.
--
-- Order matters here: extension -> columns -> functions -> trigger -> backfill -> indexes
-- (indexes last, so the backfill does not maintain them row by row).

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "search_name" TEXT,
ADD COLUMN     "search_skel" TEXT,
ADD COLUMN     "search_text" TEXT;

-- One token -> folded phonetic skeleton. Latin digraphs are folded while Devanagari is still
-- Devanagari (the Latin rules only match ASCII), then Devanagari is transliterated into the
-- same folded alphabet, then the schwa ('a') — which Hindi and English speakers drop or insert
-- unpredictably — is removed from both.
CREATE OR REPLACE FUNCTION sampark_fold_token(tok text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  s text := tok;
BEGIN
  -- Latin
  s := replace(s, 'ngh', 'nh');                          -- singh / सिंह
  s := replace(s, 'ck', 'k');
  s := regexp_replace(s, '([bcdgjkpst])h+', '\1', 'g');  -- bh dh gh kh th jh ph ch chh sh
  s := translate(s, 'fwzq', 'pvjk');
  s := replace(s, 'x', 'ks');
  s := replace(s, 'ee', 'i');
  s := replace(s, 'oo', 'u');
  s := replace(s, 'ai', 'e');
  s := replace(s, 'ei', 'e');
  s := replace(s, 'au', 'o');
  -- A nasal directly before a plosive/affricate (kunjam / kujam, panch / pach) is written or
  -- omitted inconsistently. Done while the Latin schwa is still present, so "madkam" keeps its
  -- 'm'. 'nh' (singh) is untouched.
  s := regexp_replace(s, '[nm]+([bcdgjkpt])', '\1', 'g');

  -- Devanagari: the same rule, explicit — anusvara/chandrabindu, or a nasal + halant, before a
  -- plosive. (A bare म + ड has an invisible inherent 'a' between them and is NOT a cluster.)
  s := regexp_replace(s, '[ंँ]([कखगघचछजझटठडढतथदधपफबभ])', '\1', 'g');
  s := regexp_replace(s, '[नमणङञ]्([कखगघचछजझटठडढतथदधपफबभ])', '\1', 'g');
  -- conjuncts first, then 1:1 transliteration into the same alphabet.
  s := replace(s, 'ज्ञ', 'gy');
  s := replace(s, 'क्ष', 'ks');
  s := replace(s, 'ऋ', 'ri');
  s := replace(s, 'ृ', 'ri');
  s := translate(s,
    'इईउऊएऐओऔऑिीुूेैोौॉंँकखगघङचछजझञटठडढणतथदधनपफबभमयरलळवशषसह०१२३४५६७८९',
    'iiuueeooo' || 'iiuueeooo' || 'n' || 'n' ||
    'kkggn' || 'ccjjn' || 'ttddn' || 'ttddn' || 'ppbbm' || 'yrllvsssh' ||
    '0123456789');
  -- Vowel-less signs (अ आ ा ः ़ ् ऽ) have no counterpart in the alphabet above.
  s := regexp_replace(s, '[अआाः़्ऽ]', '', 'g');

  -- Shared
  s := replace(s, 'a', '');
  s := regexp_replace(s, '([a-z])\1+', '\1', 'g');       -- doubled letters
  s := regexp_replace(s, '[^a-z0-9]', '', 'g');
  RETURN s;
END $$;

-- Whole string -> space-separated folded tokens, honorifics / noise words removed.
CREATE OR REPLACE FUNCTION sampark_search_key(input text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  tok    text;
  folded text;
  keys   text[] := '{}';
  stop   constant text[] := ARRAY[
    'स्व', 'स्वर्गीय', 'स्वर्गीया', 'श्री', 'श्रीमती', 'श्रीमान', 'ग्राम', 'थाना', 'निवासी',
    'late', 'shri', 'shree', 'sri', 'shrimati', 'smt', 'mr', 'mrs', 'dr', 'swa', 'sw',
    'swargiya', 'gram', 'thana', 'village', 'vill', 'ps'
  ];
BEGIN
  IF input IS NULL THEN RETURN ''; END IF;
  FOREACH tok IN ARRAY regexp_split_to_array(
    -- NFC composes न+़ / र+़ / ळ+़ into single code points (ऩ ऱ ऴ) that the fold table does not
    -- list, which would silently drop the consonant; put them back on their base letters.
    translate(
      lower(normalize(replace(replace(input, E'‍', ''), E'‌', ''), NFC)),
      'ऩऱऴ', 'नरळ'
    ),
    '[^a-z0-9ऀ-ॣ०-ॿ]+'
  ) LOOP
    CONTINUE WHEN tok = '' OR tok = ANY (stop);
    folded := sampark_fold_token(tok);
    IF folded <> '' THEN keys := keys || folded; END IF;
  END LOOP;
  RETURN array_to_string(keys, ' ');
END $$;

-- Vowel-free skeleton of a key. Vowel slips (e/i, o/u) are the commonest Hindi<->English
-- spelling error and cost whole trigrams on short names; consonants rarely change.
CREATE OR REPLACE FUNCTION sampark_search_skel(key text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(string_agg(s, ' '), '')
  FROM (
    SELECT regexp_replace(t, '[aeiou]', '', 'g') AS s
    FROM unnest(string_to_array(key, ' ')) AS t
  ) x
  WHERE s <> ''
$$;

-- Keeps the three derived columns current for EVERY writer (Prisma, import, seed, raw SQL).
-- Fires only when a searched column is in the SET list, so assignment transfers, report-sort-key
-- bumps etc. pay nothing.
CREATE OR REPLACE FUNCTION cadres_search_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_name := sampark_search_key(concat_ws(' ', NEW.name, array_to_string(NEW.aliases, ' ')));
  NEW.search_text := sampark_search_key(concat_ws(' ',
    NEW.name, array_to_string(NEW.aliases, ' '), NEW.father_name, NEW.thana, NEW.designation,
    NEW.post, NEW.serial_number, NEW.residing_village, NEW.current_address, NEW.permanent_address));
  NEW.search_skel := sampark_search_skel(NEW.search_text);
  RETURN NEW;
END $$;

CREATE TRIGGER cadres_search_keys
  BEFORE INSERT OR UPDATE OF name, aliases, father_name, thana, designation, post, serial_number,
    residing_village, current_address, permanent_address
  ON "cadres"
  FOR EACH ROW EXECUTE FUNCTION cadres_search_keys();

-- Backfill every row (soft-deleted included). `SET name = name` puts `name` in the SET list so
-- the trigger fires; updated_at is NOT touched (Prisma maintains it client-side), so this does
-- not look like a change to /sync/pull and re-download the register to every phone.
UPDATE "cadres" SET "name" = "name";

-- CreateIndex
CREATE INDEX "cadres_search_text_trgm_idx" ON "cadres" USING GIN ("search_text" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "cadres_search_skel_trgm_idx" ON "cadres" USING GIN ("search_skel" gin_trgm_ops);
