-- ADR-036. date_of_birth (age derived on read, never stored) + three family-name
-- columns. All nullable: existing rows predate them, the import supplies them later.
-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "date_of_birth" DATE,
ADD COLUMN     "father_name" TEXT,
ADD COLUMN     "mother_name" TEXT,
ADD COLUMN     "spouse_name" TEXT;
