import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { cadreScopeWhere, type CadreScope } from '../../lib/scope.js';
import { toWireCadreCase, type WireCadreCase } from '../../lib/serialize.js';
import { writeAuditLog } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import type { CreateCaseBody, UpdateCaseBody } from './cadre-cases.schema.js';

export interface CadreCasesDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export interface CadreCasesService {
  // Reports inherit their cadre's scope (ADR-044) — this does the same: a case
  // record is as sensitive as the cadre it is about.
  list(cadreId: number, scope: CadreScope): Promise<WireCadreCase[]>;
  create(cadreId: number, body: CreateCaseBody, actorId: number, scope: CadreScope): Promise<WireCadreCase>;
  update(
    cadreId: number,
    caseId: number,
    body: UpdateCaseBody,
    actorId: number,
    scope: CadreScope,
  ): Promise<WireCadreCase>;
  remove(cadreId: number, caseId: number, actorId: number, scope: CadreScope): Promise<void>;
}

function toDateOrNull(d: string | null | undefined): Date | null | undefined {
  if (d === undefined) return undefined;
  return d === null ? null : new Date(`${d}T00:00:00.000Z`);
}

// snake_case wire body -> Prisma column data. Every field is `?? undefined` so an
// omitted key in a PATCH body leaves the column untouched (Prisma skips `undefined`
// keys); an explicit `null` clears it.
function toData(body: CreateCaseBody | UpdateCaseBody) {
  return {
    crimeNumber: body.crime_number,
    sections: body.sections,
    crimeThana: body.crime_thana,
    crimeDescription: body.crime_description,
    arrestDate: toDateOrNull(body.arrest_date),
    bailGranted: body.bail_granted,
    bailDate: toDateOrNull(body.bail_date),
    inJail: body.in_jail,
    jailName: body.jail_name,
    underInvestigation: body.under_investigation,
    underTrial: body.under_trial,
    challanNumber: body.challan_number,
    courtName: body.court_name,
    caseStatus: body.case_status,
    publicHarmOccurred: body.public_harm_occurred,
    uapaApplied: body.uapa_applied,
  };
}

export function makeCadreCasesService({ prisma, log }: CadreCasesDeps): CadreCasesService {
  // Single chokepoint: confirms the cadre exists, is not soft-deleted, and is in
  // the caller's scope. Out-of-scope reads 404 (not 403) — same reasoning as
  // cadres.service.ts's getById and reports.service.ts's assertCadre — so a cadre
  // id is never enumerable from the response code alone.
  async function assertCadre(cadreId: number, scope: CadreScope): Promise<void> {
    const cadre = await prisma.cadre.findFirst({
      where: { id: cadreId, deletedAt: null, ...cadreScopeWhere(scope) },
      select: { id: true },
    });
    if (cadre === null) throw notFound('Cadre not found');
  }

  async function assertCase(cadreId: number, caseId: number, scope: CadreScope) {
    await assertCadre(cadreId, scope);
    const row = await prisma.cadreCase.findFirst({
      where: { id: caseId, cadreId, deletedAt: null },
    });
    if (row === null) throw notFound('Case not found');
    return row;
  }

  return {
    async list(cadreId, scope) {
      await assertCadre(cadreId, scope);
      const rows = await prisma.cadreCase.findMany({
        where: { cadreId, deletedAt: null },
        orderBy: { id: 'asc' },
      });
      return rows.map(toWireCadreCase);
    },

    async create(cadreId, body, actorId, scope) {
      await assertCadre(cadreId, scope);
      const row = await prisma.$transaction(async (tx) => {
        const created = await tx.cadreCase.create({ data: { cadreId, ...toData(body) } });
        await writeAuditLog(tx, {
          actorId,
          action: 'cadre_case.create',
          entityType: 'cadre_case',
          entityId: String(created.id),
          after: { cadreId, ...body },
        });
        return created;
      });
      log.info({ cadreId, caseId: row.id, actorId }, 'cadre case created');
      return toWireCadreCase(row);
    },

    async update(cadreId, caseId, body, actorId, scope) {
      // Confirms the case exists, belongs to this cadre, and the cadre is in
      // scope — the returned row is discarded; the audit log below records only
      // the JSON-safe wire body, not a full row with Date columns.
      await assertCase(cadreId, caseId, scope);
      const row = await prisma.$transaction(async (tx) => {
        const updated = await tx.cadreCase.update({ where: { id: caseId }, data: toData(body) });
        await writeAuditLog(tx, {
          actorId,
          action: 'cadre_case.update',
          entityType: 'cadre_case',
          entityId: String(caseId),
          after: body,
        });
        return updated;
      });
      log.info({ cadreId, caseId, actorId }, 'cadre case updated');
      return toWireCadreCase(row);
    },

    async remove(cadreId, caseId, actorId, scope) {
      await assertCase(cadreId, caseId, scope);
      await prisma.$transaction(async (tx) => {
        await tx.cadreCase.update({ where: { id: caseId }, data: { deletedAt: new Date() } });
        await writeAuditLog(tx, {
          actorId,
          action: 'cadre_case.delete',
          entityType: 'cadre_case',
          entityId: String(caseId),
        });
      });
      log.info({ cadreId, caseId, actorId }, 'cadre case deleted');
    },
  };
}
