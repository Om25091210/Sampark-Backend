-- CreateEnum
CREATE TYPE "CreateRequestStatus" AS ENUM ('pending', 'applied', 'rejected', 'cancelled');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'cadre_create_outcome';

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "cadre_create_request_id" INTEGER;

-- CreateTable
CREATE TABLE "cadre_create_requests" (
    "id" SERIAL NOT NULL,
    "draft" JSONB NOT NULL,
    "thana" TEXT NOT NULL,
    "submitted_by_id" INTEGER NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "status" "CreateRequestStatus" NOT NULL DEFAULT 'pending',
    "needs_admin" BOOLEAN NOT NULL DEFAULT true,
    "needs_super_admin" BOOLEAN NOT NULL DEFAULT true,
    "admin_approved_by_id" INTEGER,
    "admin_approved_at" TIMESTAMP(3),
    "super_admin_approved_by_id" INTEGER,
    "super_admin_approved_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decided_by_id" INTEGER,
    "decided_reason" TEXT,
    "cadre_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cadre_create_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cadre_create_requests_cadre_id_key" ON "cadre_create_requests"("cadre_id");

-- CreateIndex
CREATE INDEX "cadre_create_requests_status_submitted_at_idx" ON "cadre_create_requests"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "cadre_create_requests_submitted_by_id_idx" ON "cadre_create_requests"("submitted_by_id");

-- CreateIndex
CREATE INDEX "cadre_create_requests_thana_idx" ON "cadre_create_requests"("thana");

-- AddForeignKey
ALTER TABLE "cadre_create_requests" ADD CONSTRAINT "cadre_create_requests_cadre_id_fkey" FOREIGN KEY ("cadre_id") REFERENCES "cadres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadre_create_requests" ADD CONSTRAINT "cadre_create_requests_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadre_create_requests" ADD CONSTRAINT "cadre_create_requests_admin_approved_by_id_fkey" FOREIGN KEY ("admin_approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadre_create_requests" ADD CONSTRAINT "cadre_create_requests_super_admin_approved_by_id_fkey" FOREIGN KEY ("super_admin_approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadre_create_requests" ADD CONSTRAINT "cadre_create_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_cadre_create_request_id_fkey" FOREIGN KEY ("cadre_create_request_id") REFERENCES "cadre_create_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Server-assigned serial numbers for digitally-created cadres (never client-supplied
-- — see src/lib/cadre-serial.ts). A DB sequence cannot repeat a value under
-- concurrent applies, unlike a client-generated number, which is the whole point:
-- it removes any collision risk, including once offline support is added later.
CREATE SEQUENCE "cadre_serial_number_seq" START WITH 1 INCREMENT BY 1;
