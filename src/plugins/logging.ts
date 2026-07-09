import type { FastifyServerOptions } from 'fastify';

// Secrets and PII must never reach the logs.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.passwordHash',
  '*.totpSecret',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.otp',
];

/**
 * Pino logger configuration for the Fastify instance. Structured JSON in
 * production/test; pretty-printed in development. A per-request id is attached
 * by the app's `genReqId` (see app.ts).
 */
export function loggerOptions(nodeEnv: string): FastifyServerOptions['logger'] {
  const redact = { paths: REDACT_PATHS, censor: '[REDACTED]' };

  if (nodeEnv === 'development') {
    return {
      level: 'debug',
      redact,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      },
    };
  }

  return { level: nodeEnv === 'test' ? 'silent' : 'info', redact };
}
