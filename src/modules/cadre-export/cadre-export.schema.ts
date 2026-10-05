import { z } from 'zod';
import { MIRROR_TABS } from './cadre-export.tabs.js';

// ADR-058 §3. The preview used to return the entire sheet (thousands of rows) on every
// call. It now returns the per-tab row counts plus a capped page of ONE tab.
export const MAX_PREVIEW_ROWS = 200;

export const sheetPreviewQuery = z.object({
  tab: z.enum(MIRROR_TABS).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PREVIEW_ROWS).default(50),
});
export type SheetPreviewQuery = z.infer<typeof sheetPreviewQuery>;
