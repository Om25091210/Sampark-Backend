-- CreateTable
CREATE TABLE "cadre_proforma_b" (
    "id" SERIAL NOT NULL,
    "cadre_id" INTEGER NOT NULL,
    "filed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fullNameWithAlias" TEXT NOT NULL,
    "native_address" JSONB NOT NULL,
    "current_address_details" JSONB NOT NULL,
    "surrender_date" DATE,
    "surrender_place_and_by" TEXT,
    "own_house_details" TEXT,
    "agricultural_land_details" TEXT,
    "vehicle_details" TEXT,
    "family_education_details" TEXT,
    "family_employment_details" TEXT,
    "prior_criminal_cases" TEXT,
    "aadhaar_voter_card_status" TEXT,
    "bank_details" TEXT,
    "health_condition" TEXT,
    "handler_details" TEXT,
    "liaison_officer_details" TEXT,
    "current_work_type_and_place" TEXT,
    "employer_details" TEXT,
    "wage_details" TEXT,
    "new_criminal_cases" TEXT,
    "full_reward_received_details" TEXT,
    "pending_reward_status" TEXT,
    "application_date_and_place" TEXT,
    "application_status" TEXT,
    "reward_withdrawn" TEXT,
    "reward_usage_details" TEXT,
    "current_maoist_contact" TEXT,
    "contact_with_whom" TEXT,
    "new_skills_learned" TEXT,
    "needs_and_requirements" TEXT,
    "maoist_movement_info" TEXT,
    "maoist_contact_attempt" TEXT,
    "other_surrendered_arrested_info" TEXT,
    "any_problems" TEXT,
    "current_photo_key" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_edited_at" TIMESTAMP(3),
    "last_edited_by_id" INTEGER,

    CONSTRAINT "cadre_proforma_b_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cadre_proforma_b_cadre_id_filed_at_idx" ON "cadre_proforma_b"("cadre_id", "filed_at");

-- AddForeignKey
ALTER TABLE "cadre_proforma_b" ADD CONSTRAINT "cadre_proforma_b_cadre_id_fkey" FOREIGN KEY ("cadre_id") REFERENCES "cadres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cadre_proforma_b" ADD CONSTRAINT "cadre_proforma_b_last_edited_by_id_fkey" FOREIGN KEY ("last_edited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
