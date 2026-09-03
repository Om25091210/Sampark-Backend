-- AlterTable
ALTER TABLE "cadre_change_requests" ADD COLUMN     "source_report_id" INTEGER;

-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "deceased_date" DATE;

-- AlterTable
ALTER TABLE "reports" ALTER COLUMN "specific_location" DROP NOT NULL,
ALTER COLUMN "current_phone" DROP NOT NULL,
ALTER COLUMN "current_activity" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "cadre_change_requests_source_report_id_idx" ON "cadre_change_requests"("source_report_id");
