-- ADR-026. Cadre change requests: an officer/admin-proposed edit to a CADRE
-- record, held until every role above the submitter has approved it.
--
-- Scope is the cadre, NOT the user account — officers do not edit their own
-- profile through this workflow.
--
-- needs_admin / needs_super_admin are frozen onto the row at submission time
-- rather than re-derived from the submitter's current role: if an officer is
-- promoted while their change sits pending, it must still require the approvals
-- it needed when it was made.
-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('pending', 'applied', 'rejected', 'cancelled', 'stale');

-- CreateTable
CREATE TABLE "cadre_change_requests" (
    "id" SERIAL NOT NULL,
    "cadre_id" INTEGER NOT NULL,
    "changes" JSONB NOT NULL,
    "submitted_by_id" INTEGER NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'pending',
    "needs_admin" BOOLEAN NOT NULL DEFAULT true,
    "needs_super_admin" BOOLEAN NOT NULL DEFAULT true,
    "admin_approved_by_id" INTEGER,
    "admin_approved_at" TIMESTAMP(3),
    "super_admin_approved_by_id" INTEGER,
    "super_admin_approved_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decided_by_id" INTEGER,
    "decided_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cadre_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cadre_change_requests_status_submitted_at_idx" ON "cadre_change_requests"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "cadre_change_requests_cadre_id_idx" ON "cadre_change_requests"("cadre_id");

-- CreateIndex
CREATE INDEX "cadre_change_requests_submitted_by_id_idx" ON "cadre_change_requests"("submitted_by_id");

-- AddForeignKey
ALTER TABLE "cadre_change_requests" ADD CONSTRAINT "cadre_change_requests_cadre_id_fkey" FOREIGN KEY ("cadre_id") REFERENCES "cadres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadre_change_requests" ADD CONSTRAINT "cadre_change_requests_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadre_change_requests" ADD CONSTRAINT "cadre_change_requests_admin_approved_by_id_fkey" FOREIGN KEY ("admin_approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadre_change_requests" ADD CONSTRAINT "cadre_change_requests_super_admin_approved_by_id_fkey" FOREIGN KEY ("super_admin_approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadre_change_requests" ADD CONSTRAINT "cadre_change_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

