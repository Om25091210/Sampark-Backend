import { z } from 'zod';

// Query params are camelCase (per the client contract). `category=all` and
// `filter=All` are client sentinels meaning "no filter".
export const listCadresQuery = z.object({
  category: z.enum(['surrendered', 'jail', 'thana', 'all']).optional(),
  filter: z.enum(['All', 'DVCM', 'ACM', 'PM']).optional(),
  search: z.string().trim().max(100).optional(),
  // ADR-019. Splits the surrendered cadres into the dashboard's two tiles:
  // `district` = surrendered in Bijapur, `other` = another district or state.
  // Only meaningful alongside category=surrendered; non-surrendered cadres have
  // no origin, so combining it with another category correctly returns nothing.
  surrenderOrigin: z.enum(['district', 'other']).optional(),
  // ADR-018. Scopes the list to one officer's assigned cadres.
  //   assignedTo=me  -> the calling user (the officer's "मेरे कैडर" tile)
  //   assignedTo=<id> -> that officer (the admin roster view)
  // Not a privilege boundary: any authenticated user can already list every
  // cadre, so this only narrows a result set it could otherwise page through.
  assignedTo: z.union([z.literal('me'), z.coerce.number().int().positive()]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});

export const cadreIdParam = z.object({ id: z.coerce.number().int().positive() });
export const transferParams = z.object({ cadreId: z.coerce.number().int().positive() });

// Request body is snake_case (per the client contract).
export const transferBody = z.object({ to_officer_id: z.number().int().positive() });

export type ListCadresQuery = z.infer<typeof listCadresQuery>;
export type TransferBody = z.infer<typeof transferBody>;

// What the service actually receives: the route resolves the `me` sentinel to the
// caller's id, so the service never has to know who is asking.
export type ResolvedListCadresQuery = Omit<ListCadresQuery, 'assignedTo'> & {
  assignedTo?: number;
};
