import { z } from "zod";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const IsoTimestampSchema = z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp");

const CrewRunStageSchema = z.object({
  status: z.enum(["running", "completed", "failed"]),
  updatedAt: IsoTimestampSchema,
  output: z.string().optional(),
  subQuestions: z.array(z.string()).optional(),
  findings: z.array(z.string()).optional(),
  researchPacket: z.string().optional(),
  draft: z.string().optional(),
  revisionCount: z.number().int().nonnegative().optional(),
  verdict: z.enum(["pass", "revise"]).optional(),
  issues: z.string().optional(),
  detail: z.string().optional(),
}).passthrough();

export const CrewRunRecordSchema = z.object({
  schemaVersion: z.number().int().positive().optional(),
  runId: z.string().min(1),
  workflow: z.literal("research-report"),
  status: z.enum(["running", "completed", "failed"]),
  currentStage: z.enum(["decomposition", "research", "analysis", "writing", "review", "completed"]),
  coordinator: z.string().min(1),
  chatId: z.number().int(),
  userId: z.number().int(),
  locale: z.enum(["en", "zh"]),
  originalPrompt: z.string(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  finalOutput: z.string().optional(),
  lastError: z.string().optional(),
  stages: z.object({
    decomposition: CrewRunStageSchema.optional(),
    research: CrewRunStageSchema.optional(),
    analysis: CrewRunStageSchema.optional(),
    writing: CrewRunStageSchema.optional(),
    review: CrewRunStageSchema.optional(),
  }).passthrough(),
}).passthrough();

export type CrewRunRecord = z.infer<typeof CrewRunRecordSchema>;

