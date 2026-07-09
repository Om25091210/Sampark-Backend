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

// Refresh tokens are opaque random strings; only their HMAC is stored in the DB.
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}
