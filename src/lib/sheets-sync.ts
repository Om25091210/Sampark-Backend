import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/env.js';

// ADR-057/058. Sheet sync is a thin HTTP client to a single Apps Script Web App
// deployment (see B-Smart.gs's doPost) -- NOT the Sheets API, no GCP project, no
// service account, no `googleapis` dependency. Om corrected the original design
// directly: "i think here we dont require gcp project right." One shared
// deployment, action-routed by the `action` field.
//
// The deployment URL lives in Postgres (ConfigEntry, ADR-059 SS1) and can change at
// runtime via PATCH /config without a redeploy -- so it is read FRESH on every call,
// never cached across calls. The shared-secret key IS static process config
// (SYNC_API_KEY env var), same posture as IMPORT_API_KEY: rotating it needs a
// redeploy either way, and that is an accepted, already-established trade-off.
export type SheetsSyncAction = 'user.sync' | 'cadre.export' | 'cadre.preview';

export interface SheetsSyncResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface SheetsSyncProvider {
  readonly name: string;
  call(action: SheetsSyncAction, payload: unknown): Promise<SheetsSyncResult>;
}

// Thrown when the deployment URL isn't configured yet (ADR-059: nothing here until
// a super_admin sets it via PATCH /config). Callers treat this as "not yet wired
// up", distinct from a transient network failure worth retrying immediately.
export class SheetsSyncNotConfiguredError extends Error {
  constructor() {
    super('sheets sync URL is not configured (PATCH /config)');
    this.name = 'SheetsSyncNotConfiguredError';
  }
}

// In-process provider: records every call, returns a canned/injectable response.
// Used in development and tests so no network call is ever made -- mirrors
// MockPushProvider/MockStorageProvider's shape exactly.
export class MockSheetsSyncProvider implements SheetsSyncProvider {
  readonly name = 'mock';
  readonly calls: Array<{ action: SheetsSyncAction; payload: unknown }> = [];
  response: SheetsSyncResult = { ok: true };

  async call(action: SheetsSyncAction, payload: unknown): Promise<SheetsSyncResult> {
    this.calls.push({ action, payload });
    return this.response;
  }
}

// Real HTTP client. The key travels as a JSON body field, not an Authorization
// header -- Apps Script Web Apps don't expose custom request headers to doPost(e).
// Apps Script's ContentService responses also have no real HTTP status control, so
// the JSON body's own `ok`/`error` fields are the only signal; a non-2xx or a
// malformed body is treated as a failure the same way a body-level `ok: false` is.
class HttpSheetsSyncProvider implements SheetsSyncProvider {
  readonly name = 'http';

  constructor(
    private readonly prisma: PrismaClient,
    private readonly apiKey: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  async call(action: SheetsSyncAction, payload: unknown): Promise<SheetsSyncResult> {
    const config = await this.prisma.configEntry.findUnique({ where: { id: 1 } });
    const url = config?.sheetsSyncUrl;
    if (url === null || url === undefined || url === '') {
      throw new SheetsSyncNotConfiguredError();
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: this.apiKey, action, payload }),
      });
    } catch (err) {
      this.log.warn({ err, action }, 'sheets sync HTTP call failed');
      return { ok: false, error: err instanceof Error ? err.message : 'network error' };
    }

    let body: SheetsSyncResult;
    try {
      body = (await res.json()) as SheetsSyncResult;
    } catch {
      return { ok: false, error: `non-JSON response (HTTP ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }
    return body;
  }
}

export function createSheetsSyncProvider(
  config: AppConfig,
  prisma: PrismaClient,
  log: FastifyBaseLogger,
): SheetsSyncProvider {
  switch (config.sheetsSyncProvider) {
    case 'http': {
      if (config.syncApiKey === undefined) {
        // Fail fast: an http-configured process without a key is misconfigured.
        throw new Error('SHEETS_SYNC_PROVIDER=http requires SYNC_API_KEY to be set');
      }
      log.info({}, 'sheets sync: using http (Apps Script Web App)');
      return new HttpSheetsSyncProvider(prisma, config.syncApiKey, log);
    }
    case 'mock':
    default:
      return new MockSheetsSyncProvider();
  }
}
