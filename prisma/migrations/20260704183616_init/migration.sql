-- CreateEnum
CREATE TYPE "Role" AS ENUM ('super_admin', 'admin', 'officer', 'viewer');

-- CreateEnum
CREATE TYPE "CadreCategory" AS ENUM ('surrendered', 'jail', 'thana');

-- CreateEnum
CREATE TYPE "CadreFilter" AS ENUM ('DVCM', 'ACM', 'PM');

-- CreateEnum
CREATE TYPE "AlertLevel" AS ENUM ('critical', 'warning', 'normal');

-- CreateEnum
CREATE TYPE "ReportingPlace" AS ENUM ('thana', 'village');

-- CreateEnum
CREATE TYPE "PersonStatus" AS ENUM ('alive', 'dead');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "totp_secret" TEXT,
    "role" "Role" NOT NULL DEFAULT 'officer',
    "designation" TEXT,
    "thana" TEXT,
    "avatar_url" TEXT,
    "badge_image_url" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cadres" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "thana" TEXT NOT NULL,
    "current_address" TEXT NOT NULL,
    "permanent_address" TEXT,
    "designation" TEXT NOT NULL,
    "category" "CadreCategory" NOT NULL,
    "filter" "CadreFilter",
    "alert_level" "AlertLevel" NOT NULL,
    "avatar_url" TEXT,
    "alert_date" TIMESTAMP(3),
    "incident" TEXT,
    "verification_office" TEXT,
    "supervisory_office" TEXT,
    "alert_tag" TEXT,
    "aliases" TEXT[],
    "surrender_date" TIMESTAMP(3),
    "surrender_location" TEXT,
    "surrender_year" TEXT,
    "regiment" TEXT,
    "family_group_info" TEXT,
    "sub_division" TEXT,
    "assigned_officer_id" INTEGER,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cadres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" SERIAL NOT NULL,
    "cadre_id" INTEGER NOT NULL,
    "reporting_place" "ReportingPlace" NOT NULL,
    "specific_location" TEXT NOT NULL,
    "person_status" "PersonStatus" NOT NULL,
    "current_phone" TEXT NOT NULL,
    "current_activity" TEXT NOT NULL,
    "photo_url" TEXT,
    "gps_latitude" DOUBLE PRECISION,
    "gps_longitude" DOUBLE PRECISION,
    "gps_address" TEXT,
    "is_home_address" BOOLEAN,
    "reported_by_id" INTEGER NOT NULL,
    "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at" TIMESTAMP(3),
    "idempotency_key" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "actor_id" INTEGER,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" SERIAL NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "cadres_category_idx" ON "cadres"("category");

-- CreateIndex
CREATE INDEX "cadres_alert_level_idx" ON "cadres"("alert_level");

-- CreateIndex
CREATE INDEX "cadres_assigned_officer_id_idx" ON "cadres"("assigned_officer_id");

-- CreateIndex
CREATE UNIQUE INDEX "reports_idempotency_key_key" ON "reports"("idempotency_key");

-- CreateIndex
CREATE INDEX "reports_cadre_id_idx" ON "reports"("cadre_id");

-- CreateIndex
CREATE INDEX "reports_reported_by_id_idx" ON "reports"("reported_by_id");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_idx" ON "otp_challenges"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_hash_key" ON "audit_logs"("hash");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_idx" ON "outbox_events"("published_at");

-- AddForeignKey
ALTER TABLE "cadres" ADD CONSTRAINT "cadres_assigned_officer_id_fkey" FOREIGN KEY ("assigned_officer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_cadre_id_fkey" FOREIGN KEY ("cadre_id") REFERENCES "cadres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
