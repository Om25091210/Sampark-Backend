-- CreateEnum
CREATE TYPE "SurrenderOrigin" AS ENUM ('district', 'other');

-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "surrender_origin" "SurrenderOrigin";

-- CreateIndex
CREATE INDEX "cadres_category_surrender_origin_idx" ON "cadres"("category", "surrender_origin");

-- ─── Backfill (ADR-019) ──────────────────────────────────────────────────────
--
-- The column is nullable and stays NULL for cadres who never surrendered — origin
-- is meaningless for a jail/thana cadre, and NULL says that honestly rather than
-- forcing a wrong 'other'.
--
-- For surrendered cadres, the only signal in the existing data is `surrender_location`,
-- which is FREE TEXT recording the place, not a classification. We read it once here
-- and never again: the column is the source of truth from now on.
--
--   * mentions बीजापुर            -> 'district'  (unambiguous)
--   * anything else, incl. NULL  -> 'other'     (the defensible default; an unknown
--                                                origin is not evidence of a Bijapur
--                                                surrender)
--
-- Rows landing in 'other' without naming a known non-Bijapur district are GUESSES and
-- need manual reclassification. Find them with:
--
--   SELECT id, name, surrender_location FROM cadres
--    WHERE category = 'surrendered' AND surrender_origin = 'other'
--      AND (surrender_location IS NULL OR surrender_location NOT LIKE '%बीजापुर%');

UPDATE "cadres"
   SET "surrender_origin" = CASE
     WHEN "surrender_location" LIKE '%बीजापुर%' THEN 'district'::"SurrenderOrigin"
     ELSE 'other'::"SurrenderOrigin"
   END
 WHERE "category" = 'surrendered';
