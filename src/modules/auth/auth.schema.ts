import { z } from 'zod';

// Request bodies are snake_case on the wire (per the client contract).
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{10,15}$/, 'must be a 10–15 digit phone number, optionally +-prefixed');

export const sendOtpBody = z.object({ phone });
export const verifyOtpBody = z.object({
  phone,
  otp: z.string().trim().regex(/^[0-9]{4,8}$/, 'must be a 4–8 digit code'),
});
export const refreshBody = z.object({ refresh_token: z.string().min(1) });

export type SendOtpBody = z.infer<typeof sendOtpBody>;
export type VerifyOtpBody = z.infer<typeof verifyOtpBody>;
export type RefreshBody = z.infer<typeof refreshBody>;
