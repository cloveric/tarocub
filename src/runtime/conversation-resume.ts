import path from "node:path";

import { SessionStore } from "../state/session-store.js";
import { updateInstanceConfig, type InstanceConfig, type ResumeState } from "../telegram/instance-config.js";

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

function scopeLegacyResumeToRecord(
  record: ConversationResumeRecord,
  legacyResume: ResumeState,
): ResumeState {
  if (record.codexSessionId === legacyResume.sessionId) {
    return legacyResume;
  }

  // Before resume state became conversation-scoped, its workspace applied to
  // every existing conversation in the instance. Preserve that actual cwd for
  // those records, but never copy the old shared symlink ownership.
  const { symlinkPath: _legacySymlinkPath, ...sharedWorkspace } = legacyResume;
  return {
    ...sharedWorkspace,
    sessionId: record.codexSessionId,
  };
}

/**
 * Move the pre-conversation-scoping `config.json.resume` value onto every
 * session record that previously inherited its instance-wide workspace. Once
 * this succeeds callers may delete the legacy field; future conversations no
 * longer inherit that workspace.
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
  if (inspected.state.chats.length === 0) return false;
  for (const record of inspected.state.chats) {
    if (!hasConversationResume(record)) {
      await store.upsert({
        ...record,
        resume: scopeLegacyResumeToRecord(record, legacyResume),
      });
    }
  }
  return true;
}

/**
 * Scope `cfg.resume` to ONE conversation, in place. v0.1.203 moved /resume
 * workspace bindings from instance config onto per-conversation session
 * records, and the message-turn entry points were updated — but the Lark
 * card-driven entry points (AskUserQuestion choice, archive-continue) kept
 * reading the raw instance config, so a resumed conversation's card follow-up
 * ran in the DEFAULT workspace with the default delivery sandbox. Every entry
 * point that turns a conversation's input into an engine turn must call this
 * before deriving a workspace from cfg.
 */
export async function applyConversationResumeScope(
  stateDir: string,
  conversationKey: string,
  cfg: InstanceConfig,
): Promise<void> {
  const store = new SessionStore(path.join(stateDir, "session.json"));
  if (cfg.resume && await migrateLegacyConversationResume(store, cfg.resume)) {
    const migratedSessionId = cfg.resume.sessionId;
    await updateInstanceConfig(stateDir, (config) => {
      const legacy = config.resume as ResumeState | undefined;
      if (legacy?.sessionId === migratedSessionId) delete config.resume;
    });
    cfg.resume = undefined;
  }
  const session = await store.findByConversationKeySafe(conversationKey);
  const scoped = session.warning
    ? undefined
    : resolveConversationResume(session.record, cfg.resume);
  if (scoped && session.record && !hasConversationResume(session.record)) {
    await store.upsert({ ...session.record, resume: scoped });
    await updateInstanceConfig(stateDir, (config) => {
      const legacy = config.resume as ResumeState | undefined;
      if (legacy?.sessionId === scoped.sessionId) delete config.resume;
    });
  }
  cfg.resume = scoped;
}
