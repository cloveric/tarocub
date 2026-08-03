import type { ResumeState } from "../telegram/instance-config.js";

export interface ConversationResumeRecord {
  codexSessionId: string;
  resume?: ResumeState | null;
}

export function hasConversationResume(record: ConversationResumeRecord | null | undefined): boolean {
  return Boolean(record && Object.prototype.hasOwnProperty.call(record, "resume"));
}

/**
 * Instance-level resume state is accepted only for the session that originally
 * created it. New writes are conversation-scoped; this branch is a one-time
 * compatibility path for pre-migration session.json files.
 */
export function resolveConversationResume(
  record: ConversationResumeRecord | null | undefined,
  legacyResume: ResumeState | undefined,
): ResumeState | undefined {
  if (hasConversationResume(record)) {
    return record?.resume ?? undefined;
  }
  return record?.codexSessionId === legacyResume?.sessionId ? legacyResume : undefined;
}

/**
 * Move the pre-conversation-scoping `config.json.resume` value onto the session
 * record that owns its session id. Callers may delete the legacy field only
 * after this returns true; otherwise another conversation could erase the old
 * binding before its owner has had a chance to migrate.
 */
export async function migrateLegacyConversationResume<T extends ConversationResumeRecord>(
  store: {
    inspect(): Promise<{ state: { chats: T[] }; warning?: string }>;
    upsert(record: T): Promise<void>;
  },
  legacyResume: ResumeState | undefined,
): Promise<boolean> {
  if (!legacyResume) return false;
  const inspected = await store.inspect();
  if (!inspected?.state || !Array.isArray(inspected.state.chats) || inspected.warning) return false;
  const owner = inspected.state.chats.find((record) => record.codexSessionId === legacyResume.sessionId);
  if (!owner) return false;
  if (!hasConversationResume(owner)) {
    await store.upsert({ ...owner, resume: legacyResume });
  }
  return true;
}
