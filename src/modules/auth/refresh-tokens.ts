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
