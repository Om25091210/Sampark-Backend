import type { FastifyInstance } from 'fastify';
import { makeUsersService } from './users.service.js';
import {
  importUsersBody,
  setPasswordBody,
  userIdParam,
  listUsersQuery,
  createUserBody,
  updateUserBody,
} from './users.schema.js';
import {
  bearerAuth,
  emptyResponse,
  examplePage,
  jsonResponse,
  zodToJson,
  EXAMPLE_USER,
  EXAMPLE_USER_IMPORT_RESULT,
} from '../../lib/openapi.js';

// Phase B (import/password/deactivate) + Phase 2 (web User Management CRUD). Every
// route here is super_admin JWT only — deliberately not the SDR-007 machine key the
// cadre import uses: minting/editing/deactivating accounts are individually
// accountable acts, and with real names gone (ADR-042) the acting super_admin's ID is
// the only granularity the audit trail has left.
export async function usersRoutes(app: FastifyInstance): Promise<void> {
  const service = makeUsersService({ prisma: app.prisma, log: app.log });

  app.get(
    '/users',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Users'],
        summary: 'List accounts, paginated + filterable (super_admin, ADR-056)',
        description:
          'Filters: role, thana, subDivision, status (active | deactivated | all — ' +
          'defaults to active), search (matches the institutional-ID `name`).',
        security: bearerAuth,
        querystring: zodToJson(listUsersQuery),
        response: { 200: jsonResponse('Paginated accounts', examplePage(EXAMPLE_USER)) },
      },
    },
    async (request) => {
      const query = listUsersQuery.parse(request.query);
      return service.list(query);
    },
  );

  app.get(
    '/users/:userId',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Users'],
        summary: 'Get one account (super_admin)',
        description:
          'Not scoped to active accounts — a deactivated account can still be opened; ' +
          '`status` on the response says which.',
        security: bearerAuth,
        params: zodToJson(userIdParam),
        response: { 200: jsonResponse('The account', EXAMPLE_USER) },
      },
    },
    async (request) => {
      const { userId } = userIdParam.parse(request.params);
      return service.getById(userId);
    },
  );

  app.post(
    '/users',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Users'],
        summary: 'Create one account (super_admin)',
        description:
          'Same row shape and validation as POST /users/import (name/email/role/password/' +
          'thana/subDivision/designation) — the body IS one row, not the {users:[...]} ' +
          'envelope. Unlike /users/import, a duplicate `name` is a 409, never a silent ' +
          'skip: this route is for provisioning one account deliberately, not re-running ' +
          'a sheet. Emits a `user.created` outbox event (ADR-057) for Phase 3\'s Sheet sync.',
        security: bearerAuth,
        body: zodToJson(createUserBody),
        response: { 201: jsonResponse('Created account', EXAMPLE_USER) },
      },
    },
    async (request, reply) => {
      const row = createUserBody.parse(request.body);
      const user = await service.create(row, request.authUser!.sub);
      return reply.code(201).send(user);
    },
  );

  app.patch(
    '/users/:userId',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Users'],
        summary: 'Edit role/thana/subDivision/designation (super_admin)',
        description:
          'Never name, email, or password — password reset is the separate, explicit ' +
          'POST /users/:userId/password. thana/subDivision are three-way per field: ' +
          'omit to leave untouched, send `null` to clear (needed when a role change ' +
          'requires swapping which scope field is set), or send a string to set it. ' +
          'Validates the MERGED post-edit state against the ADR-042 org-scope invariant, ' +
          'not just the submitted fields. Emits a `user.updated` outbox event (ADR-057).',
        security: bearerAuth,
        params: zodToJson(userIdParam),
        body: zodToJson(updateUserBody),
        response: { 200: jsonResponse('Updated account', EXAMPLE_USER) },
      },
    },
    async (request) => {
      const { userId } = userIdParam.parse(request.params);
      const body = updateUserBody.parse(request.body);
      return service.update(userId, body, request.authUser!.sub);
    },
  );

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

  app.delete(
    '/users/:userId',
    {
      preHandler: [app.authenticate, app.requireRole('super_admin')],
      schema: {
        tags: ['Users'],
        summary: 'Deactivate an account (super_admin)',
        description:
          'SOFT delete — sets `deletedAt` and revokes every live refresh token, so the ' +
          'account stops working immediately rather than lasting until its tokens expire. ' +
          'Never a hard delete: the id is referenced by reports, change requests and audit ' +
          'rows, and "who filed this" must survive the account being retired. A deactivated ' +
          'user disappears from GET /officers and from the scope model. Refuses ' +
          'self-deactivation — super_admin is the only role that can restore accounts.',
        security: bearerAuth,
        params: zodToJson(userIdParam),
        response: { 204: emptyResponse('Deactivated') },
      },
    },
    async (request, reply) => {
      const { userId } = userIdParam.parse(request.params);
      await service.deactivate(userId, request.authUser!.sub);
      return reply.code(204).send();
    },
  );
}
