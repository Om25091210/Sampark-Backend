-- ADR-040. Home district (dropdown on the edit form: the 7 Bastar-region districts).
-- Nullable: existing rows predate it; the Apps Script backfills it via /cadres/import.

-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "district" TEXT;
