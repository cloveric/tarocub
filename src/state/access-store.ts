import { randomInt } from "node:crypto";

import { AccessStateSchema } from "./access-state-schema.js";
import { JsonStore } from "./json-store.js";
import type { AccessPolicy, AccessState, PairedUser, PendingPair } from "../types.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const PAIRING_TTL_MS = 5 * 60 * 1000;

function createDefaultAccessState(): AccessState {
  return {
    policy: "pairing",
    pairedUsers: [],
    allowlist: [],
    pendingPairs: [],
  };
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

  constructor(filePath: string) {
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

  async setPolicy(policy: AccessPolicy): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.load();
      state.policy = policy;
      await this.store.write(state);
    });
  }

  async allowChat(chatId: number): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.load();
      state.allowlist = [...new Set([...state.allowlist, chatId])];
      await this.store.write(state);
    });
  }

  async revokeChat(chatId: number): Promise<void> {
    await this.enqueueWrite(async () => {
      const state = await this.load();
      state.allowlist = state.allowlist.filter((entry) => entry !== chatId);
      state.pairedUsers = state.pairedUsers.filter((entry) => entry.telegramChatId !== chatId);
      state.pendingPairs = state.pendingPairs.filter((entry) => entry.telegramChatId !== chatId);
      await this.store.write(state);
    });
  }

  async getStatus(): Promise<{
    policy: AccessPolicy;
    pairedUsers: number;
    allowlist: number[];
    pendingPairs: { code: string; telegramChatId: number; expiresAt: string }[];
  }> {
    const state = await this.load();

    return {
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
      const state = await this.load();
      const nowTime = now.getTime();
      const reusablePendingPair = state.pendingPairs.find(
        (pair) =>
          pair.telegramUserId === telegramUserId &&
          pair.telegramChatId === telegramChatId &&
          new Date(pair.expiresAt).getTime() > nowTime,
      );

      state.pendingPairs = state.pendingPairs.filter(
        (pair) => new Date(pair.expiresAt).getTime() > nowTime && pair.telegramUserId !== telegramUserId,
      );

      if (reusablePendingPair) {
        state.pendingPairs.push(reusablePendingPair);
        await this.store.write(state);
        issued = reusablePendingPair;
        return;
      }

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
      const state = await this.load();
      const pendingPair = state.pendingPairs.find((pair) => pair.code === code);

      if (!pendingPair) {
        return;
      }

      state.pendingPairs = state.pendingPairs.filter((pair) => pair.code !== code);

      if (new Date(pendingPair.expiresAt).getTime() <= now.getTime()) {
        await this.store.write(state);
        return;
      }

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
    const run = this.pendingWrite.then(task, task);
    this.pendingWrite = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
