import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';
import { makeCadreExportService } from './cadre-export.service.js';
import { MockSheetsSyncProvider } from '../../lib/sheets-sync.js';
import { MockStorageProvider } from '../../lib/storage.js';

const prisma = new PrismaClient();
const config = testConfig();

const TOKEN = 'CDREXPORT';
const SA_ID = `${TOKEN}_SA`;
const OFF_ID = `${TOKEN}_OFF`;
const NAME_1 = `${TOKEN}_ONE`;
const NAME_2 = `${TOKEN}_TWO`;

let saId = 0;
let offId = 0;
let saToken = '';
let officerToken = '';
let cadre1Id = 0;
let cadre2Id = 0;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const makeApp = (opts: { sheetsSync?: MockSheetsSyncProvider } = {}): Promise<FastifyInstance> =>
  buildApp({ config, prisma, logger: false, sheetsSync: opts.sheetsSync ?? new MockSheetsSyncProvider() });

const silentLog = { warn: () => undefined, info: () => undefined } as unknown as import('fastify').FastifyBaseLogger;

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { name: { in: [SA_ID, OFF_ID] } } });
  const sa = await prisma.user.create({ data: { name: SA_ID, role: 'super_admin' } });
  const off = await prisma.user.create({ data: { name: OFF_ID, role: 'officer', thana: 'बीजापुर सदर' } });
  saId = sa.id;
  offId = off.id;
  saToken = await signAccessToken({ sub: saId, role: 'super_admin' }, config.jwtSecret, '15m');
  officerToken = await signAccessToken({ sub: offId, role: 'officer' }, config.jwtSecret, '15m');

  await prisma.cadre.deleteMany({ where: { name: { in: [NAME_1, NAME_2] } } });
  const c1 = await prisma.cadre.create({
    data: {
      serialNumber: `${TOKEN}-1`,
      name: NAME_1,
      phone: '+919999900001',
      thana: 'बीजापुर सदर',
      currentAddress: 'test address 1',
      designation: 'test',
      category: 'surrendered',
      alertLevel: 'normal',
      aliases: [],
      avatarKey: `cadres/${TOKEN}/avatar.jpg`,
      assignedOfficerId: offId,
    },
  });
  const c2 = await prisma.cadre.create({
    data: {
      serialNumber: `${TOKEN}-2`,
      name: NAME_2,
      phone: '+919999900002',
      thana: 'बीजापुर सदर',
      currentAddress: 'test address 2',
      designation: 'test',
      category: 'thana',
      alertLevel: 'warning',
      aliases: [],
    },
  });
  cadre1Id = c1.id;
  cadre2Id = c2.id;
});

afterAll(async () => {
  await prisma.syncLog.deleteMany({ where: { eventType: 'cadre.export' } });
  await prisma.auditLog.deleteMany({ where: { entityType: 'cadre_export' } });
  await prisma.notification.deleteMany({ where: { userId: { in: [saId, offId] } } });
  await prisma.cadre.deleteMany({ where: { id: { in: [cadre1Id, cadre2Id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [saId, offId] } } });
  await prisma.$disconnect();
});

describe('cadre export service (ADR-058) - called directly, mirroring outbox.worker.test.ts', () => {
  it('chunks the roster, embeds the avatar for the row that has one, and writes a success SyncLog row', async () => {
    const storage = new MockStorageProvider();
    const imageBytes = Buffer.from('fake-jpeg-bytes');
    await storage.put(`cadres/${TOKEN}/avatar.jpg`, imageBytes, 'image/jpeg');

    const sheetsSync = new MockSheetsSyncProvider();
    const service = makeCadreExportService({ prisma, storage, sheetsSync, log: silentLog, chunkSize: 1 });

    await service.runExport(saId);

    // chunkSize=1 forces one call per cadre in the whole (shared) table -- filter down
    // to OUR rows only, since other test files' cadre fixtures share this DB.
    const ourCalls = sheetsSync.calls.filter((c) => {
      const rows = (c.payload as { rows: Array<{ name: string }> }).rows;
      return rows.some((r) => r.name === NAME_1 || r.name === NAME_2);
    });
    const ourRows = ourCalls.flatMap((c) => (c.payload as { rows: Array<Record<string, unknown>> }).rows);
    const row1 = ourRows.find((r) => r.name === NAME_1);
    const row2 = ourRows.find((r) => r.name === NAME_2);

    expect(row1).toBeDefined();
    expect(row1!.serialNumber).toBe(`${TOKEN}-1`);
    expect(row1!.assignedOfficerName).toBe(OFF_ID);
    expect(row1!.avatarBase64).toBe(imageBytes.toString('base64'));
    expect(row1!.avatarContentType).toBe('image/jpeg');

    expect(row2).toBeDefined();
    expect(row2!.avatarBase64).toBeUndefined(); // no avatarKey on this cadre

    const logRow = await prisma.syncLog.findFirst({
      where: { eventType: 'cadre.export' },
      orderBy: { id: 'desc' },
    });
    expect(logRow).not.toBeNull();
    expect(logRow!.status).toBe('success');

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'cadre_export', action: 'cadre.export_triggered' },
      orderBy: { id: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(saId);
  });

  it('a rejected chunk (ok: false) is logged as an error row and does not abort the rest of the run', async () => {
    const storage = new MockStorageProvider();
    const sheetsSync = new MockSheetsSyncProvider();
    sheetsSync.response = { ok: false, error: 'unauthorized' };
    const service = makeCadreExportService({ prisma, storage, sheetsSync, log: silentLog, chunkSize: 1 });

    await service.runExport(saId);

    const logRow = await prisma.syncLog.findFirst({
      where: { eventType: 'cadre.export' },
      orderBy: { id: 'desc' },
    });
    expect(logRow).not.toBeNull();
    expect(logRow!.status).toBe('error');
  });

  it('preview() proxies the sheets-sync cadre.preview call verbatim', async () => {
    const storage = new MockStorageProvider();
    const sheetsSync = new MockSheetsSyncProvider();
    sheetsSync.response = { ok: true, rows: [{ serialNumber: 'x' }] };
    const service = makeCadreExportService({ prisma, storage, sheetsSync, log: silentLog });

    const result = await service.preview();
    expect(result).toEqual({ ok: true, rows: [{ serialNumber: 'x' }] });
    expect(sheetsSync.calls[sheetsSync.calls.length - 1]!.action).toBe('cadre.preview');
  });
});

describe('POST /cadres/export-to-sheet, GET /cadres/sheet-preview (ADR-058)', () => {
  it('401s unauthenticated, 403s a non-super_admin, for both routes', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'POST', url: '/api/v1/cadres/export-to-sheet' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/cadres/sheet-preview' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({ method: 'POST', url: '/api/v1/cadres/export-to-sheet', headers: auth(officerToken) })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/cadres/sheet-preview', headers: auth(officerToken) })).statusCode,
    ).toBe(403);
    await app.close();
  });

  it('a super_admin POST returns 202 immediately (fire-and-forget)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/cadres/export-to-sheet', headers: auth(saToken) });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { status: string }).status).toBe('started');
    await app.close();
  });

  it('GET /cadres/sheet-preview proxies the sheets-sync response', async () => {
    const sheetsSync = new MockSheetsSyncProvider();
    sheetsSync.response = { ok: true, rows: [{ serialNumber: 'preview-row' }] };
    const app = await makeApp({ sheetsSync });
    const res = await app.inject({ method: 'GET', url: '/api/v1/cadres/sheet-preview', headers: auth(saToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, rows: [{ serialNumber: 'preview-row' }] });
    await app.close();
  });
});
