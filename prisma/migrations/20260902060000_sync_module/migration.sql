-- AlterTable
ALTER TABLE "cadre_change_requests" ADD COLUMN "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "cadre_change_requests_idempotency_key_key" ON "cadre_change_requests"("idempotency_key");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");
