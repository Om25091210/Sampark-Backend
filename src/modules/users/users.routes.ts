import type { FastifyInstance } from 'fastify';
import { makeUsersService } from './users.service.js';
import { importUsersBody, setPasswordBody, userIdParam } from './users.schema.js';
import {
  bearerAuth,
  emptyResponse,
  jsonResponse,
  zodToJson,
  EXAMPLE_USER_IMPORT_RESULT,
} from '../../lib/openapi.js';

// Phase B. Account provisioning. BOTH routes are super_admin JWT only — deliberately not
// the SDR-007 machine key that the cadre import uses: minting accounts and resetting
// credentials are individually accountable acts, and with real names gone (ADR-042) the
// acting super_admin's ID is the only granularity the audit trail has left.
export async function usersRoutes(app: FastifyInstance): Promise<void> {
  const service = makeUsersService({ prisma: app.prisma, log: app.log });

  app.post(
    '/users/import',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Users'],
        summary: 'Bulk-create accounts (super_admin)',
        description:
          'Batched account creation, same shape as POST /cadres/import. Body is an OBJECT ' +
          'with a `users` array (max 200). UPSERTS BY `name` — the institutional ID: an ' +
          'existing name is SKIPPED, never overwritten, so a re-run cannot reset a password ' +
          'that has since changed. Row fields mirror the User entity (camelCase); `name` is ' +
          'the institutional ID, NOT a person. `password` is optional — an account created ' +
          'without one exists but cannot log in until a super_admin sets it. Scope is ' +
          'validated per row: admin requires subDivision, officer requires thana, ' +
          'super_admin must have neither. Returns a per-row result array in input order.',
        security: bearerAuth,
        body: zodToJson(importUsersBody),
        response: { 200: jsonResponse('Per-row import results', EXAMPLE_USER_IMPORT_RESULT) },
      },
    },
    async (request) => {
      const { users } = importUsersBody.parse(request.body);
      return service.importUsers(users, request.authUser!.sub);
    },
  );

  app.post(
    '/users/:userId/password',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Users'],
        summary: 'Set or reset an account password (super_admin)',
        description:
          'Sets the password, REVOKES every live refresh token for that account (a reset ' +
          'prompted by a suspected compromise must not leave the compromised session alive), ' +
          'and clears any SDR-002 lockout. Audited as `user.password_reset` against the ' +
          'acting super_admin — the password itself is never recorded.',
        security: bearerAuth,
        params: zodToJson(userIdParam),
        body: zodToJson(setPasswordBody),
        response: { 204: emptyResponse('Password set') },
      },
    },
    async (request, reply) => {
      const { userId } = userIdParam.parse(request.params);
      const { password } = setPasswordBody.parse(request.body);
      await service.setPassword(userId, password, request.authUser!.sub);
      return reply.code(204).send();
    },
  );
}
