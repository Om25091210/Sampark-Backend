import { z, type ZodRawShape, type ZodTypeAny } from 'zod';

/**
 * Zod's `.nullable()` accepts `null` but NOT a missing key, so a "full record" create
 * schema made of nullable fields still 400s on a payload that simply leaves the untouched
 * fields out (JSON also drops `undefined`). The proforma forms are filled incrementally
 * on paper and in the app, so a create must treat "not provided" as "null".
 *
 * Wrap a CREATE schema with this; never an edit/partial one — there a filled `null` would
 * propose wiping every field the officer did not touch.
 */
export function fillMissingNullable<S extends z.ZodObject<ZodRawShape>>(schema: S) {
  const nullableKeys = Object.entries(schema.shape)
    .filter(([, field]) => (field as ZodTypeAny).isNullable())
    .map(([key]) => key);

  return z.preprocess((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
    const input = raw as Record<string, unknown>;
    const out: Record<string, unknown> = { ...input };
    for (const key of nullableKeys) {
      if (out[key] === undefined) out[key] = null;
    }
    return out;
  }, schema);
}
