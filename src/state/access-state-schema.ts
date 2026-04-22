import { z } from "zod";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const IsoTimestampSchema = z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp");

export const PairedUserSchema = z.object({
  telegramUserId: z.number().int(),
  telegramChatId: z.number().int(),
  pairedAt: IsoTimestampSchema,
}).passthrough();

export const PendingPairSchema = z.object({
  code: z.string(),
  telegramUserId: z.number().int(),
  telegramChatId: z.number().int(),
  expiresAt: IsoTimestampSchema,
}).passthrough();

export const AccessStateSchema = z.object({
  schemaVersion: z.number().int().optional(),
  multiChat: z.boolean().optional().default(false),
  policy: z.enum(["pairing", "allowlist"]),
  pairedUsers: z.array(PairedUserSchema),
  allowlist: z.array(z.number().int()),
  pendingPairs: z.array(PendingPairSchema),
}).passthrough();
