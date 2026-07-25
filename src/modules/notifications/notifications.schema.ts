import { z } from 'zod';

// In-app notification inbox (v1, ADR-048). Request bodies are snake_case, entity
// responses/queries camelCase — the existing client contract, not a new convention.

export const listNotificationsQuery = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;

export const notificationIdParam = z.object({ id: z.coerce.number().int().positive() });

export const broadcastBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(2000),
    target: z.enum(['all', 'thana', 'sub_division']),
    thana: z.string().trim().min(1).max(200).optional(),
    sub_division: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => b.target !== 'thana' || b.thana !== undefined, {
    message: 'thana is required when target is "thana"',
    path: ['thana'],
  })
  .refine((b) => b.target !== 'sub_division' || b.sub_division !== undefined, {
    message: 'sub_division is required when target is "sub_division"',
    path: ['sub_division'],
  });
export type BroadcastBody = z.infer<typeof broadcastBody>;
