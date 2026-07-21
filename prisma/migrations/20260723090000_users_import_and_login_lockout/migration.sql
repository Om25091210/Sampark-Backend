-- Phase B. SDR-002 account-level brute-force lockout.
--
-- Keyed on the submitted email string rather than a user id: if only real accounts could
-- lock, the 423 would itself answer "does this account exist?", and the institutional IDs
-- are guessable by construction. An unknown email locks the same way, so the distinct
-- status code leaks nothing.

-- CreateTable
CREATE TABLE "login_attempts" (
    "email" TEXT NOT NULL,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "last_failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMP(3),

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("email")
);
