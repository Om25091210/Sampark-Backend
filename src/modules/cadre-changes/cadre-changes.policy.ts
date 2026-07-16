import type { Role } from '@prisma/client';

// ─── Cadre field write policy (ADR-026) ───────────────────────────────────────
//
// The single place that answers "can this role write this cadre field, and does it
// need sign-off". Everything else — routes, service, tests — reads from here. A
// policy spread across route handlers is a policy nobody can audit.
//
// Two classes of field, decided with the maintainer on 2026-07-16:
//
//  DIRECT   — operational metadata. Written immediately by any non-viewer. These
//             are tools for finding cadres, not claims about a person: routing a
//             tag through two approvals would stop tagging being usable, which is
//             the whole point of having it (it drives filtering and sorting).
//
//  APPROVAL — facts of record. Proposed, never written directly (except by
//             super_admin, who is the top of the chain). Changing a cadre's phone
//             or address or asserting their paperwork exists is a claim someone
//             above the submitter signs off on.
//
// Anything absent from BOTH lists is not writable through the API at all.
// `serialNumber` is the deliberate example: it comes from the paper register via
// the import (Design-Docs#7) and is not something a user invents or edits.
// `category` and `alertLevel` are also absent — reclassifying a cadre is a bigger
// decision than an edit form, and needs its own ADR before it gets a write path.

export const DIRECT_FIELDS = ['alertTag', 'aliases'] as const;

export const APPROVAL_FIELDS = [
  'name',
  'phone',
  'thana',
  'currentAddress',
  'permanentAddress',
  'designation',
  'incident',
  'verificationOffice',
  'supervisoryOffice',
  'surrenderDate',
  'surrenderLocation',
  'surrenderOrigin',
  'surrenderYear',
  'regiment',
  'familyGroupInfo',
  'subDivision',
  'hardcopyDocsExist',
] as const;

export type DirectField = (typeof DIRECT_FIELDS)[number];
export type ApprovalField = (typeof APPROVAL_FIELDS)[number];

export function isDirectField(f: string): f is DirectField {
  return (DIRECT_FIELDS as readonly string[]).includes(f);
}

export function isApprovalField(f: string): f is ApprovalField {
  return (APPROVAL_FIELDS as readonly string[]).includes(f);
}

// ─── The approval ladder ──────────────────────────────────────────────────────
//
// "Every role above you must approve." Confirmed with the maintainer:
//   officer     -> admin -> super_admin  (2 approvals)
//   admin       -> super_admin           (1 approval)
//   super_admin -> applied immediately   (0)
//   viewer      -> cannot submit at all
//
// Returned flags are FROZEN onto the request row at submission time, never
// re-derived on read: promoting an officer to admin must not retroactively
// shorten a chain that is already in flight.

export interface RequiredApprovals {
  needsAdmin: boolean;
  needsSuperAdmin: boolean;
}

export function requiredApprovalsFor(role: Role): RequiredApprovals {
  switch (role) {
    case 'officer':
      return { needsAdmin: true, needsSuperAdmin: true };
    case 'admin':
      return { needsAdmin: false, needsSuperAdmin: true };
    case 'super_admin':
      return { needsAdmin: false, needsSuperAdmin: false };
    default:
      // viewer — rejected before this is reached; exhaustive for safety.
      return { needsAdmin: true, needsSuperAdmin: true };
  }
}

/** Viewers are read-only; everyone else may propose. */
export function canSubmit(role: Role): boolean {
  return role !== 'viewer';
}

/** Direct writes (tags/aliases) are open to every non-viewer. */
export function canWriteDirect(role: Role): boolean {
  return role !== 'viewer';
}

/**
 * Whether `role` can cast the approval this request is still waiting on.
 *
 * An admin cannot clear the super_admin step and vice versa — each role signs its
 * own rung. A super_admin may sign the admin rung too (they outrank it), which
 * keeps a request from deadlocking when no admin is around; the reverse is never
 * true.
 */
export function canApproveNext(
  role: Role,
  req: { needsAdmin: boolean; adminApprovedAt: Date | null; needsSuperAdmin: boolean },
): boolean {
  const adminStepOutstanding = req.needsAdmin && req.adminApprovedAt === null;
  if (adminStepOutstanding) return role === 'admin' || role === 'super_admin';
  return role === 'super_admin' && req.needsSuperAdmin;
}
