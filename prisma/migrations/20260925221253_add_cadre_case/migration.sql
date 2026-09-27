-- CreateTable
CREATE TABLE "cadre_cases" (
    "id" SERIAL NOT NULL,
    "cadre_id" INTEGER NOT NULL,
    "crime_number" TEXT,
    "sections" TEXT,
    "crime_thana" TEXT,
    "crime_description" TEXT,
    "arrest_date" DATE,
    "bail_granted" BOOLEAN NOT NULL DEFAULT false,
    "bail_date" DATE,
    "in_jail" BOOLEAN NOT NULL DEFAULT false,
    "jail_name" TEXT,
    "under_investigation" BOOLEAN NOT NULL DEFAULT false,
    "under_trial" BOOLEAN NOT NULL DEFAULT false,
    "challan_number" TEXT,
    "court_name" TEXT,
    "case_status" TEXT,
    "public_harm_occurred" BOOLEAN NOT NULL DEFAULT false,
    "uapa_applied" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "cadre_cases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cadre_cases_cadre_id_idx" ON "cadre_cases"("cadre_id");

-- AddForeignKey
ALTER TABLE "cadre_cases" ADD CONSTRAINT "cadre_cases_cadre_id_fkey" FOREIGN KEY ("cadre_id") REFERENCES "cadres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
