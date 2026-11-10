import { z } from 'zod';
import { createReportBodyShape, checkDeathRequirements } from '../reports/reports.schema.js';
import { changeableFieldsSchema } from '../cadre-changes/cadre-changes.schema.js';
import { proformaAFieldsCreateSchema, proformaAFieldsPartial } from '../cadre-proforma-a/cadre-proforma-a.schema.js';
import { proformaBFieldsCreateSchema, proformaBFieldsPartial } from '../cadre-proforma-b/cadre-proforma-b.schema.js';

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
// Each item schema lives in its own constant so the push handler can validate ITEMS one at a
// time (see parsePushBody) instead of the whole batch at once.
const pushReportItem = createReportBodyShape
  .extend({ cadre_id: z.number().int().positive(), idempotency_key: z.string().uuid() })
  // This task. Same death-report requirements as the direct create route —
  // see reports.schema.ts's checkDeathRequirements comment.
  .superRefine(checkDeathRequirements);

const pushChangeItem = z.object({
  idempotency_key: z.string().uuid(),
  cadre_id: z.number().int().positive(),
  changes: changeableFieldsSchema.refine(
    (c) => Object.keys(c).length > 0,
    'at least one field must be proposed',
  ),
  note: z.string().trim().max(1000).optional(),
});

// ADR-064 offline addendum. Same ADR-013 idempotency pattern, generalised to the
// proforma ladder. `kind` discriminates create (no existing row — `fields` is the
// full record, mirrors CadreCreateRequest.draft) from edit (`changes` is a partial
// diff against the record the device last saw, mirrors cadreChangeRequests above).
const pushProformaAItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'),
    idempotency_key: z.string().uuid(),
    cadre_id: z.number().int().positive(),
    fields: proformaAFieldsCreateSchema,
    note: z.string().trim().max(1000).optional(),
  }),
  z.object({
    kind: z.literal('edit'),
    idempotency_key: z.string().uuid(),
    cadre_id: z.number().int().positive(),
    changes: proformaAFieldsPartial.refine(
      (c) => Object.keys(c).length > 0,
      'at least one field must be proposed',
    ),
    note: z.string().trim().max(1000).optional(),
  }),
]);

// Same shape, plus `b_id` (required on `edit` — which filing this changes; a
// `create` has none yet, same reasoning as CadreProformaB's targetId).
const pushProformaBItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'),
    idempotency_key: z.string().uuid(),
    cadre_id: z.number().int().positive(),
    fields: proformaBFieldsCreateSchema,
    note: z.string().trim().max(1000).optional(),
  }),
  z.object({
    kind: z.literal('edit'),
    idempotency_key: z.string().uuid(),
    cadre_id: z.number().int().positive(),
    b_id: z.number().int().positive(),
    changes: proformaBFieldsPartial.refine(
      (c) => Object.keys(c).length > 0,
      'at least one field must be proposed',
    ),
    note: z.string().trim().max(1000).optional(),
  }),
]);

// This is the shape of a CLEAN push. It is what the API docs show and what the service
// receives; the handler does not parse a request with it directly — see parsePushBody.
export const syncPushBody = z.object({
  reports: z.array(pushReportItem).max(100).default([]),
  cadreChangeRequests: z.array(pushChangeItem).max(100).default([]),
  proformaAChangeRequests: z.array(pushProformaAItem).max(100).default([]),
  proformaBChangeRequests: z.array(pushProformaBItem).max(100).default([]),
});

// ─── Per-item validation ──────────────────────────────────────────────────────
//
// The route promises "never all-or-nothing — one bad item in the batch does not fail the
// rest". Parsing the whole body with `syncPushBody` broke that promise at the first hurdle:
// ONE item failing validation returned 400 for the entire request, and a phone sends every
// kind of queued edit (cadre edits, AB and B proformas) in a single POST. So one poisoned
// proforma — in production, an economic status sent as the Hindi label instead of the
// enum, plus a blank list entry — silently blocked every other edit that officer had queued,
// on every sync, for as long as it sat in the outbox.
//
// Instead: only the envelope (four arrays, each capped) is validated up front. Each item is
// then validated on its own; a failing item is reported back under its own clientKey as a
// normal per-item `error` result, and the valid ones go through untouched.

const pushEnvelope = z.object({
  reports: z.array(z.unknown()).max(100).default([]),
  cadreChangeRequests: z.array(z.unknown()).max(100).default([]),
  proformaAChangeRequests: z.array(z.unknown()).max(100).default([]),
  proformaBChangeRequests: z.array(z.unknown()).max(100).default([]),
});

export type PushKind = 'reports' | 'cadreChangeRequests' | 'proformaAChangeRequests' | 'proformaBChangeRequests';

export interface RejectedPushItem {
  /** Position of the item in the REQUEST's array, so results can be returned in request order. */
  index: number;
  clientKey: string;
  error: string;
}

export interface ParsedPush {
  body: SyncPushBody;
  rejected: Record<PushKind, RejectedPushItem[]>;
}

const ITEM_SCHEMAS = {
  reports: pushReportItem,
  cadreChangeRequests: pushChangeItem,
  proformaAChangeRequests: pushProformaAItem,
  proformaBChangeRequests: pushProformaBItem,
} as const;

const KEY_PROBE = z.object({ idempotency_key: z.string().uuid() });

function describeIssue(err: z.ZodError): string {
  const first = err.issues[0];
  if (first === undefined) return 'डेटा अमान्य है';
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `डेटा अमान्य है — ${path}${first.message}`;
}

/**
 * Validates a push request item by item. Throws (→ 400) only when the REQUEST itself is
 * malformed: not an object, an array missing or over its cap, or an item with no usable
 * `idempotency_key` — without one there is no clientKey to report that item's failure
 * under, and the phone always sends one.
 */
export function parsePushBody(raw: unknown): ParsedPush {
  const envelope = pushEnvelope.parse(raw ?? {});
  const rejected: Record<PushKind, RejectedPushItem[]> = {
    reports: [], cadreChangeRequests: [], proformaAChangeRequests: [], proformaBChangeRequests: [],
  };
  const valid: Record<PushKind, unknown[]> = {
    reports: [], cadreChangeRequests: [], proformaAChangeRequests: [], proformaBChangeRequests: [],
  };

  for (const kind of Object.keys(ITEM_SCHEMAS) as PushKind[]) {
    envelope[kind].forEach((item, index) => {
      const parsed = ITEM_SCHEMAS[kind].safeParse(item);
      if (parsed.success) {
        valid[kind].push(parsed.data);
        return;
      }
      const key = KEY_PROBE.safeParse(item);
      if (!key.success) {
        // No way to report this item individually — the request is malformed.
        throw parsed.error;
      }
      rejected[kind].push({ index, clientKey: key.data.idempotency_key, error: describeIssue(parsed.error) });
    });
  }

  return { body: valid as unknown as SyncPushBody, rejected };
}
export type SyncPushBody = z.infer<typeof syncPushBody>;
