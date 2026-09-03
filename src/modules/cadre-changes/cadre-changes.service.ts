import type { FastifyBaseLogger } from 'fastify';
import { cadreScopeWhere, type CadreScope } from '../../lib/scope.js';
import { Prisma, type PrismaClient, type Role, type CadreChangeRequest, type AlertLevel } from '@prisma/client';
import { tagToLevel } from '../../lib/alert-tags.js';
import { writeAuditLog } from '../../lib/audit.js';
import { writeOutboxEvent } from '../../lib/outbox.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import type { StorageProvider } from '../../lib/storage.js';
import type { PushProvider } from '../../lib/push.js';
import { writeNotification } from '../../lib/notifications.js';
import { cadreChangeApprovedCopy, cadreChangeRejectedCopy } from '../../lib/notification-copy.js';
import {
  fireImmediateDispatch,
  type NotificationDispatchDeps,
  type NotificationDispatchPayload,
} from '../../lib/notification-dispatch.js';
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
  // ADR-029. Signs proposed/current `avatarKey`s into preview URLs so an approver
  // can actually LOOK at a photo before approving it.
  storage: StorageProvider;
  mediaUrlTtlSeconds: number;
  // ADR-048. Real push for the notification this module writes on approve/reject.
  pushProvider: PushProvider;
}

export interface Actor {
  id: number;
  role: Role;
  /**
   * ADR-044. Carried on the Actor rather than added as a parameter to all six methods:
   * every one of them already takes an Actor, and a scope that travels WITH the identity
   * cannot be forgotten at one call site the way a seventh argument can.
   */
  scope: CadreScope;
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

// ADR-036: dateOfBirth joins surrenderDate here — both arrive as ISO strings in the
// change JSON and must become Date objects before Prisma writes the column.
// This task: deceasedDate is the same shape.
const DATE_FIELDS = new Set(['surrenderDate', 'dateOfBirth', 'deceasedDate']);

function sameValue(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Wire shape ───────────────────────────────────────────────────────────────

export interface WireChangeEntry {
  old: JsonValue;
  new: JsonValue;
  /**
   * ADR-029. For `avatarKey` only: signed preview URLs for the two keys. An
   * approver shown `cadres/cadre-2/avatar-9f1c….jpg` is being asked to approve a
   * photo they cannot see, which is not a decision — it is a rubber stamp.
   */
  oldUrl?: string;
  newUrl?: string;
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

type SignFn = (key: string) => Promise<string>;

// ADR-054. All three independent photo slots get signed previews the same way —
// still "only a photo needs looking at", just three fields instead of one now.
const AVATAR_FIELDS = ['avatarKey', 'avatarKey2', 'avatarKey3'] as const;

/**
 * ADR-029 / ADR-054. Attaches signed previews to whichever avatar-slot entries a
 * request actually carries. Everything else is passed through untouched.
 */
async function withPreviews(
  changes: Record<string, WireChangeEntry>,
  sign: SignFn,
): Promise<Record<string, WireChangeEntry>> {
  const signIfKey = async (v: JsonValue): Promise<string | undefined> =>
    typeof v === 'string' && v !== '' ? sign(v) : undefined;

  let out = changes;
  for (const field of AVATAR_FIELDS) {
    const entry = out[field];
    if (entry === undefined) continue;
    out = {
      ...out,
      [field]: {
        ...entry,
        oldUrl: await signIfKey(entry.old),
        newUrl: await signIfKey(entry.new),
      },
    };
  }
  return out;
}

async function toWire(r: Row, sign: SignFn): Promise<WireChangeRequest> {
  return {
    id: r.id,
    cadreId: r.cadreId,
    cadre: r.cadre
      ? { id: r.cadre.id, name: r.cadre.name, serialNumber: r.cadre.serialNumber ?? undefined }
      : undefined,
    changes: await withPreviews(r.changes as unknown as Record<string, WireChangeEntry>, sign),
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

export interface SubmitOptions {
  /** This task. Set only by reports.service.ts's report-time death sync — links
   *  the resulting request back to the ONE report that proposed it, so deleting
   *  that report can find and cancel it again (see cancelBySourceReport below).
   *  Never set by the HTTP route: this is an internal, service-to-service option,
   *  not a client-controllable field. */
  sourceReportId?: number;
}

export interface CadreChangesService {
  submit(cadreId: number, body: SubmitChangeBody, actor: Actor, opts?: SubmitOptions): Promise<WireChangeRequest>;
  list(query: ResolvedListChangesQuery, actor: Actor): Promise<Paginated<WireChangeRequest>>;
  approve(id: number, actor: Actor): Promise<WireChangeRequest>;
  reject(id: number, reason: string, actor: Actor): Promise<WireChangeRequest>;
  cancel(id: number, actor: Actor): Promise<WireChangeRequest>;
  /**
   * This task. Withdraws the SPECIFIC pending request that report-time death
   * sync created for `reportId`, if one still exists and is still pending —
   * e.g. an officer deletes their own just-filed mistaken death report before
   * anyone has approved it. A no-op (never throws) when there is none, or it
   * already moved past pending: the caller (reports.service.ts's remove()) has
   * ALREADY authorized the report deletion under its own rules, so this is a
   * mechanical cleanup, not a separately-gated action — unlike `cancel` above,
   * it does not check "is this actor the submitter". Deliberately does NOT
   * touch an already-APPLIED request: once two approvers have signed off on a
   * death, deleting the report that first reported it does not silently
   * un-mark the cadre — that stays a deliberate profile edit, same as clearing
   * any other permanentStatus mark.
   */
  cancelBySourceReport(reportId: number, actorId: number): Promise<void>;
  patchDirect(cadreId: number, body: PatchCadreBody, actor: Actor): Promise<void>;
}

export function makeCadreChangesService({
  prisma,
  log,
  storage,
  mediaUrlTtlSeconds,
  pushProvider,
}: CadreChangesDeps): CadreChangesService {
  // ADR-029. Re-signs an avatarKey into a short-lived preview URL for the approver.
  const signUrl = (key: string): Promise<string> => storage.presignGet(key, mediaUrlTtlSeconds);
  // ADR-048. Shared deps for the best-effort immediate push dispatch fired after
  // approve/reject's transaction commits — never call SNS from inside $transaction.
  const dispatchDeps: NotificationDispatchDeps = { prisma, pushProvider, log };

  /**
   * Applies a request's values to the cadre, or marks it stale. Caller supplies the tx.
   * ADR-048: when it actually applies (not stale), also returns the notify payload for
   * the caller to fire — via fireImmediateDispatch — once the OUTER transaction (this
   * function's own, or submit()'s enclosing one) has committed. Never dispatched from
   * in here: this function only ever runs inside a transaction, and SNS must never be
   * called from inside one.
   */
  async function applyWithin(
    tx: Prisma.TransactionClient,
    req: CadreChangeRequest,
    actorId: number,
  ): Promise<{
    request: CadreChangeRequest;
    notify?: { outboxEventId: number; payload: NotificationDispatchPayload };
  }> {
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
      return { request: stale };
    }

    const data: Record<string, unknown> = {};
    for (const [field, entry] of Object.entries(changes)) data[field] = toColumn(field, entry.new);

    const before: Record<string, JsonValue> = {};
    const after: Record<string, JsonValue> = {};
    for (const [field, entry] of Object.entries(changes)) {
      before[field] = entry.old;
      after[field] = entry.new;
    }

    // ADR-027. The submitter is the editor of record, not the approver who happened
    // to sign last: the officer proposed the change, the approver only allowed it.
    data.lastEditedAt = new Date();
    data.lastEditedById = req.submittedById;

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

    // ADR-048. Notify the submitter their change went live — in-app inbox row +
    // real push. `cadre.name` is read BEFORE this update, which is the right value
    // even when `name` itself is one of the changed fields: the notification
    // describes the record by the identity it had at the moment of decision.
    const copy = cadreChangeApprovedCopy(cadre.name);
    const notification = await writeNotification(tx, {
      userId: req.submittedById,
      type: 'cadre_change_outcome',
      title: copy.title,
      body: copy.body,
      cadreId: req.cadreId,
      cadreChangeId: req.id,
    });
    const notifyEvent = await writeOutboxEvent(tx, {
      aggregateType: 'notification',
      aggregateId: String(notification.id),
      eventType: 'notification.created',
      payload: {
        notificationId: notification.id,
        userId: req.submittedById,
        title: copy.title,
        body: copy.body,
      },
    });

    return {
      request: applied,
      notify: {
        outboxEventId: notifyEvent.id,
        payload: {
          notificationId: notification.id,
          userId: req.submittedById,
          title: copy.title,
          body: copy.body,
        },
      },
    };
  }

  async function loadOrThrow(id: number): Promise<Row> {
    const req = await prisma.cadreChangeRequest.findUnique({ where: { id }, include: WITH_PEOPLE });
    if (req === null) throw notFound('Change request not found');
    return req as Row;
  }

  /**
   * A change request is exactly as sensitive as the cadre it edits, so it inherits that
   * cadre's scope. Loaded separately (rather than joined into WITH_PEOPLE) so the check is
   * one obvious call every mutating path makes, instead of a condition buried in a select.
   * 404, not 403 — same reason as everywhere else: ids must stay unenumerable.
   */
  async function assertRequestInScope(req: { cadreId: number }, actor: Actor): Promise<void> {
    const cadre = await prisma.cadre.findFirst({
      where: { id: req.cadreId, deletedAt: null, ...cadreScopeWhere(actor.scope) },
      select: { id: true },
    });
    if (cadre === null) throw notFound('Change request not found');
  }

  return {
    async submit(cadreId, body, actor, opts) {
      // Sync module (ADR-013's pattern, extended to this entity — see the Prisma
      // column's comment). Checked FIRST, before the permission/cadre checks, so a
      // retried offline submission is cheap and safe even if something about the
      // caller or cadre changed meanwhile — matches reports.service.ts's create().
      if (body.idempotency_key !== undefined) {
        const existing = await prisma.cadreChangeRequest.findUnique({
          where: { idempotencyKey: body.idempotency_key },
          include: WITH_PEOPLE,
        });
        if (existing !== null) return toWire(existing as Row, signUrl);
      }

      if (!canSubmit(actor.role)) throw forbidden('Viewers cannot propose changes');

      const cadre = await prisma.cadre.findFirst({
        where: { id: cadreId, deletedAt: null, ...cadreScopeWhere(actor.scope) },
      });
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

      // ADR-027. One in-flight proposal per field. Two officers proposing the same
      // field used to be caught only at APPLY time: both sat pending, the first
      // approved won, and the second went `stale` days later — after two approvers
      // had spent attention on a change that was never going to land. Refuse the
      // second submission at the door instead, naming who holds the field and
      // since when, so the officer can go talk to them.
      //
      // Checked in JS rather than a JSONB key query: a cadre has a handful of
      // pending rows at most, and `changes ? 'field'` is not expressible through
      // Prisma's typed filters without raw SQL.
      const inFlight = await prisma.cadreChangeRequest.findMany({
        where: { cadreId, status: 'pending' },
        include: { submittedBy: { select: { id: true, name: true } } },
        orderBy: { submittedAt: 'asc' },
      });

      const clashes: string[] = [];
      for (const field of Object.keys(changes)) {
        const holder = inFlight.find((r) =>
          Object.keys(r.changes as Record<string, unknown>).includes(field),
        );
        if (holder !== undefined) {
          clashes.push(`${field} (${holder.submittedBy.name}, अनुरोध #${holder.id})`);
        }
      }
      if (clashes.length > 0) {
        throw conflict(
          `इन फ़ील्ड पर पहले से एक अनुरोध लंबित है: ${clashes.join(', ')}`,
          'CHANGE_PENDING',
        );
      }

      const { needsAdmin, needsSuperAdmin } = requiredApprovalsFor(actor.role);

      let notify: { outboxEventId: number; payload: NotificationDispatchPayload } | undefined;

      let created: CadreChangeRequest;
      try {
        created = await prisma.$transaction(async (tx) => {
          let req = await tx.cadreChangeRequest.create({
            data: {
              cadreId,
              changes: changes as unknown as Prisma.InputJsonValue,
              submittedById: actor.id,
              note: body.note ?? null,
              needsAdmin,
              needsSuperAdmin,
              idempotencyKey: body.idempotency_key ?? null,
              sourceReportId: opts?.sourceReportId ?? null,
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

          // super_admin sits at the top of the ladder, so their change needs
          // nobody: it applies in this same transaction. The request row is still
          // written — an unapproved-but-applied edit still belongs in the trail,
          // and skipping the row would make super_admin edits invisible to history.
          if (!needsAdmin && !needsSuperAdmin) {
            const result = await applyWithin(tx, req, actor.id);
            req = result.request;
            notify = result.notify;
          }

          return req;
        });
      } catch (err) {
        // Sync module. Concurrent replay lost the race on the unique idempotency
        // key — fetch and return the winner's record instead of surfacing the
        // conflict (same recovery reports.service.ts's create() already does).
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          body.idempotency_key !== undefined
        ) {
          const winner = await prisma.cadreChangeRequest.findUnique({
            where: { idempotencyKey: body.idempotency_key },
            include: WITH_PEOPLE,
          });
          if (winner !== null) return toWire(winner as Row, signUrl);
        }
        throw err;
      }

      // ADR-048. Fired only after the transaction above has committed — never call
      // SNS from inside $transaction.
      if (notify !== undefined) fireImmediateDispatch(dispatchDeps, notify.outboxEventId, notify.payload);

      return toWire(await loadOrThrow(created.id), signUrl);
    },

    async list(query, actor) {
      const where: Prisma.CadreChangeRequestWhereInput = {};
      // ADR-044 + BE#16. The approver queue and the submissions list are both bounded by
      // the cadre's jurisdiction, so an SDOP's queue is their own sub-division's work.
      if (actor.scope.kind !== 'all') where.cadre = { thana: { in: [...actor.scope.thanas] } };
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
          // ADR-028. Only what a super_admin can actually sign RIGHT NOW: their own
          // rung, and only once the admin rung (where required) is already cleared.
          //
          // Previously this also matched requests still awaiting an admin, so the
          // super_admin approved, watched the card stay put, and approved again —
          // which is how one person silently completed a two-person review.
          where.needsSuperAdmin = true;
          where.superAdminApprovedAt = null;
          where.OR = [{ needsAdmin: false }, { NOT: { adminApprovedAt: null } }];
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
        data: await Promise.all((rows as Row[]).map((r) => toWire(r, signUrl))),
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
      await assertRequestInScope(req, actor);
      if (!canApproveNext(actor.role, req)) {
        throw forbidden('This change is not awaiting your approval');
      }

      const now = new Date();
      const adminStepOutstanding = req.needsAdmin && req.adminApprovedAt === null;

      let notify: { outboxEventId: number; payload: NotificationDispatchPayload } | undefined;

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
        if (!stillWaiting) {
          const result = await applyWithin(tx, next, actor.id);
          next = result.request;
          notify = result.notify;
        }

        return next;
      });

      if (notify !== undefined) fireImmediateDispatch(dispatchDeps, notify.outboxEventId, notify.payload);

      return toWire(await loadOrThrow(updated.id), signUrl);
    },

    async reject(id, reason, actor) {
      const req = await loadOrThrow(id);
      await assertRequestInScope(req, actor);
      if (req.status !== 'pending') {
        throw badRequest(`Change request is already ${req.status}`, 'NOT_PENDING');
      }
      if (!canApproveNext(actor.role, req)) {
        throw forbidden('This change is not awaiting your decision');
      }

      let notify: { outboxEventId: number; payload: NotificationDispatchPayload } | undefined;

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

        // ADR-048. Always terminal — unlike approve(), there is no "mid-chain,
        // don't notify yet" branch here.
        const copy = cadreChangeRejectedCopy(req.cadre?.name ?? '', reason);
        const notification = await writeNotification(tx, {
          userId: req.submittedById,
          type: 'cadre_change_outcome',
          title: copy.title,
          body: copy.body,
          cadreId: req.cadreId,
          cadreChangeId: id,
        });
        const notifyEvent = await writeOutboxEvent(tx, {
          aggregateType: 'notification',
          aggregateId: String(notification.id),
          eventType: 'notification.created',
          payload: {
            notificationId: notification.id,
            userId: req.submittedById,
            title: copy.title,
            body: copy.body,
          },
        });
        notify = {
          outboxEventId: notifyEvent.id,
          payload: {
            notificationId: notification.id,
            userId: req.submittedById,
            title: copy.title,
            body: copy.body,
          },
        };
      });

      if (notify !== undefined) fireImmediateDispatch(dispatchDeps, notify.outboxEventId, notify.payload);

      return toWire(await loadOrThrow(id), signUrl);
    },

    async cancel(id, actor) {
      const req = await loadOrThrow(id);
      await assertRequestInScope(req, actor);
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

      return toWire(await loadOrThrow(id), signUrl);
    },

    async cancelBySourceReport(reportId, actorId) {
      const req = await prisma.cadreChangeRequest.findFirst({
        where: { sourceReportId: reportId, status: 'pending' },
      });
      // No matching request, or it already left `pending` (approved, rejected,
      // or gone stale) — nothing to do. See the interface doc comment for why
      // an already-applied one is deliberately left untouched.
      if (req === null) return;

      await prisma.$transaction(async (tx) => {
        await tx.cadreChangeRequest.update({
          where: { id: req.id },
          data: { status: 'cancelled', decidedAt: new Date(), decidedById: actorId },
        });
        await writeAuditLog(tx, {
          actorId,
          action: 'cadre.change.cancelled',
          entityType: 'cadre_change_request',
          entityId: String(req.id),
          before: { status: 'pending' },
          after: { status: 'cancelled', reason: 'source report deleted' },
        });
      });
    },

    async patchDirect(cadreId, body, actor) {
      if (!canWriteDirect(actor.role)) throw forbidden('Viewers cannot edit cadres');

      const cadre = await prisma.cadre.findFirst({
        where: { id: cadreId, deletedAt: null, ...cadreScopeWhere(actor.scope) },
      });
      if (cadre === null) throw notFound('Cadre not found');

      const before = {
        alertTag: cadre.alertTag,
        aliases: cadre.aliases,
        alertDate: cadre.alertDate,
        alertLevel: cadre.alertLevel,
      };

      // ADR-032/033: both of these are DERIVED from the tag write, never sent by the
      // client. `alertDate` answers "when was this alert recorded"; `alertLevel` is
      // what the tag *means*. Only a tag change moves either — an alias-only write
      // must leave both alone. Clearing the tag clears the date and drops the level
      // to `normal`: a cadre with no alert has no alert date and no severity.
      const data: PatchCadreBody & { alertDate?: Date | null; alertLevel?: AlertLevel } = { ...body };
      if ('alertTag' in body) {
        const tag = body.alertTag ?? null;
        data.alertDate = tag ? new Date() : null;
        data.alertLevel = tagToLevel(tag);
      }

      await prisma.$transaction(async (tx) => {
        // A tag/alias write is still someone touching the record (ADR-027) — an
        // officer checking "who last edited this" should see it.
        await tx.cadre.update({
          where: { id: cadreId },
          data: { ...data, lastEditedAt: new Date(), lastEditedById: actor.id },
        });
        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'cadre.updated',
          entityType: 'cadre',
          entityId: String(cadreId),
          before,
          after: data,
        });
        await writeOutboxEvent(tx, {
          aggregateType: 'cadre',
          aggregateId: String(cadreId),
          eventType: 'cadre.updated',
          payload: { cadreId, fields: Object.keys(data), actorId: actor.id },
        });
      });
    },
  };
}
