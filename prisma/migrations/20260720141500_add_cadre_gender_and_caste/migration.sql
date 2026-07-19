-- ADR-038. gender (register लिंग, two-value enum) + caste (register जाति, free text).
-- Both nullable: existing rows predate the one-time historical import (Design-Docs#7)
-- that supplies them, and caste is only ~82% filled in the source register.

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female');

-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "caste" TEXT,
ADD COLUMN     "gender" "Gender";
