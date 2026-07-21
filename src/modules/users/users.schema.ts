import { z } from 'zod';

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

const optText = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v === null || v === '' ? undefined : v));

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
  // The org-scope invariant (ADR-042), enforced per row rather than trusted. A
  // mis-scoped account is not a cosmetic error: in Phase C the scope columns ARE the
  // row-level authorization boundary, so an officer with no thana would see nothing and
  // an admin with no sub-division would supervise nothing — and both would look like
  // application bugs long after the sheet that caused them was forgotten.
  .superRefine((row, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (row.role === 'admin') {
      if (row.subDivision === undefined) fail('role=admin requires subDivision (its SDOP scope)');
      if (row.thana !== undefined) fail('role=admin must not set thana — its scope is the sub-division');
    }
    if (row.role === 'officer') {
      if (row.thana === undefined) fail('role=officer requires thana (its station scope)');
      if (row.subDivision !== undefined) fail('role=officer must not set subDivision — its scope is the thana');
    }
    if (row.role === 'super_admin' && (row.thana !== undefined || row.subDivision !== undefined)) {
      fail('role=super_admin is unrestricted — leave thana and subDivision empty');
    }
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
