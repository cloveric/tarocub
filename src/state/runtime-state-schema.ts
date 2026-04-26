import { z } from "zod";

export const RuntimeStateSchema = z.object({
  lastHandledUpdateId: z.number().int().nonnegative().nullable(),
  activeTurnCount: z.number().int().nonnegative().default(0),
  activeTurnStartedAt: z.string().datetime().optional(),
  activeTurnUpdatedAt: z.string().datetime().optional(),
}).passthrough();
