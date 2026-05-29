import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withFileMutex } from "../state/file-mutex.js";
import type { TelemetryAdapter, TelemetryTags } from "./telemetry.js";

export interface TurnPoolWaitEvent {
  waitedMs: number;
  activeCount: number;
  maxActive: number;
  reason: "turn_pool";
}

export interface TurnPoolRunOptions {
  signal?: AbortSignal;
  waitNotifyAfterMs?: number;
  onWait?: (event: TurnPoolWaitEvent) => void | Promise<void>;
  metadata?: {
    channel?: string;
    instanceName?: string;
    conversationKey?: string;
    sessionId?: string;
  };
}

export interface TurnPoolLike {
  run<T>(task: () => Promise<T>, options?: TurnPoolRunOptions): Promise<T>;
}

interface TurnPoolLease {
  id: string;
  pid: number;
  acquiredAt: string;
  updatedAt: string;
  channel?: string;
  instanceName?: string;
  conversationKey?: string;
  sessionId?: string;
}

interface TurnPoolState {
  leases: TurnPoolLease[];
}

export interface FileTurnPoolOptions {
  maxActive: number;
  poolPath?: string;
  staleLeaseMs?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  telemetry?: TelemetryAdapter;
  telemetryTags?: TelemetryTags;
}

const DEFAULT_STALE_LEASE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 250;
// Refresh a held lease's updatedAt well within DEFAULT_STALE_LEASE_MS so a
// legitimately long-running turn (e.g. a "no timeout" task) is never mistaken
// for a dead/abandoned lease and evicted, which would over-admit past maxActive.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60 * 1000;

export function resolveDefaultTurnPoolPath(): string {
  return path.join(os.tmpdir(), "tarocub-turn-pool", "turns.json");
}

export class FileTurnPool implements TurnPoolLike {
  private readonly maxActive: number;
  private readonly poolPath: string;
  private readonly staleLeaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly telemetry?: TelemetryAdapter;
  private readonly telemetryTags?: TelemetryTags;

  constructor(options: FileTurnPoolOptions) {
    this.maxActive = Math.max(0, Math.floor(options.maxActive));
    this.poolPath = options.poolPath ?? resolveDefaultTurnPoolPath();
    this.staleLeaseMs = options.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.telemetry = options.telemetry;
    this.telemetryTags = options.telemetryTags;
  }

  async run<T>(task: () => Promise<T>, options: TurnPoolRunOptions = {}): Promise<T> {
    if (this.maxActive <= 0) {
      return await task();
    }

    const leaseId = `${process.pid}-${Date.now()}-${randomUUID()}`;
    const waitStartedAt = Date.now();
    let waitNotified = false;
    let waitMetricRecorded = false;
    let acquired = false;
    let heartbeat: NodeJS.Timeout | undefined;
    try {
      for (;;) {
        throwIfAborted(options.signal);
        const activeCount = await this.tryAcquire(leaseId, options);
        if (activeCount < this.maxActive) {
          acquired = true;
          await this.recordPoolMetric("pool_active", activeCount + 1, options);
          await this.recordPoolMetric("pool_waiting", 0, options);
          break;
        }

        if (!waitMetricRecorded) {
          waitMetricRecorded = true;
          await this.recordPoolMetric("pool_active", activeCount, options);
          await this.recordPoolMetric("pool_waiting", 1, options);
        }
        const waitedMs = Math.max(0, Date.now() - waitStartedAt);
        if (!waitNotified && options.onWait && waitedMs >= (options.waitNotifyAfterMs ?? 0)) {
          waitNotified = true;
          await options.onWait({
            waitedMs,
            activeCount,
            maxActive: this.maxActive,
            reason: "turn_pool",
          });
        }
        await sleep(this.pollIntervalMs, options.signal);
      }

      heartbeat = setInterval(() => {
        void this.renewLease(leaseId).catch(() => undefined);
      }, this.heartbeatIntervalMs);
      heartbeat.unref?.();

      return await task();
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (acquired) {
        const activeAfterRelease = await this.release(leaseId).catch(() => undefined);
        if (typeof activeAfterRelease === "number") {
          await this.recordPoolMetric("pool_active", activeAfterRelease, options);
        }
      }
    }
  }

  private async renewLease(leaseId: string): Promise<void> {
    await withFileMutex(this.poolPath, async () => {
      const state = await this.readState();
      let changed = false;
      const now = new Date().toISOString();
      const leases = state.leases.map((lease) => {
        if (lease.id === leaseId) {
          changed = true;
          return { ...lease, updatedAt: now };
        }
        return lease;
      });
      if (changed) {
        await this.writeState({ leases });
      }
    });
  }

  private async tryAcquire(leaseId: string, options: TurnPoolRunOptions): Promise<number> {
    let activeCount = 0;
    await withFileMutex(this.poolPath, async () => {
      const state = await this.readState();
      const leases = state.leases.filter((lease) => this.isLeaseAlive(lease));
      activeCount = leases.length;
      if (leases.length < this.maxActive) {
        const now = new Date().toISOString();
        leases.push({
          id: leaseId,
          pid: process.pid,
          acquiredAt: now,
          updatedAt: now,
          ...(options.metadata?.channel ? { channel: options.metadata.channel } : {}),
          ...(options.metadata?.instanceName ? { instanceName: options.metadata.instanceName } : {}),
          ...(options.metadata?.conversationKey ? { conversationKey: options.metadata.conversationKey } : {}),
          ...(options.metadata?.sessionId ? { sessionId: options.metadata.sessionId } : {}),
        });
      }
      await this.writeState({ leases });
    });
    return activeCount;
  }

  private async release(leaseId: string): Promise<number> {
    let activeCount = 0;
    await withFileMutex(this.poolPath, async () => {
      const state = await this.readState();
      const leases = state.leases.filter((lease) => lease.id !== leaseId);
      activeCount = leases.length;
      await this.writeState({ leases });
    });
    return activeCount;
  }

  private async recordPoolMetric(name: "pool_active" | "pool_waiting", value: number, options: TurnPoolRunOptions): Promise<void> {
    await Promise.resolve(this.telemetry?.recordMetric?.(name, value, {
      ...this.telemetryTags,
      ...(options.metadata?.channel ? { channel: options.metadata.channel } : {}),
      ...(options.metadata?.instanceName ? { instanceName: options.metadata.instanceName } : {}),
      ...(options.metadata?.conversationKey ? { conversationKey: options.metadata.conversationKey } : {}),
      ...(options.metadata?.sessionId ? { sessionId: options.metadata.sessionId } : {}),
    })).catch(() => undefined);
  }

  private async readState(): Promise<TurnPoolState> {
    try {
      const raw = await readFile(this.poolPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TurnPoolState>;
      return {
        leases: Array.isArray(parsed.leases)
          ? parsed.leases.filter(isTurnPoolLease)
          : [],
      };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return { leases: [] };
      }
      throw error;
    }
  }

  private async writeState(state: TurnPoolState): Promise<void> {
    await mkdir(path.dirname(this.poolPath), { recursive: true, mode: 0o700 });
    await writeFile(this.poolPath, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  private isLeaseAlive(lease: TurnPoolLease): boolean {
    const updatedAtMs = new Date(lease.updatedAt).getTime();
    if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > this.staleLeaseMs) {
      return false;
    }
    return isProcessAlive(lease.pid);
  }
}

function isTurnPoolLease(value: unknown): value is TurnPoolLease {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<TurnPoolLease>;
  return typeof record.id === "string" &&
    typeof record.pid === "number" &&
    typeof record.acquiredAt === "string" &&
    typeof record.updatedAt === "string";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return false;
      }
      if (code === "EPERM") {
        return true;
      }
    }
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("turn pool wait aborted");
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let abort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (signal && abort) {
        signal.removeEventListener("abort", abort);
      }
      resolve();
    }, ms);
    timer.unref?.();
    if (!signal) {
      return;
    }
    abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort!);
      reject(new Error("turn pool wait aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
