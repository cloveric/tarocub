import { z } from "zod";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export const ResumeStateFileSchema = z.object({
  sessionId: z.string(),
  dirName: z.string(),
  workspacePath: z.string(),
  symlinkPath: z.string().optional(),
}).passthrough();

export const ConfigFileSchema = z.object({
  engine: z.enum(["codex", "claude"]).optional(),
  locale: z.enum(["en", "zh"]).optional(),
  verbosity: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  budgetUsd: z.number().positive().optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  model: z.string().optional(),
  resume: ResumeStateFileSchema.optional(),
  bus: z.unknown().optional(),
}).passthrough();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export function formatSchemaError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return "invalid config shape";
  }
  const path = issue.path.length > 0 ? issue.path.join(".") : "root";
  return `${path}: ${issue.message}`;
}
