import { z } from 'zod';

// Query params are camelCase (per the client contract). `search` matches across
// name, phone, thana, and designation — the fields an admin would recognise an
// officer by when picking one to assign a cadre to.
export const listOfficersQuery = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});

export type ListOfficersQuery = z.infer<typeof listOfficersQuery>;
