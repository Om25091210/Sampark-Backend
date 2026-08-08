import { z } from 'zod';
import { nfc } from '../../lib/text.js';

// ─── Bulk account creation (Phase B) ──────────────────────────────────────────
//
// Mirrors POST /cadres/import (ADR-038) deliberately: same wrapper object, same batch
// cap, same per-row result array. The Apps Script that drove the 1,478-cadre import is
// being extended for users, so the two contracts should not differ in shape for no
// reason — a body-shape mismatch already cost one wasted 1,478-row send.
//
// Row fields mirror the User ENTITY (camelCase), exactly as the cadre import mirrors
// Cadre. `name` IS the institutional ID ("SHOGNGL01") — ADR-042 made User.name hold the
// ID rather than a person's name — and it is the upsert key.

/** Bounds the request body; the client batches well under this. */
export const MAX_USER_IMPORT_BATCH = 200;

// Phase 0: NFC. `thana`/`subDivision` here ARE the account's authorisation scope, and
// they are compared against the same fields on cadres. A canonically-equal but
// byte-different spelling would under-scope the account with no visible symptom.
const optText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v === null || v === undefined || v === '' ? undefined : nfc(v)));

export type UserRole = 'super_admin' | 'admin' | 'officer' | 'viewer';

// The org-scope invariant (ADR-042), extracted so both `importUserRow`'s row validation
// AND Phase 2's PATCH /users/:id (which validates the MERGED post-edit state, not just
// the submitted fields) share one definition. `viewer` is deliberately unconstrained,
// matching the original rule — there was never a clause for it.
export function scopeInvariantErrors(
  role: UserRole,
  thana: string | null | undefined,
  subDivision: string | null | undefined,
): string[] {
  const errors: string[] = [];
  const has = (v: string | null | undefined) => v !== undefined && v !== null;
  if (role === 'admin') {
    if (!has(subDivision)) errors.push('role=admin requires subDivision (its SDOP scope)');
    if (has(thana)) errors.push('role=admin must not set thana — its scope is the sub-division');
  }
  if (role === 'officer') {
    if (!has(thana)) errors.push('role=officer requires thana (its station scope)');
    if (has(subDivision)) errors.push('role=officer must not set subDivision — its scope is the thana');
  }
  if (role === 'super_admin' && (has(thana) || has(subDivision))) {
    errors.push('role=super_admin is unrestricted — leave thana and subDivision empty');
  }
  return errors;
}

export const importUserRow = z
  .object({
    // The institutional ID. Upsert key — an existing name is SKIPPED, never overwritten,
    // so a re-run cannot silently reset a password that has since been changed.
    name: z.string().trim().min(1, 'name (institutional ID) is required'),
    // Lower-cased on the way in so the stored value matches what /auth/login looks up.
    email: z.string().trim().toLowerCase().email('must be a valid email address'),
    role: z.enum(['super_admin', 'admin', 'officer', 'viewer']),
    // Optional: an account created without one simply cannot log in until a super_admin
    // sets it (ADR-042). Supplying it here is what the hardcoded-password rollout does.
    password: z.string().min(8, 'password must be at least 8 characters').optional(),
    thana: optText,
    subDivision: optText,
    designation: optText,
  })
  // Enforced per row rather than trusted. A mis-scoped account is not a cosmetic error:
  // in Phase C the scope columns ARE the row-level authorization boundary, so an officer
  // with no thana would see nothing and an admin with no sub-division would supervise
  // nothing — and both would look like application bugs long after the sheet that caused
  // them was forgotten.
  .superRefine((row, ctx) => {
    for (const message of scopeInvariantErrors(row.role, row.thana, row.subDivision)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });

// ─── Single-account CRUD (Phase 2 — web User Management) ─────────────────────
//
// POST /users reuses importUserRow's row shape verbatim — same fields, same
// validation, same org-scope invariant. It is NOT the batch envelope; the body IS
// one row. Unlike /users/import, a duplicate `name` here is a 409, not a silent skip.
export const createUserBody = importUserRow;

// PATCH edits role/thana/subDivision/designation only — never name (the immutable
// institutional ID / upsert key) or email (derived from name, ADR-042 §5) or password
// (its own explicit POST /users/:id/password endpoint, never bundled into a generic PATCH).
//
// thana/subDivision are three-way per field: OMITTED = leave untouched, `null` =
// explicitly clear (needed when a role change requires swapping which scope field is
// set), a string = set it. The service validates the MERGED (existing + patch) state
// against scopeInvariantErrors, since a role change alone can violate the invariant
// unless the caller also clears the now-wrong scope field in the same request.
const nullableText = z
  .string()
  .trim()
  .min(1)
  .transform(nfc)
  .nullable();

export const updateUserBody = z
  .object({
    role: z.enum(['super_admin', 'admin', 'officer', 'viewer']).optional(),
    thana: nullableText.optional(),
    subDivision: nullableText.optional(),
    designation: nullableText.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'at least one field is required');

export const listUsersQuery = z.object({
  role: z.enum(['super_admin', 'admin', 'officer', 'viewer']).optional(),
  thana: z.string().trim().max(100).optional(),
  subDivision: z.string().trim().max(100).optional(),
  // Defaults to active-only, matching every other roster view (e.g. GET /officers) —
  // 'all'/'deactivated' are an explicit opt-in for the management UI's own filter.
  status: z.enum(['active', 'deactivated', 'all']).default('active'),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});

// Wrapper object, matching {"cadres":[...]}. Rows arrive as unknowns so ONE malformed row
// cannot fail the whole parse — the service validates each with importUserRow and reports
// per row. The envelope itself IS validated: an object with a bounded, non-empty array.
export const importUsersBody = z.object({
  users: z.array(z.unknown()).min(1, 'users must be a non-empty array').max(MAX_USER_IMPORT_BATCH),
});

// ─── Password set / reset (Phase B) ───────────────────────────────────────────
//
// super_admin JWT only — never the SDR-007 machine key. A reset is an individually
// accountable act against one account, and with real names gone the acting ID is the only
// granularity the audit trail has left; a shared machine key would erase even that.
export const setPasswordBody = z.object({
  password: z.string().min(8, 'password must be at least 8 characters'),
});

export const userIdParam = z.object({ userId: z.coerce.number().int().positive() });

export type ImportUserRow = z.infer<typeof importUserRow>;
export type ImportUsersBody = z.infer<typeof importUsersBody>;
export type SetPasswordBody = z.infer<typeof setPasswordBody>;
export type CreateUserBody = z.infer<typeof createUserBody>;
export type UpdateUserBody = z.infer<typeof updateUserBody>;
export type ListUsersQuery = z.infer<typeof listUsersQuery>;
