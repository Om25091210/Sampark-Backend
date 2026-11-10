import type { FastifyInstance } from 'fastify';
import { makeAuthService } from './auth.service.js';
import { loginBody, logoutBody, refreshBody, twoFactorVerifyBody } from './auth.schema.js';
import {
  bearerAuth,
  emptyResponse,
  jsonResponse,
  zodToJson,
  EXAMPLE_AUTH_USER,
  EXAMPLE_TOKEN_PAIR,
} from '../../lib/openapi.js';

// ADR-042. Email+password authentication for EVERY account. The SMS-OTP track
// (ADR-012) is removed entirely — there is no /auth/otp/* any more.
// Public: login, 2fa/verify, refresh. Authenticated: me, logout.
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const service = makeAuthService({
    prisma: app.prisma,
    config: app.config,
    log: app.log,
  });

  app.post(
    '/auth/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Log in with email + password',
        description:
          'Public. Officers receive a token pair directly (`status: "authenticated"`). ' +
          'admin/super_admin receive a 2FA challenge: `status: "totp_required"` when already ' +
          'enrolled, or `status: "totp_enrollment"` (carrying `totp_secret` + `totp_uri`) on ' +
          'first login. Both are completed at POST /auth/2fa/verify. A bad email, an inactive ' +
          'account, a password-less account and a wrong password all return the SAME ' +
          '401 INVALID_CREDENTIALS — the IDs are guessable by construction, so the form must ' +
          'not be an enumeration oracle.',
        body: zodToJson(loginBody),
        response: {
          200: jsonResponse('Authenticated, or a 2FA challenge', {
            status: 'authenticated',
            ...EXAMPLE_TOKEN_PAIR,
          }),
        },
      },
    },
    async (request) => {
      const { email, password } = loginBody.parse(request.body);
      return service.login(email, password);
    },
  );

  app.post(
    '/auth/2fa/verify',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Complete an admin/super_admin login with a TOTP code',
        description:
          'Public (the challenge token is the credential). Also CONFIRMS enrolment: the first ' +
          'valid code marks the secret confirmed, after which login demands a code instead of ' +
          're-issuing a secret.',
        body: zodToJson(twoFactorVerifyBody),
        response: {
          200: jsonResponse('Authenticated', { status: 'authenticated', ...EXAMPLE_TOKEN_PAIR }),
        },
      },
    },
    async (request) => {
      const { challenge_token, otp } = twoFactorVerifyBody.parse(request.body);
      return service.verifyTwoFactor(challenge_token, otp);
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
        summary: 'Log out — one session if `refresh_token` is sent, otherwise all of the user\'s sessions',
        description:
          'Optional body `{ refresh_token }`. With it only that device\'s session ends (officers share ' +
          'institutional IDs across phones, so one phone logging out must not end the others). ' +
          'Without it every refresh token for the user is revoked.',
        security: bearerAuth,
        response: { 204: emptyResponse('Logged out') },
      },
    },
    async (request, reply) => {
      const { refresh_token } = logoutBody.parse(request.body ?? {});
      await service.logout(request.authUser!.sub, refresh_token);
      reply.code(204);
      return null;
    },
  );
}
