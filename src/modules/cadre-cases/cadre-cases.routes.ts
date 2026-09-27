import type { FastifyInstance } from 'fastify';
import { makeCadreCasesService } from './cadre-cases.service.js';
import { caseCadreParam, caseDetailParams, createCaseBody, updateCaseBody } from './cadre-cases.schema.js';
import { bearerAuth, emptyResponse, jsonArrayResponse, jsonResponse, zodToJson } from '../../lib/openapi.js';

// जेल/जमानत master profile — one cadre (category='jail') may carry several
// criminal cases (this task). DIRECT writes, no approval ladder: see the Prisma
// schema comment on CadreCase for why. List is open to any authenticated user
// (same posture as the per-cadre report log); create/update are officer+; delete
// is admin+ (destructive actions get the stricter tier, mirroring cadre delete).
export async function cadreCasesRoutes(app: FastifyInstance): Promise<void> {
  const service = makeCadreCasesService({ prisma: app.prisma, log: app.log });

  app.get(
    '/cadres/:cadreId/cases',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['Cadre Cases'],
        summary: 'List a जेल/जमानत profile’s criminal cases',
        security: bearerAuth,
        params: zodToJson(caseCadreParam),
        response: { 200: jsonArrayResponse('Cases, oldest first', [{ id: 1, cadreId: 12, crimeNumber: '02/2010' }]) },
      },
    },
    async (request) => {
      const { cadreId } = caseCadreParam.parse(request.params);
      return service.list(cadreId, request.scope!);
    },
  );

  app.post(
    '/cadres/:cadreId/cases',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Cadre Cases'],
        summary: 'Add a criminal case to a जेल/जमानत profile (officer+, direct write)',
        security: bearerAuth,
        params: zodToJson(caseCadreParam),
        body: zodToJson(createCaseBody),
        response: { 201: jsonResponse('Case created', { id: 1, cadreId: 12 }) },
      },
    },
    async (request, reply) => {
      const { cadreId } = caseCadreParam.parse(request.params);
      const body = createCaseBody.parse(request.body);
      const created = await service.create(cadreId, body, request.authUser!.sub, request.scope!);
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/cadres/:cadreId/cases/:caseId',
    {
      preHandler: [app.authenticate, app.requireRole('officer', 'admin', 'super_admin')],
      schema: {
        tags: ['Cadre Cases'],
        summary: 'Edit a criminal case (officer+, direct write)',
        security: bearerAuth,
        params: zodToJson(caseDetailParams),
        body: zodToJson(updateCaseBody),
        response: { 200: jsonResponse('Case updated', { id: 1, cadreId: 12 }) },
      },
    },
    async (request) => {
      const { cadreId, caseId } = caseDetailParams.parse(request.params);
      const body = updateCaseBody.parse(request.body);
      return service.update(cadreId, caseId, body, request.authUser!.sub, request.scope!);
    },
  );

  app.delete(
    '/cadres/:cadreId/cases/:caseId',
    {
      preHandler: [app.authenticate, app.requireRole('admin', 'super_admin')],
      schema: {
        tags: ['Cadre Cases'],
        summary: 'Delete a criminal case (admin+, soft-delete)',
        security: bearerAuth,
        params: zodToJson(caseDetailParams),
        response: { 204: emptyResponse('Deleted') },
      },
    },
    async (request, reply) => {
      const { cadreId, caseId } = caseDetailParams.parse(request.params);
      await service.remove(cadreId, caseId, request.authUser!.sub, request.scope!);
      return reply.code(204).send();
    },
  );
}
