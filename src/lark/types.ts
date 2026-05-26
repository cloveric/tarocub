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
  downloadResource(fileKey: string, type: "image" | "file"): Promise<Buffer>;
  fetchMessage?(messageId: string): Promise<LarkFetchedMessage | null>;
}

export interface LarkFetchedMessage {
  messageId: string;
  messageType?: string;
  content?: string;
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
  checkAccess?(input: {
    chatId: number;
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
    abortSignal?: AbortSignal;
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
