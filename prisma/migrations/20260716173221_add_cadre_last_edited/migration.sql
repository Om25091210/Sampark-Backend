-- ADR-027. Who last changed this cadre's contents, and when.
--
-- NOT `updated_at`: that moves on assignment transfers too, so it cannot answer
-- "has someone edited this cadre's details recently?" — the question an officer
-- asks before proposing an edit of their own.
--
-- Denormalised deliberately (unlike next_reporting_due_at, which is derived): this
-- is a fact recorded at write time, not a function of existing data, and only the
-- two write paths ever set it.
--
-- Null on every existing row: nothing was edited through a write path that did not
-- exist until today, and back-filling it from updated_at would invent an editor.

-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "last_edited_at" TIMESTAMP(3),
ADD COLUMN     "last_edited_by_id" INTEGER;

-- AddForeignKey
ALTER TABLE "cadres" ADD CONSTRAINT "cadres_last_edited_by_id_fkey" FOREIGN KEY ("last_edited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
