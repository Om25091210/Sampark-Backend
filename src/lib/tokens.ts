import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, createHmac } from 'node:crypto';

const encoder = new TextEncoder();

export interface AccessTokenClaims {
  sub: number; // user id
  role: string;
}

// Access tokens are short-lived HS256 JWTs.
export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttl: string,
): Promise<string> {
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(claims.sub))
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(encoder.encode(secret));
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, encoder.encode(secret));
  const sub = Number(payload.sub);
  const role = typeof payload.role === 'string' ? payload.role : '';
  if (!Number.isInteger(sub) || role === '') {
    throw new Error('malformed access token payload');
  }
  return { sub, role };
}

// ADR-042. The short-lived token binding step 1 (password) to step 2 (TOTP) of an
// admin/super_admin login. Carries `typ: '2fa'` and NO `role`, so it cannot be used as
// an access token: `verifyAccessToken` above rejects a payload without a role, and
// `verifyChallengeToken` below rejects anything without typ='2fa'. The two token kinds
// therefore cannot be swapped for one another in either direction.
export async function signChallengeToken(
  userId: number,
  secret: string,
  ttl = '5m',
): Promise<string> {
  return new SignJWT({ typ: '2fa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(encoder.encode(secret));
}

/** Returns the user id the challenge was issued for. Throws if it is not a 2FA challenge. */
export async function verifyChallengeToken(token: string, secret: string): Promise<number> {
  const { payload } = await jwtVerify(token, encoder.encode(secret));
  if (payload.typ !== '2fa') throw new Error('not a 2fa challenge token');
  const sub = Number(payload.sub);
  if (!Number.isInteger(sub)) throw new Error('malformed challenge token payload');
  return sub;
}

// Refresh tokens are opaque random strings; only their HMAC is stored in the DB.
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}
