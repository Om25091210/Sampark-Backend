import type { FastifyBaseLogger } from 'fastify';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { writeAuditLog } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { importUserRow, type ImportUserRow } from './users.schema.js';

export interface UsersDeps {
  prisma: PrismaClient;
  log: FastifyBaseLogger;
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
  };
}
