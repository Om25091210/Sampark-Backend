import { z } from 'zod';

// Query params are camelCase (per the client contract). `category=all` and
// `filter=All` are client sentinels meaning "no filter".
export const listCadresQuery = z.object({
  category: z.enum(['surrendered', 'jail', 'thana', 'all']).optional(),
  filter: z.enum(['All', 'DVCM', 'ACM', 'PM']).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});

export const cadreIdParam = z.object({ id: z.coerce.number().int().positive() });
export const transferParams = z.object({ cadreId: z.coerce.number().int().positive() });

// Request body is snake_case (per the client contract).
export const transferBody = z.object({ to_officer_id: z.number().int().positive() });

export type ListCadresQuery = z.infer<typeof listCadresQuery>;
export type TransferBody = z.infer<typeof transferBody>;
