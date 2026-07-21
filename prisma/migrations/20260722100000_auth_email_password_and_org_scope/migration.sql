-- ADR-042. Auth overhaul: SMS-OTP removed entirely (superseding ADR-012), every account
-- authenticates by email+password. `User.name` becomes the unique institutional ID and
-- User gains the org-hierarchy scope fields.

-- 1. Remove the two FABRICATED seed officers (राजेश / प्रिया). They are not real people.
--    Their cadre assignments are nulled (assigned_officer_id IS nullable, so those four
--    cadres simply become unassigned, to be given to a real ID later).
--    Their 9 fabricated seed reports are DELETED rather than orphaned: reports.reported_by_id
--    is NOT NULL, and making it nullable to accommodate fake rows would permanently weaken
--    the report→reporter link the audit trail rests on — precisely the accountability this
--    ADR already narrows by dropping real names.
UPDATE "cadres" SET "assigned_officer_id" = NULL
 WHERE "assigned_officer_id" IN (SELECT "id" FROM "users" WHERE "phone" IN ('+919770000001', '+919770000002'));

UPDATE "cadre_change_requests" SET "admin_approved_by_id" = NULL
 WHERE "admin_approved_by_id" IN (SELECT "id" FROM "users" WHERE "phone" IN ('+919770000001', '+919770000002'));
UPDATE "cadre_change_requests" SET "super_admin_approved_by_id" = NULL
 WHERE "super_admin_approved_by_id" IN (SELECT "id" FROM "users" WHERE "phone" IN ('+919770000001', '+919770000002'));
UPDATE "cadre_change_requests" SET "decided_by_id" = NULL
 WHERE "decided_by_id" IN (SELECT "id" FROM "users" WHERE "phone" IN ('+919770000001', '+919770000002'));

DELETE FROM "cadre_change_requests"
 WHERE "submitted_by_id" IN (SELECT "id" FROM "users" WHERE "phone" IN ('+919770000001', '+919770000002'));
DELETE FROM "reports"
 WHERE "reported_by_id" IN (SELECT "id" FROM "users" WHERE "phone" IN ('+919770000001', '+919770000002'));
DELETE FROM "refresh_tokens"
 WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "phone" IN ('+919770000001', '+919770000002'));

DELETE FROM "users" WHERE "phone" IN ('+919770000001', '+919770000002');

-- 2. The OTP challenge table has no remaining reader or writer. Nothing references it by FK.
DROP TABLE IF EXISTS "otp_challenges";

-- 3. User: phone is no longer the login key (nullable); add the org-scope + TOTP-enrolment
--    columns; `name` becomes the unique institutional ID (and the /users/import upsert key).
ALTER TABLE "users" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN     "sub_division" TEXT;
ALTER TABLE "users" ADD COLUMN     "totp_confirmed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_name_key" ON "users"("name");
