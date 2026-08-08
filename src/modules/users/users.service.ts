import type { FastifyBaseLogger } from 'fastify';
import { Prisma, type User } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { writeAuditLog } from '../../lib/audit.js';
import { writeOutboxEvent } from '../../lib/outbox.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { toWireUser, type WireUser } from '../../lib/serialize.js';
import {
  importUserRow,
  scopeInvariantErrors,
  type ImportUserRow,
  type CreateUserBody,
  type UpdateUserBody,
  type ListUsersQuery,
} from './users.schema.js';

export interface UsersDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ADR-057. Everything Phase 3's Sheet-sync consumer will need from a `user.*` outbox
// event — id, name, email, role, thana, subDivision, designation, status, timestamp.
// One builder so create/update/deactivate can never emit three different shapes.
function userSyncPayload(u: User): Prisma.InputJsonValue {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    thana: u.thana,
    subDivision: u.subDivision,
    designation: u.designation,
    status: u.deletedAt === null ? 'active' : 'deactivated',
    timestamp: u.updatedAt.toISOString(),
  };
}

/** Per-row outcome, keyed by the institutional ID so the sheet can write it straight back. */
export interface ImportUserResult {
  name: string | null;
  status: 'created' | 'skipped_duplicate' | 'error';
  userId?: number;
  error?: string;
}

export interface ImportUsersResult {
  results: ImportUserResult[];
}

export interface UsersService {
  importUsers(rows: unknown[], actorId: number): Promise<ImportUsersResult>;
  setPassword(userId: number, password: string, actorId: number): Promise<void>;
  deactivate(userId: number, actorId: number): Promise<void>;
  // Phase 2 (web User Management).
  list(query: ListUsersQuery): Promise<Paginated<WireUser>>;
  getById(userId: number): Promise<WireUser>;
  create(row: CreateUserBody, actorId: number): Promise<WireUser>;
  update(userId: number, body: UpdateUserBody, actorId: number): Promise<WireUser>;
}

/** Echo whatever `name` a raw (possibly invalid) row carried, so the sheet can still key on it. */
function rawName(raw: unknown): string | null {
  if (raw !== null && typeof raw === 'object' && 'name' in raw) {
    const n = (raw as Record<string, unknown>).name;
    if (typeof n === 'string' && n.trim() !== '') return n.trim();
  }
  return null;
}

function formatIssues(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join('.') || '(row)'}: ${i.message}`).join('; ');
}

/** The unique constraints on users are `name` and `email` — either can collide. */
function uniqueTarget(err: unknown): string | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null;
  const target = (err.meta as { target?: string[] | string } | undefined)?.target;
  if (Array.isArray(target)) return target.join(',');
  return typeof target === 'string' ? target : 'unknown';
}

export function makeUsersService({ prisma, log }: UsersDeps): UsersService {
  return {
    async importUsers(rows, actorId) {
      // Phase 1: validate every row up front (safeParse — one bad row must not fail the
      // batch). Results stay dense and in input order so the sheet maps row-for-row.
      const results: ImportUserResult[] = new Array(rows.length);
      const valid: { index: number; row: ImportUserRow }[] = [];
      rows.forEach((raw, index) => {
        const parsed = importUserRow.safeParse(raw);
        if (!parsed.success) {
          results[index] = { name: rawName(raw), status: 'error', error: formatIssues(parsed.error) };
        } else {
          valid.push({ index, row: parsed.data });
        }
      });

      // Phase 2: one query for every ID already taken, so the duplicate check is a map
      // lookup per row rather than a query per row.
      const names = valid.map((v) => v.row.name);
      const existing =
        names.length > 0
          ? await prisma.user.findMany({ where: { name: { in: names } }, select: { id: true, name: true } })
          : [];
      const idByName = new Map(existing.map((u) => [u.name, u.id]));

      // Phase 3: create the new accounts, each in its own transaction (create + audit), so
      // a failure on one row neither rolls back the rows before it nor aborts those after.
      for (const { index, row } of valid) {
        const dupId = idByName.get(row.name);
        if (dupId !== undefined) {
          // SKIP, never update — a re-run must not silently reset a password that has
          // been changed since, nor re-scope an account someone corrected by hand.
          results[index] = { name: row.name, status: 'skipped_duplicate', userId: dupId };
          continue;
        }
        try {
          // Absent password → account exists but cannot log in until one is set (ADR-042).
          const passwordHash = row.password !== undefined ? await hashPassword(row.password) : null;
          const created = await prisma.$transaction(async (tx) => {
            const u = await tx.user.create({
              data: {
                name: row.name,
                email: row.email,
                role: row.role,
                passwordHash,
                thana: row.thana ?? null,
                subDivision: row.subDivision ?? null,
                designation: row.designation ?? null,
              },
            });
            await writeAuditLog(tx, {
              actorId,
              action: 'user.import',
              entityType: 'user',
              entityId: String(u.id),
              // Never the password or its hash — the audit trail records that an account
              // was created and with what authority, not the credential itself.
              after: {
                name: u.name,
                email: u.email,
                role: u.role,
                thana: u.thana,
                subDivision: u.subDivision,
                passwordSet: passwordHash !== null,
              },
            });
            return u;
          });
          idByName.set(row.name, created.id);
          results[index] = { name: row.name, status: 'created', userId: created.id };
        } catch (err) {
          const target = uniqueTarget(err);
          if (target !== null) {
            // Lost a race, or the EMAIL collides with a different account's. The second is
            // a real data error the sheet must see, so say which constraint tripped rather
            // than reporting a generic duplicate.
            if (target.includes('name')) {
              results[index] = { name: row.name, status: 'skipped_duplicate' };
            } else {
              results[index] = {
                name: row.name,
                status: 'error',
                error: `email already belongs to another account (unique: ${target})`,
              };
            }
          } else {
            log.error({ err, name: row.name }, 'user import row failed');
            results[index] = { name: row.name, status: 'error', error: 'internal error creating user' };
          }
        }
      }

      return { results };
    },

    async setPassword(userId, password, actorId) {
      const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
      if (user === null) throw notFound('User not found');

      const passwordHash = await hashPassword(password);
      await prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id: userId }, data: { passwordHash } });
        // A password change must end the sessions the OLD password opened — otherwise a
        // reset prompted by a suspected compromise leaves the compromised session alive.
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        // SDR-002: clear any lockout. An admin resetting the password is the intended way
        // out of a locked account, so leaving the lock in place would defeat the remedy.
        await tx.loginAttempt.deleteMany({ where: { email: user.email ?? '' } });
        await writeAuditLog(tx, {
          actorId,
          action: 'user.password_reset',
          entityType: 'user',
          entityId: String(userId),
          // WHO was reset and BY WHOM — never the password itself.
          after: { name: user.name, sessionsRevoked: true },
        });
      });
    },

    async deactivate(userId, actorId) {
      // SOFT delete. The account's id is referenced by reports, change requests and audit
      // rows; hard-deleting would either orphan or destroy that history, and "who filed
      // this report" must survive the account being retired.
      //
      // Refusing self-deactivation is a real guard, not ceremony: super_admin is the only
      // role that can create or reactivate accounts, so an admin removing their own last
      // session could lock the organisation out of its own user management.
      if (userId === actorId) {
        throw badRequest('You cannot deactivate your own account', 'CANNOT_DEACTIVATE_SELF');
      }

      const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
      if (user === null) throw notFound('User not found');

      await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });
        // A deactivated account must not keep a live session — otherwise "removed" means
        // "removed in 15 minutes, or 30 days if they hold a refresh token".
        await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await writeAuditLog(tx, {
          actorId,
          action: 'user.deactivate',
          entityType: 'user',
          entityId: String(userId),
          before: { name: user.name, role: user.role, deletedAt: null },
          after: { name: user.name, deletedAt: u.deletedAt!.toISOString(), sessionsRevoked: true },
        });
        // ADR-057. What Phase 3's Sheet-sync consumer will drain on the next cycle.
        await writeOutboxEvent(tx, {
          aggregateType: 'user',
          aggregateId: String(userId),
          eventType: 'user.deactivated',
          payload: userSyncPayload(u),
        });
      });
    },

    // Phase 2 (web User Management).

    async list(query) {
      const where: Prisma.UserWhereInput = {};
      if (query.status === 'active') where.deletedAt = null;
      else if (query.status === 'deactivated') where.deletedAt = { not: null };
      // 'all' → no deletedAt filter.
      if (query.role !== undefined) where.role = query.role;
      if (query.thana !== undefined) where.thana = query.thana;
      if (query.subDivision !== undefined) where.subDivision = query.subDivision;
      if (query.search !== undefined && query.search !== '') {
        where.name = { contains: query.search, mode: 'insensitive' };
      }

      const [total, rows] = await prisma.$transaction([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);

      return {
        data: rows.map(toWireUser),
        total,
        page: query.page,
        pageSize: query.pageSize,
        hasMore: query.page * query.pageSize < total,
      };
    },

    // Deliberately not scoped to deletedAt: null — a management UI needs to be able to
    // open a deactivated account's detail (its `status` field tells the caller which).
    async getById(userId) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user === null) throw notFound('User not found');
      return toWireUser(user);
    },

    // A single-row create, reusing importUserRow's exact validation. Unlike
    // /users/import, a duplicate `name` here is a 409 — this route is never a bulk
    // re-run, so there is no "skip, don't clobber a changed password" case to protect.
    async create(row, actorId) {
      const existing = await prisma.user.findUnique({ where: { name: row.name }, select: { id: true } });
      if (existing !== null) throw conflict(`name "${row.name}" already exists`, 'DUPLICATE_NAME');

      const passwordHash = row.password !== undefined ? await hashPassword(row.password) : null;
      try {
        const created = await prisma.$transaction(async (tx) => {
          const u = await tx.user.create({
            data: {
              name: row.name,
              email: row.email,
              role: row.role,
              passwordHash,
              thana: row.thana ?? null,
              subDivision: row.subDivision ?? null,
              designation: row.designation ?? null,
            },
          });
          await writeAuditLog(tx, {
            actorId,
            action: 'user.created',
            entityType: 'user',
            entityId: String(u.id),
            after: {
              name: u.name,
              email: u.email,
              role: u.role,
              thana: u.thana,
              subDivision: u.subDivision,
              designation: u.designation,
              passwordSet: passwordHash !== null,
            },
          });
          await writeOutboxEvent(tx, {
            aggregateType: 'user',
            aggregateId: String(u.id),
            eventType: 'user.created',
            payload: userSyncPayload(u),
          });
          return u;
        });
        return toWireUser(created);
      } catch (err) {
        // A race against a concurrent create/import lost between the pre-check above
        // and the insert — same collision handling as importUsers.
        const target = uniqueTarget(err);
        if (target !== null) {
          if (target.includes('name')) throw conflict(`name "${row.name}" already exists`, 'DUPLICATE_NAME');
          throw conflict(`email already belongs to another account (unique: ${target})`, 'DUPLICATE_EMAIL');
        }
        log.error({ err, name: row.name }, 'user create failed');
        throw err;
      }
    },

    // role/thana/subDivision/designation only. Validates the MERGED post-edit state
    // (existing values + this patch), not just the submitted fields — a role change
    // alone can violate scopeInvariantErrors unless the caller also clears the
    // now-wrong scope field in the same request (e.g. officer -> admin must clear
    // thana AND set subDivision together).
    async update(userId, body, actorId) {
      const existing = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
      if (existing === null) throw notFound('User not found');

      const effectiveRole = body.role ?? existing.role;
      const effectiveThana = 'thana' in body ? body.thana : existing.thana;
      const effectiveSubDivision = 'subDivision' in body ? body.subDivision : existing.subDivision;

      const scopeErrors = scopeInvariantErrors(effectiveRole, effectiveThana, effectiveSubDivision);
      if (scopeErrors.length > 0) throw badRequest(scopeErrors.join('; '), 'INVALID_SCOPE');

      const data: Prisma.UserUpdateInput = {};
      if (body.role !== undefined) data.role = body.role;
      if ('thana' in body) data.thana = body.thana;
      if ('subDivision' in body) data.subDivision = body.subDivision;
      if ('designation' in body) data.designation = body.designation;

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({ where: { id: userId }, data });
        await writeAuditLog(tx, {
          actorId,
          action: 'user.updated',
          entityType: 'user',
          entityId: String(userId),
          before: {
            role: existing.role,
            thana: existing.thana,
            subDivision: existing.subDivision,
            designation: existing.designation,
          },
          after: { role: u.role, thana: u.thana, subDivision: u.subDivision, designation: u.designation },
        });
        await writeOutboxEvent(tx, {
          aggregateType: 'user',
          aggregateId: String(userId),
          eventType: 'user.updated',
          payload: userSyncPayload(u),
        });
        return u;
      });
      return toWireUser(updated);
    },
  };
}
