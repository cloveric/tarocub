import path from "node:path";

import { withFileMutex } from "../state/file-mutex.js";
import { JsonStore } from "../state/json-store.js";
import type { LarkNormalizedBridgeMessage } from "./message-normalizer.js";

const LARK_CHAT_ID_MAP_FILENAME = "lark-chat-id-map.json";
const LARK_USER_ID_MAP_FILENAME = "lark-user-id-map.json";

type LarkNumericIdKind = "chat" | "user";

export async function verifyLarkNumericIds(stateDir: string, normalized: LarkNormalizedBridgeMessage): Promise<void> {
  await assertStableLarkIdMappings(stateDir, [
    ["chat", normalized.bridgeChatId, normalized.conversationKey],
    ["user", normalized.bridgeUserId, normalized.senderId],
  ]);
}

export async function assertStableLarkIdMappings(
  stateDir: string,
  mappings: Array<[LarkNumericIdKind, number, string]>,
): Promise<void> {
  const grouped = new Map<LarkNumericIdKind, Array<[number, string]>>();
  for (const [kind, numericId, rawId] of mappings) {
    const entries = grouped.get(kind) ?? [];
    entries.push([numericId, rawId]);
    grouped.set(kind, entries);
  }

  for (const [kind, entries] of grouped) {
    const mapPath = path.join(stateDir, larkIdMapFilename(kind));
    await withFileMutex(mapPath, async () => {
      const store = new JsonStore<Record<string, string>>(mapPath, parseLarkIdMap);
      const current = await store.read({});
      let changed = false;
      for (const [numericId, rawId] of entries) {
        const key = String(numericId);
        const existing = current[key];
        if (existing && existing !== rawId) {
          throw new Error(`Lark ${kind} numeric ID collision for ${numericId}`);
        }
        if (!existing) {
          current[key] = rawId;
          changed = true;
        }
      }
      if (changed) {
        await store.write(current);
      }
    });
  }
}

function larkIdMapFilename(kind: LarkNumericIdKind): string {
  return kind === "chat" ? LARK_CHAT_ID_MAP_FILENAME : LARK_USER_ID_MAP_FILENAME;
}

function parseLarkIdMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const parsed: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/^\d+$/.test(key) && typeof raw === "string") {
      parsed[key] = raw;
    }
  }
  return parsed;
}
