import { z } from 'zod';

// Media routes are addressed under their cadre, same as core reports.
export const mediaCadreParam = z.object({ cadreId: z.coerce.number().int().positive() });
export type MediaCadreParam = z.infer<typeof mediaCadreParam>;

// The mobile client uploads report photos as image/jpeg or image/png (see
// report.service.ts uploadPhoto). Anything else is rejected at the edge.
export const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export function isAllowedImageType(mimetype: string): boolean {
  return mimetype in EXT_BY_TYPE;
}
