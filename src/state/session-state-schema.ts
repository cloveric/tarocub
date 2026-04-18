import { z } from "zod";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const IsoTimestampSchema = z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp");

export const SessionRecordSchema = z.object({
  telegramChatId: z.number().int(),
  codexSessionId: z.string(),
  status: z.enum(["idle", "running", "queued", "blocked"]),
  updatedAt: IsoTimestampSchema,
}).passthrough();

export const SessionStateSchema = z.object({
  chats: z.array(SessionRecordSchema),
}).passthrough();
