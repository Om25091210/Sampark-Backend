import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// promisify picks node's 3-argument scrypt overload, which drops the options we need to
// pass the cost parameters. Assert the 4-argument shape rather than casting at each call.
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

// ADR-042. Password hashing with node's built-in scrypt.
//
// Deliberately NOT argon2 or bcrypt: both are native modules, and a native build step
// is exactly the kind of thing that breaks the Alpine production image at the worst
// moment — for a solo maintainer that is a real operational cost, not a theoretical
// one. scrypt is memory-hard, OWASP-acceptable for password storage, and already in
// the runtime, so it adds no dependency and no build risk. The codebase already leans
// on node:crypto (HMAC for refresh tokens, timingSafeEqual for the import key).
//
// Params: N=16384, r=8, p=1 → ~16 MB per hash (128 * N * r), which sits inside node's
// default 32 MB scrypt maxmem. Raising N later is safe: the cost parameters are stored
// IN the encoded hash, so old hashes keep verifying against their own N.
const N = 16_384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * Encoded as `scrypt$N$r$p$salt$hash` (both hex). Self-describing on purpose — the
 * verifier reads the parameters off the stored value rather than assuming today's
 * constants, so changing them cannot silently invalidate every existing password.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(plain, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Constant-time verify. Returns false — never throws — for a malformed or unknown
 * stored value, so a corrupt row reads as "wrong password" rather than a 500 that
 * tells an attacker they found something interesting.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'hex');
    expected = Buffer.from(parts[5]!, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    // maxmem must cover this hash's OWN parameters, not the current defaults, or an
    // older//larger-N hash would throw instead of verifying.
    const derived = await scrypt(plain, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 256 * n * r,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
