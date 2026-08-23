-- CreateEnum
CREATE TYPE "OtherOriginType" AS ENUM ('other_district', 'other_state');

-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "other_origin_type" "OtherOriginType";

-- CreateIndex
CREATE INDEX "cadres_category_surrender_origin_other_origin_type_idx" ON "cadres"("category", "surrender_origin", "other_origin_type");
