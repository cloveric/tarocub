import { z } from "zod";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const UsageTimestampSchema = z.union([
  z.literal(""),
  z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp"),
]);

export const UsageRecordSchema = z.object({
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalCachedTokens: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  requestCount: z.number().int().nonnegative(),
  lastUpdatedAt: UsageTimestampSchema,
}).passthrough();
