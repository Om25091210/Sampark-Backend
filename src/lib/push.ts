import type { FastifyBaseLogger } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  SNSClient,
  CreatePlatformEndpointCommand,
  PublishCommand,
  DeleteEndpointCommand,
  EndpointDisabledException,
} from '@aws-sdk/client-sns';
import type { AppConfig } from '../config/env.js';

// ADR-048. Real push delivery via AWS SNS Mobile Push (FCM V1 credentials). Mirrors
// lib/storage.ts's Mock/Real provider-class shape exactly. Production wires in AWS SNS
// in ap-south-1; dev/test uses the in-process mock, selected by PUSH_PROVIDER.
export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushProvider {
  readonly name: string;
  /** Idempotent per token — SNS's CreatePlatformEndpoint returns the same ARN for a
   *  token it has already seen. Safe to call on every login. */
  createEndpoint(token: string): Promise<{ endpointArn: string }>;
  publish(endpointArn: string, msg: PushMessage): Promise<void>;
  deleteEndpoint(endpointArn: string): Promise<void>;
}

// Thrown by SnsPushProvider.publish when the endpoint is confirmed gone (the device
// uninstalled, or the token rotated) — the caller prunes the DeviceToken row rather
// than retrying forever. Provider-agnostic so call sites never import an AWS SDK type.
export class PushEndpointDisabledError extends Error {
  constructor(public readonly endpointArn: string) {
    super(`push endpoint disabled: ${endpointArn}`);
    this.name = 'PushEndpointDisabledError';
  }
}

// In-process provider: deterministic fake ARNs, logs only. Used in development and
// tests so no AWS credentials or network are needed.
export class MockPushProvider implements PushProvider {
  readonly name = 'mock';
  readonly arnByToken = new Map<string, string>();

  async createEndpoint(token: string): Promise<{ endpointArn: string }> {
    let endpointArn = this.arnByToken.get(token);
    if (endpointArn === undefined) {
      endpointArn = `arn:aws:sns:mock:000000000000:endpoint/GCM/sampark-mock/${randomUUID()}`;
      this.arnByToken.set(token, endpointArn);
    }
    return { endpointArn };
  }

  async publish(endpointArn: string, msg: PushMessage): Promise<void> {
    // No log dependency here — tests construct this provider directly and assert on
    // calls, not log output (mirrors how MockStorageProvider stays silent too).
    void endpointArn;
    void msg;
  }

  async deleteEndpoint(endpointArn: string): Promise<void> {
    for (const [token, arn] of this.arnByToken) if (arn === endpointArn) this.arnByToken.delete(token);
  }
}

// Real AWS SNS Mobile Push, backed by FCM V1 credentials on the platform application.
class SnsPushProvider implements PushProvider {
  readonly name = 'sns';
  private readonly client: SNSClient;

  constructor(
    private readonly platformApplicationArn: string,
    region: string,
    private readonly log: FastifyBaseLogger,
  ) {
    // Credentials resolve via the SDK's default provider chain (ECS task IAM role).
    this.client = new SNSClient({ region });
  }

  async createEndpoint(token: string): Promise<{ endpointArn: string }> {
    const res = await this.client.send(
      new CreatePlatformEndpointCommand({
        PlatformApplicationArn: this.platformApplicationArn,
        Token: token,
      }),
    );
    if (res.EndpointArn === undefined) {
      throw new Error('SNS CreatePlatformEndpoint returned no EndpointArn');
    }
    return { endpointArn: res.EndpointArn };
  }

  async publish(endpointArn: string, msg: PushMessage): Promise<void> {
    // FCM V1 envelope. Data values must be strings (FCM's data-message contract);
    // stringify here once so every call site gets it free.
    const stringData =
      msg.data !== undefined
        ? Object.fromEntries(Object.entries(msg.data).map(([k, v]) => [k, String(v)]))
        : undefined;
    const fcmV1Message = {
      message: {
        notification: { title: msg.title, body: msg.body },
        ...(stringData !== undefined ? { data: stringData } : {}),
      },
    };
    try {
      await this.client.send(
        new PublishCommand({
          TargetArn: endpointArn,
          MessageStructure: 'json',
          Message: JSON.stringify({ default: msg.body, GCM: JSON.stringify(fcmV1Message) }),
        }),
      );
    } catch (err) {
      if (err instanceof EndpointDisabledException) {
        throw new PushEndpointDisabledError(endpointArn);
      }
      this.log.error({ err, endpointArn }, 'SNS publish failed');
      throw err;
    }
  }

  async deleteEndpoint(endpointArn: string): Promise<void> {
    try {
      await this.client.send(new DeleteEndpointCommand({ EndpointArn: endpointArn }));
    } catch (err) {
      // Best-effort — a device already gone from SNS is not a failure the caller
      // (usually a logout flow) should be blocked on.
      this.log.warn({ err, endpointArn }, 'SNS delete endpoint failed (ignored)');
    }
  }
}

export function createPushProvider(config: AppConfig, log: FastifyBaseLogger): PushProvider {
  switch (config.pushProvider) {
    case 'sns': {
      if (config.snsPlatformApplicationArn === undefined) {
        // Fail fast: an sns-configured process without a platform application is misconfigured.
        throw new Error('PUSH_PROVIDER=sns requires SNS_PLATFORM_APPLICATION_ARN to be set');
      }
      log.info({ platformApplicationArn: config.snsPlatformApplicationArn }, 'push: using SNS');
      return new SnsPushProvider(config.snsPlatformApplicationArn, config.s3Region, log);
    }
    case 'mock':
    default:
      return new MockPushProvider();
  }
}
