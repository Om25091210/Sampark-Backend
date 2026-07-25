import { z } from 'zod';

// ADR-048. Request bodies are snake_case, matching the existing client contract.
export const registerDeviceBody = z.object({
  token: z.string().trim().min(1).max(4096),
});
export type RegisterDeviceBody = z.infer<typeof registerDeviceBody>;

export const unregisterDeviceBody = z.object({
  token: z.string().trim().min(1).max(4096),
});
export type UnregisterDeviceBody = z.infer<typeof unregisterDeviceBody>;
