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

// ─── Bulk historical import (ADR-038) ──────────────────────────────────────────
//
// One-time backfill of the ~1,478-row paper surrender register, pushed from an
// unattended Apps Script (Design-Docs#7). Deliberately OUTSIDE the CadreChangeRequest
// approval ladder (ADR-026): that workflow edits cadres that already exist, and these
// are brand-new rows with no record to attach a request to — the same way a
// super_admin's direct writes already skip the ladder.
//
// Row fields are camelCase, MIRRORING the Cadre wire entity the Apps Script already
// maps to — a deliberate, documented deviation from the snake_case request-body
// convention. This is a bulk entity load performed by a machine/super-admin tool, not
// a mobile-client operation, so it follows the entity's casing, not the client's.

/** A repeated round-trip cap: bounds request size and honours Apps Script's 6-min limit. */
export const MAX_IMPORT_BATCH = 200;

// Optional free-text field: accepts a string, or null/undefined/"" as "absent".
// Apps Script sends null for an empty sheet cell; all three normalise to undefined.
const optText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v === null || v === '' ? undefined : v));

// Optional ISO date (the sheet's ~29 malformed dates are cleaned upstream — we expect
// clean ISO here, per the spec). null/"" → undefined; a bad date string fails the row.
const optDate = z.preprocess(
  (v) => (v === null || v === '' ? undefined : v),
  z.coerce.date().optional(),
);

// One register row. Required fields mirror the NOT-NULL Cadre columns; everything
// else is nullable in the source and optional here. Parsed per-row (safeParse) by the
// service so ONE bad row becomes that row's `error` result, never a failed batch.
export const importCadreRow = z.object({
  // The natural idempotency key (ADR-025) — clean + unique 1..1478 in the source.
  serialNumber: z.string().trim().min(1, 'serialNumber is required'),
  name: z.string().trim().min(1, 'name is required'),
  // Required but MAY be empty (decided): a cadre with no phone sends "", not null.
  phone: z.string(),
  thana: z.string().trim().min(1, 'thana is required'),
  currentAddress: z.string().trim().min(1, 'currentAddress is required'),
  designation: z.string().trim().min(1, 'designation is required'),
  category: z.enum(['surrendered', 'jail', 'thana']),
  alertLevel: z.enum(['critical', 'warning', 'normal']),
  // Optional — only DVCM/ACM/PM rows carry a filter; the other ~30 designations leave it null.
  filter: z
    .enum(['DVCM', 'ACM', 'PM'])
    .nullish()
    .transform((v) => v ?? undefined),
  permanentAddress: optText,
  surrenderDate: optDate,
  surrenderLocation: optText,
  surrenderOrigin: z
    .enum(['district', 'other'])
    .nullish()
    .transform((v) => v ?? undefined),
  surrenderYear: optText,
  regiment: optText,
  subDivision: optText,
  fatherName: optText,
  motherName: optText,
  spouseName: optText,
  incident: optText,
  // ADR-038. New demographic columns.
  gender: z
    .enum(['male', 'female'])
    .nullish()
    .transform((v) => v ?? undefined),
  caste: optText,
  dateOfBirth: optDate,
  // Alias + otherAliasNote fold into the string[] column. Absent/null → [].
  aliases: z
    .array(z.string().trim().min(1))
    .nullish()
    .transform((v) => v ?? []),
});

// The batch envelope. Rows arrive as unknowns so a single malformed row cannot fail
// the whole parse here — the service validates each with importCadreRow and reports
// per-row. The envelope itself IS Zod-validated: an object with a bounded, non-empty
// `cadres` array.
export const importCadresBody = z.object({
  cadres: z.array(z.unknown()).min(1, 'cadres must be a non-empty array').max(MAX_IMPORT_BATCH),
});

export type ImportCadreRow = z.infer<typeof importCadreRow>;
export type ImportCadresBody = z.infer<typeof importCadresBody>;

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
