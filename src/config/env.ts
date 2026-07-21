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

  // ADR-042 (amended). TOTP second factor for admin + super_admin.
  //
  // Temporarily DEFAULTED OFF at the client's request: enrolling 14 authenticator apps
  // was blocking the rollout, and they want every account on plain email+password until
  // TOTP is done properly. The TOTP code paths are intact and still tested — re-enabling
  // is this flag, not a rebuild. Flip the default back to 'true' (or set the env var)
  // when the client is ready.
  //
  // While this is 'false', admin/super_admin are single-factor like everyone else. That
  // is a real reduction in the control SDR-001 asked for; recorded in the ADR amendment.
  TOTP_ENABLED: z.enum(['true', 'false']).default('false'),

  // ADR-038 / SDR-007. Scoped machine credential for the unattended historical-import
  // job (Apps Script → POST /cadres/import). NOT a super_admin session: presenting it
  // authorizes that one route and nothing else. OPTIONAL — when unset, the key path is
  // simply disabled and the route accepts only an interactive super_admin JWT (the
  // dev/test path). Min length matches JWT_SECRET so a real key is never a weak string.
  IMPORT_API_KEY: z.string().min(32, 'IMPORT_API_KEY must be at least 32 characters').optional(),

  // ADR-042. OTP_* / SMS_PROVIDER / MOCK_OTP_ECHO are GONE. The SMS-OTP login track is
  // removed entirely in favour of email+password, so there is no OTP to size, no gateway
  // to select, and no staging escape hatch to echo a code. Terraform's `mock_otp_echo`
  // variable and its ECS env entry go with them.

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
  // ADR-038 / SDR-007. Machine credential for POST /cadres/import; undefined disables
  // the key path (super_admin JWT only). Redacted from logs like every other secret.
  importApiKey?: string;
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
  /** ADR-042 (amended). When false, admin/super_admin skip the TOTP step entirely. */
  totpEnabled: boolean;
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
    importApiKey: env.IMPORT_API_KEY,
    accessTokenTtl: env.ACCESS_TOKEN_TTL,
    refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    totpEnabled: env.TOTP_ENABLED === 'true',
    storageProvider: env.STORAGE_PROVIDER,
    s3Bucket: env.S3_BUCKET,
    s3Region: env.S3_REGION,
    mediaUrlTtlSeconds: env.MEDIA_URL_TTL_SECONDS,
    uploadMaxBytes: env.UPLOAD_MAX_BYTES,
  };
}
