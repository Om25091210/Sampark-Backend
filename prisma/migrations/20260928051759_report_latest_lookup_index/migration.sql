-- CreateIndex
CREATE INDEX "reports_cadre_id_deleted_at_reported_at_id_idx" ON "reports"("cadre_id", "deleted_at", "reported_at", "id");
