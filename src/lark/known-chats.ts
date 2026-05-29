import path from "node:path";

import { JsonStore } from "../state/json-store.js";
import type { LarkBridgeChatType, LarkChatMode, LarkNormalizedBridgeMessage } from "./message-normalizer.js";

export interface LarkKnownChat {
  chatId: string;
  conversationKey: string;
  bridgeChatId: number;
  bridgeAccessChatId: number;
  chatType: LarkBridgeChatType;
  chatMode?: LarkChatMode;
  threadId?: string;
  chatName?: string;
  senderName?: string;
  label: string;
  lastSeenAt: string;
}

interface LarkKnownChatState {
  chats: LarkKnownChat[];
}

const MAX_KNOWN_LARK_CHATS = 500;

function parseState(value: unknown): LarkKnownChatState {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const chats = Array.isArray(raw.chats)
    ? raw.chats
      .map(parseKnownChat)
      .filter((entry): entry is LarkKnownChat => entry !== null)
    : [];

  return {
    chats: dedupeKnownChats(chats)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, MAX_KNOWN_LARK_CHATS),
  };
}

function parseKnownChat(value: unknown): LarkKnownChat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.chatId !== "string" ||
    typeof raw.conversationKey !== "string" ||
    typeof raw.bridgeChatId !== "number" ||
    typeof raw.bridgeAccessChatId !== "number" ||
    (raw.chatType !== "private" && raw.chatType !== "group") ||
    typeof raw.label !== "string" ||
    typeof raw.lastSeenAt !== "string"
  ) {
    return null;
  }

  const entry: LarkKnownChat = {
    chatId: raw.chatId,
    conversationKey: raw.conversationKey,
    bridgeChatId: raw.bridgeChatId,
    bridgeAccessChatId: raw.bridgeAccessChatId,
    chatType: raw.chatType,
    label: raw.label,
    lastSeenAt: raw.lastSeenAt,
  };
  if (isLarkChatMode(raw.chatMode)) entry.chatMode = raw.chatMode;
  if (typeof raw.threadId === "string" && raw.threadId.length > 0) entry.threadId = raw.threadId;
  if (typeof raw.chatName === "string" && raw.chatName.length > 0) entry.chatName = raw.chatName;
  if (typeof raw.senderName === "string" && raw.senderName.length > 0) entry.senderName = raw.senderName;
  return entry;
}

export class LarkKnownChatStore {
  private static readonly writeQueues = new Map<string, Promise<void>>();
  private readonly filePath: string;
  private readonly store: JsonStore<LarkKnownChatState>;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "known-chats.json");
    this.store = new JsonStore(this.filePath, parseState);
  }

  async record(normalized: LarkNormalizedBridgeMessage, now = new Date()): Promise<void> {
    const entry = knownChatFromNormalized(normalized, now);
    await this.enqueueWrite(async () => {
      const state = await this.store.read({ chats: [] });
      const next = dedupeKnownChats([
        entry,
        ...state.chats.filter((chat) => chat.conversationKey !== entry.conversationKey),
      ])
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
        .slice(0, MAX_KNOWN_LARK_CHATS);
      await this.store.write({ chats: next });
    });
  }

  async get(conversationKey: string): Promise<LarkKnownChat | null> {
    const state = await this.store.read({ chats: [] });
    return state.chats.find((chat) => chat.conversationKey === conversationKey) ?? null;
  }

  async list(limit = 50): Promise<LarkKnownChat[]> {
    const state = await this.store.read({ chats: [] });
    return state.chats.slice(0, limit);
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const previous = LarkKnownChatStore.writeQueues.get(this.filePath) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const queued = next.catch(() => undefined);
    LarkKnownChatStore.writeQueues.set(this.filePath, queued);
    try {
      await next;
    } finally {
      if (LarkKnownChatStore.writeQueues.get(this.filePath) === queued) {
        LarkKnownChatStore.writeQueues.delete(this.filePath);
      }
    }
  }
}

function knownChatFromNormalized(normalized: LarkNormalizedBridgeMessage, now: Date): LarkKnownChat {
  const entry: LarkKnownChat = {
    chatId: normalized.chatId,
    conversationKey: normalized.conversationKey,
    bridgeChatId: normalized.bridgeChatId,
    bridgeAccessChatId: normalized.bridgeAccessChatId,
    chatType: normalized.bridgeChatType,
    label: labelForKnownChat(normalized),
    lastSeenAt: now.toISOString(),
  };
  if (normalized.chatMode) entry.chatMode = normalized.chatMode;
  if (normalized.threadId) entry.threadId = normalized.threadId;
  if (normalized.chatName) entry.chatName = normalized.chatName;
  if (normalized.senderName) entry.senderName = normalized.senderName;
  return entry;
}

function labelForKnownChat(normalized: LarkNormalizedBridgeMessage): string {
  if (normalized.chatName?.trim()) {
    return normalized.chatName.trim();
  }
  if (normalized.bridgeChatType === "private" && normalized.senderName?.trim()) {
    return normalized.senderName.trim();
  }
  if (normalized.threadId) {
    return `${normalized.chatId} / ${normalized.threadId}`;
  }
  return normalized.chatId;
}

function dedupeKnownChats(chats: LarkKnownChat[]): LarkKnownChat[] {
  const byConversation = new Map<string, LarkKnownChat>();
  for (const chat of chats) {
    byConversation.set(chat.conversationKey, chat);
  }
  return [...byConversation.values()];
}

function isLarkChatMode(value: unknown): value is LarkChatMode {
  return value === "p2p" || value === "group" || value === "topic";
}
