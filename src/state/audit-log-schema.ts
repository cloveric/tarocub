import { z } from "zod";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const IsoTimestampSchema = z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp");

export const AuditEventSchema = z.object({
  timestamp: IsoTimestampSchema.optional(),
  type: z.string(),
  instanceName: z.string().optional(),
  chatId: z.number().int().optional(),
  userId: z.number().int().optional(),
  updateId: z.number().int().optional(),
  outcome: z.string().optional(),
  detail: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export function formatAuditSchemaError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "invalid audit event";
  }
  const path = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${path}: ${issue.message}`;
}
