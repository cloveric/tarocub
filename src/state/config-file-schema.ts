import { z } from "zod";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];

export const ResumeStateFileSchema = z.object({
  sessionId: z.string(),
  dirName: z.string(),
  workspacePath: z.string(),
  symlinkPath: z.string().optional(),
}).passthrough();

export const GroupModeFileSchema = z.object({
  enabled: z.boolean().optional(),
  allowedChatIds: z.array(z.number()).optional(),
  listenAllChatIds: z.array(z.number()).optional(),
}).passthrough();

export const WorkspaceProfileFileSchema = z.object({
  name: z.string(),
  path: z.string(),
  updatedAt: z.string().optional(),
}).passthrough();

// Feishu VC bot-in-meeting config. Every field is optional and the feature is
// OFF unless `enabled` is explicitly true, so this section is inert on every
// existing instance. It also requires Feishu beta (灰度) scopes the app may not
// have — see src/lark/vc/preflight.ts.
export const MeetingConfigFileSchema = z.object({
  enabled: z.boolean().optional(),
  autoJoinOnInvite: z.boolean().optional(),
  trigger: z.string().optional(),
  transcriptKeep: z.number().int().min(10).max(2000).optional(),
  respondIn: z.enum(["meeting", "im", "both"]).optional(),
  pollIntervalMs: z.number().int().min(1000).max(60000).optional(),
  summaryOnEnd: z.boolean().optional(),
}).passthrough();

export const ConfigFileSchema = z.object({
  engine: z.enum(["codex", "claude", "antigravity", "kimi", "deepseek"]).optional(),
  approvalMode: z.enum(["normal", "full-auto", "bypass"]).optional(),
  codexRuntime: z.enum(["app-server", "process"]).optional(),
  locale: z.enum(["en", "zh"]).optional(),
  verbosity: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  budgetUsd: z.number().positive().optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  model: z.string().optional(),
  codexServiceTier: z.literal("fast").optional(),
  larkElementStream: z.boolean().optional(),
  disableRuntimeTimeout: z.boolean().optional(),
  larkSteerEnabled: z.boolean().optional(),
  larkSteerWindowSeconds: z.number().int().nonnegative().optional(),
  timezone: z.string().optional(),
  resume: ResumeStateFileSchema.optional(),
  workspacePath: z.string().optional(),
  workspaceProfiles: z.array(WorkspaceProfileFileSchema).optional(),
  groupMode: GroupModeFileSchema.optional(),
  meeting: MeetingConfigFileSchema.optional(),
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
