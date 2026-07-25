-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('report_overdue', 'cadre_change_outcome', 'thana_transfer', 'broadcast');

-- AlterTable
ALTER TABLE "cadres" ADD COLUMN     "last_escalation_tier" TEXT;

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "cadre_id" INTEGER,
    "cadre_change_id" INTEGER,
    "data" JSONB,
    "read_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "endpoint_arn" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'android',
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_endpoint_arn_key" ON "device_tokens"("endpoint_arn");

-- CreateIndex
CREATE INDEX "device_tokens_user_id_deleted_at_idx" ON "device_tokens"("user_id", "deleted_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_cadre_id_fkey" FOREIGN KEY ("cadre_id") REFERENCES "cadres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_cadre_change_id_fkey" FOREIGN KEY ("cadre_change_id") REFERENCES "cadre_change_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
