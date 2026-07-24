-- CreateEnum
CREATE TYPE "PriorityCategory" AS ENUM ('A', 'B', 'C', 'jail', 'death');

-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "priority_category" "PriorityCategory";

-- CreateIndex
CREATE INDEX "cadres_priority_category_idx" ON "cadres"("priority_category");
