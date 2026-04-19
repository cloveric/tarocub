import { z } from "zod";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const IsoTimestampSchema = z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp");

const ResumeStateSchema = z.object({
  sessionId: z.string(),
  dirName: z.string(),
  workspacePath: z.string(),
  symlinkPath: z.string().optional(),
});

const SuspendedConversationStateSchema = z.object({
  sessionId: z.string().nullable(),
  resume: ResumeStateSchema.nullable(),
});

export const SessionRecordSchema = z.object({
  telegramChatId: z.number().int(),
  codexSessionId: z.string(),
  status: z.enum(["idle", "running", "queued", "blocked"]),
  updatedAt: IsoTimestampSchema,
  suspendedPrevious: SuspendedConversationStateSchema.optional(),
});

export const SessionStateSchema = z.object({
  schemaVersion: z.number().int().optional(),
  chats: z.array(SessionRecordSchema),
});
