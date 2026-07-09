import { z } from 'zod';

// Environment is parsed + validated exactly once, at boot (see server.ts).
// Never read process.env deep in the codebase — depend on the typed result of loadEnv().
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().url(),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // OTP
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  // SMS delivery. Only `mock` is implemented; `msg91` is a placeholder for a real
  // India-resident gateway wired in later.
  SMS_PROVIDER: z.enum(['mock', 'msg91']).default('mock'),

  // Media storage (report photos + PDF exports). `mock` keeps objects in-process and
  // returns deterministic fake URLs (dev/test); `s3` uses AWS S3 in ap-south-1
  // (data-residency rule). AWS credentials come from the SDK's default chain.
  STORAGE_PROVIDER: z.enum(['mock', 's3']).default('mock'),
  S3_BUCKET: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).default('ap-south-1'),
  // Presigned-GET lifetime for returned media URLs. 7 days is the SigV4 maximum.
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().positive().max(604800).default(604800),
  // Hard cap on an uploaded photo (bytes). Default 10 MB.
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Fail fast: a misconfigured process must not start.
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

// The subset of config the app internals depend on (decorated as `app.config`).
export interface AppConfig {
  nodeEnv: Env['NODE_ENV'];
  jwtSecret: string;
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
  otpTtlSeconds: number;
  otpLength: number;
  otpMaxAttempts: number;
  smsProvider: Env['SMS_PROVIDER'];
  storageProvider: Env['STORAGE_PROVIDER'];
  s3Bucket?: string;
  s3Region: string;
  mediaUrlTtlSeconds: number;
  uploadMaxBytes: number;
}

export function toAppConfig(env: Env): AppConfig {
  return {
    nodeEnv: env.NODE_ENV,
    jwtSecret: env.JWT_SECRET,
    accessTokenTtl: env.ACCESS_TOKEN_TTL,
    refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    otpTtlSeconds: env.OTP_TTL_SECONDS,
    otpLength: env.OTP_LENGTH,
    otpMaxAttempts: env.OTP_MAX_ATTEMPTS,
    smsProvider: env.SMS_PROVIDER,
    storageProvider: env.STORAGE_PROVIDER,
    s3Bucket: env.S3_BUCKET,
    s3Region: env.S3_REGION,
    mediaUrlTtlSeconds: env.MEDIA_URL_TTL_SECONDS,
    uploadMaxBytes: env.UPLOAD_MAX_BYTES,
  };
}
