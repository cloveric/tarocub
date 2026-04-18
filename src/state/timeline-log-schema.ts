import { z } from "zod";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const IsoTimestampSchema = z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp");

export const TimelineEventSchema = z.object({
  timestamp: IsoTimestampSchema.optional(),
  type: z.enum([
    "input.received",
    "command.handled",
    "turn.started",
    "turn.completed",
    "turn.retried",
    "workflow.prepared",
    "workflow.failed",
    "workflow.completed",
    "file.accepted",
    "file.rejected",
    "budget.blocked",
    "budget.threshold_reached",
  ]),
  instanceName: z.string().optional(),
  channel: z.enum(["telegram", "bus"]).optional(),
  chatId: z.number().int().optional(),
  userId: z.number().int().optional(),
  updateId: z.number().int().optional(),
  outcome: z.string().optional(),
  detail: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export function formatTimelineSchemaError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "invalid timeline event";
  }
  const eventPath = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${eventPath}: ${issue.message}`;
}
