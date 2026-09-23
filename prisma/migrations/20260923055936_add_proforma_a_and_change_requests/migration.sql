-- CreateEnum
CREATE TYPE "EconomicStatus" AS ENUM ('poor', 'average', 'fair');

-- CreateEnum
CREATE TYPE "ProformaType" AS ENUM ('ab', 'b');

-- CreateEnum
CREATE TYPE "ProformaChangeType" AS ENUM ('create', 'edit');

-- CreateTable
CREATE TABLE "cadre_proforma_a" (
    "id" SERIAL NOT NULL,
    "cadre_id" INTEGER NOT NULL,
    "party" TEXT,
    "father_occupation" TEXT,
    "spouse_occupation" TEXT,
    "sub_caste" TEXT,
    "religion" TEXT,
    "place_of_birth" TEXT,
    "aadhaar_number" TEXT,
    "identifier_mobile" TEXT,
    "identifier_email" TEXT,
    "social_media_handle" TEXT,
    "ration_card_number" TEXT,
    "voter_id_number" TEXT,
    "driving_license_number" TEXT,
    "bank_account_number" TEXT,
    "post_office_account_number" TEXT,
    "educational_qualification" TEXT,
    "occupation" TEXT,
    "economic_status" "EconomicStatus",
    "fingerprint_key" TEXT,
    "height" TEXT,
    "build" TEXT,
    "complexion" TEXT,
    "distinguishing_features" TEXT,
    "hair" TEXT,
    "eyebrows" TEXT,
    "eyes" TEXT,
    "iris_color" TEXT,
    "nose" TEXT,
    "teeth" TEXT,
    "lips" TEXT,
    "fingers" TEXT,
    "chin" TEXT,
    "ears" TEXT,
    "face" TEXT,
    "beard" TEXT,
    "moustache" TEXT,
    "marks_or_tattoos" TEXT,
    "deformity" TEXT,
    "special_habits" TEXT,
    "vulnerabilities" TEXT,
    "handwriting_sample_key" TEXT,
    "friends_and_associates" TEXT,
    "childhood_friends" JSONB,
    "classmates" JSONB,
    "organization_associates_chronological" JSONB,
    "relatives" JSONB,
    "identifying_police_officers" JSONB,
    "other_points_of_interest" JSONB,
    "prior_arrest_details" TEXT,
    "convictions" TEXT,
    "area_of_operation" TEXT,
    "section_b" JSONB,
    "section_c" JSONB,
    "section_d" JSONB,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_edited_at" TIMESTAMP(3),
    "last_edited_by_id" INTEGER,

    CONSTRAINT "cadre_proforma_a_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proforma_change_requests" (
    "id" SERIAL NOT NULL,
    "cadre_id" INTEGER NOT NULL,
    "proforma_type" "ProformaType" NOT NULL,
    "change_type" "ProformaChangeType" NOT NULL,
    "target_id" INTEGER,
    "draft" JSONB,
    "changes" JSONB,
    "submitted_by_id" INTEGER NOT NULL,
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'pending',
    "needs_admin" BOOLEAN NOT NULL DEFAULT true,
    "needs_super_admin" BOOLEAN NOT NULL DEFAULT true,
    "admin_approved_by_id" INTEGER,
    "admin_approved_at" TIMESTAMP(3),
    "super_admin_approved_by_id" INTEGER,
    "super_admin_approved_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "decided_by_id" INTEGER,
    "decided_reason" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proforma_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cadre_proforma_a_cadre_id_key" ON "cadre_proforma_a"("cadre_id");

-- CreateIndex
CREATE UNIQUE INDEX "proforma_change_requests_idempotency_key_key" ON "proforma_change_requests"("idempotency_key");

-- CreateIndex
CREATE INDEX "proforma_change_requests_status_submitted_at_idx" ON "proforma_change_requests"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "proforma_change_requests_cadre_id_idx" ON "proforma_change_requests"("cadre_id");

-- CreateIndex
CREATE INDEX "proforma_change_requests_submitted_by_id_idx" ON "proforma_change_requests"("submitted_by_id");

-- AddForeignKey
ALTER TABLE "cadre_proforma_a" ADD CONSTRAINT "cadre_proforma_a_cadre_id_fkey" FOREIGN KEY ("cadre_id") REFERENCES "cadres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadre_proforma_a" ADD CONSTRAINT "cadre_proforma_a_last_edited_by_id_fkey" FOREIGN KEY ("last_edited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proforma_change_requests" ADD CONSTRAINT "proforma_change_requests_cadre_id_fkey" FOREIGN KEY ("cadre_id") REFERENCES "cadres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proforma_change_requests" ADD CONSTRAINT "proforma_change_requests_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proforma_change_requests" ADD CONSTRAINT "proforma_change_requests_admin_approved_by_id_fkey" FOREIGN KEY ("admin_approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proforma_change_requests" ADD CONSTRAINT "proforma_change_requests_super_admin_approved_by_id_fkey" FOREIGN KEY ("super_admin_approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proforma_change_requests" ADD CONSTRAINT "proforma_change_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
