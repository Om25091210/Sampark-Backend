import { z } from 'zod';

// Path params. Reports are always addressed under their cadre.
export const reportCadreParam = z.object({ cadreId: z.coerce.number().int().positive() });
export const reportDetailParams = z.object({
  cadreId: z.coerce.number().int().positive(),
  reportId: z.coerce.number().int().positive(),
});

// List query params are camelCase (per the client contract). `search` matches
// across specific location, current activity, and current phone.
export const listReportsQuery = z.object({
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(15),
});

// Create body is snake_case (per the client contract). Unknown keys the client
// sends but the core contract doesn't model (e.g. `selected_date`, `photo_urls`)
// are stripped by Zod's default (non-strict) parse — they belong to reports-media
// or are not yet part of the wire contract, so ignoring them is non-breaking.
export const createReportBody = z.object({
  // Path is authoritative; body `cadre_id` (always sent by the client) is
  // optional here and cross-checked in the route.
  cadre_id: z.number().int().positive().optional(),
  reporting_place: z.enum(['thana', 'village']),
  specific_location: z.string().trim().min(1).max(500),
  person_status: z.enum(['alive', 'dead']),
  current_phone: z.string().trim().min(1).max(20),
  current_activity: z.string().trim().min(1).max(1000),
  photo_url: z.string().trim().max(2048).optional(),
  gps_coords: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      address: z.string().max(500),
    })
    .optional(),
  is_home_address: z.boolean().optional(),
  // ADR-013: client-generated UUID v4, unique per logical action, stable across
  // offline retries. Optional for now; effectively required once the mobile sync
  // change ships. When present, the create dedupes on it.
  idempotency_key: z.string().uuid().optional(),
});

export type ListReportsQuery = z.infer<typeof listReportsQuery>;
export type CreateReportBody = z.infer<typeof createReportBody>;
