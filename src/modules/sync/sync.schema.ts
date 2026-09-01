import { z } from 'zod';
import { createReportBody } from '../reports/reports.schema.js';
import { changeableFieldsSchema } from '../cadre-changes/cadre-changes.schema.js';

// ─── Pull (server → device) ────────────────────────────────────────────────────
//
// `lastPulledAt` is a server-issued epoch-ms cursor — specifically the `serverTime`
// THIS SAME endpoint returned on the caller's previous pull, never the device's own
// clock. A phone offline for weeks may have a badly skewed clock by the time it
// reconnects; trusting it here would corrupt the delta window silently. Absent =
// first sync (reinstall, or a device that has never synced): a full snapshot.
export const syncPullQuery = z.object({
  lastPulledAt: z.coerce.number().int().nonnegative().optional(),
});
export type SyncPullQuery = z.infer<typeof syncPullQuery>;

// ─── Push (device → server) ────────────────────────────────────────────────────
//
// A batch of offline-queued writes. Both arrays are capped: a push this large would
// mean weeks of unsynced work sitting in one request, at which point the mobile
// outbox's own per-item retry recovers better than one huge all-or-nothing call.
//
// Every item carries its own client-generated `idempotency_key` (UUID v4) — ADR-013's
// pattern, generalised to every push-capable entity (see the CadreChangeRequest
// column's comment). Unlike the legacy per-cadre create-report route, the key is
// REQUIRED here: this endpoint exists ONLY to replay a queued outbox action, and the
// key is also how the response's per-item result is matched back to that action —
// there is no positional fallback.
export const syncPushBody = z.object({
  reports: z
    .array(createReportBody.extend({ cadre_id: z.number().int().positive(), idempotency_key: z.string().uuid() }))
    .max(100)
    .default([]),
  cadreChangeRequests: z
    .array(
      z.object({
        idempotency_key: z.string().uuid(),
        cadre_id: z.number().int().positive(),
        changes: changeableFieldsSchema.refine(
          (c) => Object.keys(c).length > 0,
          'at least one field must be proposed',
        ),
        note: z.string().trim().max(1000).optional(),
      }),
    )
    .max(100)
    .default([]),
});
export type SyncPushBody = z.infer<typeof syncPushBody>;
