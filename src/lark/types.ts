import type {
  CardActionEvent,
  CommentEvent,
  NormalizedMessage,
  RejectEvent,
} from "@larksuiteoapi/node-sdk";

import type {
  CodexThreadGoal,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
} from "../codex/adapter.js";
import type { BridgeAccessDecision } from "../runtime/bridge.js";
import type { BridgeTurnLockWaitEvent } from "../runtime/turn-lock.js";
import type { TurnPoolWaitEvent } from "../runtime/turn-pool.js";
import type { LarkChatMode } from "./message-normalizer.js";

export interface LarkSendOptions {
  replyTo?: string;
  replyInThread?: boolean;
}

export interface LarkStreamControllerLike {
  messageId: string;
  current: object;
  update(card: object | ((current: object) => object)): Promise<void>;
}

export type LarkMessageResourceType = "image" | "file";

export interface LarkMessageResourceResponseLike {
  getReadableStream(): NodeJS.ReadableStream;
}

export interface LarkRawClientLike {
  im?: {
    v1?: {
      messageResource?: {
        get(payload: {
          path: {
            message_id: string;
            file_key: string;
          };
          params: {
            type: LarkMessageResourceType;
          };
        }): Promise<LarkMessageResourceResponseLike>;
      };
    };
  };
}

export interface LarkChannelLike {
  send(to: string, input: unknown, opts?: LarkSendOptions): Promise<{ messageId: string }>;
  stream(to: string, input: {
    card: {
      initial: object;
      producer: (controller: LarkStreamControllerLike) => Promise<void>;
    };
  }, opts?: LarkSendOptions): Promise<{ messageId: string }>;
  updateCard?(messageId: string, card: object): Promise<void>;
  recallMessage?(messageId: string): Promise<void>;
  addReaction?(messageId: string, emojiType: string): Promise<string>;
  removeReaction?(messageId: string, reactionId: string): Promise<void>;
  removeReactionByEmoji?(messageId: string, emojiType: string): Promise<boolean>;
  downloadResource(fileKey: string, type: "image" | "file"): Promise<Buffer>;
  /**
   * The underlying SDK client (`@larksuiteoapi/node-sdk`), used to upload an
   * image and obtain an `image_key` for embedding in a card's `img` element via
   * `rawClient.im.v1.image.create`. The SDK channel does NOT expose a standalone
   * `uploadImage` method, so the raw client is the supported path. Optional/typed
   * as unknown so test channels can stub just the slice they need.
   */
  rawClient?: unknown;
  fetchMessage?(messageId: string): Promise<LarkFetchedMessage | null>;
  getChatMode?(chatId: string): Promise<LarkChatMode>;
  /**
   * Whether the chat is in topic-message form, i.e. each topic should be its own
   * isolated session. True for a native topic group (chat_mode='topic') and for
   * a conversation group switched to the topic message form
   * (group_message_type='thread'); false for the default conversation form
   * (group_message_type='chat'), whose topic replies share the one group session.
   */
  getChatTopicForm?(chatId: string): Promise<boolean>;
}

export interface LarkFetchedMessage {
  messageId: string;
  messageType?: string;
  content?: string;
  senderId?: string;
  senderName?: string;
  createTime?: string;
  children?: LarkFetchedMessage[];
}

export interface LarkRuntimeChannelLike extends LarkChannelLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(name: "message", handler: (message: NormalizedMessage) => void | Promise<void>): () => void;
  on(name: "reject", handler: (event: RejectEvent) => void): () => void;
  on(name: "cardAction", handler: (event: CardActionEvent) => void | Promise<void>): () => void;
  on(name: "comment", handler: (event: CommentEvent) => void | Promise<void>): () => void;
  on(name: "error", handler: (error: Error) => void): () => void;
}

export interface LarkBridgeLike {
  destroy?(): void | Promise<void>;
  checkAccess?(input: {
    chatId: number;
    conversationChatId?: number;
    userId: number;
    chatType: string;
    messageThreadId?: number;
    conversationKey?: string;
    locale?: "en" | "zh";
  }): Promise<BridgeAccessDecision>;
  checkUserAuthorization?(input: {
    chatId: number;
    userId: number;
    chatType: string;
    messageThreadId?: number;
    conversationKey?: string;
    locale?: "en" | "zh";
  }): Promise<BridgeAccessDecision>;
  handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    messageThreadId?: number;
    locale?: "en" | "zh";
    text: string;
    replyContext?: {
      messageId: string;
      text: string;
    };
    conversationKey?: string;
    files: string[];
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    requestOutputDir?: string;
    workspaceOverride?: string;
    instructions?: string;
    extraEnv?: Record<string, string>;
    abortSignal?: AbortSignal;
    onTurnLockWait?: (event: BridgeTurnLockWaitEvent) => void | Promise<void>;
    turnPoolWaitNotifyAfterMs?: number;
    onTurnPoolWait?: (event: TurnPoolWaitEvent) => void | Promise<void>;
  }): Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number } }>;
  validateCodexThread?(threadId: string): Promise<void>;
  getThreadGoal?(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    conversationKey?: string;
    workspaceOverride?: string;
  }): Promise<{ goal: CodexThreadGoal | null }>;
  setThreadGoal?(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    conversationKey?: string;
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<{ goal: CodexThreadGoal | null }>;
  watchThreadGoal?(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    conversationKey?: string;
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    abortSignal?: AbortSignal;
  }): Promise<{ goal: CodexThreadGoal | null }>;
  clearThreadGoal?(input: {
    chatId: number;
    userId?: number;
    chatType?: string;
    conversationKey?: string;
    workspaceOverride?: string;
  }): Promise<{ cleared: boolean }>;
}

export interface LarkServiceLogger {
  log(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
}
