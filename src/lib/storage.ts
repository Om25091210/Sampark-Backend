import type { FastifyBaseLogger } from 'fastify';
import { S3Client, PutObjectCommand, GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from '../config/env.js';

// Provider-agnostic object storage (report photos + PDF exports). Production wires
// in AWS S3 in ap-south-1 (data-residency rule); dev/test uses the in-process mock,
// selected by STORAGE_PROVIDER. Objects live in a private bucket; reads are handed
// out as time-limited presigned GET URLs (never public objects).
export interface StoredObject {
  body: Buffer;
  contentType: string;
}

export interface StorageProvider {
  readonly name: string;
  /** Stores an object at `key`. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Returns a time-limited URL a client can GET to read the object. */
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  /**
   * Reads an object's raw bytes server-side. ADR-058: the cadre Sheet export
   * downloads photo bytes directly (never a presigned URL, which would rot
   * past the mirror sheet's browse window) and hands them to Apps Script as
   * base64 for `Sheet.insertImage()`. Returns null when the key doesn't
   * exist — a missing photo is a per-row skip, never a thrown error.
   */
  getObject(key: string): Promise<StoredObject | null>;
}

// In-process store: keeps objects in a Map and returns deterministic fake URLs.
// Used in development and tests so no AWS credentials or network are needed.
export class MockStorageProvider implements StorageProvider {
  readonly name = 'mock';
  readonly objects = new Map<string, StoredObject>();

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { body, contentType });
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    // Deterministic, obviously-fake URL carrying the same query shape as a real
    // presign, so client/UX code can treat both identically.
    return `https://mock-storage.local/${key}?X-Amz-Expires=${expiresInSeconds}`;
  }

  async getObject(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }
}

// Real AWS S3 storage. Bucket is private; reads are presigned GETs.
class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  private readonly client: S3Client;

  // This task (जेल/जमानत performance follow-up). In-process cache of presigned
  // GET URLs, keyed by object key. Every cadre in a full `/sync/pull` (and every
  // page of `GET /cadres`) gets re-presigned unconditionally, uncached — at
  // ~8,600 cadres (~56% carrying a photo) that is thousands of real AWS SDK v3
  // signing calls per full sync. Confirmed the cost is the SDK's per-call
  // overhead, not the DB query: an identical `pull()` against MockStorageProvider
  // at a comparable row count (9,000 cadres, local) ran ~6x faster than
  // production's real-S3 run at ~8,600. Presigning never touches the network —
  // it's a pure local signature computation — so caching the RESULT (not the
  // object) is safe: a cached URL is byte-identical in what it authorizes to a
  // freshly-signed one for the same key, and (ADR-016) the object at a key is
  // never mutated in place, so there is no staleness to worry about either way.
  // Cached for at most half the real TTL (capped at 10 minutes) so a served URL
  // is never close to its own expiry by the time a client uses it.
  private readonly presignCache = new Map<string, { url: string; expiresAt: number }>();

  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    // Credentials resolve via the SDK's default provider chain (env / instance role).
    this.client = new S3Client({ region });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    const now = Date.now();
    const cached = this.presignCache.get(key);
    if (cached !== undefined && cached.expiresAt > now) return cached.url;

    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
    const cacheMs = Math.min(expiresInSeconds * 1000 * 0.5, 10 * 60 * 1000);
    this.presignCache.set(key, { url, expiresAt: now + cacheMs });
    return url;
  }

  async getObject(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (res.Body === undefined) return null;
      const bytes = await res.Body.transformToByteArray();
      return { body: Buffer.from(bytes), contentType: res.ContentType ?? 'application/octet-stream' };
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }
}

export function createStorageProvider(config: AppConfig, log: FastifyBaseLogger): StorageProvider {
  switch (config.storageProvider) {
    case 's3': {
      if (config.s3Bucket === undefined) {
        // Fail fast: an s3-configured process without a bucket is misconfigured.
        throw new Error('STORAGE_PROVIDER=s3 requires S3_BUCKET to be set');
      }
      log.info({ bucket: config.s3Bucket, region: config.s3Region }, 'storage: using S3');
      return new S3StorageProvider(config.s3Bucket, config.s3Region);
    }
    case 'mock':
    default:
      return new MockStorageProvider();
  }
}
