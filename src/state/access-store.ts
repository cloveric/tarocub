import { randomInt } from "node:crypto";

import { AccessStateSchema } from "./access-state-schema.js";
import { withFileMutex } from "./file-mutex.js";
import { JsonStore } from "./json-store.js";
import type { AccessPolicy, AccessState, PairedUser, PendingPair } from "../types.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const PAIRING_TTL_MS = 5 * 60 * 1000;

function createDefaultAccessState(): AccessState {
  return {
    multiChat: false,
    policy: "pairing",
    pairedUsers: [],
    allowlist: [],
    pendingPairs: [],
  };
}

export function findConflictingAuthorizedChatId(state: AccessState, chatId: number): number | null {
  if (state.multiChat) {
    return null;
  }

  const authorizedChatIds = new Set<number>([
    ...state.allowlist,
    ...state.pairedUsers.map((entry) => entry.telegramChatId),
  ]);
  authorizedChatIds.delete(chatId);

  const conflict = authorizedChatIds.values().next();
  return conflict.done ? null : conflict.value;
}

function isExpiredPendingPair(pair: PendingPair, now: Date): boolean {
  return new Date(pair.expiresAt).getTime() <= now.getTime();
}

function activePendingPairs(state: AccessState, now: Date): PendingPair[] {
  return state.pendingPairs.filter((pair) => !isExpiredPendingPair(pair, now));
}

/** Drops expired pending pairs in place; returns true when anything was removed. */
function pruneExpiredPendingPairs(state: AccessState, now: Date): boolean {
  const active = activePendingPairs(state, now);
  if (active.length === state.pendingPairs.length) {
    return false;
  }
  state.pendingPairs = active;
  return true;
}

export function findConflictingLockedChatId(state: AccessState, chatId: number, _now: Date = new Date()): number | null {
  if (state.multiChat) {
    return null;
  }

  // Pairing codes are only untrusted claims, not authorization. Let multiple
  // chats request codes; the first successfully redeemed code acquires the
  // single-chat lock. Otherwise any stranger could message a fresh bot first
  // and deny the operator access for the full pairing TTL.
  const lockedChatIds = new Set<number>([
    ...state.allowlist,
    ...state.pairedUsers.map((entry) => entry.telegramChatId),
  ]);
  lockedChatIds.delete(chatId);

  const conflict = lockedChatIds.values().next();
  return conflict.done ? null : conflict.value;
}

function countAuthorizedChats(state: AccessState): number {
  return new Set<number>([
    ...state.allowlist,
    ...state.pairedUsers.map((entry) => entry.telegramChatId),
  ]).size;
}

function generateCode(): string {
  let code = "";

  for (let index = 0; index < CODE_LENGTH; index++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }

  return code;
}

export class AccessStore {
  private readonly store: JsonStore<AccessState>;
  private pendingWrite: Promise<void> = Promise.resolve();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.store = new JsonStore<AccessState>(filePath, (value) => {
      const result = AccessStateSchema.safeParse(value);
      if (result.success) {
        return result.data;
      }

      throw new Error("invalid access state");
    });
  }

  async load(): Promise<AccessState> {
    return this.store.read(createDefaultAccessState());
  }

  /**
   * Load for a mutation. If access.json is genuinely CORRUPT (bad JSON / invalid
   * shape — not a transient I/O error), quarantine it and start from the safe
   * default (pairing policy + empty allowlist = deny everyone, fail-closed) so a
   * single bad write can't permanently brick both access AND the admin commands
   * needed to repair it. Transient errors rethrow so the intact file is retried.
   * The caller's own write persists the recovered state.
   */
  private async loadForWrite(): Promise<AccessState> {
    try {
      return await this.load();
    } catch (error) {
      if (!isRepairableAccessStateError(error)) {
        throw error;
      }
      console.error(`Corrupt ${this.filePath}; quarantining and resetting access to deny-all (re-pair to restore):`, error instanceof Error ? error.message : error);
      await this.store.quarantineCurrentFile("corrupt");
      return createDefaultAccessState();
    }
  }

  async setPolicy(policy: AccessPolicy): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.loadForWrite();
      pruneExpiredPendingPairs(state, new Date());
      state.policy = policy;
      await this.store.write(state);
    });
  }

  async setMultiChat(enabled: boolean): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.loadForWrite();
      const now = new Date();
      pruneExpiredPendingPairs(state, now);
      if (!enabled && countAuthorizedChats(state) > 1) {
        throw new Error("cannot disable multi-chat while multiple chats are authorized");
      }
      state.multiChat = enabled;
      await this.store.write(state);
    });
  }

  async allowChat(chatId: number): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.loadForWrite();
      pruneExpiredPendingPairs(state, new Date());
      if (findConflictingAuthorizedChatId(state, chatId) !== null) {
        throw new Error("instance is locked to another chat until multi-chat is enabled");
      }
      state.allowlist = [...new Set([...state.allowlist, chatId])];
      await this.store.write(state);
    });
  }

  async revokeChat(chatId: number): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.loadForWrite();
      pruneExpiredPendingPairs(state, new Date());
      state.allowlist = state.allowlist.filter((entry) => entry !== chatId);
      state.pairedUsers = state.pairedUsers.filter((entry) => entry.telegramChatId !== chatId);
      state.pendingPairs = state.pendingPairs.filter((entry) => entry.telegramChatId !== chatId);
      await this.store.write(state);
    });
  }

  async allowUser(userId: number): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.loadForWrite();
      pruneExpiredPendingPairs(state, new Date());
      state.allowlist = [...new Set([...state.allowlist, userId])];
      await this.store.write(state);
    });
  }

  async revokeUser(userId: number): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.loadForWrite();
      pruneExpiredPendingPairs(state, new Date());
      state.allowlist = state.allowlist.filter((entry) => entry !== userId);
      state.pairedUsers = state.pairedUsers.filter((entry) => entry.telegramUserId !== userId);
      state.pendingPairs = state.pendingPairs.filter((entry) => entry.telegramUserId !== userId);
      await this.store.write(state);
    });
  }

  async getStatus(): Promise<{
    multiChat: boolean;
    policy: AccessPolicy;
    pairedUsers: number;
    allowlist: number[];
    pendingPairs: { code: string; telegramChatId: number; expiresAt: string }[];
  }> {
    const state = await this.loadForWrite();

    return {
      multiChat: state.multiChat,
      policy: state.policy,
      pairedUsers: state.pairedUsers.length,
      allowlist: [...state.allowlist],
      pendingPairs: state.pendingPairs.map(({ code, telegramChatId, expiresAt }) => ({
        code,
        telegramChatId,
        expiresAt,
      })),
    };
  }

  async issuePairingCode({
    telegramUserId,
    telegramChatId,
    now,
  }: {
    telegramUserId: number;
    telegramChatId: number;
    now: Date;
  }): Promise<PendingPair> {
    let issued!: PendingPair;
    await this.enqueueWrite(async () => {
      const state = await this.loadForWrite();
      pruneExpiredPendingPairs(state, now);

      const reusablePendingPair = state.pendingPairs.find(
        (pair) =>
          pair.telegramUserId === telegramUserId &&
          pair.telegramChatId === telegramChatId,
      );

      if (reusablePendingPair) {
        await this.store.write(state);
        issued = reusablePendingPair;
        return;
      }

      if (findConflictingLockedChatId(state, telegramChatId, now) !== null) {
        throw new Error("instance is locked to another chat until multi-chat is enabled");
      }

      state.pendingPairs = state.pendingPairs.filter((pair) => pair.telegramUserId !== telegramUserId);

      const pendingCodes = new Set(state.pendingPairs.map((pair) => pair.code));

      let code = generateCode();
      while (pendingCodes.has(code)) {
        code = generateCode();
      }

      issued = {
        code,
        telegramUserId,
        telegramChatId,
        expiresAt: new Date(now.getTime() + PAIRING_TTL_MS).toISOString(),
      };

      state.pendingPairs.push(issued);
      await this.store.write(state);
    });
    return issued;
  }

  async redeemPairingCode(code: string, now: Date): Promise<PairedUser | null> {
    let pairedUser: PairedUser | null = null;
    await this.enqueueWrite(async () => {
      const state = await this.loadForWrite();
      const pruned = pruneExpiredPendingPairs(state, now);
      const pendingPair = state.pendingPairs.find((pair) => pair.code === code);

      if (!pendingPair) {
        // Persist the prune so an expired (or unknown) code's record doesn't linger.
        if (pruned) {
          await this.store.write(state);
        }
        return;
      }

      if (findConflictingAuthorizedChatId(state, pendingPair.telegramChatId) !== null) {
        throw new Error("instance is locked to another chat until multi-chat is enabled");
      }

      state.pendingPairs = state.pendingPairs.filter((pair) => pair.code !== code);

      pairedUser = {
        telegramUserId: pendingPair.telegramUserId,
        telegramChatId: pendingPair.telegramChatId,
        pairedAt: now.toISOString(),
      };

      state.pairedUsers = state.pairedUsers.filter(
        (user) =>
          user.telegramUserId !== pairedUser!.telegramUserId || user.telegramChatId !== pairedUser!.telegramChatId,
      );
      state.pairedUsers.push(pairedUser);
      state.allowlist = [...new Set([...state.allowlist, pendingPair.telegramChatId])];

      await this.store.write(state);
    });
    return pairedUser;
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = this.pendingWrite.then(
      () => withFileMutex(this.filePath, task),
      () => withFileMutex(this.filePath, task),
    );
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Corrupt-content errors (bad JSON / invalid shape) that quarantine-and-reset
 * can recover from — as opposed to transient I/O errors, which must rethrow. */
function isRepairableAccessStateError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && error.message === "invalid access state")
  );
}
