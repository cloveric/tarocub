import type { EngineApprovalDecision } from "../codex/adapter.js";
import { delegateToInstance as defaultDelegateToInstance } from "../bus/bus-client.js";
import { loadBusConfig as defaultLoadBusConfig } from "../bus/bus-config.js";
import { ChatQueue } from "../runtime/chat-queue.js";
import type { CronScheduler } from "../runtime/cron-scheduler.js";
import type { ScannedSession } from "../runtime/session-scanner.js";
import type { CronStore } from "../state/cron-store.js";
import type { MiniBusCommandContext } from "../telegram/mini-bus-commands.js";
import { detectLarkCliStatus, type LarkCliStatus } from "./cli.js";
import {
  createLarkChatWithCli,
  type LarkChatCreateInput,
  type LarkChatCreateResult,
} from "./chat-client.js";
import type { LarkCommentClientLike } from "./comment-client.js";
import type { LarkChatMode, LarkNormalizedBridgeMessage } from "./message-normalizer.js";
import {
  createLarkDocumentWithCli,
  type LarkDocumentCreateInput,
  type LarkDocumentCreateResult,
} from "./document-client.js";

export interface LarkActiveRun {
  abortController: AbortController;
}

export interface LarkQueuePolicy {
  preempt: boolean;
  batchWindowMs: number;
}

export interface PendingLarkBatch {
  normalized: LarkNormalizedBridgeMessage;
  texts: string[];
  timer: ReturnType<typeof setTimeout>;
  resolve: Array<(value: boolean) => void>;
  reject: Array<(error: unknown) => void>;
}

export interface LarkCronRuntime {
  store: CronStore;
  scheduler: Pick<CronScheduler, "refresh" | "runJobNow">;
}

export interface LarkBusRuntime {
  loadBusConfig?: typeof defaultLoadBusConfig;
  delegateToInstance?: typeof defaultDelegateToInstance;
}

export interface LarkMiniRuntime {
  runQueuedBridgeTurn?: MiniBusCommandContext["runQueuedBridgeTurn"];
}

export interface LarkSessionRuntime {
  scanRecentSessions?: (hours: number) => Promise<ScannedSession[]>;
  scanRecentAntigravitySessions?: (hours: number) => Promise<ScannedSession[]>;
}

export interface PendingLarkApproval {
  requestId: string;
  chatId: string;
  conversationKey?: string;
  bridgeChatType?: "private" | "group";
  replyTo?: string;
  replyInThread?: boolean;
  askUserQuestionInput?: unknown;
  resolve: (decision: EngineApprovalDecision) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
}

export interface LarkServiceRuntime {
  activeRuns: Map<string, LarkActiveRun>;
  pendingApprovals: Map<string, PendingLarkApproval>;
  chatQueue: ChatQueue;
  queuePolicy: LarkQueuePolicy;
  pendingBatches: Map<string, PendingLarkBatch>;
  chatModeCache: Map<string, LarkChatMode>;
  cronRuntime?: LarkCronRuntime;
  busRuntime?: LarkBusRuntime;
  miniRuntime?: LarkMiniRuntime;
  sessionRuntime?: LarkSessionRuntime;
  commentClient?: LarkCommentClientLike;
  transcribeMedia?: (filePath: string) => Promise<string>;
  detectLarkCli: () => Promise<LarkCliStatus>;
  createChat: (input: LarkChatCreateInput) => Promise<LarkChatCreateResult>;
  createDocument: (input: LarkDocumentCreateInput) => Promise<LarkDocumentCreateResult>;
}

export function createLarkServiceRuntime(options: {
  createChat?: (input: LarkChatCreateInput) => Promise<LarkChatCreateResult>;
  createDocument?: (input: LarkDocumentCreateInput) => Promise<LarkDocumentCreateResult>;
  commentClient?: LarkCommentClientLike;
  cronRuntime?: LarkCronRuntime;
  busRuntime?: LarkBusRuntime;
  miniRuntime?: LarkMiniRuntime;
  sessionRuntime?: LarkSessionRuntime;
  transcribeMedia?: (filePath: string) => Promise<string>;
  detectLarkCli?: () => Promise<LarkCliStatus>;
  queuePolicy?: Partial<LarkQueuePolicy>;
} = {}): LarkServiceRuntime {
  return {
    activeRuns: new Map(),
    pendingApprovals: new Map(),
    chatQueue: new ChatQueue(),
    queuePolicy: {
      preempt: options.queuePolicy?.preempt === true,
      batchWindowMs: Math.max(0, Math.floor(options.queuePolicy?.batchWindowMs ?? 0)),
    },
    pendingBatches: new Map(),
    chatModeCache: new Map(),
    ...(options.cronRuntime ? { cronRuntime: options.cronRuntime } : {}),
    ...(options.busRuntime ? { busRuntime: options.busRuntime } : {}),
    ...(options.miniRuntime ? { miniRuntime: options.miniRuntime } : {}),
    ...(options.sessionRuntime ? { sessionRuntime: options.sessionRuntime } : {}),
    ...(options.commentClient ? { commentClient: options.commentClient } : {}),
    ...(options.transcribeMedia ? { transcribeMedia: options.transcribeMedia } : {}),
    detectLarkCli: options.detectLarkCli ?? detectLarkCliStatus,
    createChat: options.createChat ?? createLarkChatWithCli,
    createDocument: options.createDocument ?? createLarkDocumentWithCli,
  };
}
