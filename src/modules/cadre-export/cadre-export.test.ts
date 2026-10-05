import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { signAccessToken } from '../../lib/tokens.js';
import { makeCadreExportService } from './cadre-export.service.js';
import { resolveMirrorTab } from './cadre-export.tabs.js';
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
      if (c.action !== 'cadre.export') return false; // the finish call carries no rows
      const rows = (c.payload as { rows: Array<{ name: string }> }).rows;
      return rows.some((r) => r.name === NAME_1 || r.name === NAME_2);
    });
    const ourRows = ourCalls.flatMap((c) => (c.payload as { rows: Array<Record<string, unknown>> }).rows);
    const row1 = ourRows.find((r) => r.name === NAME_1);
    const row2 = ourRows.find((r) => r.name === NAME_2);

    expect(row1).toBeDefined();
    expect(row1!.serialNumber).toBe(`${TOKEN}-1`);
    // The upsert key is the cadre's id, and each row names its category tab.
    expect(row1!.cadreId).toBe(cadre1Id);
    expect(row1!.tab).toBe('Cadre-Unclassified'); // surrendered, no origin set on the fixture
    expect(row1!.assignedOfficerName).toBe(OFF_ID);
    expect(row1!.avatarBase64).toBe(imageBytes.toString('base64'));
    expect(row1!.avatarContentType).toBe('image/jpeg');

    expect(row2).toBeDefined();
    expect(row2!.cadreId).toBe(cadre2Id);
    expect(row2!.tab).toBe('Cadre-Thana');
    expect(row2!.avatarBase64).toBeUndefined(); // no avatarKey on this cadre

    const logRow = await prisma.syncLog.findFirst({
      where: { eventType: 'cadre.export' },
      orderBy: { id: 'desc' },
    });
    expect(logRow).not.toBeNull();
    expect(logRow!.status).toBe('success');
    // The log keeps counts + a bounded error sample, not one entry per cadre.
    const detail = logRow!.detail as { total: number; errors: number; byTab: Record<string, number> };
    expect(detail.errors).toBe(0);
    expect(detail.byTab['Cadre-Thana']).toBeGreaterThanOrEqual(1);

    // A clean run ends with the stale-row pass, carrying this run's start stamp.
    const finishCall = sheetsSync.calls.find((c) => c.action === 'cadre.export.finish');
    expect(finishCall).toBeDefined();
    expect((finishCall!.payload as { runStartedAt: string }).runStartedAt).toBe(row1!.syncedAt);

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
    // After a partial run a missing stamp may just be a failed chunk, so the stale-row
    // pass must NOT run -- it would wrongly flag healthy rows as removed.
    expect(sheetsSync.calls.some((c) => c.action === 'cadre.export.finish')).toBe(false);
  });

  it('a second run is refused with 409 EXPORT_RUNNING while one is in flight, and allowed again after it ends', async () => {
    const storage = new MockStorageProvider();
    const sheetsSync = new MockSheetsSyncProvider();
    const service = makeCadreExportService({ prisma, storage, sheetsSync, log: silentLog });

    const first = await service.begin(saId);
    await expect(service.begin(saId)).rejects.toMatchObject({ statusCode: 409, code: 'EXPORT_RUNNING' });

    await service.execute(first);
    const second = await service.begin(saId); // slot is free again
    await service.execute(second);
  });

  it('a crashed run (running row older than the stale window) does not block a new run', async () => {
    const stale = await prisma.syncLog.create({
      data: {
        eventType: 'cadre.export',
        status: 'running',
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      },
    });
    const service = makeCadreExportService({
      prisma,
      storage: new MockStorageProvider(),
      sheetsSync: new MockSheetsSyncProvider(),
      log: silentLog,
    });
    const handle = await service.begin(saId);
    await service.execute(handle);
    await prisma.syncLog.delete({ where: { id: stale.id } });
  });

  it('one failed avatar download skips only that image, not the row or its chunk', async () => {
    const storage = new MockStorageProvider();
    storage.getObject = async () => {
      throw new Error('S3 timeout');
    };
    const sheetsSync = new MockSheetsSyncProvider();
    const service = makeCadreExportService({ prisma, storage, sheetsSync, log: silentLog });

    await service.runExport(saId);

    const rows = sheetsSync.calls
      .filter((c) => c.action === 'cadre.export')
      .flatMap((c) => (c.payload as { rows: Array<Record<string, unknown>> }).rows);
    const row1 = rows.find((r) => r.name === NAME_1);
    expect(row1).toBeDefined();
    expect(row1!.avatarBase64).toBeUndefined();
    const logRow = await prisma.syncLog.findFirst({ where: { eventType: 'cadre.export' }, orderBy: { id: 'desc' } });
    expect(logRow!.status).toBe('success');
  });

  it('rows the sheet kept because of unpushed edits are counted, and are not an error', async () => {
    const sheetsSync = new MockSheetsSyncProvider();
    sheetsSync.response = { ok: true, skippedEdited: 2 };
    const service = makeCadreExportService({
      prisma,
      storage: new MockStorageProvider(),
      sheetsSync,
      log: silentLog,
      chunkSize: 1,
    });
    await service.runExport(saId);
    const logRow = await prisma.syncLog.findFirst({ where: { eventType: 'cadre.export' }, orderBy: { id: 'desc' } });
    expect(logRow!.status).toBe('success');
    // chunkSize 1 => one call per cadre in the shared table, each reporting 2.
    expect((logRow!.detail as { skippedEdited: number }).skippedEdited).toBeGreaterThanOrEqual(2);
  });

  it('rows the sheet reports as rejected make the run an error', async () => {
    const sheetsSync = new MockSheetsSyncProvider();
    sheetsSync.response = { ok: true, rejected: [{ cadreId: cadre1Id, error: 'unknown tab' }] };
    const service = makeCadreExportService({
      prisma,
      storage: new MockStorageProvider(),
      sheetsSync,
      log: silentLog,
    });
    await service.runExport(saId);
    const logRow = await prisma.syncLog.findFirst({ where: { eventType: 'cadre.export' }, orderBy: { id: 'desc' } });
    expect(logRow!.status).toBe('error');
    expect((logRow!.detail as { errorSamples: Array<{ error: string }> }).errorSamples[0]!.error).toBe('unknown tab');
  });

  it('preview() forwards the tab and limit to the sheets-sync cadre.preview call', async () => {
    const storage = new MockStorageProvider();
    const sheetsSync = new MockSheetsSyncProvider();
    sheetsSync.response = { ok: true, tabs: [], rows: [{ serialNumber: 'x' }] };
    const service = makeCadreExportService({ prisma, storage, sheetsSync, log: silentLog });

    const result = await service.preview({ tab: 'Cadre-Thana', limit: 10 });
    expect(result).toEqual({ ok: true, tabs: [], rows: [{ serialNumber: 'x' }] });
    const last = sheetsSync.calls[sheetsSync.calls.length - 1]!;
    expect(last.action).toBe('cadre.preview');
    expect(last.payload).toEqual({ tab: 'Cadre-Thana', limit: 10 });
  });
});

describe('resolveMirrorTab (ADR-067)', () => {
  const tab = (category: string, surrenderOrigin: string | null = null, otherOriginType: string | null = null) =>
    resolveMirrorTab({ category, surrenderOrigin, otherOriginType });

  it('maps every create-form choice to its own tab', () => {
    expect(tab('surrendered', 'district')).toBe('Cadre-Surrendered');
    expect(tab('surrendered', 'other', 'other_district')).toBe('Cadre-OtherDistrict');
    expect(tab('surrendered', 'other', 'other_state')).toBe('Cadre-OtherState');
    expect(tab('thana')).toBe('Cadre-Thana');
    expect(tab('jail')).toBe('Cadre-Jail');
  });

  it('puts incompletely classified surrendered rows in Unclassified instead of dropping them', () => {
    expect(tab('surrendered')).toBe('Cadre-Unclassified');
    expect(tab('surrendered', 'other')).toBe('Cadre-Unclassified'); // origin other, no sub-type
    expect(tab('something-new')).toBe('Cadre-Unclassified');
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
    // Exactly what the web's startCadreSheetExport() sends: apiFetch always sets
    // content-type: application/json, and Fastify 400s an EMPTY body under that header,
    // so the web posts `{}` rather than nothing.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cadres/export-to-sheet',
      headers: { ...auth(saToken), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect((res.json() as { status: string }).status).toBe('started');
    await app.close();
  });

  it('409s a POST while an export is already running', async () => {
    // Insert the in-flight row directly: the earlier test's background run may or may
    // not have finished, and either way a running row must block.
    const inFlight = await prisma.syncLog.create({ data: { eventType: 'cadre.export', status: 'running' } });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/cadres/export-to-sheet', headers: auth(saToken) });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('EXPORT_RUNNING');
    await prisma.syncLog.delete({ where: { id: inFlight.id } });
    await app.close();
  });

  it('GET /cadres/sheet-preview proxies the sheets-sync response and forwards tab/limit', async () => {
    const sheetsSync = new MockSheetsSyncProvider();
    sheetsSync.response = { ok: true, rows: [{ serialNumber: 'preview-row' }] };
    const app = await makeApp({ sheetsSync });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cadres/sheet-preview?tab=Cadre-Jail&limit=5',
      headers: auth(saToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, rows: [{ serialNumber: 'preview-row' }] });
    expect(sheetsSync.calls[sheetsSync.calls.length - 1]!.payload).toEqual({ tab: 'Cadre-Jail', limit: 5 });
    await app.close();
  });

  it('GET /cadres/sheet-preview rejects an unknown tab and an oversized limit', async () => {
    const app = await makeApp();
    const bad = await app.inject({ method: 'GET', url: '/api/v1/cadres/sheet-preview?tab=Evil', headers: auth(saToken) });
    expect(bad.statusCode).toBe(400);
    const big = await app.inject({ method: 'GET', url: '/api/v1/cadres/sheet-preview?limit=9999', headers: auth(saToken) });
    expect(big.statusCode).toBe(400);
    await app.close();
  });
});
