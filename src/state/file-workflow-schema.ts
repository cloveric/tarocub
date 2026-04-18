import { z } from "zod";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const IsoTimestampSchema = z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp");

export const FileWorkflowRecordSchema = z.object({
  uploadId: z.string(),
  chatId: z.number().int(),
  userId: z.number().int(),
  kind: z.enum(["image", "document", "archive"]),
  status: z.enum(["preparing", "processing", "awaiting_continue", "completed", "failed"]),
  sourceFiles: z.array(z.string()),
  derivedFiles: z.array(z.string()),
  summary: z.string(),
  summaryMessageId: z.number().int().optional(),
  extractedPath: z.string().optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).passthrough();

export const FileWorkflowStateSchema = z.object({
  records: z.array(FileWorkflowRecordSchema),
}).passthrough();
