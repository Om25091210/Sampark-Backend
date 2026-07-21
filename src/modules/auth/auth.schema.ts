import { z } from 'zod';

// ADR-042. Request bodies are snake_case on the wire (per the client contract).
// The SMS-OTP bodies (sendOtpBody / verifyOtpBody) are GONE — that track is removed.

// Email is lower-cased on the way in so `SDOPKUTRU01@…` and `sdopkutru01@…` are the
// same account. The stored value is always the lower-cased form (see /users/import).
export const loginBody = z.object({
  email: z.string().trim().toLowerCase().email('must be a valid email address'),
  password: z.string().min(1, 'password is required'),
});

// Step 2 of the admin/super_admin login, and the confirming step of TOTP enrolment.
export const twoFactorVerifyBody = z.object({
  challenge_token: z.string().min(1),
  otp: z.string().trim().regex(/^[0-9]{6}$/, 'must be a 6-digit code'),
});

export const refreshBody = z.object({ refresh_token: z.string().min(1) });

export type LoginBody = z.infer<typeof loginBody>;
export type TwoFactorVerifyBody = z.infer<typeof twoFactorVerifyBody>;
export type RefreshBody = z.infer<typeof refreshBody>;
