-- ADR-029. Split the single `hardcopy_docs_exist` flag into the four documents it
-- was standing in for, and add a durable key for the cadre photo.
--
-- The one-flag design (ADR-026) was unanswerable in the field: an officer with the
-- Aadhaar on file but no agreement letter had to lie in one direction or the other.
-- The client asked for them individually and was right.

-- 1. Add the new columns.
ALTER TABLE "cadres" ADD COLUMN "has_aadhaar"          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "cadres" ADD COLUMN "has_bank_account"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "cadres" ADD COLUMN "has_ab_proforma"      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "cadres" ADD COLUMN "has_agreement_letter" BOOLEAN NOT NULL DEFAULT false;

-- ADR-029. Durable S3 key for the cadre photo. The key, never a presigned URL —
-- ADR-016's lesson. Legacy `avatar_url` is kept for rows that predate this.
ALTER TABLE "cadres" ADD COLUMN "avatar_key" TEXT;

-- 2. Backfill BEFORE dropping the old column, rather than after (which would be a
--    silent data loss). `hardcopy_docs_exist = true` meant "all four are on file",
--    so that is what it maps to. Every current row is false, so in practice this
--    is a no-op — but a migration that would have discarded a true is the wrong
--    shape to commit regardless of today's data.
UPDATE "cadres"
SET "has_aadhaar"          = true,
    "has_bank_account"     = true,
    "has_ab_proforma"      = true,
    "has_agreement_letter" = true
WHERE "hardcopy_docs_exist" = true;

-- 3. Now the old column carries nothing the new ones do not.
ALTER TABLE "cadres" DROP COLUMN "hardcopy_docs_exist";