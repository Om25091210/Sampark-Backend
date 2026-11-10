import type { Prisma } from '@prisma/client';

/**
 * How long after a refresh token is ROTATED it can still be exchanged once more.
 *
 * Rotation revokes the old token the moment it is used. On a weak link the response can
 * be lost after the server has already rotated: the phone still holds the old token, the
 * server has revoked it, and the next refresh fails with 401 — which logs the officer
 * out (and wipes their offline mirror) in exactly the no-signal places they cannot sign
 * back in. Accepting the just-rotated token for a short window lets that retry through.
 * Ten minutes covers the app's own 5-minute background sync tick plus margin.
 *
 * This only ever applies to a token revoked BY ROTATION (`rotatedAt` set). A token ended
 * by logout, password reset or deactivation goes through `revokeAllRefreshTokens`, which
 * clears `rotatedAt`, so no ended session can be revived through this window.
 */
export const REFRESH_REUSE_GRACE_MS = 10 * 60_000;

/**
 * Ends ONE device's session: the given refresh token AND everything rotation derived from it
 * (its whole `family`), and only if the token belongs to `userId`. Used by a logout that names
 * its session, so an officer signing out on their phone does not end the sessions of the other
 * phones sharing that institutional ID.
 *
 * The family matters because the phone often names a token that has already been rotated away
 * (its stored copy lags behind the API client's refresh); revoking just that row would leave
 * the device's live token valid on the server. A token that is unknown or belongs to someone
 * else matches nothing — a silent no-op, never an error, so the endpoint leaks nothing about
 * which tokens exist. A row from before families existed has none and is revoked on its own.
 * `rotatedAt` is cleared with the revoke for the same reason as in revokeAllRefreshTokens: a
 * logged-out token must not stay replayable through the reuse window.
 */
export async function revokeRefreshTokenFor(
  client: Prisma.TransactionClient,
  userId: number,
  tokenHash: string,
): Promise<void> {
  const stored = await client.refreshToken.findFirst({
    where: { userId, tokenHash },
    select: { id: true, family: true },
  });
  if (stored === null) return;
  await client.refreshToken.updateMany({
    where: {
      ...(stored.family !== null ? { userId, family: stored.family } : { id: stored.id }),
      OR: [{ revokedAt: null }, { rotatedAt: { not: null } }],
    },
    data: { revokedAt: new Date(), rotatedAt: null },
  });
}

/**
 * Ends every session a user has: revokes all live refresh tokens AND closes the reuse
 * window on any recently-rotated ones. Logout, password reset and deactivation must all
 * go through here — revoking only `revokedAt: null` rows would leave a rotated token
 * replayable for up to REFRESH_REUSE_GRACE_MS after the session was meant to be dead.
 */
export async function revokeAllRefreshTokens(
  client: Prisma.TransactionClient,
  userId: number,
): Promise<void> {
  await client.refreshToken.updateMany({
    where: { userId, OR: [{ revokedAt: null }, { rotatedAt: { not: null } }] },
    data: { revokedAt: new Date(), rotatedAt: null },
  });
}
