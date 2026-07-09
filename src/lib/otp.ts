import { randomInt, createHmac, timingSafeEqual } from 'node:crypto';

// Numeric OTP of the configured length, cryptographically random.
export function generateOtpCode(length: number): string {
  const upperExclusive = 10 ** length;
  return randomInt(0, upperExclusive).toString().padStart(length, '0');
}

// OTPs are stored as an HMAC (never plaintext), bound to the phone number.
export function hashOtp(code: string, phone: string, secret: string): string {
  return createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex');
}

export function verifyOtpHash(
  code: string,
  phone: string,
  secret: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(hashOtp(code, phone, secret));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
