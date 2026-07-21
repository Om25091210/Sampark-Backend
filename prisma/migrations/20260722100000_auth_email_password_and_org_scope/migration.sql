-- ADR-042. Auth overhaul: SMS-OTP removed entirely (superseding ADR-012), every account
-- authenticates by email+password. `User.name` becomes the unique institutional ID and
-- User gains the org-hierarchy scope fields.

-- 1. Remove ALL FOUR fabricated seed accounts. None of them are real people and none are
--    on the 74-account roster: सुपर एडमिन / एडमिन (demo admins, no credentials under the
--    new scheme) and राजेश / प्रिया (demo officers).
--
--    Every foreign key into `users` is handled below. There are eight, and they were
--    enumerated from the schema rather than guessed — a missed one fails the DELETE with
--    an FK violation halfway through a production migration. Checked against staging:
--    cadre 1 carries last_edited_by_id = 1, and 5 change requests reference these users,
--    so three of these statements are load-bearing, not defensive boilerplate.
--
--    Nullable FKs are nulled (the row survives, unowned). NOT NULL FKs (reports,
--    change-request submitter) mean the row cannot survive without its user, so those
--    fabricated rows are deleted — rather than making the columns nullable, which would
--    permanently weaken the report→reporter and request→submitter links that the audit
--    model depends on.
--
--    audit_logs.actor_id is deliberately NOT touched: it has no FK constraint (it is a
--    plain int on an append-only, hash-chained table), so the trail keeps its record of
--    what these ids did even after the accounts are gone.

-- 1a. Cadre back-references (both nullable → null them; the cadres survive, unassigned).
UPDATE "cadres" SET "assigned_officer_id" = NULL
 WHERE "assigned_officer_id" IN (SELECT "id" FROM "users"
   WHERE "phone" IN ('+919999999999', '+919888888888', '+919770000001', '+919770000002'));

UPDATE "cadres" SET "last_edited_by_id" = NULL, "last_edited_at" = NULL
 WHERE "last_edited_by_id" IN (SELECT "id" FROM "users"
   WHERE "phone" IN ('+919999999999', '+919888888888', '+919770000001', '+919770000002'));

-- 1b. Change-request approver columns (all three nullable → null them).
UPDATE "cadre_change_requests" SET "admin_approved_by_id" = NULL
 WHERE "admin_approved_by_id" IN (SELECT "id" FROM "users"
   WHERE "phone" IN ('+919999999999', '+919888888888', '+919770000001', '+919770000002'));
UPDATE "cadre_change_requests" SET "super_admin_approved_by_id" = NULL
 WHERE "super_admin_approved_by_id" IN (SELECT "id" FROM "users"
   WHERE "phone" IN ('+919999999999', '+919888888888', '+919770000001', '+919770000002'));
UPDATE "cadre_change_requests" SET "decided_by_id" = NULL
 WHERE "decided_by_id" IN (SELECT "id" FROM "users"
   WHERE "phone" IN ('+919999999999', '+919888888888', '+919770000001', '+919770000002'));

-- 1c. NOT NULL back-references → the fabricated rows go with their users.
DELETE FROM "cadre_change_requests"
 WHERE "submitted_by_id" IN (SELECT "id" FROM "users"
   WHERE "phone" IN ('+919999999999', '+919888888888', '+919770000001', '+919770000002'));
DELETE FROM "reports"
 WHERE "reported_by_id" IN (SELECT "id" FROM "users"
   WHERE "phone" IN ('+919999999999', '+919888888888', '+919770000001', '+919770000002'));
DELETE FROM "refresh_tokens"
 WHERE "user_id" IN (SELECT "id" FROM "users"
   WHERE "phone" IN ('+919999999999', '+919888888888', '+919770000001', '+919770000002'));

DELETE FROM "users"
 WHERE "phone" IN ('+919999999999', '+919888888888', '+919770000001', '+919770000002');

-- 2. The OTP challenge table has no remaining reader or writer. Nothing references it by FK.
DROP TABLE IF EXISTS "otp_challenges";

-- 3. User: phone is no longer the login key (nullable); add the org-scope + TOTP-enrolment
--    columns; `name` becomes the unique institutional ID (and the /users/import upsert key).
ALTER TABLE "users" ALTER COLUMN "phone" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN     "sub_division" TEXT;
ALTER TABLE "users" ADD COLUMN     "totp_confirmed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_name_key" ON "users"("name");
