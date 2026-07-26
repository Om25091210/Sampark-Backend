-- CreateEnum
CREATE TYPE "PermanentStatus" AS ENUM ('deceased', 'government_job', 'gs', 'living_elsewhere');

-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "permanent_status" "PermanentStatus";

-- CreateIndex
CREATE INDEX "cadres_permanent_status_idx" ON "cadres"("permanent_status");
