import { z } from 'zod';

// Media routes are addressed under their cadre, same as core reports.
export const mediaCadreParam = z.object({ cadreId: z.coerce.number().int().positive() });
export type MediaCadreParam = z.infer<typeof mediaCadreParam>;

// Image-type knowledge moved to lib/images.ts when the bulk avatar backfill needed it
// too; re-exported here so the media routes' existing imports keep reading naturally.
export { EXT_BY_TYPE, isAllowedImageType } from '../../lib/images.js';
