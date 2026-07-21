import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient, User } from '@prisma/client';
import type { AppConfig } from '../../config/env.js';
import { toWireUser, type WireUser } from '../../lib/serialize.js';
import { unauthorized } from '../../lib/errors.js';
import { verifyPassword } from '../../lib/password.js';
import { generateTotpSecret, totpProvisioningUri, verifyTotp } from '../../lib/totp.js';
import {
  generateRefreshToken,
  hashToken,
  signAccessToken,
  signChallengeToken,
  verifyChallengeToken,
} from '../../lib/tokens.js';

export interface AuthDeps {
  prisma: PrismaClient;
  config: AppConfig;
  log: FastifyBaseLogger;
}

interface TokenPair {
  access: string;
  refresh: string;
}

export interface AuthedResponse {
  status: 'authenticated';
  access_token: string;
  refresh_token: string;
  token_type: 'bearer';
  user: WireUser;
}

/** admin/super_admin, already enrolled — supply a TOTP code to finish. */
export interface TotpRequiredResponse {
  status: 'totp_required';
  challenge_token: string;
  expires_in: number;
}

/**
 * admin/super_admin whose TOTP enrolment has never been completed. The secret + URI are
 * returned ONCE per login attempt so the authenticator app can be set up; the account is
 * not usable until a code confirms it.
 */
export interface TotpEnrollmentResponse {
  status: 'totp_enrollment';
  challenge_token: string;
  expires_in: number;
  totp_secret: string;
  totp_uri: string;
}

export type LoginResponse = AuthedResponse | TotpRequiredResponse | TotpEnrollmentResponse;

export interface AuthService {
  login(email: string, password: string): Promise<LoginResponse>;
  verifyTwoFactor(challengeToken: string, otp: string): Promise<AuthedResponse>;
  refresh(refreshToken: string): Promise<{ access_token: string; refresh_token: string }>;
  me(userId: number): Promise<WireUser>;
  logout(userId: number): Promise<void>;
}

// ADR-042 / SDR-001. Which roles carry a second factor. Officers (the 60 shared thana
// IDs) deliberately do NOT — see lib/totp.ts for the reasoning.
const TOTP_ROLES = new Set(['admin', 'super_admin']);

/** The 2FA challenge's lifetime. Short: it is a hop between two steps, not a session. */
const CHALLENGE_TTL_SECONDS = 300;

export function makeAuthService({ prisma, config, log }: AuthDeps): AuthService {
  async function issueTokens(user: User): Promise<TokenPair> {
    const access = await signAccessToken(
      { sub: user.id, role: user.role },
      config.jwtSecret,
      config.accessTokenTtl,
    );
    const refresh = generateRefreshToken();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refresh, config.jwtSecret),
        expiresAt: new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000),
      },
    });
    return { access, refresh };
  }

  async function authed(user: User): Promise<AuthedResponse> {
    const tokens = await issueTokens(user);
    return {
      status: 'authenticated',
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      token_type: 'bearer',
      user: toWireUser(user),
    };
  }

  return {
    async login(email, password) {
      const user = await prisma.user.findUnique({ where: { email } });

      // ONE generic failure for "no such email", "soft-deleted", "no password set" and
      // "wrong password". The OTP track deliberately told an unknown number it was not
      // registered (a closed roster of provisioned phones); a password form is a
      // different threat surface — distinguishing the cases here would turn the login
      // into an account-enumeration oracle for a system whose IDs are guessable by
      // construction (SHOGNGL01, SHOGNGL02, …).
      const invalid = (): never => {
        throw unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
      };

      if (user === null || user.deletedAt !== null || user.passwordHash === null) {
        // Still hash-compare nothing: the timing difference between "no user" and
        // "wrong password" is not worth defending here beyond the identical response,
        // but log it so a burst of unknown-email attempts is visible.
        log.warn({ email }, 'login attempt for unknown, inactive, or password-less account');
        return invalid();
      }

      if (!(await verifyPassword(password, user.passwordHash))) {
        log.warn({ userId: user.id }, 'login attempt with an incorrect password');
        return invalid();
      }

      // Officers finish here — one factor, by design.
      //
      // ADR-042 (amended): when `totpEnabled` is false, EVERY role finishes here. The
      // client turned the second factor off for now so all 74 accounts sign in with
      // email+password alone; the branch below is intact and still tested, so restoring
      // it is a config flip. While off, admin/super_admin carry no second factor.
      if (!config.totpEnabled || !TOTP_ROLES.has(user.role)) return authed(user);

      const challenge_token = await signChallengeToken(user.id, config.jwtSecret);

      // Enrolled → ask for the code.
      if (user.totpSecret !== null && user.totpConfirmedAt !== null) {
        return { status: 'totp_required', challenge_token, expires_in: CHALLENGE_TTL_SECONDS };
      }

      // Not enrolled (or enrolment abandoned half-way): mint a fresh secret and hand
      // back the provisioning URI. Re-minting on every unconfirmed attempt is
      // deliberate — a secret the user never successfully scanned is worthless, and
      // reusing it would leave an account permanently stuck if the first scan failed.
      const secret = generateTotpSecret();
      await prisma.user.update({
        where: { id: user.id },
        data: { totpSecret: secret, totpConfirmedAt: null },
      });
      return {
        status: 'totp_enrollment',
        challenge_token,
        expires_in: CHALLENGE_TTL_SECONDS,
        totp_secret: secret,
        totp_uri: totpProvisioningUri(user.name, secret),
      };
    },

    async verifyTwoFactor(challengeToken, otp) {
      let userId: number;
      try {
        userId = await verifyChallengeToken(challengeToken, config.jwtSecret);
      } catch {
        throw unauthorized('Invalid or expired challenge', 'INVALID_CHALLENGE');
      }

      // With TOTP off, no challenge should ever have been issued — refuse rather than
      // letting a stale challenge from before the flip act as a second way in.
      if (!config.totpEnabled) {
        throw unauthorized('Invalid or expired challenge', 'INVALID_CHALLENGE');
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user === null || user.deletedAt !== null || user.totpSecret === null) {
        throw unauthorized('Invalid or expired challenge', 'INVALID_CHALLENGE');
      }
      // A challenge minted for an account that is no longer TOTP-bearing must not become
      // a second way in.
      if (!TOTP_ROLES.has(user.role)) {
        throw unauthorized('Invalid or expired challenge', 'INVALID_CHALLENGE');
      }

      if (!verifyTotp(otp, user.totpSecret)) {
        log.warn({ userId: user.id }, 'failed TOTP verification');
        throw unauthorized('Invalid code', 'INVALID_TOTP');
      }

      // First successful code completes enrolment. Recorded so `login` stops re-issuing
      // a fresh secret and starts demanding the code.
      const confirmed =
        user.totpConfirmedAt === null
          ? await prisma.user.update({
              where: { id: user.id },
              data: { totpConfirmedAt: new Date() },
            })
          : user;

      return authed(confirmed);
    },

    async refresh(refreshToken) {
      const tokenHash = hashToken(refreshToken, config.jwtSecret);
      const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
      if (stored === null || stored.revokedAt !== null || stored.expiresAt <= new Date()) {
        throw unauthorized('Invalid or expired refresh token', 'INVALID_REFRESH');
      }
      const user = await prisma.user.findUnique({ where: { id: stored.userId } });
      if (user === null || user.deletedAt !== null) {
        throw unauthorized('Invalid or expired refresh token', 'INVALID_REFRESH');
      }
      // Rotate: revoke the used token, issue a fresh pair.
      await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
      const tokens = await issueTokens(user);
      return { access_token: tokens.access, refresh_token: tokens.refresh };
    },

    async me(userId) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user === null || user.deletedAt !== null) throw unauthorized();
      return toWireUser(user);
    },

    async logout(userId) {
      await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    },
  };
}
