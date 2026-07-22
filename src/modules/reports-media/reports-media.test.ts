import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { testConfig } from '../../test/helpers.js';
import { MockStorageProvider } from '../../lib/storage.js';
import { signAccessToken } from '../../lib/tokens.js';

const prisma = new PrismaClient();
const config = testConfig();
const PHONES = ['+919000000040', '+919000000041', '+919000000042'];
const CADRE_NAME = 'TEST CADRE REPORTS MEDIA';

let officerId = 0;
let adminId = 0;
let viewerId = 0;
let cadreId = 0;
let officerToken = '';
let adminToken = '';
let viewerToken = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

// Fresh app per test with an injected in-process storage we can inspect.
async function makeApp(storage = new MockStorageProvider()): Promise<{ app: FastifyInstance; storage: MockStorageProvider }> {
  const app = await buildApp({ config, prisma, storage, logger: false });
  return { app, storage };
}

// Builds a single-file multipart/form-data body by hand (no form-data dep).
function multipartFile(
  field: string,
  filename: string,
  contentType: string,
  content: Buffer,
): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----samparktest${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

// Minimal JPEG-ish payload; mimetype comes from the multipart header, not sniffing.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

beforeAll(async () => {
  const officer = await prisma.user.upsert({
    // ADR-044: posted to the fixture cadre's station.
    where: { phone: PHONES[0] },
    update: { deletedAt: null, role: 'officer', name: 'Media Officer', thana: 'बीजापुर' },
    create: { phone: PHONES[0]!, name: 'Media Officer', role: 'officer', thana: 'बीजापुर' },
  });
  const admin = await prisma.user.upsert({
    // ADR-044: the PDF export is a cadre read, so this SDOP needs the cadre's sub-division.
    where: { phone: PHONES[1] },
    update: { deletedAt: null, role: 'admin', name: 'Media Admin', subDivision: 'बीजापुर' },
    create: { phone: PHONES[1]!, name: 'Media Admin', role: 'admin', subDivision: 'बीजापुर' },
  });
  const viewer = await prisma.user.upsert({
    where: { phone: PHONES[2] }, update: { deletedAt: null, role: 'viewer', name: 'Media Viewer' },
    create: { phone: PHONES[2]!, name: 'Media Viewer', role: 'viewer' },
  });
  officerId = officer.id;
  adminId = admin.id;
  viewerId = viewer.id;

  await prisma.cadre.deleteMany({ where: { name: CADRE_NAME } });
  const cadre = await prisma.cadre.create({
    data: {
      name: CADRE_NAME, phone: '+910000000002', thana: 'बीजापुर',
      currentAddress: 'Test address', designation: 'Test', category: 'surrendered',
      alertLevel: 'normal', aliases: [], assignedOfficerId: officerId, avatarUrl: 'https://x/a.jpg',
    },
  });
  cadreId = cadre.id;

  officerToken = await signAccessToken({ sub: officerId, role: 'officer' }, config.jwtSecret, '15m');
  adminToken = await signAccessToken({ sub: adminId, role: 'admin' }, config.jwtSecret, '15m');
  viewerToken = await signAccessToken({ sub: viewerId, role: 'viewer' }, config.jwtSecret, '15m');
});

// Reports are created by some tests; clean them (and audit/outbox) between tests.
async function purgeReports(): Promise<void> {
  const rows = await prisma.report.findMany({ where: { cadreId }, select: { id: true } });
  const ids = rows.map((r) => String(r.id));
  if (ids.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'report', entityId: { in: ids } } });
    await prisma.outboxEvent.deleteMany({ where: { aggregateType: 'report', aggregateId: { in: ids } } });
  }
  await prisma.report.deleteMany({ where: { cadreId } });
}

afterEach(purgeReports);

afterAll(async () => {
  await purgeReports();
  await prisma.cadre.deleteMany({ where: { id: cadreId } });
  await prisma.user.deleteMany({ where: { phone: { in: PHONES } } });
  await prisma.$disconnect();
});

describe('reports-media — photo upload', () => {
  it('rejects an unauthenticated upload → 401', async () => {
    const { app } = await makeApp();
    const mp = multipartFile('file', 'photo.jpg', 'image/jpeg', JPEG);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports/upload`, headers: mp.headers, payload: mp.body,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('forbids upload for viewers → 403', async () => {
    const { app } = await makeApp();
    const mp = multipartFile('file', 'photo.jpg', 'image/jpeg', JPEG);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports/upload`,
      headers: { ...auth(viewerToken), ...mp.headers }, payload: mp.body,
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('rejects an unsupported file type → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const { app } = await makeApp();
    const mp = multipartFile('file', 'note.txt', 'text/plain', Buffer.from('hello'));
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports/upload`,
      headers: { ...auth(officerToken), ...mp.headers }, payload: mp.body,
    });
    expect(res.statusCode).toBe(415);
    expect((res.json() as { error: { code: string } }).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    await app.close();
  });

  it('uploads a JPEG (officer) → 200 { key, url } and stores the object', async () => {
    const { app, storage } = await makeApp();
    const mp = multipartFile('file', 'photo.jpg', 'image/jpeg', JPEG);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/cadres/${cadreId}/reports/upload`,
      headers: { ...auth(officerToken), ...mp.headers }, payload: mp.body,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { key: string; url: string };
    expect(typeof body.url).toBe('string');
    expect(body.url).toContain(`reports/cadre-${cadreId}/`);
    // ADR-016: the durable key is returned so the client can persist it.
    expect(body.key).toMatch(new RegExp(`^reports/cadre-${cadreId}/.+\\.jpg$`));
    // Exactly one object was stored, with the JPEG bytes + content type.
    expect(storage.objects.size).toBe(1);
    const [key, obj] = [...storage.objects.entries()][0]!;
    expect(key).toBe(body.key);
    expect(key.startsWith(`reports/cadre-${cadreId}/`)).toBe(true);
    expect(obj.contentType).toBe('image/jpeg');
    expect(obj.body.equals(JPEG)).toBe(true);
    await app.close();
  });

  it('uploads against an unknown cadre → 404', async () => {
    const { app } = await makeApp();
    const mp = multipartFile('file', 'photo.jpg', 'image/jpeg', JPEG);
    const res = await app.inject({
      method: 'POST', url: '/api/v1/cadres/99999999/reports/upload',
      headers: { ...auth(officerToken), ...mp.headers }, payload: mp.body,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('reports-media — PDF export', () => {
  async function seedReport(): Promise<void> {
    await prisma.report.create({
      data: {
        cadreId, reportingPlace: 'village', specificLocation: 'गाँव चौक', personStatus: 'alive',
        currentPhone: '+919812345678', currentActivity: 'खेती कर रहा है', reportedById: officerId,
      },
    });
  }

  it('rejects an unauthenticated export → 401', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: `/api/v1/cadres/${cadreId}/reports/export` });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('forbids export for officers (admin+ only) → 403', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/cadres/${cadreId}/reports/export`, headers: auth(officerToken),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('exports a Hindi PDF (admin) → 200 { download_url } and stores a PDF object', async () => {
    await seedReport();
    const { app, storage } = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/cadres/${cadreId}/reports/export`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { download_url: string };
    expect(typeof body.download_url).toBe('string');
    expect(body.download_url).toContain(`exports/cadre-${cadreId}/`);
    // A single PDF object was stored, and it is a real PDF (starts with %PDF-).
    expect(storage.objects.size).toBe(1);
    const [, obj] = [...storage.objects.entries()][0]!;
    expect(obj.contentType).toBe('application/pdf');
    expect(obj.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await app.close();
  });

  it('exports even when the cadre has no reports → 200', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/cadres/${cadreId}/reports/export`, headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect(typeof (res.json() as { download_url: string }).download_url).toBe('string');
    await app.close();
  });

  it('exports an unknown cadre → 404', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/cadres/99999999/reports/export', headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
