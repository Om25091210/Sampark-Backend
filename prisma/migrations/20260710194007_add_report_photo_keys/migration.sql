-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "photo_keys" TEXT[] DEFAULT ARRAY[]::TEXT[];
