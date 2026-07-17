import { z } from 'zod';

// ADR-033. A repeatable query param arrives as a string when sent once and an array
// when sent more than once. Normalising here means the service always sees an array
// and never has to care how many chips the user tapped.
const multi = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
    z.array(inner).min(1).max(20).optional(),
  );

// Query params are camelCase (per the client contract). `category=all` and
// `filter=All` are client sentinels meaning "no filter".
export const listCadresQuery = z.object({
  // ADR-033: multi-valued. The master filter sheet is a multi-select, so a single
  // value could never express "critical OR warning" — the sheet used to resolve that
  // client-side over one fetched page, which silently lost everyone past page 1.
  category: multi(z.enum(['surrendered', 'jail', 'thana', 'all'])),
  filter: z.enum(['All', 'DVCM', 'ACM', 'PM']).optional(),
  search: z.string().trim().max(100).optional(),
  // ADR-033. Real distinct values from the roster, offered by GET /cadres/facets —
  // never a hardcoded list. Matched as a substring, case-insensitively: a cadre's
  // thana reads "बीजापुर / गंगालूर", so an equality match on "बीजापुर" would miss it.
  thana: multi(z.string().trim().min(1).max(100)),
  designation: multi(z.string().trim().min(1).max(200)),
  // ADR-019. Splits the surrendered cadres into the dashboard's two tiles:
  // `district` = surrendered in Bijapur, `other` = another district or state.
  // Only meaningful alongside category=surrendered; non-surrendered cadres have
  // no origin, so combining it with another category correctly returns nothing.
  surrenderOrigin: z.enum(['district', 'other']).optional(),
  // ADR-020. Server-side alert-severity filter, so the dashboard's "सक्रिय अलर्ट"
  // tile can drill into exactly the critical cadres rather than filtering a single
  // fetched page client-side (which would miss everyone past the first page).
  // ADR-033 widened it to multi-value; the dashboard's single-value drill-in still
  // works unchanged, since one value normalises to a one-element array.
  alertLevel: multi(z.enum(['critical', 'warning', 'normal'])),
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
