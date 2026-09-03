import { z } from 'zod';

// In-app notification inbox (v1, ADR-048). Request bodies are snake_case, entity
// responses/queries camelCase — the existing client contract, not a new convention.

export const listNotificationsQuery = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  // This task. Lets a caller narrow to one notification type — e.g. the mobile
  // notice-board dialog asks for `type=broadcast&unreadOnly=true` specifically,
  // rather than filtering a mixed unread page client-side and risking a
  // broadcast buried past page 1 of other unread types.
  type: z.enum(['report_overdue', 'cadre_change_outcome', 'cadre_create_outcome', 'thana_transfer', 'broadcast']).optional(),
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
