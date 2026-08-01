import type { Role } from '@prisma/client';

// ─── The approval ladder ──────────────────────────────────────────────────────
//
// Identical to cadre-changes.policy.ts's ladder (ADR-026/ADR-028) — role-based, not
// field-based, so it applies unchanged to a whole-record creation:
//   officer     -> admin -> super_admin  (2 approvals)
//   admin       -> super_admin           (1 approval)
//   super_admin -> applied immediately   (0)
//   viewer      -> cannot submit at all
//
// Returned flags are FROZEN onto the request row at submission time, never
// re-derived on read — promoting an officer to admin must not retroactively
// shorten a chain that is already in flight.
//
// There is no DIRECT_FIELDS/APPROVAL_FIELDS equivalent here: a create request has no
// per-field lock concept (see cadre-create-requests.service.ts for why).

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

/** Viewers are read-only; everyone else may propose a new cadre. */
export function canSubmit(role: Role): boolean {
  return role !== 'viewer';
}

/**
 * Whether `role` can cast the approval this request is still waiting on.
 *
 * STRICT: each rung is signed by its own role, in order — same ADR-028 rule as
 * cadre-changes: a super_admin may NOT sign the admin rung. Preventing a
 * hypothetical deadlock is not worth silently collapsing a two-person review into
 * one person clicking twice.
 */
export function canApproveNext(
  role: Role,
  req: {
    needsAdmin: boolean;
    adminApprovedAt: Date | null;
    needsSuperAdmin: boolean;
    superAdminApprovedAt: Date | null;
  },
): boolean {
  if (req.needsAdmin && req.adminApprovedAt === null) return role === 'admin';
  return role === 'super_admin' && req.needsSuperAdmin && req.superAdminApprovedAt === null;
}
