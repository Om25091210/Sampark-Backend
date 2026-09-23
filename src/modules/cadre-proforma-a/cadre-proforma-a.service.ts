import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import { cadreScopeWhere, type CadreScope } from '../../lib/scope.js';
import { Prisma, type PrismaClient, type Role, type ProformaChangeRequest } from '@prisma/client';
import { writeAuditLog } from '../../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { tallyBulkApprove, type BulkApproveOutcome, type BulkApproveResult } from '../../lib/bulk-approve.js';
import type { StorageProvider } from '../../lib/storage.js';
import { EXT_BY_TYPE, isAllowedImageType } from '../../lib/images.js';
import {
  canApproveNext,
  canSubmit,
  requiredApprovalsFor,
} from '../cadre-changes/cadre-changes.policy.js';
import {
  proformaAFieldsSchema,
  type ProformaAFields,
  type ProformaAFieldsPartial,
  type SubmitProformaACreateBody,
  type SubmitProformaAEditBody,
  type ResolvedListProformaChangesQuery,
} from './cadre-proforma-a.schema.js';

export interface CadreProformaADeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
  storage: StorageProvider;
  mediaUrlTtlSeconds: number;
}

export interface Actor {
  id: number;
  role: Role;
  scope: CadreScope;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// PROFORMA_A_FIELDS is every key `proformaAFieldsSchema` knows about — the create/
// edit surface, and the set a diff is computed over. Derived from the schema
// itself (not hand-duplicated) so the two can never drift.
const PROFORMA_A_FIELDS = Object.keys(proformaAFieldsSchema.shape) as (keyof ProformaAFields)[];

type JsonValue = unknown;

function sameValue(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

interface ChangeEntry {
  old: JsonValue;
  new: JsonValue;
}

export interface WireProformaChangeRequest {
  id: number;
  cadreId: number;
  proformaType: 'ab' | 'b';
  changeType: 'create' | 'edit';
  targetId?: number;
  draft?: ProformaAFields;
  changes?: Record<string, ChangeEntry>;
  submittedBy: { id: number; name: string; role: Role };
  submittedAt: string;
  note?: string;
  status: ProformaChangeRequest['status'];
  needsAdmin: boolean;
  needsSuperAdmin: boolean;
  adminApprovedBy?: { id: number; name: string };
  adminApprovedAt?: string;
  superAdminApprovedBy?: { id: number; name: string };
  superAdminApprovedAt?: string;
  decidedAt?: string;
  decidedReason?: string;
  awaitingRole?: 'admin' | 'super_admin';
}

const WITH_PEOPLE = {
  submittedBy: { select: { id: true, name: true, role: true } },
  adminApprovedBy: { select: { id: true, name: true } },
  superAdminApprovedBy: { select: { id: true, name: true } },
} as const;

type Row = ProformaChangeRequest & {
  submittedBy: { id: number; name: string; role: Role };
  adminApprovedBy?: { id: number; name: string } | null;
  superAdminApprovedBy?: { id: number; name: string } | null;
};

function awaitingRole(r: ProformaChangeRequest): 'admin' | 'super_admin' | undefined {
  if (r.status !== 'pending') return undefined;
  if (r.needsAdmin && r.adminApprovedAt === null) return 'admin';
  if (r.needsSuperAdmin && r.superAdminApprovedAt === null) return 'super_admin';
  return undefined;
}

function toWire(r: Row): WireProformaChangeRequest {
  return {
    id: r.id,
    cadreId: r.cadreId,
    proformaType: r.proformaType,
    changeType: r.changeType,
    targetId: r.targetId ?? undefined,
    draft: r.draft as unknown as ProformaAFields | undefined,
    changes: r.changes as unknown as Record<string, ChangeEntry> | undefined,
    submittedBy: r.submittedBy,
    submittedAt: r.submittedAt.toISOString(),
    note: r.note ?? undefined,
    status: r.status,
    needsAdmin: r.needsAdmin,
    needsSuperAdmin: r.needsSuperAdmin,
    adminApprovedBy: r.adminApprovedBy ?? undefined,
    adminApprovedAt: r.adminApprovedAt?.toISOString(),
    superAdminApprovedBy: r.superAdminApprovedBy ?? undefined,
    superAdminApprovedAt: r.superAdminApprovedAt?.toISOString(),
    decidedAt: r.decidedAt?.toISOString(),
    decidedReason: r.decidedReason ?? undefined,
    awaitingRole: awaitingRole(r),
  };
}

export interface CadreProformaAService {
  get(cadreId: number, actor: Actor): Promise<ProformaAFields | null>;
  submitCreate(cadreId: number, body: SubmitProformaACreateBody, actor: Actor): Promise<WireProformaChangeRequest>;
  submitEdit(cadreId: number, body: SubmitProformaAEditBody, actor: Actor): Promise<WireProformaChangeRequest>;
  list(query: ResolvedListProformaChangesQuery, actor: Actor): Promise<Paginated<WireProformaChangeRequest>>;
  approve(id: number, actor: Actor): Promise<WireProformaChangeRequest>;
  approveBulk(ids: number[], actor: Actor): Promise<BulkApproveResult>;
  reject(id: number, reason: string, actor: Actor): Promise<WireProformaChangeRequest>;
  cancel(id: number, actor: Actor): Promise<WireProformaChangeRequest>;
  uploadImage(
    cadreId: number,
    slot: 'fingerprint' | 'handwriting',
    file: { buffer: Buffer; contentType: string },
    actor: Actor,
  ): Promise<{ key: string; url: string }>;
}

export function makeCadreProformaAService({ prisma, storage, mediaUrlTtlSeconds }: CadreProformaADeps): CadreProformaAService {
  async function assertCadreInScope(cadreId: number, actor: Actor): Promise<void> {
    const cadre = await prisma.cadre.findFirst({
      where: { id: cadreId, deletedAt: null, ...cadreScopeWhere(actor.scope) },
      select: { id: true },
    });
    if (cadre === null) throw notFound('Cadre not found');
  }

  async function loadOrThrow(id: number): Promise<Row> {
    const req = await prisma.proformaChangeRequest.findUnique({ where: { id }, include: WITH_PEOPLE });
    if (req === null) throw notFound('Proforma change request not found');
    return req as Row;
  }

  async function assertRequestInScope(req: { cadreId: number }, actor: Actor): Promise<void> {
    const cadre = await prisma.cadre.findFirst({
      where: { id: req.cadreId, deletedAt: null, ...cadreScopeWhere(actor.scope) },
      select: { id: true },
    });
    if (cadre === null) throw notFound('Proforma change request not found');
  }

  /** Applies a pending create/edit request's payload to CadreProformaA. Caller supplies the tx. */
  async function applyWithin(
    tx: Prisma.TransactionClient,
    req: ProformaChangeRequest,
    actorId: number,
  ): Promise<ProformaChangeRequest> {
    if (req.changeType === 'create') {
      const draft = req.draft as unknown as ProformaAFields;

      // Re-check uniqueness at apply time too — a second create request for the
      // same cadre could have been approved first while this one waited.
      const already = await tx.cadreProformaA.findUnique({ where: { cadreId: req.cadreId } });
      if (already !== null) {
        const stale = await tx.proformaChangeRequest.update({
          where: { id: req.id },
          data: {
            status: 'stale',
            decidedAt: new Date(),
            decidedById: actorId,
            decidedReason: 'इस कैडर के लिए AB प्रोफार्मा पहले ही बन चुका है',
          },
        });
        await writeAuditLog(tx, {
          actorId,
          action: 'proforma_a.create.stale',
          entityType: 'proforma_change_request',
          entityId: String(req.id),
          after: { cadreId: req.cadreId },
        });
        return stale;
      }

      const created = await tx.cadreProformaA.create({
        data: {
          cadreId: req.cadreId,
          ...(draft as unknown as Record<string, unknown>),
          lastEditedAt: new Date(),
          lastEditedById: req.submittedById,
        } as unknown as Prisma.CadreProformaAUncheckedCreateInput,
      });

      const applied = await tx.proformaChangeRequest.update({
        where: { id: req.id },
        data: { status: 'applied', decidedAt: new Date(), decidedById: actorId, targetId: created.id },
      });

      await writeAuditLog(tx, {
        actorId,
        action: 'proforma_a.created',
        entityType: 'cadre_proforma_a',
        entityId: String(created.id),
        after: { cadreId: req.cadreId },
      });
      return applied;
    }

    // changeType === 'edit'
    const target = await tx.cadreProformaA.findFirst({
      where: { id: req.targetId ?? -1, deletedAt: null },
    });
    if (target === null) throw notFound('Proforma record not found');

    const changes = req.changes as unknown as Record<string, ChangeEntry>;
    const record = target as unknown as Record<string, unknown>;

    const drifted = Object.entries(changes).filter(([field, entry]) => !sameValue(record[field], entry.old));
    if (drifted.length > 0) {
      const stale = await tx.proformaChangeRequest.update({
        where: { id: req.id },
        data: {
          status: 'stale',
          decidedAt: new Date(),
          decidedById: actorId,
          decidedReason: `मान बदल चुका है: ${drifted.map(([f]) => f).join(', ')}`,
        },
      });
      await writeAuditLog(tx, {
        actorId,
        action: 'proforma_a.change.stale',
        entityType: 'proforma_change_request',
        entityId: String(req.id),
        before: { status: req.status },
        after: { status: 'stale', driftedFields: drifted.map(([f]) => f) },
      });
      return stale;
    }

    const data: Record<string, unknown> = {};
    const before: Record<string, JsonValue> = {};
    const after: Record<string, JsonValue> = {};
    for (const [field, entry] of Object.entries(changes)) {
      data[field] = entry.new;
      before[field] = entry.old;
      after[field] = entry.new;
    }
    data.lastEditedAt = new Date();
    data.lastEditedById = req.submittedById;

    await tx.cadreProformaA.update({ where: { id: target.id }, data: data as Prisma.CadreProformaAUpdateInput });

    const applied = await tx.proformaChangeRequest.update({
      where: { id: req.id },
      data: { status: 'applied', decidedAt: new Date(), decidedById: actorId },
    });

    await writeAuditLog(tx, {
      actorId,
      action: 'proforma_a.change.applied',
      entityType: 'cadre_proforma_a',
      entityId: String(target.id),
      before: before as Prisma.InputJsonValue,
      after: after as Prisma.InputJsonValue,
    });
    return applied;
  }

  const service: CadreProformaAService = {
    async get(cadreId, actor) {
      await assertCadreInScope(cadreId, actor);
      const row = await prisma.cadreProformaA.findFirst({ where: { cadreId, deletedAt: null } });
      if (row === null) return null;
      const out: Record<string, unknown> = {};
      for (const field of PROFORMA_A_FIELDS) out[field] = (row as unknown as Record<string, unknown>)[field];
      return out as ProformaAFields;
    },

    async submitCreate(cadreId, body, actor) {
      if (body.idempotency_key !== undefined) {
        const existing = await prisma.proformaChangeRequest.findUnique({
          where: { idempotencyKey: body.idempotency_key },
          include: WITH_PEOPLE,
        });
        if (existing !== null) return toWire(existing as Row);
      }

      if (!canSubmit(actor.role)) throw forbidden('Viewers cannot propose changes');
      await assertCadreInScope(cadreId, actor);

      const already = await prisma.cadreProformaA.findFirst({ where: { cadreId, deletedAt: null } });
      if (already !== null) {
        throw conflict('इस कैडर के लिए AB प्रोफार्मा पहले ही मौजूद है — संपादन के लिए PATCH का उपयोग करें', 'PROFORMA_A_EXISTS');
      }

      const inFlight = await prisma.proformaChangeRequest.findFirst({
        where: { cadreId, proformaType: 'ab', changeType: 'create', status: 'pending' },
      });
      if (inFlight !== null) {
        throw conflict('इस कैडर के लिए AB प्रोफार्मा अनुरोध पहले से लंबित है', 'CHANGE_PENDING');
      }

      const { needsAdmin, needsSuperAdmin } = requiredApprovalsFor(actor.role);

      let created: ProformaChangeRequest;
      try {
        created = await prisma.$transaction(async (tx) => {
          let req = await tx.proformaChangeRequest.create({
            data: {
              cadreId,
              proformaType: 'ab',
              changeType: 'create',
              draft: body.fields as unknown as Prisma.InputJsonValue,
              submittedById: actor.id,
              note: body.note ?? null,
              needsAdmin,
              needsSuperAdmin,
              idempotencyKey: body.idempotency_key ?? null,
            },
          });

          await writeAuditLog(tx, {
            actorId: actor.id,
            action: 'proforma_a.create.submitted',
            entityType: 'proforma_change_request',
            entityId: String(req.id),
            after: { cadreId, needsAdmin, needsSuperAdmin },
          });

          if (!needsAdmin && !needsSuperAdmin) req = await applyWithin(tx, req, actor.id);
          return req;
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          body.idempotency_key !== undefined
        ) {
          const winner = await prisma.proformaChangeRequest.findUnique({
            where: { idempotencyKey: body.idempotency_key },
            include: WITH_PEOPLE,
          });
          if (winner !== null) return toWire(winner as Row);
        }
        throw err;
      }

      return toWire(await loadOrThrow(created.id));
    },

    async submitEdit(cadreId, body, actor) {
      if (body.idempotency_key !== undefined) {
        const existing = await prisma.proformaChangeRequest.findUnique({
          where: { idempotencyKey: body.idempotency_key },
          include: WITH_PEOPLE,
        });
        if (existing !== null) return toWire(existing as Row);
      }

      if (!canSubmit(actor.role)) throw forbidden('Viewers cannot propose changes');
      await assertCadreInScope(cadreId, actor);

      const target = await prisma.cadreProformaA.findFirst({ where: { cadreId, deletedAt: null } });
      if (target === null) throw notFound('इस कैडर के लिए अभी तक कोई AB प्रोफार्मा नहीं बना है');

      const record = target as unknown as Record<string, unknown>;
      const proposed = body.changes as ProformaAFieldsPartial as Record<string, unknown>;

      const changes: Record<string, ChangeEntry> = {};
      for (const [field, value] of Object.entries(proposed)) {
        if (!sameValue(record[field], value)) changes[field] = { old: record[field] ?? null, new: value ?? null };
      }
      if (Object.keys(changes).length === 0) {
        throw badRequest('No change proposed — every value matches the record already', 'NO_CHANGE');
      }

      const inFlight = await prisma.proformaChangeRequest.findMany({
        where: { cadreId, proformaType: 'ab', changeType: 'edit', status: 'pending' },
        include: { submittedBy: { select: { id: true, name: true } } },
      });
      const clashes: string[] = [];
      for (const field of Object.keys(changes)) {
        const holder = inFlight.find((r) => Object.keys(r.changes as Record<string, unknown>).includes(field));
        if (holder !== undefined) clashes.push(`${field} (${holder.submittedBy.name}, अनुरोध #${holder.id})`);
      }
      if (clashes.length > 0) {
        throw conflict(`इन फ़ील्ड पर पहले से एक अनुरोध लंबित है: ${clashes.join(', ')}`, 'CHANGE_PENDING');
      }

      const { needsAdmin, needsSuperAdmin } = requiredApprovalsFor(actor.role);

      let created: ProformaChangeRequest;
      try {
        created = await prisma.$transaction(async (tx) => {
          let req = await tx.proformaChangeRequest.create({
            data: {
              cadreId,
              proformaType: 'ab',
              changeType: 'edit',
              targetId: target.id,
              changes: changes as unknown as Prisma.InputJsonValue,
              submittedById: actor.id,
              note: body.note ?? null,
              needsAdmin,
              needsSuperAdmin,
              idempotencyKey: body.idempotency_key ?? null,
            },
          });

          await writeAuditLog(tx, {
            actorId: actor.id,
            action: 'proforma_a.change.submitted',
            entityType: 'proforma_change_request',
            entityId: String(req.id),
            after: { cadreId, fields: Object.keys(changes), needsAdmin, needsSuperAdmin },
          });

          if (!needsAdmin && !needsSuperAdmin) req = await applyWithin(tx, req, actor.id);
          return req;
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          body.idempotency_key !== undefined
        ) {
          const winner = await prisma.proformaChangeRequest.findUnique({
            where: { idempotencyKey: body.idempotency_key },
            include: WITH_PEOPLE,
          });
          if (winner !== null) return toWire(winner as Row);
        }
        throw err;
      }

      return toWire(await loadOrThrow(created.id));
    },

    async list(query, actor) {
      const where: Prisma.ProformaChangeRequestWhereInput = { proformaType: 'ab' };
      if (actor.scope.kind !== 'all') where.cadre = { thana: { in: [...actor.scope.thanas] } };
      if (query.status !== undefined) where.status = query.status;
      if (query.submittedBy !== undefined) where.submittedById = query.submittedBy;
      if (query.cadreId !== undefined) where.cadreId = query.cadreId;

      if (query.awaitingMe === true) {
        where.status = 'pending';
        if (actor.role === 'admin') {
          where.needsAdmin = true;
          where.adminApprovedAt = null;
        } else if (actor.role === 'super_admin') {
          where.needsSuperAdmin = true;
          where.superAdminApprovedAt = null;
          where.OR = [{ needsAdmin: false }, { NOT: { adminApprovedAt: null } }];
        } else {
          where.id = -1;
        }
      }

      const [total, rows] = await prisma.$transaction([
        prisma.proformaChangeRequest.count({ where }),
        prisma.proformaChangeRequest.findMany({
          where,
          include: WITH_PEOPLE,
          orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      return {
        data: (rows as Row[]).map(toWire),
        total,
        page: query.page,
        pageSize: query.pageSize,
        hasMore: query.page * query.pageSize < total,
      };
    },

    async approve(id, actor) {
      const req = await loadOrThrow(id);
      if (req.status !== 'pending') throw badRequest(`Change request is already ${req.status}`, 'NOT_PENDING');
      if (req.submittedById === actor.id) throw forbidden('You cannot approve a change you submitted');
      await assertRequestInScope(req, actor);
      if (!canApproveNext(actor.role, req)) throw forbidden('This change is not awaiting your approval');

      const now = new Date();
      const adminStepOutstanding = req.needsAdmin && req.adminApprovedAt === null;

      const updated = await prisma.$transaction(async (tx) => {
        const data: Prisma.ProformaChangeRequestUpdateInput = adminStepOutstanding
          ? { adminApprovedBy: { connect: { id: actor.id } }, adminApprovedAt: now }
          : { superAdminApprovedBy: { connect: { id: actor.id } }, superAdminApprovedAt: now };

        let next = await tx.proformaChangeRequest.update({ where: { id }, data });

        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'proforma_a.change.approved',
          entityType: 'proforma_change_request',
          entityId: String(id),
          before: { adminApprovedAt: req.adminApprovedAt, superAdminApprovedAt: req.superAdminApprovedAt },
          after: { rung: adminStepOutstanding ? 'admin' : 'super_admin', by: actor.id },
        });

        const stillWaiting =
          (next.needsAdmin && next.adminApprovedAt === null) ||
          (next.needsSuperAdmin && next.superAdminApprovedAt === null);
        if (!stillWaiting) next = await applyWithin(tx, next, actor.id);

        return next;
      });

      return toWire(await loadOrThrow(updated.id));
    },

    async approveBulk(ids, actor) {
      const unique = [...new Set(ids)];
      const results: BulkApproveOutcome[] = [];
      for (const id of unique) {
        try {
          const wire = await service.approve(id, actor);
          results.push({
            id,
            status: wire.status === 'applied' ? 'applied' : wire.status === 'stale' ? 'stale' : 'approved',
          });
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          results.push({ id, status: 'error', code: err.code });
        }
      }
      return tallyBulkApprove(results);
    },

    async reject(id, reason, actor) {
      const req = await loadOrThrow(id);
      await assertRequestInScope(req, actor);
      if (req.status !== 'pending') throw badRequest(`Change request is already ${req.status}`, 'NOT_PENDING');
      if (!canApproveNext(actor.role, req)) throw forbidden('This change is not awaiting your decision');

      await prisma.$transaction(async (tx) => {
        await tx.proformaChangeRequest.update({
          where: { id },
          data: { status: 'rejected', decidedAt: new Date(), decidedById: actor.id, decidedReason: reason },
        });
        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'proforma_a.change.rejected',
          entityType: 'proforma_change_request',
          entityId: String(id),
          before: { status: 'pending' },
          after: { status: 'rejected', reason },
        });
      });

      return toWire(await loadOrThrow(id));
    },

    async cancel(id, actor) {
      const req = await loadOrThrow(id);
      await assertRequestInScope(req, actor);
      if (req.submittedById !== actor.id) throw forbidden('Only the submitter can withdraw a change');
      if (req.status !== 'pending') throw badRequest(`Change request is already ${req.status}`, 'NOT_PENDING');

      await prisma.$transaction(async (tx) => {
        await tx.proformaChangeRequest.update({
          where: { id },
          data: { status: 'cancelled', decidedAt: new Date(), decidedById: actor.id },
        });
        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'proforma_a.change.cancelled',
          entityType: 'proforma_change_request',
          entityId: String(id),
          before: { status: 'pending' },
          after: { status: 'cancelled' },
        });
      });

      return toWire(await loadOrThrow(id));
    },

    async uploadImage(cadreId, slot, file, actor) {
      await assertCadreInScope(cadreId, actor);
      if (!isAllowedImageType(file.contentType)) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only image/jpeg and image/png are accepted');
      }
      const ext = EXT_BY_TYPE[file.contentType] ?? 'bin';
      const key = `cadres/cadre-${cadreId}/proforma-a-${slot}-${randomUUID()}.${ext}`;
      await storage.put(key, file.buffer, file.contentType);
      const url = await storage.presignGet(key, mediaUrlTtlSeconds);
      return { key, url };
    },
  };

  return service;
}
