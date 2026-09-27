import { z } from 'zod';

// जेल/जमानत master profile — one or more criminal cases per cadre (this task).
// Path params: cases are always addressed under their cadre, same convention as
// reports.schema.ts.
export const caseCadreParam = z.object({ cadreId: z.coerce.number().int().positive() });
export const caseDetailParams = z.object({
  cadreId: z.coerce.number().int().positive(),
  caseId: z.coerce.number().int().positive(),
});

// Request bodies are snake_case (per the client contract — see cadres.schema.ts's
// create-cadre body and reports.schema.ts's create-report body for the same rule).
// Every field is optional: the source register has plenty of "NA" cells, and an
// officer adding one case in the field may not have every fact yet either. Dates
// are plain calendar dates (`YYYY-MM-DD`), not datetimes — cases have no time-of-day
// component, unlike Report.reportedAt.
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00.000Z`)), 'not a real calendar date');

export const caseBodyShape = z.object({
  crime_number: z.string().trim().max(100).nullable().optional(),
  sections: z.string().trim().max(500).nullable().optional(),
  crime_thana: z.string().trim().max(200).nullable().optional(),
  crime_description: z.string().trim().max(5000).nullable().optional(),
  arrest_date: dateOnly.nullable().optional(),
  bail_granted: z.boolean().optional(),
  bail_date: dateOnly.nullable().optional(),
  in_jail: z.boolean().optional(),
  jail_name: z.string().trim().max(200).nullable().optional(),
  under_investigation: z.boolean().optional(),
  under_trial: z.boolean().optional(),
  challan_number: z.string().trim().max(100).nullable().optional(),
  court_name: z.string().trim().max(200).nullable().optional(),
  case_status: z.string().trim().max(100).nullable().optional(),
  public_harm_occurred: z.boolean().optional(),
  uapa_applied: z.boolean().optional(),
});

export const createCaseBody = caseBodyShape;
// Update is the same shape — every field already optional, so PATCH semantics
// ("send only what changed") fall out naturally without a second schema.
export const updateCaseBody = caseBodyShape;

export type CreateCaseBody = z.infer<typeof createCaseBody>;
export type UpdateCaseBody = z.infer<typeof updateCaseBody>;
