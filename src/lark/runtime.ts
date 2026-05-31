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
import type { ManagedCardHandle } from "./managed-card.js";
import type { LarkChatMode, LarkNormalizedBridgeMessage } from "./message-normalizer.js";
import {
  createLarkDocumentWithCli,
  type LarkDocumentCreateInput,
  type LarkDocumentCreateResult,
} from "./document-client.js";

export interface LarkActiveRun {
  abortController: AbortController;
  // Set true once a live run card (managed or inline) exists for this run. When a
  // task is stopped, that card updates IN PLACE to "已中断", so the stop handlers
  // must NOT also post a redundant "已停止。" text. Absent/false → no card (the
  // CardKit-unavailable fallback), so the text is the only acknowledgment.
  hasRunCard?: boolean;
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
  /**
   * Set when the AskUserQuestion form was delivered as a CardKit managed card,
   * so the submit handler can turn it read-only IN PLACE (CardKit updates land
   * even right after the user interacts, unlike im.message.patch). Absent when
   * CardKit was unavailable and the form fell back to a normal card send.
   */
  managedCard?: ManagedCardHandle;
  resolve: (decision: EngineApprovalDecision) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
}

/**
 * A live "queued" card. `messageId` is always set (used to take the card over as
 * the run card, or to recall it). `handle` is set when the card was delivered as
 * a CardKit managed card, so the cancel tap can flip it to "已取消" IN PLACE
 * (CardKit survives a post-interaction update, where im.message.patch reverts).
 * Absent `handle` → a plain inline card (CardKit was unavailable).
 */
export interface LarkQueueCardRef {
  messageId: string;
  handle?: ManagedCardHandle;
}

export interface LarkServiceRuntime {
  activeRuns: Map<string, LarkActiveRun>;
  pendingApprovals: Map<string, PendingLarkApproval>;
  chatQueue: ChatQueue;
  queuePolicy: LarkQueuePolicy;
  pendingBatches: Map<string, PendingLarkBatch>;
  /**
   * Per-chat cache of the resolved session mode (p2p/group/topic) with an expiry,
   * so switching a group's 群消息形式 (conversation ⇄ topic) takes effect within
   * the TTL instead of requiring a service restart.
   */
  chatModeCache: Map<string, { mode: LarkChatMode; expiresAt: number }>;
  /** queued message id → its "queued" card ref, so each task's run card reuses
   *  its own card and the cancel handler can update it in place. */
  queueCards: Map<string, LarkQueueCardRef>;
  /**
   * Queued task ids the user explicitly cancelled from a card button. The
   * cancel handler already updated that task's card, so its eventual skip must
   * stay silent (no duplicate "skipped" notice).
   */
  cancelledQueueTaskIds: Set<string>;
  appInfo?: { appId: string; domain?: string };
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
    queueCards: new Map(),
    cancelledQueueTaskIds: new Set(),
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
