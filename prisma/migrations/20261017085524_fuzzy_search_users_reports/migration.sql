-- ADR-071. Fuzzy search beyond cadres: the officer roster (GET /officers), the account list
-- (GET /users) and the aggregate reporting feed (GET /reports) get the same derived keys and
-- trigram indexes as `cadres` (ADR-070, migration 20261017081655_cadre_fuzzy_search, whose
-- sampark_search_key / sampark_search_skel functions this reuses). Also adds the scoring
-- functions the "similar cadres" check needs to re-rank a small candidate set exactly.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "search_skel" TEXT,
ADD COLUMN     "search_text" TEXT;

-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "search_skel" TEXT,
ADD COLUMN     "search_text" TEXT;

-- One query token against one haystack. Exact word 1.0, word prefix 0.92, substring 0.8, trigram
-- word-similarity of the key (four characters or more — a 3-letter key shares its first two trigrams
-- with every word that starts the same, a flat 0.5), or 0.85 x that of the vowel-free skeleton.
-- Tokens under three characters have too few trigrams to mean anything: prefix only.
-- (Mirrored in Sampark Mobile Application/src/lib/searchKey.ts — keep the two in step.)
CREATE OR REPLACE FUNCTION sampark_token_score(t text, sk text, hay text, hay_skel text) RETURNS real
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT GREATEST(
    CASE WHEN hay ~ ('(^| )' || t || '( |$)') THEN 1.0
         WHEN hay ~ ('(^| )' || t) THEN 0.92
         WHEN length(t) >= 3 AND strpos(hay, t) > 0 THEN 0.8
         ELSE 0 END,
    CASE WHEN length(t) >= 4 THEN word_similarity(t, hay) ELSE 0 END,
    CASE WHEN length(sk) >= 3 THEN 0.85 * word_similarity(sk, hay_skel) ELSE 0 END
  )::real
$$;

-- A whole typed query against one record's key: NULL unless EVERY token scores at least 0.5
-- (a second word narrows, it never widens), otherwise the mean token score.
CREATE OR REPLACE FUNCTION sampark_text_score(q text, hay text, hay_skel text) RETURNS real
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN count(*) = 0 OR min(s) < 0.5 THEN NULL ELSE avg(s) END::real
  FROM (
    SELECT sampark_token_score(t, regexp_replace(t, '[aeiou]', '', 'g'), coalesce(hay, ''), coalesce(hay_skel, '')) AS s
    FROM unnest(string_to_array(sampark_search_key(q), ' ')) AS t
    WHERE t <> ''
  ) x
$$;

CREATE OR REPLACE FUNCTION users_search_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := sampark_search_key(concat_ws(' ', NEW.name, NEW.thana, NEW.designation, NEW.sub_division));
  NEW.search_skel := sampark_search_skel(NEW.search_text);
  RETURN NEW;
END $$;

CREATE TRIGGER users_search_keys
  BEFORE INSERT OR UPDATE OF name, thana, designation, sub_division
  ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_search_keys();

CREATE OR REPLACE FUNCTION reports_search_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := sampark_search_key(concat_ws(' ', NEW.specific_location, NEW.current_activity));
  NEW.search_skel := sampark_search_skel(NEW.search_text);
  RETURN NEW;
END $$;

CREATE TRIGGER reports_search_keys
  BEFORE INSERT OR UPDATE OF specific_location, current_activity
  ON "reports"
  FOR EACH ROW EXECUTE FUNCTION reports_search_keys();

-- Backfill. `SET x = x` puts a trigger column in the SET list so the trigger fires; updated_at is
-- NOT touched (Prisma maintains it client-side), so /sync/pull does not re-send these rows.
UPDATE "users" SET "name" = "name";
UPDATE "reports" SET "specific_location" = "specific_location";

-- CreateIndex (after the backfill, so it is not maintained row by row)
CREATE INDEX "users_search_text_trgm_idx" ON "users" USING GIN ("search_text" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "users_search_skel_trgm_idx" ON "users" USING GIN ("search_skel" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "reports_search_text_trgm_idx" ON "reports" USING GIN ("search_text" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "reports_search_skel_trgm_idx" ON "reports" USING GIN ("search_skel" gin_trgm_ops);
