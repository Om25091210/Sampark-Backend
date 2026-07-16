-- ADR-025. The official register serial number carried over from the paper records.
--
-- Deliberately NOT reusing `cadres.id`: that is a surrogate autoincrement PK with
-- gaps from deletes, and the ~1,790-row surrendered-cadre import (Design-Docs#7)
-- will assign every row a fresh PK. A serial number an officer has written into a
-- paper register must not change under them, so it needs its own column sourced
-- from the register itself.
--
-- Nullable: every existing row predates the import that supplies these, and there
-- is no honest value to backfill — inventing one (e.g. from `id`) would be exactly
-- the kind of plausible-looking fiction this project keeps having to undo.
--
-- Unique: a register number that repeats identifies nothing. NULLs are exempt from
-- UNIQUE in Postgres, so existing rows are unaffected. If the import turns out to
-- contain duplicate serials, this constraint is meant to fail loudly rather than
-- let two cadres share an identifier.
ALTER TABLE "cadres" ADD COLUMN     "serial_number" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "cadres_serial_number_key" ON "cadres"("serial_number");
