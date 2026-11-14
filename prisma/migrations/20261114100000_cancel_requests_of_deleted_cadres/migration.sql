-- One-off cleanup. Deleting a cadre used to leave its pending change / proforma requests
-- sitting in the approver queue: applyWithin() refuses a soft-deleted cadre, so nobody could
-- approve them and nobody could usefully reject them. cadres.service.ts's remove() now cancels
-- them at delete time; this cancels the ones already stranded. Idempotent (only touches
-- status = 'pending'), data-only, no schema change.

UPDATE "cadre_change_requests" r
SET "status" = 'cancelled',
    "decided_at" = NOW(),
    "decided_reason" = 'Cadre deleted'
FROM "cadres" c
WHERE r."cadre_id" = c."id"
  AND c."deleted_at" IS NOT NULL
  AND r."status" = 'pending';

UPDATE "proforma_change_requests" r
SET "status" = 'cancelled',
    "decided_at" = NOW(),
    "decided_reason" = 'Cadre deleted'
FROM "cadres" c
WHERE r."cadre_id" = c."id"
  AND c."deleted_at" IS NOT NULL
  AND r."status" = 'pending';
