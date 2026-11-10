-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "family" TEXT;

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_family_idx" ON "refresh_tokens"("user_id", "family");
