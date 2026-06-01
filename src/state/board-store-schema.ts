import { z } from "zod";

export const BoardTaskStatusSchema = z.enum(["todo", "ready", "running", "review", "blocked", "done", "archived"]);
export const BoardTaskPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);

export const BoardTaskActorSchema = z.object({
  chatId: z.number(),
  userId: z.number(),
  messageThreadId: z.number().optional(),
  conversationKey: z.string().min(1),
}).passthrough();

export const BoardTaskRunSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["running", "done", "failed"]),
  startedAt: z.string(),
  lastHeartbeatAt: z.string().optional(),
  heartbeatNote: z.string().optional(),
  completedAt: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

export const BoardChecklistItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  done: z.boolean(),
  createdAt: z.string(),
  completedAt: z.string().optional(),
}).passthrough();

export const BoardArtifactSchema = z.object({
  kind: z.string().min(1),
  value: z.string().min(1),
  createdAt: z.string().optional(),
}).passthrough();

export const BoardReviewGateSchema = z.object({
  required: z.boolean(),
  reviewer: z.string().optional(),
}).passthrough();

export const BoardTaskWorkspaceSchema = z.object({
  mode: z.enum(["default", "dir", "worktree", "scratch"]),
  path: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
}).passthrough();

export const BoardTaskRecordSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: BoardTaskStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  description: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  priority: BoardTaskPrioritySchema.optional(),
  labels: z.array(z.string()).optional(),
  checklist: z.array(BoardChecklistItemSchema).optional(),
  artifacts: z.array(BoardArtifactSchema).optional(),
  review: BoardReviewGateSchema.optional(),
  summary: z.string().optional(),
  blockedReason: z.string().optional(),
  assignee: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
  runs: z.array(BoardTaskRunSchema).optional(),
  workspace: BoardTaskWorkspaceSchema.optional(),
  createdBy: BoardTaskActorSchema,
}).passthrough();

export const BoardStoreStateSchema = z.object({
  nextTaskId: z.number().optional(),
  nextRunId: z.number().optional(),
  limits: z.object({
    global: z.number().optional(),
    perAssignee: z.number().optional(),
    perConversation: z.number().optional(),
  }).passthrough().optional(),
  tasks: z.array(BoardTaskRecordSchema).optional(),
}).passthrough();

export type BoardTaskStatus = z.infer<typeof BoardTaskStatusSchema>;
export type BoardTaskPriority = z.infer<typeof BoardTaskPrioritySchema>;
export type BoardTaskActor = z.infer<typeof BoardTaskActorSchema>;
export type BoardTaskRun = z.infer<typeof BoardTaskRunSchema>;
export type BoardChecklistItem = z.infer<typeof BoardChecklistItemSchema>;
export type BoardArtifact = z.infer<typeof BoardArtifactSchema>;
export type BoardReviewGate = z.infer<typeof BoardReviewGateSchema>;
export type BoardTaskWorkspace = z.infer<typeof BoardTaskWorkspaceSchema>;
export type BoardWipLimits = {
  global: number;
  perAssignee: number;
  perConversation: number;
};
export type BoardTaskRecord = {
  id: string;
  title: string;
  status: BoardTaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  description?: string;
  acceptanceCriteria: string[];
  priority: BoardTaskPriority;
  labels: string[];
  checklist: BoardChecklistItem[];
  artifacts: BoardArtifact[];
  review: BoardReviewGate;
  summary?: string;
  blockedReason?: string;
  assignee?: string;
  dependencies: string[];
  runs: BoardTaskRun[];
  workspace?: BoardTaskWorkspace;
  createdBy: BoardTaskActor;
};
export type BoardStoreState = {
  nextTaskId: number;
  nextRunId: number;
  limits: BoardWipLimits;
  tasks: BoardTaskRecord[];
};
