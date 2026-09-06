// Shared wire shape for the approver-queue "select all" — POST /changes/approve-bulk
// and POST /cadre-create-requests/approve-bulk return this exact object. Both modules
// approve each id through their own single-approve path (own transaction, scope check,
// drift check, self-approval guard, notification); this only tallies the outcomes.

/**
 * One request's outcome inside a bulk approve.
 * - `applied`  — fully signed and written to the cadre / cadre created
 * - `approved` — a rung was signed but the ladder still waits on someone above
 * - `stale`    — a drift check refused it (change requests only; a create has no
 *                prior value to drift from, so it never reports this)
 * - `error`    — could not be approved by this actor now (already decided, not their
 *                rung, their own proposal, out of scope); `code` is the AppError code
 */
export interface BulkApproveOutcome {
  id: number;
  status: 'applied' | 'approved' | 'stale' | 'error';
  code?: string;
}

export interface BulkApproveResult {
  results: BulkApproveOutcome[];
  applied: number;
  approved: number;
  stale: number;
  failed: number;
}

/** Fold a list of per-id outcomes into the response envelope. */
export function tallyBulkApprove(results: BulkApproveOutcome[]): BulkApproveResult {
  return {
    results,
    applied: results.filter((r) => r.status === 'applied').length,
    approved: results.filter((r) => r.status === 'approved').length,
    stale: results.filter((r) => r.status === 'stale').length,
    failed: results.filter((r) => r.status === 'error').length,
  };
}
