import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { cadreScopeWhere, scopeAdmitsThana, type CadreScope } from '../../lib/scope.js';
import { Prisma, type PrismaClient, type Role, type CadreCreateRequest } from '@prisma/client';
import { writeAuditLog } from '../../lib/audit.js';
import { writeOutboxEvent } from '../../lib/outbox.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import type { StorageProvider } from '../../lib/storage.js';
import type { PushProvider } from '../../lib/push.js';
import { writeNotification } from '../../lib/notifications.js';
import { cadreCreateApprovedCopy, cadreCreateRejectedCopy } from '../../lib/notification-copy.js';
import { nextCadreSerialNumber } from '../../lib/cadre-serial.js';
import { EXT_BY_TYPE } from '../../lib/images.js';
import {
  fireImmediateDispatch,
  type NotificationDispatchDeps,
  type NotificationDispatchPayload,
} from '../../lib/notification-dispatch.js';
import { canApproveNext, canSubmit, requiredApprovalsFor } from './cadre-create-requests.policy.js';
import type {
  CreateCadreDraft,
  ResolvedListCreateRequestsQuery,
  SubmitCreateRequestBody,
} from './cadre-create-requests.schema.js';

export interface CadreCreateRequestsDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
  // Signs proposed avatarKey/2/3 into preview URLs, same reason as cadre-changes:
  // an approver shown a bare S3 key is being asked to approve a photo they cannot see.
  storage: StorageProvider;
  mediaUrlTtlSeconds: number;
  pushProvider: PushProvider;
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

export interface DuplicateWarning {
  cadres: { id: number; name: string; serialNumber: string | null; thana: string }[];
  createRequests: { id: number; name: string; submittedBy: string }[];
}

export interface UploadInput {
  buffer: Buffer;
  contentType: string;
}

// ─── Wire shape ───────────────────────────────────────────────────────────────

export interface WireCreateRequest {
  id: number;
  draft: CreateCadreDraft & { avatarUrl?: string; avatarUrl2?: string; avatarUrl3?: string };
  submittedBy: { id: number; name: string; role: Role };
  submittedAt: string;
  note?: string;
  status: CadreCreateRequest['status'];
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
  /** Present only once the request has been applied. */
  cadreId?: number;
  /**
   * Non-blocking — computed live, never persisted. Present only when a
   * name+thana+(phone|DOB) match exists against an existing cadre or another
   * pending create request. Never blocks submission or approval.
   */
  duplicateWarning?: DuplicateWarning;
}

type Row = CadreCreateRequest & {
  submittedBy: { id: number; name: string; role: Role };
  adminApprovedBy?: { id: number; name: string } | null;
  superAdminApprovedBy?: { id: number; name: string } | null;
};

function awaitingRole(r: CadreCreateRequest): 'admin' | 'super_admin' | undefined {
  if (r.status !== 'pending') return undefined;
  if (r.needsAdmin && r.adminApprovedAt === null) return 'admin';
  if (r.needsSuperAdmin && r.superAdminApprovedAt === null) return 'super_admin';
  return undefined;
}

type SignFn = (key: string) => Promise<string>;

const WITH_PEOPLE = {
  submittedBy: { select: { id: true, name: true, role: true } },
  adminApprovedBy: { select: { id: true, name: true } },
  superAdminApprovedBy: { select: { id: true, name: true } },
} as const;

async function toWire(r: Row, sign: SignFn): Promise<WireCreateRequest> {
  const draft = r.draft as unknown as CreateCadreDraft;
  const [avatarUrl, avatarUrl2, avatarUrl3] = await Promise.all([
    draft.avatarKey ? sign(draft.avatarKey) : Promise.resolve(undefined),
    draft.avatarKey2 ? sign(draft.avatarKey2) : Promise.resolve(undefined),
    draft.avatarKey3 ? sign(draft.avatarKey3) : Promise.resolve(undefined),
  ]);

  return {
    id: r.id,
    draft: { ...draft, avatarUrl, avatarUrl2, avatarUrl3 },
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
    cadreId: r.cadreId ?? undefined,
  };
}

/**
 * Non-blocking duplicate-of-an-existing-person check. Matches on thana + case-
 * insensitive name + (phone OR dateOfBirth), against both real cadres and other
 * pending create requests. Same-name-different-person is legitimate — the approval
 * ladder is the human checkpoint that decides, so this only ever WARNS, never blocks
 * submission or approval, and is never persisted onto the request row (recomputed
 * live so it reflects whatever exists right now, not what existed at submission).
 */
async function findDuplicateCandidates(
  draft: CreateCadreDraft,
  prisma: PrismaClient,
  excludeRequestId?: number,
): Promise<DuplicateWarning | undefined> {
  const dob = draft.dateOfBirth ? new Date(draft.dateOfBirth) : undefined;

  const cadres = await prisma.cadre.findMany({
    where: {
      deletedAt: null,
      thana: draft.thana,
      name: { equals: draft.name, mode: 'insensitive' },
      OR: [{ phone: draft.phone }, ...(dob !== undefined ? [{ dateOfBirth: dob }] : [])],
    },
    select: { id: true, name: true, serialNumber: true, thana: true },
    take: 5,
  });

  // Checked in JS against the JSON draft, not a JSONB query — a thana has a handful
  // of pending create requests at most, same convention as cadre-changes' in-flight
  // per-field lock check.
  const pending = await prisma.cadreCreateRequest.findMany({
    where: {
      status: 'pending',
      thana: draft.thana,
      ...(excludeRequestId !== undefined ? { id: { not: excludeRequestId } } : {}),
    },
    include: { submittedBy: { select: { name: true } } },
  });

  const createRequests = pending
    .map((r) => ({ id: r.id, draft: r.draft as unknown as CreateCadreDraft, submittedBy: r.submittedBy.name }))
    .filter(({ draft: d }) => {
      const nameMatch = d.name.toLowerCase() === draft.name.toLowerCase();
      const otherMatch =
        d.phone === draft.phone ||
        (dob !== undefined && !!d.dateOfBirth && new Date(d.dateOfBirth).getTime() === dob.getTime());
      return nameMatch && otherMatch;
    })
    .map(({ id, draft: d, submittedBy }) => ({ id, name: d.name, submittedBy }));

  if (cadres.length === 0 && createRequests.length === 0) return undefined;
  return { cadres, createRequests };
}

export interface CadreCreateRequestsService {
  submit(body: SubmitCreateRequestBody, actor: Actor): Promise<WireCreateRequest>;
  list(query: ResolvedListCreateRequestsQuery, actor: Actor): Promise<Paginated<WireCreateRequest>>;
  approve(id: number, actor: Actor): Promise<WireCreateRequest>;
  reject(id: number, reason: string, actor: Actor): Promise<WireCreateRequest>;
  cancel(id: number, actor: Actor): Promise<WireCreateRequest>;
  uploadDraftAvatar(file: UploadInput, actor: Actor): Promise<{ key: string; url: string }>;
}

export function makeCadreCreateRequestsService({
  prisma,
  log,
  storage,
  mediaUrlTtlSeconds,
  pushProvider,
}: CadreCreateRequestsDeps): CadreCreateRequestsService {
  const signUrl = (key: string): Promise<string> => storage.presignGet(key, mediaUrlTtlSeconds);
  const dispatchDeps: NotificationDispatchDeps = { prisma, pushProvider, log };

  /**
   * Creates the real Cadre row and marks the request applied. Caller supplies the
   * tx. Unlike cadre-changes' applyWithin, there is no drift check — a create
   * request has no prior value anything could have drifted from; the only
   * analogous risk (a near-duplicate person) is handled as a non-blocking warning
   * at submit/list time, never as a reason to refuse applying here.
   */
  async function applyWithin(
    tx: Prisma.TransactionClient,
    req: CadreCreateRequest,
    actorId: number,
  ): Promise<{
    request: CadreCreateRequest;
    notify?: { outboxEventId: number; payload: NotificationDispatchPayload };
  }> {
    const draft = req.draft as unknown as CreateCadreDraft;
    const serialNumber = await nextCadreSerialNumber(tx);

    const cadre = await tx.cadre.create({
      data: {
        serialNumber,
        name: draft.name,
        phone: draft.phone,
        thana: draft.thana,
        currentAddress: draft.currentAddress,
        permanentAddress: draft.permanentAddress ?? null,
        residingVillage: draft.residingVillage ?? null,
        designation: draft.designation,
        category: draft.category,
        priorityCategory: draft.priorityCategory ?? null,
        // ADR-033 invariant: no alertTag at creation ⇒ level is `normal`. Neither
        // field is on the create form (edit.tsx doesn't expose them either) — an
        // officer tags an alert afterward via the existing tag picker.
        alertLevel: 'normal',
        alertTag: null,
        incident: draft.incident ?? null,
        verificationOffice: draft.verificationOffice ?? null,
        supervisoryOffice: draft.supervisoryOffice ?? null,
        aliases: [],
        surrenderDate: draft.surrenderDate ? new Date(draft.surrenderDate) : null,
        surrenderLocation: draft.surrenderLocation ?? null,
        surrenderOrigin: draft.surrenderOrigin ?? null,
        otherOriginType: draft.otherOriginType ?? null,
        surrenderYear: draft.surrenderYear ?? null,
        familyGroupInfo: draft.familyGroupInfo ?? null,
        subDivision: draft.subDivision ?? null,
        district: draft.district ?? null,
        dateOfBirth: draft.dateOfBirth ? new Date(draft.dateOfBirth) : null,
        fatherName: draft.fatherName ?? null,
        motherName: draft.motherName ?? null,
        spouseName: draft.spouseName ?? null,
        gender: draft.gender ?? null,
        caste: draft.caste ?? null,
        hasAadhaar: draft.hasAadhaar,
        hasBankAccount: draft.hasBankAccount,
        hasAbProforma: draft.hasAbProforma,
        hasAgreementLetter: draft.hasAgreementLetter,
        avatarKey: draft.avatarKey ?? null,
        avatarKey2: draft.avatarKey2 ?? null,
        avatarKey3: draft.avatarKey3 ?? null,
        // Not on the create form — no edit path exists for these either (filter is
        // import-only, permanentStatus/assignedOfficerId are set via their own
        // dedicated flows once the record exists).
        permanentStatus: null,
        filter: null,
        assignedOfficerId: null,
        // ADR-027: the submitter is the editor of record.
        lastEditedAt: new Date(),
        lastEditedById: req.submittedById,
      },
    });

    const applied = await tx.cadreCreateRequest.update({
      where: { id: req.id },
      data: { status: 'applied', cadreId: cadre.id, decidedAt: new Date(), decidedById: actorId },
    });

    await writeAuditLog(tx, {
      actorId,
      action: 'cadre.create.applied',
      entityType: 'cadre',
      entityId: String(cadre.id),
      after: draft as unknown as Prisma.InputJsonValue,
    });
    await writeOutboxEvent(tx, {
      aggregateType: 'cadre',
      aggregateId: String(cadre.id),
      eventType: 'cadre.created',
      payload: { cadreId: cadre.id, createRequestId: req.id, actorId },
    });

    const copy = cadreCreateApprovedCopy(cadre.name);
    const notification = await writeNotification(tx, {
      userId: req.submittedById,
      type: 'cadre_create_outcome',
      title: copy.title,
      body: copy.body,
      cadreId: cadre.id,
      cadreCreateRequestId: req.id,
    });
    const notifyEvent = await writeOutboxEvent(tx, {
      aggregateType: 'notification',
      aggregateId: String(notification.id),
      eventType: 'notification.created',
      payload: { notificationId: notification.id, userId: req.submittedById, title: copy.title, body: copy.body },
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
    const req = await prisma.cadreCreateRequest.findUnique({ where: { id }, include: WITH_PEOPLE });
    if (req === null) throw notFound('Create request not found');
    return req as Row;
  }

  /**
   * `thana` lives directly on the request row (there is no cadre relation yet to
   * read it from), so unlike cadre-changes' assertRequestInScope this needs no
   * extra query. 404, not 403 — same reason as everywhere else: ids must stay
   * unenumerable.
   */
  function assertRequestInScope(req: { thana: string }, actor: Actor): void {
    if (!scopeAdmitsThana(actor.scope, req.thana)) throw notFound('Create request not found');
  }

  return {
    async submit(body, actor) {
      if (!canSubmit(actor.role)) throw forbidden('Viewers cannot propose a new cadre');

      const { draft } = body;

      // There is no existing cadre row to scope from, so the proposed thana stands
      // in — same precedent as transferThana's destination check.
      if (!scopeAdmitsThana(actor.scope, draft.thana)) {
        throw badRequest('thana is outside your jurisdiction', 'THANA_OUT_OF_SCOPE');
      }

      const duplicateWarning = await findDuplicateCandidates(draft, prisma);

      const { needsAdmin, needsSuperAdmin } = requiredApprovalsFor(actor.role);

      let notify: { outboxEventId: number; payload: NotificationDispatchPayload } | undefined;

      const created = await prisma.$transaction(async (tx) => {
        let req = await tx.cadreCreateRequest.create({
          data: {
            draft: draft as unknown as Prisma.InputJsonValue,
            thana: draft.thana,
            submittedById: actor.id,
            note: body.note ?? null,
            needsAdmin,
            needsSuperAdmin,
          },
        });

        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'cadre.create.submitted',
          entityType: 'cadre_create_request',
          entityId: String(req.id),
          after: { name: draft.name, thana: draft.thana, needsAdmin, needsSuperAdmin },
        });

        // super_admin needs nobody: applies in this same transaction. The request
        // row is still written — an unapproved-but-applied creation still belongs
        // in the trail.
        if (!needsAdmin && !needsSuperAdmin) {
          const result = await applyWithin(tx, req, actor.id);
          req = result.request;
          notify = result.notify;
        }

        return req;
      });

      if (notify !== undefined) fireImmediateDispatch(dispatchDeps, notify.outboxEventId, notify.payload);

      const wire = await toWire(await loadOrThrow(created.id), signUrl);
      return { ...wire, duplicateWarning };
    },

    async list(query, actor) {
      const where: Prisma.CadreCreateRequestWhereInput = {};
      if (actor.scope.kind !== 'all') where.thana = { in: [...actor.scope.thanas] };
      if (query.status !== undefined) where.status = query.status;
      if (query.submittedBy !== undefined) where.submittedById = query.submittedBy;

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
        prisma.cadreCreateRequest.count({ where }),
        prisma.cadreCreateRequest.findMany({
          where,
          include: WITH_PEOPLE,
          orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      const data = await Promise.all(
        (rows as Row[]).map(async (r) => {
          const wire = await toWire(r, signUrl);
          // Recomputed live on every row — never persisted/frozen, since freshness
          // (has a matching cadre/request appeared since?) matters more than
          // immutability here. Only meaningful while still pending.
          const duplicateWarning =
            r.status === 'pending'
              ? await findDuplicateCandidates(r.draft as unknown as CreateCadreDraft, prisma, r.id)
              : undefined;
          return { ...wire, duplicateWarning };
        }),
      );

      return {
        data,
        total,
        page: query.page,
        pageSize: query.pageSize,
        hasMore: query.page * query.pageSize < total,
      };
    },

    async approve(id, actor) {
      const req = await loadOrThrow(id);
      if (req.status !== 'pending') {
        throw badRequest(`Create request is already ${req.status}`, 'NOT_PENDING');
      }
      if (req.submittedById === actor.id) {
        throw forbidden('You cannot approve a cadre you submitted');
      }
      assertRequestInScope(req, actor);
      if (!canApproveNext(actor.role, req)) {
        throw forbidden('This request is not awaiting your approval');
      }

      const now = new Date();
      const adminStepOutstanding = req.needsAdmin && req.adminApprovedAt === null;

      let notify: { outboxEventId: number; payload: NotificationDispatchPayload } | undefined;

      const updated = await prisma.$transaction(async (tx) => {
        const data: Prisma.CadreCreateRequestUpdateInput = adminStepOutstanding
          ? { adminApprovedBy: { connect: { id: actor.id } }, adminApprovedAt: now }
          : { superAdminApprovedBy: { connect: { id: actor.id } }, superAdminApprovedAt: now };

        let next = await tx.cadreCreateRequest.update({ where: { id }, data });

        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'cadre.create.approved',
          entityType: 'cadre_create_request',
          entityId: String(id),
          before: { adminApprovedAt: req.adminApprovedAt, superAdminApprovedAt: req.superAdminApprovedAt },
          after: { rung: adminStepOutstanding ? 'admin' : 'super_admin', by: actor.id },
        });

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
      assertRequestInScope(req, actor);
      if (req.status !== 'pending') {
        throw badRequest(`Create request is already ${req.status}`, 'NOT_PENDING');
      }
      if (!canApproveNext(actor.role, req)) {
        throw forbidden('This request is not awaiting your decision');
      }

      let notify: { outboxEventId: number; payload: NotificationDispatchPayload } | undefined;

      await prisma.$transaction(async (tx) => {
        await tx.cadreCreateRequest.update({
          where: { id },
          data: { status: 'rejected', decidedAt: new Date(), decidedById: actor.id, decidedReason: reason },
        });
        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'cadre.create.rejected',
          entityType: 'cadre_create_request',
          entityId: String(id),
          before: { status: 'pending' },
          after: { status: 'rejected', reason },
        });

        const draft = req.draft as unknown as CreateCadreDraft;
        const copy = cadreCreateRejectedCopy(draft.name, reason);
        const notification = await writeNotification(tx, {
          userId: req.submittedById,
          type: 'cadre_create_outcome',
          title: copy.title,
          body: copy.body,
          cadreCreateRequestId: id,
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
      assertRequestInScope(req, actor);
      if (req.submittedById !== actor.id) {
        throw forbidden('Only the submitter can withdraw a create request');
      }
      if (req.status !== 'pending') {
        throw badRequest(`Create request is already ${req.status}`, 'NOT_PENDING');
      }

      await prisma.$transaction(async (tx) => {
        await tx.cadreCreateRequest.update({
          where: { id },
          data: { status: 'cancelled', decidedAt: new Date(), decidedById: actor.id },
        });
        await writeAuditLog(tx, {
          actorId: actor.id,
          action: 'cadre.create.cancelled',
          entityType: 'cadre_create_request',
          entityId: String(id),
          before: { status: 'pending' },
          after: { status: 'cancelled' },
        });
      });

      return toWire(await loadOrThrow(id), signUrl);
    },

    async uploadDraftAvatar(file, actor) {
      // Role-gated only — there is no cadre yet to scope a check against. Uploading
      // does not create or change anything by itself; the key only becomes a real
      // cadre's photo once a create request carrying it is applied.
      if (!canSubmit(actor.role)) throw forbidden('Viewers cannot upload');

      const ext = EXT_BY_TYPE[file.contentType] ?? 'bin';
      const key = `cadres/draft/${randomUUID()}/avatar-${randomUUID()}.${ext}`;
      await storage.put(key, file.buffer, file.contentType);
      const url = await storage.presignGet(key, mediaUrlTtlSeconds);
      return { key, url };
    },
  };
}
