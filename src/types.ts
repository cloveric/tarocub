export type AccessPolicy = "pairing" | "allowlist";

export interface PairedUser {
  telegramUserId: number;
  telegramChatId: number;
  pairedAt: string;
}

export interface PendingPair {
  code: string;
  telegramUserId: number;
  telegramChatId: number;
  expiresAt: string;
}

export interface AccessState {
  policy: AccessPolicy;
  pairedUsers: PairedUser[];
  allowlist: number[];
  pendingPairs: PendingPair[];
}

export interface AppConfig {
  instanceName: string;
  telegramBotToken: string;
  stateDir: string;
  inboxDir: string;
  accessStatePath: string;
  sessionStatePath: string;
  runtimeLogPath: string;
  codexExecutable: string;
}

export interface SuspendedConversationState {
  sessionId: string | null;
  resume: {
    sessionId: string;
    dirName: string;
    workspacePath: string;
    symlinkPath?: string;
  } | null;
}

export interface SessionRecord {
  telegramChatId: number;
  codexSessionId: string;
  status: "idle" | "running" | "queued" | "blocked";
  updatedAt: string;
  suspendedPrevious?: SuspendedConversationState;
}

export interface SessionState {
  chats: SessionRecord[];
}
