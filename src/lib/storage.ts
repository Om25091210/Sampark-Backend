import type { FastifyBaseLogger } from 'fastify';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
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
}

// Real AWS S3 storage. Bucket is private; reads are presigned GETs.
class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  private readonly client: S3Client;

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
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
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
