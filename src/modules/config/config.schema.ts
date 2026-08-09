import { z } from 'zod';

// ADR-059. The Configuration page manages exactly one non-secret connection
// setting: the Apps Script Web App deployment URL the sheets-sync HTTP client
// calls. Nullable-settable -- a super_admin can clear it to pause sync without
// touching Secrets Manager.
export const updateConfigBody = z.object({
  sheetsSyncUrl: z.string().trim().url('sheetsSyncUrl must be a valid URL').nullable(),
});

export type UpdateConfigBody = z.infer<typeof updateConfigBody>;

// ADR-059 §4 / Phase 6. The Configuration page's status panel reads recent
// sync_log rows -- capped well below the table's full size, this is a status
// glance, not an export.
export const listSyncLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListSyncLogQuery = z.infer<typeof listSyncLogQuery>;
