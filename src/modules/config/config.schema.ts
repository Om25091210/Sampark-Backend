import { z } from 'zod';

// ADR-059. The Configuration page manages exactly one non-secret connection
// setting: the Apps Script Web App deployment URL the sheets-sync HTTP client
// calls. Nullable-settable -- a super_admin can clear it to pause sync without
// touching Secrets Manager.
export const updateConfigBody = z.object({
  sheetsSyncUrl: z.string().trim().url('sheetsSyncUrl must be a valid URL').nullable(),
});

export type UpdateConfigBody = z.infer<typeof updateConfigBody>;
