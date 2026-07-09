import type { FastifyInstance } from 'fastify';
import { makeAuthService } from './auth.service.js';
import { refreshBody, sendOtpBody, verifyOtpBody } from './auth.schema.js';
import {
  bearerAuth,
  emptyResponse,
  jsonResponse,
  zodToJson,
  EXAMPLE_AUTH_USER,
  EXAMPLE_TOKEN_PAIR,
} from '../../lib/openapi.js';

// Officer authentication (SMS-OTP track). Mounted under /api/v1.
// Public: otp/send, otp/verify, refresh. Authenticated: me, logout.
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const service = makeAuthService({
    prisma: app.prisma,
    config: app.config,
    sms: app.sms,
    log: app.log,
  });

  app.post(
    '/auth/otp/send',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Send an OTP to a provisioned officer phone',
        description: 'Public. Unknown/inactive numbers → 403 PHONE_NOT_REGISTERED (closed roster).',
        body: zodToJson(sendOtpBody),
        response: { 200: jsonResponse('OTP dispatched', { message: 'OTP sent', expires_in: 300 }) },
      },
    },
    async (request) => {
      const { phone } = sendOtpBody.parse(request.body);
      return service.sendOtp(phone);
    },
  );

  app.post(
    '/auth/otp/verify',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Verify an OTP and receive a token pair',
        description: 'Public. Returns snake_case tokens + a camelCase `user` (AuthUser).',
        body: zodToJson(verifyOtpBody),
        response: { 200: jsonResponse('Authenticated', EXAMPLE_TOKEN_PAIR) },
      },
    },
    async (request) => {
      const { phone, otp } = verifyOtpBody.parse(request.body);
      return service.verifyOtp(phone, otp);
    },
  );

  app.post(
    '/auth/refresh',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Rotate tokens with a refresh token',
        description: 'Public. Rotate-on-refresh: revokes the used token, issues a fresh pair.',
        body: zodToJson(refreshBody),
        response: {
          200: jsonResponse('New token pair', {
            access_token: EXAMPLE_TOKEN_PAIR.access_token,
            refresh_token: EXAMPLE_TOKEN_PAIR.refresh_token,
          }),
        },
      },
    },
    async (request) => {
      const { refresh_token } = refreshBody.parse(request.body);
      return service.refresh(refresh_token);
    },
  );

  app.get(
    '/auth/me',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Auth'],
        summary: 'Current authenticated user',
        security: bearerAuth,
        response: { 200: jsonResponse('The AuthUser', EXAMPLE_AUTH_USER) },
      },
    },
    async (request) => {
      // authenticate guarantees authUser is populated.
      return service.me(request.authUser!.sub);
    },
  );

  app.post(
    '/auth/logout',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Auth'],
        summary: 'Revoke all refresh tokens for the user',
        security: bearerAuth,
        response: { 204: emptyResponse('Logged out') },
      },
    },
    async (request, reply) => {
      await service.logout(request.authUser!.sub);
      reply.code(204);
      return null;
    },
  );
}
