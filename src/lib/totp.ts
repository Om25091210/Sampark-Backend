import { authenticator } from 'otplib';

// ADR-042 / SDR-001. TOTP second factor for admin + super_admin ONLY (14 accounts).
//
// Not the 60 thana-level IDs: those are shared field accounts on devices in EDGE/2G
// areas, where a drifted device clock would lock out an entire thana, and a TOTP secret
// shared across shift-holders is a worse secret than no second factor. SDR-001's own
// reasoning ("TOTP overhead is not appropriate for 400+ constables") still holds; HQ and
// SDOP are few, desk-based, and hold the widest data access.
//
// `otplib` is the library CLAUDE.md pins for this (replacing the thesis's pyotp).

// A one-step (±30s) window either side. Tolerates ordinary clock skew without widening
// the acceptance window to the point where a shoulder-surfed code stays usable.
authenticator.options = { window: 1 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

/** The `otpauth://` URI an authenticator app scans. `account` is the institutional ID. */
export function totpProvisioningUri(account: string, secret: string): string {
  return authenticator.keyuri(account, 'SAMPARK', secret);
}

/** Constant-time-ish verify via otplib; returns false rather than throwing on junk input. */
export function verifyTotp(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token, secret });
  } catch {
    return false;
  }
}
