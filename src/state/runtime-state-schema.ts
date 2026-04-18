import { z } from "zod";

export const RuntimeStateSchema = z.object({
  lastHandledUpdateId: z.number().int().nonnegative().nullable(),
}).passthrough();
