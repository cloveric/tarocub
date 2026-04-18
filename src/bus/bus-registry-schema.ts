import { z } from "zod";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const IsoTimestampSchema = z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp");

export const BusRegistryEntrySchema = z.object({
  port: z.number().int().positive().max(65535),
  pid: z.number().int().positive(),
  secret: z.string(),
  updatedAt: IsoTimestampSchema,
}).passthrough();
