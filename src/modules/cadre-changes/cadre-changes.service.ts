import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type PrismaClient, type Role, type CadreChangeRequest } from '@prisma/client';
import { writeAuditLog } from '../../lib/audit.js';
import { writeOutboxEvent } from '../../lib/outbox.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import {
  canApproveNext,
  canSubmit,
  canWriteDirect,
  requiredApprovalsFor,
} from './cadre-changes.policy.js';
import type {
  ChangeableFields,
  PatchCadreBody,
  ResolvedListChangesQuery,
  SubmitChangeBody,
} from './cadre-changes.schema.js';

export interface CadreChangesDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export interface Actor {
  id: number;
  role: Role;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ─── Value normalisation ──────────────────────────────────────────────────────
//
// `changes` is JSON, but the cadre columns are Dates, arrays and scalars. Both the
// drift check and the apply step have to move between the two, and getting this
// wrong is silent: a Date compared against its own ISO string is "different", so
// every dated change would go stale for no reason.

type JsonValue = string | number | boolean | null | JsonValue[];

/** A cadre column value → its JSON-comparable form. */
function toJson(v: unknown): JsonValue {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map((x) => toJson(x)) as JsonValue[];
  return v as JsonValue;
}

/** A proposed JSON value → the form Prisma writes for that column. */
function toColumn(field: string, v: JsonValue): unknown {
  if (v === null) return null;
  if (DATE_FIELDS.has(field) && typeof v === 'string') return new Date(v);
  return v;
}

const DATE_FIELDS = new Set(['surrenderDate']);

function sameValue(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Wire shape ───────────────────────────────────────────────────────────────

export interface WireChangeEntry {
  old: JsonValue;
  new: JsonValue;
}

export interface WireChangeRequest {
  id: number;
  cadreId: number;
  cadre?: { id: number; name: string; serialNumber?: string };
  changes: Record<string, WireChangeEntry>;
  // Every approver sees who proposed it — the maintainer's explicit requirement.
  submittedBy: { id: number; name: string; role: Role };
  submittedAt: string;
  note?: string;
  status: CadreChangeRequest['status'];
  needsAdmin: boolean;
  needsSuperAdmin: boolean;
  adminApprovedBy?: { id: number; name: string };
  adminApprovedAt?: string;
  superAdminApprovedBy?: { id: number; name: string };
  superAdminApprovedAt?: string;
  decidedAt?: string;
  decidedReason?: string;
  /** Which rung it is waiting on. Absent once the request is terminal. */
  awaitingRole?: 'admin' | 'super_admin';
}

type Row = CadreChangeRequest & {
  cadre?: { id: number; name: string; serialNumber: string | null } | null;
  submittedBy: { id: number; name: string; role: Role };
  adminApprovedBy?: { id: number; name: string } | null;
  superAdminApprovedBy?: { id: number; name: string } | null;
};

function awaitingRole(r: CadreChangeRequest): 'admin' | 'super_admin' | undefined {
  if (r.status !== 'pending') return undefined;
  if (r.needsAdmin && r.adminApprovedAt === null) return 'admin';
  if (r.needsSuperAdmin && r.superAdminApprovedAt === null) return 'super_admin';
  return undefined;
}

function toWire(r: Row): WireChangeRequest {
  return {
    id: r.id,
    cadreId: r.cadreId,
    cadre: r.cadre
      ? { id: r.cadre.id, name: r.cadre.name, serialNumber: r.cadre.serialNumber ?? undefined }
      : undefined,
    changes: r.changes as unknown as Record<string, WireChangeEntry>,
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

const WITH_PEOPLE = {
  cadre: { select: { id: true, name: true, serialNumber: true } },
  submittedBy: { select: { id: true, name: true, role: true } },
  adminApprovedBy: { select: { id: true, name: true } },
  superAdminApprovedBy: { select: { id: true, name: true } },
} as const;

export interface CadreChangesService {
  submit(cadreId: number, body: SubmitChangeBody, actor: Actor): Promise<WireChangeRequest>;
  list(query: ResolvedListChangesQuery, actor: Actor): Promise<Paginated<WireChangeRequest>>;
  approve(id: number, actor: Actor): Promise<WireChangeRequest>;
  reject(id: number, reason: string, actor: Actor): Promise<WireChangeRequest>;
  cancel(id: number, actor: Actor): Promise<WireChangeRequest>;
  patchDirect(cadreId: number, body: PatchCadreBody, actor: Actor): Promise<void>;
}

export function makeCadreChangesService({ prisma }: CadreChangesDeps): CadreChangesService {
  /** Applies a request's values to the cadre, or marks it stale. Caller supplies the tx. */
  async function applyWithin(
    tx: Prisma.TransactionClient,
    req: CadreChangeRequest,
    actorId: number,
  ): Promise<CadreChangeRequest> {
    const cadre = await tx.cadre.findFirst({ where: { id: req.cadreId, deletedAt: null } });
    if (cadre === null) throw notFound('Cadre not found');

    const changes = req.changes as unknown as Record<string, WireChangeEntry>;
    const record = cadre as unknown as Record<string, unknown>;

    // Drift check. The value may have moved since submission — by another request,
    // a direct write, or the import. Applying anyway would silently discard whoever
    // wrote last, and the approver would never know they had done it.
    const drifted = Object.entries(changes).filter(
      ([field, entry]) => !sameValue(toJson(record[field]), entry.old),
    );

    if (drifted.length > 0) {
      const stale = await tx.cadreChangeRequest.update({
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
        action: 'cadre.change.stale',
        entityType: 'cadre_change_request',
        entityId: String(req.id),
        before: { status: req.status },
        after: { status: 'stale', driftedFields: drifted.map(([f]) => f) },
      });
      return stale;
    }

    const data: Record<string, unknown> = {};
    for (const [field, entry] of Object.entries(changes)) data[field] = toColumn(field, entry.new);

    const before: Record<string, JsonValue> = {};
    const after: Record<string, JsonValue> = {};
    for (const [field, entry] of Object.entries(changes)) {
      before[field] = entry.old;
      after[field] = entry.new;
    }

    await tx.cadre.update({ where: { id: req.cadreId }, data: data as Prisma.CadreUpdateInput });

    const applied = await tx.cadreChangeRequest.update({
      where: { id: req.id },
      data: { status: 'applied', decidedAt: new Date(), decidedById: actorId },
    });

    await writeAuditLog(tx, {
      actorId,
      action: 'cadre.change.applied',
      entityType: 'cadre',
      entityId: String(req.cadreId),
      before,
      after,
    });
    await writeOutboxEvent(tx, {
      aggregateType: 'cadre',
      aggregateId: String(req.cadreId),
      eventType: 'cadre.changed',
      payload: { cadreId: req.cadreId, changeRequestId: req.id, fields: Object.keys(changes), actorId },
    });

    return applied;
  }

  async function loadOrThrow(id: number): Promise<Row> {
    const req = await prisma.cadreChangeRequest.findUnique({ where: { id }, include: WITH_PEOPLE });
    if (req === null) throw notFound('Change request not found');
    return req as Row;
  }

  return {
    async submit(cadreId, body, actor) {
      if (!canSubmit(actor.role)) throw forbidden('Viewers cannot propose changes');

      const cadre = await prisma.cadre.findFirst({ where: { id: cadreId, deletedAt: null } });
      if (cadre === null) throw notFound('Cadre not found');

      const record = cadre as unknown as Record<string, unknown>;
      const proposed = body.changes as ChangeableFields as Record<string, unknown>;

      // Snapshot the current value of each field alongside the proposed one. The
      // old value is what the approver is shown and what the drift check compares
      // against later — it is evidence, not decoration.
      const changes: Record<string, WireChangeEntry> = {};
      for (const [field, value] of Object.entries(proposed)) {
        const current = toJson(record[field]);
        const next = toJson(value);
        // Drop no-ops rather than making someone approve "X -> X".
        if (sameValue(current, next)) continue;
        changes[field] = { old: current, new: next };
      }

      if (Object.keys(changes).length === 0) {
        throw badRequest('No change proposed — every value matches the cadre already', 'NO_CHANGE');
      }

      const { needsAdmin, needsSuperAdmin } = requiredApprovalsFor(actor.role);

      const created = await prisma.$transaction(async (tx) => {
        let req = await tx.cadreChangeRequest.create({
          data: {
            cadreId,
            changes: changes as unknown as Prisma.InputJsonValue,
            submittedById: actor.id,
            note: body.note ?? null,
            needsAdmin,
            needsSuperAdmin,
          },
        });

        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'cadre.change.submitted',
          entityType: 'cadre_change_request',
          entityId: String(req.id),
          // No `before`: the request did not exist until now.
          after: { cadreId, fields: Object.keys(changes), needsAdmin, needsSuperAdmin },
        });

        // super_admin sits at the top of the ladder, so their change needs nobody:
        // it applies in this same transaction. The request row is still written —
        // an unapproved-but-applied edit still belongs in the trail, and skipping
        // the row would make super_admin edits invisible to history.
        if (!needsAdmin && !needsSuperAdmin) req = await applyWithin(tx, req, actor.id);

        return req;
      });

      return toWire(await loadOrThrow(created.id));
    },

    async list(query, actor) {
      const where: Prisma.CadreChangeRequestWhereInput = {};
      if (query.status !== undefined) where.status = query.status;
      if (query.submittedBy !== undefined) where.submittedById = query.submittedBy;
      if (query.cadreId !== undefined) where.cadreId = query.cadreId;

      // The approver queue: only requests whose OUTSTANDING rung this caller can
      // sign. Expressed as a filter, not an access boundary — every authenticated
      // user may read the list; only the right role may act on it.
      if (query.awaitingMe === true) {
        where.status = 'pending';
        if (actor.role === 'admin') {
          where.needsAdmin = true;
          where.adminApprovedAt = null;
        } else if (actor.role === 'super_admin') {
          where.OR = [
            { needsAdmin: true, adminApprovedAt: null },
            { needsSuperAdmin: true, superAdminApprovedAt: null },
          ];
        } else {
          // Officers and viewers approve nothing; an empty queue is the honest
          // answer rather than a 403 on a list they are allowed to read.
          where.id = -1;
        }
      }

      const [total, rows] = await prisma.$transaction([
        prisma.cadreChangeRequest.count({ where }),
        prisma.cadreChangeRequest.findMany({
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
      if (req.status !== 'pending') {
        throw badRequest(`Change request is already ${req.status}`, 'NOT_PENDING');
      }
      // You cannot approve your own proposal, even outranking the rung it waits on.
      // Self-approval would turn the chain into a formality for exactly the people
      // it exists to check.
      if (req.submittedById === actor.id) {
        throw forbidden('You cannot approve a change you submitted');
      }
      if (!canApproveNext(actor.role, req)) {
        throw forbidden('This change is not awaiting your approval');
      }

      const now = new Date();
      const adminStepOutstanding = req.needsAdmin && req.adminApprovedAt === null;

      const updated = await prisma.$transaction(async (tx) => {
        const data: Prisma.CadreChangeRequestUpdateInput = adminStepOutstanding
          ? { adminApprovedBy: { connect: { id: actor.id } }, adminApprovedAt: now }
          : { superAdminApprovedBy: { connect: { id: actor.id } }, superAdminApprovedAt: now };

        let next = await tx.cadreChangeRequest.update({ where: { id }, data });

        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'cadre.change.approved',
          entityType: 'cadre_change_request',
          entityId: String(id),
          before: { adminApprovedAt: req.adminApprovedAt, superAdminApprovedAt: req.superAdminApprovedAt },
          after: { rung: adminStepOutstanding ? 'admin' : 'super_admin', by: actor.id },
        });

        // Fully signed → apply now, in this transaction. There is deliberately no
        // resting "approved" state: a request that says approved while the cadre
        // still holds the old value is the lie this whole workflow exists to avoid.
        const stillWaiting =
          (next.needsAdmin && next.adminApprovedAt === null) ||
          (next.needsSuperAdmin && next.superAdminApprovedAt === null);
        if (!stillWaiting) next = await applyWithin(tx, next, actor.id);

        return next;
      });

      return toWire(await loadOrThrow(updated.id));
    },

    async reject(id, reason, actor) {
      const req = await loadOrThrow(id);
      if (req.status !== 'pending') {
        throw badRequest(`Change request is already ${req.status}`, 'NOT_PENDING');
      }
      if (!canApproveNext(actor.role, req)) {
        throw forbidden('This change is not awaiting your decision');
      }

      await prisma.$transaction(async (tx) => {
        // Any rung can reject, and rejection is terminal — the request does not
        // continue up the chain. Existing approvals are left ON the row rather than
        // cleared: the trail should still show who backed it before it was refused.
        await tx.cadreChangeRequest.update({
          where: { id },
          data: { status: 'rejected', decidedAt: new Date(), decidedById: actor.id, decidedReason: reason },
        });
        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'cadre.change.rejected',
          entityType: 'cadre_change_request',
          entityId: String(id),
          before: { status: 'pending' },
          after: { status: 'rejected', reason },
        });
      });

      return toWire(await loadOrThrow(id));
    },

    async cancel(id, actor) {
      const req = await loadOrThrow(id);
      if (req.submittedById !== actor.id) {
        throw forbidden('Only the submitter can withdraw a change');
      }
      if (req.status !== 'pending') {
        throw badRequest(`Change request is already ${req.status}`, 'NOT_PENDING');
      }

      await prisma.$transaction(async (tx) => {
        await tx.cadreChangeRequest.update({
          where: { id },
          data: { status: 'cancelled', decidedAt: new Date(), decidedById: actor.id },
        });
        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'cadre.change.cancelled',
          entityType: 'cadre_change_request',
          entityId: String(id),
          before: { status: 'pending' },
          after: { status: 'cancelled' },
        });
      });

      return toWire(await loadOrThrow(id));
    },

    async patchDirect(cadreId, body, actor) {
      if (!canWriteDirect(actor.role)) throw forbidden('Viewers cannot edit cadres');

      const cadre = await prisma.cadre.findFirst({ where: { id: cadreId, deletedAt: null } });
      if (cadre === null) throw notFound('Cadre not found');

      const before = { alertTag: cadre.alertTag, aliases: cadre.aliases };

      await prisma.$transaction(async (tx) => {
        await tx.cadre.update({ where: { id: cadreId }, data: body });
        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'cadre.updated',
          entityType: 'cadre',
          entityId: String(cadreId),
          before,
          after: body,
        });
        await writeOutboxEvent(tx, {
          aggregateType: 'cadre',
          aggregateId: String(cadreId),
          eventType: 'cadre.updated',
          payload: { cadreId, fields: Object.keys(body), actorId: actor.id },
        });
      });
    },
  };
}
