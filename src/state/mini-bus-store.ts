import path from "node:path";

import { withFileMutex } from "./file-mutex.js";
import { JsonStore } from "./json-store.js";
import {
  MiniBusStoreStateSchema,
  type MiniBusCrewRole,
  type MiniBusGroupRecord,
  type MiniBusPeerRecord,
  type MiniBusStoreState,
} from "./mini-bus-store-schema.js";

export type { MiniBusCrewRole, MiniBusGroupRecord, MiniBusPeerRecord } from "./mini-bus-store-schema.js";

export type MiniBusPeerInput = Pick<MiniBusPeerRecord, "chatId" | "messageThreadId" | "conversationKey"> & {
  name: string;
};

const MINI_BUS_PEER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MINI_BUS_CREW_ROLES = ["researcher", "analyst", "writer", "reviewer"] as const;
const DEFAULT_MINI_CREW_MAX_RESEARCH_QUESTIONS = 4;
const DEFAULT_MINI_CREW_MAX_REVISION_ROUNDS = 1;

export function resolveMiniBusStorePath(stateDir: string): string {
  return path.join(stateDir, "mini-bus.json");
}

export function normalizeMiniBusPeerName(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  return MINI_BUS_PEER_NAME_PATTERN.test(normalized) ? normalized : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultState(): MiniBusStoreState {
  return { groups: {} };
}

function normalizeNameList(names: string[]): string[] {
  return [...new Set(names.map((name) => normalizeMiniBusPeerName(name)).filter((name): name is string => name !== null))];
}

export function normalizeMiniBusCrewRole(role: string): MiniBusCrewRole | null {
  const normalized = role.trim().toLowerCase();
  return (MINI_BUS_CREW_ROLES as readonly string[]).includes(normalized)
    ? normalized as MiniBusCrewRole
    : null;
}

function normalizeCrewOptions(group: {
  crew?: {
    maxResearchQuestions?: number;
    maxRevisionRounds?: number;
  };
}): MiniBusGroupRecord["crew"] {
  const maxResearchQuestions =
    typeof group.crew?.maxResearchQuestions === "number" &&
      Number.isFinite(group.crew.maxResearchQuestions) &&
      group.crew.maxResearchQuestions > 0
      ? Math.trunc(group.crew.maxResearchQuestions)
      : DEFAULT_MINI_CREW_MAX_RESEARCH_QUESTIONS;
  const maxRevisionRounds =
    typeof group.crew?.maxRevisionRounds === "number" &&
      Number.isFinite(group.crew.maxRevisionRounds) &&
      group.crew.maxRevisionRounds >= 0
      ? Math.trunc(group.crew.maxRevisionRounds)
      : DEFAULT_MINI_CREW_MAX_REVISION_ROUNDS;
  return { maxResearchQuestions, maxRevisionRounds };
}

function normalizeRoles(roles: Record<string, string> | undefined): Partial<Record<MiniBusCrewRole, string>> {
  const normalizedRoles: Partial<Record<MiniBusCrewRole, string>> = {};
  for (const [rawRole, rawPeerName] of Object.entries(roles ?? {})) {
    const role = normalizeMiniBusCrewRole(rawRole);
    const peerName = normalizeMiniBusPeerName(rawPeerName);
    if (role && peerName) {
      normalizedRoles[role] = peerName;
    }
  }
  return normalizedRoles;
}

function normalizeGroup(group: {
  peers?: MiniBusPeerRecord[];
  parallel?: string[];
  chain?: string[];
  verifier?: string;
  roles?: Record<string, string>;
  crew?: {
    maxResearchQuestions?: number;
    maxRevisionRounds?: number;
  };
}): MiniBusGroupRecord {
  const peers = [
    ...new Map((group.peers ?? [])
      .map((peer) => {
        const name = normalizeMiniBusPeerName(peer.name);
        return name ? { ...peer, name } : null;
      })
      .filter((peer): peer is MiniBusPeerRecord => peer !== null)
      .map((peer) => [peer.name, peer])).values(),
  ];
  const verifier = typeof group.verifier === "string" ? normalizeMiniBusPeerName(group.verifier) ?? undefined : undefined;
  return {
    peers,
    parallel: normalizeNameList(group.parallel ?? []),
    chain: normalizeNameList(group.chain ?? []),
    roles: normalizeRoles(group.roles),
    crew: normalizeCrewOptions(group),
    ...(verifier ? { verifier } : {}),
  };
}

function parseMiniBusStoreState(value: unknown): MiniBusStoreState {
  const result = MiniBusStoreStateSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`invalid mini bus store state: ${result.error.message}`);
  }

  const groups: MiniBusStoreState["groups"] = {};
  for (const [chatId, group] of Object.entries(result.data.groups ?? {})) {
    groups[chatId] = normalizeGroup(group);
  }
  return { groups };
}

export class MiniBusStore {
  private readonly store: JsonStore<MiniBusStoreState>;
  private readonly filePath: string;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.filePath = resolveMiniBusStorePath(stateDir);
    this.store = new JsonStore(this.filePath, parseMiniBusStoreState);
  }

  async listPeers(chatId: number): Promise<MiniBusPeerRecord[]> {
    const state = await this.store.read(defaultState());
    return [...(state.groups[String(chatId)]?.peers ?? [])];
  }

  async getGroup(chatId: number): Promise<MiniBusGroupRecord> {
    const state = await this.store.read(defaultState());
    return state.groups[String(chatId)] ?? normalizeGroup({});
  }

  async getPeer(chatId: number, name: string): Promise<MiniBusPeerRecord | null> {
    const normalizedName = normalizeMiniBusPeerName(name);
    if (!normalizedName) {
      return null;
    }
    const peers = await this.listPeers(chatId);
    return peers.find((peer) => peer.name === normalizedName) ?? null;
  }

  async upsertPeer(input: MiniBusPeerInput): Promise<MiniBusPeerRecord> {
    const normalizedName = normalizeMiniBusPeerName(input.name);
    if (!normalizedName) {
      throw new Error("invalid mini bus peer name");
    }

    return this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const chatKey = String(input.chatId);
      const group = state.groups[chatKey] ?? normalizeGroup({});
      const timestamp = nowIso();
      const existingIndex = group.peers.findIndex((peer) => peer.name === normalizedName);
      const existing = existingIndex === -1 ? null : group.peers[existingIndex]!;
      const record: MiniBusPeerRecord = {
        name: normalizedName,
        chatId: input.chatId,
        ...(input.messageThreadId !== undefined ? { messageThreadId: input.messageThreadId } : {}),
        conversationKey: input.conversationKey,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };

      const nextPeers = [...group.peers];
      if (existingIndex === -1) {
        nextPeers.push(record);
      } else {
        nextPeers[existingIndex] = record;
      }
      state.groups[chatKey] = { ...group, peers: nextPeers };
      await this.store.write(state);
      return record;
    });
  }

  async setParallel(chatId: number, names: string[]): Promise<string[]> {
    return this.setNameList(chatId, "parallel", names);
  }

  async setChain(chatId: number, names: string[]): Promise<string[]> {
    return this.setNameList(chatId, "chain", names);
  }

  async setVerifier(chatId: number, name: string | null): Promise<string | undefined> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const chatKey = String(chatId);
      const group = state.groups[chatKey] ?? normalizeGroup({});
      const verifier = name === null ? undefined : normalizeMiniBusPeerName(name) ?? undefined;
      state.groups[chatKey] = {
        ...group,
        ...(verifier ? { verifier } : {}),
      };
      if (!verifier) {
        delete state.groups[chatKey].verifier;
      }
      await this.store.write(state);
      return verifier;
    });
  }

  async setRole(chatId: number, role: MiniBusCrewRole, name: string): Promise<string> {
    const normalizedName = normalizeMiniBusPeerName(name);
    if (!normalizedName) {
      throw new Error("invalid mini bus peer name");
    }

    return this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const chatKey = String(chatId);
      const group = state.groups[chatKey] ?? normalizeGroup({});
      state.groups[chatKey] = {
        ...group,
        roles: {
          ...group.roles,
          [role]: normalizedName,
        },
      };
      await this.store.write(state);
      return normalizedName;
    });
  }

  async removePeer(chatId: number, name: string): Promise<boolean> {
    const normalizedName = normalizeMiniBusPeerName(name);
    if (!normalizedName) {
      return false;
    }

    return this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const chatKey = String(chatId);
      const group = state.groups[chatKey];
      if (!group) {
        return false;
      }

      const nextPeers = group.peers.filter((peer) => peer.name !== normalizedName);
      if (nextPeers.length === group.peers.length) {
        return false;
      }
      const nextRoles = Object.fromEntries(
        Object.entries(group.roles).filter(([, peerName]) => peerName !== normalizedName),
      ) as Partial<Record<MiniBusCrewRole, string>>;
      state.groups[chatKey] = {
        ...group,
        peers: nextPeers,
        parallel: group.parallel.filter((peerName) => peerName !== normalizedName),
        chain: group.chain.filter((peerName) => peerName !== normalizedName),
        roles: nextRoles,
        ...(group.verifier === normalizedName ? {} : { verifier: group.verifier }),
      };
      if (group.verifier === normalizedName) {
        delete state.groups[chatKey].verifier;
      }
      await this.store.write(state);
      return true;
    });
  }

  private async setNameList(chatId: number, key: "parallel" | "chain", names: string[]): Promise<string[]> {
    return this.enqueueWrite(async () => {
      const state = await this.store.read(defaultState());
      const chatKey = String(chatId);
      const group = state.groups[chatKey] ?? normalizeGroup({});
      const normalized = normalizeNameList(names);
      state.groups[chatKey] = {
        ...group,
        [key]: normalized,
      };
      await this.store.write(state);
      return normalized;
    });
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
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
