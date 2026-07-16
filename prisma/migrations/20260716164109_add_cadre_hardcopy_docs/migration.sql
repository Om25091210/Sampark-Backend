-- ADR-026. Whether the cadre's physical paperwork (Aadhaar, bank account, AB proforma,
-- agreement letter) exists on file. Written only through the change-request
-- workflow: ticking it asserts the documents exist, which is a claim that gets
-- signed off. Defaults false = "not confirmed present" rather than nullable —
-- a tri-state checkbox is not what was asked for.

-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "hardcopy_docs_exist" BOOLEAN NOT NULL DEFAULT false;
