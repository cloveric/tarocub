import { z } from "zod";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export const InstanceLockRecordSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().min(1),
  acquiredAt: z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp"),
}).passthrough();
