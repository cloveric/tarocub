// Restart-loop circuit breaker (adapted from Hermes's restart_loop_guard).
//
// TaroCub has no launchd/systemd KeepAlive of its own, but operators can (and
// the Docker docs do) run the service under a supervisor that respawns on
// crash. If boot-time recovery work — interrupted-turn marking, delivery-
// obligation redelivery — is itself what crashes the process, a supervised
// deployment enters a tight crash/respawn loop, and even an unsupervised one
// fails every manual start. This breaker detects repeated UNCLEAN boots
// (previous run died without releasing the service lock) inside a short
// window and tells the caller to skip boot recovery for that boot: the
// service still starts and serves live traffic, it just stops replaying
// whatever keeps killing it.
//
// Operator restarts never trip it: a clean shutdown releases the lock, so the
// next boot is not counted, and a clean shutdown also clears the window.
// Best-effort by design: every failure fails OPEN (no trip) — a broken
// breaker must never wedge a healthy service.

import { readFile, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";

const RESTART_LOOP_FILENAME = "restart-loop.json";

export const DEFAULT_MAX_UNCLEAN_BOOTS = 3;
export const DEFAULT_UNCLEAN_BOOT_WINDOW_MS = 10 * 60_000;

export interface RestartLoopCheck {
  tripped: boolean;
  /** Unclean boots (ms epochs) inside the window, including this one. */
  recentBoots: number[];
}

export function resolveRestartLoopStatePath(stateDir: string): string {
  return path.join(stateDir, RESTART_LOOP_FILENAME);
}

async function loadBoots(stateDir: string): Promise<number[]> {
  try {
    const raw = await readFile(resolveRestartLoopStatePath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const boots = (parsed as { boots?: unknown })?.boots;
    if (!Array.isArray(boots)) {
      return [];
    }
    return boots.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  } catch {
    return [];
  }
}

async function saveBoots(stateDir: string, boots: number[]): Promise<void> {
  const filePath = resolveRestartLoopStatePath(stateDir);
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify({ boots }), "utf8");
  await rename(tmpPath, filePath);
}

/**
 * Record that the service just booted after an UNCLEAN previous shutdown and
 * report whether the crash-loop threshold is now reached. Call only when the
 * boot actually recovered a stale service lock; clean boots must not count.
 */
export async function recordUncleanBootAndCheck(
  stateDir: string,
  options: { maxUncleanBoots?: number; windowMs?: number; now?: number } = {},
): Promise<RestartLoopCheck> {
  const maxBoots = options.maxUncleanBoots ?? DEFAULT_MAX_UNCLEAN_BOOTS;
  const windowMs = Math.max(1_000, options.windowMs ?? DEFAULT_UNCLEAN_BOOT_WINDOW_MS);
  const now = options.now ?? Date.now();
  try {
    const cutoff = now - windowMs;
    const boots = (await loadBoots(stateDir)).filter((ts) => ts >= cutoff && ts <= now);
    boots.push(now);
    await saveBoots(stateDir, boots).catch(() => undefined);
    return {
      tripped: maxBoots > 0 && boots.length >= maxBoots,
      recentBoots: boots,
    };
  } catch {
    // Fail open: a broken breaker must never block recovery on a healthy boot.
    return { tripped: false, recentBoots: [] };
  }
}

/**
 * Read-only variant: report whether the persisted window already holds enough
 * unclean endings to trip, WITHOUT recording a new one. Used at boot when the
 * lock was released cleanly but the previous run may have ended in a fatal
 * error (which records via `recordUncleanBootAndCheck` at exit time).
 */
export async function isRestartLoopTripped(
  stateDir: string,
  options: { maxUncleanBoots?: number; windowMs?: number; now?: number } = {},
): Promise<RestartLoopCheck> {
  const maxBoots = options.maxUncleanBoots ?? DEFAULT_MAX_UNCLEAN_BOOTS;
  const windowMs = Math.max(1_000, options.windowMs ?? DEFAULT_UNCLEAN_BOOT_WINDOW_MS);
  const now = options.now ?? Date.now();
  try {
    const cutoff = now - windowMs;
    const boots = (await loadBoots(stateDir)).filter((ts) => ts >= cutoff && ts <= now);
    return {
      tripped: maxBoots > 0 && boots.length >= maxBoots,
      recentBoots: boots,
    };
  } catch {
    return { tripped: false, recentBoots: [] };
  }
}

/** Clear the window on clean shutdown so past crashes never haunt a healthy restart. */
export async function clearRestartLoopState(stateDir: string): Promise<void> {
  try {
    await rm(resolveRestartLoopStatePath(stateDir), { force: true });
  } catch {
    // best-effort
  }
}
