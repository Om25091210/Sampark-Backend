-- CreateTable
CREATE TABLE "config" (
    "id" SERIAL NOT NULL,
    "sheets_sync_url" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" INTEGER,

    CONSTRAINT "config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_log" (
    "id" SERIAL NOT NULL,
    "event_type" TEXT NOT NULL,
    "target_key" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sync_log_created_at_idx" ON "sync_log"("created_at");

-- AddForeignKey
ALTER TABLE "config" ADD CONSTRAINT "config_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
