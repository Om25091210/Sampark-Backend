import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

// Swagger/OpenAPI helpers. IMPORTANT: every schema produced here is DOCUMENTATION
// ONLY. The app installs a no-op validatorCompiler (see app.ts), so Fastify never
// validates requests against these — the routes keep validating with their existing
// Zod `.parse()`. This keeps the working routes' behaviour byte-for-byte unchanged
// while giving Swagger UI an accurate, Zod-derived request shape.

// Converts a module's existing Zod schema to an OpenAPI-3 JSON Schema for display.
export function zodToJson(schema: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

// A response body documented by example. `additionalProperties: true` guarantees
// fast-json-stringify never strips a field from the real wire payload, so adding a
// response schema cannot change what the client receives.
export function jsonResponse(description: string, example: unknown): Record<string, unknown> {
  return { description, type: 'object', additionalProperties: true, example };
}

// An empty (no-body) response, e.g. 204.
export function emptyResponse(description: string): Record<string, unknown> {
  return { description, type: 'null' };
}

// Security requirement marking a route as Bearer-JWT protected (lock icon in the UI).
export const bearerAuth = [{ bearerAuth: [] }];

// ─── Reusable response examples (mirror the wire contract in serialize.ts / mobile) ──

export const EXAMPLE_AUTH_USER = {
  id: 3,
  name: 'राजेश कुमार सिंह',
  phone: '+919770000001',
  role: 'officer',
  designation: 'सहायक उपनिरीक्षक',
  thana: 'बीजापुर सदर',
};

// An officer as the admin assignment picker sees them (ADR-018): the user entity
// plus their current cadre load.
export const EXAMPLE_OFFICER = {
  ...EXAMPLE_AUTH_USER,
  assignedCadreCount: 4,
};

export const EXAMPLE_CADRE = {
  id: 12,
  name: 'बबलू माडवी',
  phone: '+919770784646',
  thana: 'बीजापुर / गंगालूर',
  currentAddress: 'मचीपाडा थाना गंगालूर जिला बीजापुर',
  designation: 'पश्चिम बस्तर डिवीजन DKBCM',
  category: 'surrendered',
  alertLevel: 'critical',
  aliases: ['बब्बू', 'माडू'],
  assignedOfficerId: 3,
  avatarUrl: 'https://sampark-media.s3.ap-south-1.amazonaws.com/cadres/12.jpg',
  surrenderYear: '2024',
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt: '2026-07-01T10:00:00.000Z',
};

export const EXAMPLE_REPORT = {
  id: 5,
  cadreId: 12,
  reportingPlace: 'village',
  specificLocation: 'गाँव चौक',
  personStatus: 'alive',
  currentPhone: '+919812345678',
  currentActivity: 'खेती कर रहा है',
  photoUrls: [
    'https://sampark-media.s3.ap-south-1.amazonaws.com/reports/cadre-12/9f1c….jpg?X-Amz-…',
  ],
  gpsCoords: { latitude: 18.79, longitude: 80.9, address: 'बीजापुर' },
  isHomeAddress: true,
  reportedAt: '2026-07-08T09:30:00.000Z',
  reportedBy: 3,
  cadre: { id: 12, name: 'बबलू माडवी', phone: '+919770784646', avatarUrl: null },
};

// A camelCase PaginatedResponse<T> envelope around the given item example.
export function examplePage(item: unknown): Record<string, unknown> {
  return { data: [item], total: 42, page: 1, pageSize: 15, hasMore: true };
}

export const EXAMPLE_TOKEN_PAIR = {
  access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  refresh_token: '9f1c2b7e6a4d…',
  token_type: 'bearer',
  user: EXAMPLE_AUTH_USER,
};
