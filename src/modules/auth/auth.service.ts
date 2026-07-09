import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient, User } from '@prisma/client';
import type { AppConfig } from '../../config/env.js';
import type { SmsProvider } from '../../lib/sms.js';
import { toWireUser, type WireUser } from '../../lib/serialize.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { generateOtpCode, hashOtp, verifyOtpHash } from '../../lib/otp.js';
import {
  generateRefreshToken,
  hashToken,
  signAccessToken,
} from '../../lib/tokens.js';

export interface AuthDeps {
  prisma: PrismaClient;
  config: AppConfig;
  sms: SmsProvider;
  log: FastifyBaseLogger;
}

interface TokenPair {
  access: string;
  refresh: string;
}

export interface AuthService {
  sendOtp(phone: string): Promise<{ message: string; expires_in: number }>;
  verifyOtp(
    phone: string,
    otp: string,
  ): Promise<{ access_token: string; refresh_token: string; token_type: 'bearer'; user: WireUser }>;
  refresh(refreshToken: string): Promise<{ access_token: string; refresh_token: string }>;
  me(userId: number): Promise<WireUser>;
  logout(userId: number): Promise<void>;
}

export function makeAuthService({ prisma, config, sms, log }: AuthDeps): AuthService {
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

  return {
    async sendOtp(phone) {
      const user = await prisma.user.findUnique({ where: { phone } });
      // Closed system of ~400 provisioned officers: an unknown/inactive number
      // gets a clear 403 (clarity over enumeration protection — see DESIGN #5).
      if (user === null || user.deletedAt !== null) {
        log.warn({ phone }, 'OTP requested for an unprovisioned or inactive number');
        throw forbidden('This number is not registered', 'PHONE_NOT_REGISTERED');
      }
      // Invalidate any still-active challenge for this phone first.
      await prisma.otpChallenge.updateMany({
        where: { phone, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      const code = generateOtpCode(config.otpLength);
      await prisma.otpChallenge.create({
        data: {
          phone,
          codeHash: hashOtp(code, phone, config.jwtSecret),
          expiresAt: new Date(Date.now() + config.otpTtlSeconds * 1000),
        },
      });
      await sms.sendOtp(phone, code);
      return { message: 'OTP sent', expires_in: config.otpTtlSeconds };
    },

    async verifyOtp(phone, otp) {
      const challenge = await prisma.otpChallenge.findFirst({
        where: { phone, consumedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });
      if (challenge === null) throw unauthorized('Invalid or expired code', 'INVALID_OTP');

      if (challenge.attempts >= config.otpMaxAttempts) {
        await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });
        throw unauthorized('Too many attempts; request a new code', 'TOO_MANY_ATTEMPTS');
      }

      if (!verifyOtpHash(otp, phone, config.jwtSecret, challenge.codeHash)) {
        await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
        throw unauthorized('Invalid or expired code', 'INVALID_OTP');
      }

      await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } });

      const user = await prisma.user.findUnique({ where: { phone } });
      if (user === null || user.deletedAt !== null) {
        throw forbidden('This number is not authorised');
      }

      // Development-only: echo the verified code so the flow can be exercised
      // end-to-end without reading a real SMS. Never logged outside development.
      if (config.nodeEnv === 'development') {
        log.info({ phone }, `AUTH — OTP verified for ${phone} (dev): ${otp}`);
      }

      const tokens = await issueTokens(user);
      return {
        access_token: tokens.access,
        refresh_token: tokens.refresh,
        token_type: 'bearer',
        user: toWireUser(user),
      };
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
