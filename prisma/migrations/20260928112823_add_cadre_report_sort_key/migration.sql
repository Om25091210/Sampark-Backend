-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "report_sort_key" TIMESTAMP(3);

-- Backfill (hand-added). Without this, every already-reported cadre would sit
-- at NULL — sorting last, behind cadres with zero reports — until their NEXT
-- report finally set the column. Computed the same way LATEST_REPORT's lateral
-- join already does: MAX(reported_at) over that cadre's own non-deleted reports.
UPDATE "cadres" c
SET "report_sort_key" = r.max_reported_at
FROM (
  SELECT cadre_id, MAX(reported_at) AS max_reported_at
  FROM "reports"
  WHERE deleted_at IS NULL
  GROUP BY cadre_id
) r
WHERE r.cadre_id = c.id;

-- CreateIndex
CREATE INDEX "cadres_report_sort_key_idx" ON "cadres"("report_sort_key");
