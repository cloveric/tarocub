import { z } from "zod";

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

export const InstanceLockRecordSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().min(1),
  acquiredAt: z.string().refine(isIsoTimestamp, "must be a valid ISO-8601 timestamp"),
}).passthrough();
