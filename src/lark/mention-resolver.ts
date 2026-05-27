import type { LarkChannelLike } from "./types.js";

const CHAT_MEMBER_CACHE_TTL_MS = 60 * 60 * 1000;

interface ChatMemberEntry {
  fetchedAt: number;
  members: Map<string, string>;
}

const chatMemberCache = new Map<string, ChatMemberEntry>();

export interface LarkMentionResolveEnv {
  CCTB_LARK_RESOLVE_MENTIONS?: string;
  LARK_RESOLVE_MENTIONS?: string;
}

export function shouldResolveLarkMentions(env: LarkMentionResolveEnv): boolean {
  return /^(?:1|true|yes|on)$/i.test((env.CCTB_LARK_RESOLVE_MENTIONS ?? env.LARK_RESOLVE_MENTIONS ?? "").trim());
}

export async function resolveLarkMentionsInText(input: {
  enabled: boolean;
  channel: LarkChannelLike | { rawClient?: unknown };
  chatId: string;
  text: string;
  now?: number;
}): Promise<string> {
  if (!input.enabled || !input.text.includes("@")) {
    return input.text;
  }
  const members = await getLarkChatMembers(input.channel, input.chatId, input.now ?? Date.now());
  if (members.size === 0) {
    return input.text;
  }
  const names = [...members.keys()].sort((a, b) => b.length - a.length);
  let resolved = input.text;
  for (const name of names) {
    const openId = members.get(name);
    if (!openId || !resolved.includes(`@${name}`)) {
      continue;
    }
    resolved = resolved.replaceAll(`@${name}`, `<at user_id="${escapeAttribute(openId)}">${escapeText(name)}</at>`);
  }
  return resolved;
}

async function getLarkChatMembers(
  channel: LarkChannelLike | { rawClient?: unknown },
  chatId: string,
  now: number,
): Promise<Map<string, string>> {
  const cached = chatMemberCache.get(chatId);
  if (cached && now - cached.fetchedAt < CHAT_MEMBER_CACHE_TTL_MS) {
    return cached.members;
  }
  let members: Map<string, string>;
  try {
    members = await fetchLarkChatMembers(channel, chatId);
  } catch {
    return new Map();
  }
  chatMemberCache.set(chatId, { fetchedAt: now, members });
  return members;
}

async function fetchLarkChatMembers(
  channel: LarkChannelLike | { rawClient?: unknown },
  chatId: string,
): Promise<Map<string, string>> {
  const getMembers = (((channel as { rawClient?: {
    im?: {
      v1?: {
        chatMembers?: {
          get(input: {
            path: { chat_id: string };
            params: { member_id_type: "open_id"; page_size: number; page_token?: string };
          }): Promise<unknown>;
        };
      };
    };
  } }).rawClient)?.im?.v1?.chatMembers?.get);
  if (!getMembers) {
    return new Map();
  }
  const collected = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const response = await getMembers({
      path: { chat_id: chatId },
      params: {
        member_id_type: "open_id",
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    const data = isRecord(response) && isRecord(response.data) ? response.data : undefined;
    const items = Array.isArray(data?.items) ? data.items.filter(isRecord) : [];
    for (const item of items) {
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const memberId = typeof item.member_id === "string" ? item.member_id.trim() : "";
      if (!name || !memberId) {
        continue;
      }
      if (collected.has(name)) {
        collected.set(name, "");
      } else {
        collected.set(name, memberId);
      }
    }
    pageToken = typeof data?.page_token === "string" && data.page_token ? data.page_token : undefined;
    if (data?.has_more !== true) {
      pageToken = undefined;
    }
  } while (pageToken);
  return collected;
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll("\"", "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
