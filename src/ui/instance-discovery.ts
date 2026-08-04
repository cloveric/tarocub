// Feature 1 (web config UI) — instance discovery. TaroCub is one-process-per-
// instance with config isolated under ~/.cctb/<instance>/, so unlike zara's
// single-supervisor model the UI cannot hold live in-process handles for other
// instances. It instead reads each instance's config off disk and its
// running-state off the service lock, and applies edits with the existing
// updateInstanceConfig (taking effect on the instance's next restart). No new
// shared supervisor, no cross-instance broker.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { loadInstanceConfig, type InstanceConfig } from "../telegram/instance-config.js";

export interface CctbInstanceSummary {
  name: string;
  stateDir: string;
  engine: InstanceConfig["engine"];
  model: string | undefined;
  effort: InstanceConfig["effort"];
  locale: InstanceConfig["locale"];
  /** True when a live service process owns this instance's lock. */
  running: boolean;
  pid: number | undefined;
  /** True when the dir has a lark.env (a configured Lark instance). */
  hasLarkEnv: boolean;
}

export function resolveCctbRoot(env: { HOME?: string; USERPROFILE?: string }): string | undefined {
  const home = env.HOME ?? env.USERPROFILE;
  return home ? path.join(home, ".cctb") : undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Whether pid is a live process (kill 0 probe). Injectable for tests. */
export type IsProcessAlive = (pid: number) => boolean;

const defaultIsProcessAlive: IsProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process; EPERM = alive but not ours (still alive).
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function readServiceLockPid(stateDir: string): Promise<number | null> {
  // Both channels write a service lock; check both known shapes.
  for (const rel of ["lark-service/instance.lock.json", "service.lock.json"]) {
    try {
      const parsed = JSON.parse(await readFile(path.join(stateDir, rel), "utf8")) as { pid?: unknown };
      if (typeof parsed.pid === "number") {
        return parsed.pid;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** List every configured instance under ~/.cctb, with config + running state. */
export async function listCctbInstances(
  env: { HOME?: string; USERPROFILE?: string },
  isProcessAlive: IsProcessAlive = defaultIsProcessAlive,
): Promise<CctbInstanceSummary[]> {
  const root = resolveCctbRoot(env);
  if (!root) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: CctbInstanceSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const stateDir = path.join(root, entry.name);
    // An instance dir has a config.json and/or lark.env. Skip bare dirs.
    const hasConfig = await fileExists(path.join(stateDir, "config.json"));
    const hasLarkEnv = await fileExists(path.join(stateDir, "lark.env"));
    if (!hasConfig && !hasLarkEnv) {
      continue;
    }
    const config = await loadInstanceConfig(stateDir);
    const pid = await readServiceLockPid(stateDir);
    const running = pid !== null && isProcessAlive(pid);
    summaries.push({
      name: entry.name,
      stateDir,
      engine: config.engine,
      model: config.model,
      effort: config.effort,
      locale: config.locale,
      running,
      pid: running ? pid ?? undefined : undefined,
      hasLarkEnv,
    });
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name));
  return summaries;
}

/** Resolve one instance's state dir, guarding against path traversal in the name. */
export function resolveInstanceStateDir(
  env: { HOME?: string; USERPROFILE?: string },
  instanceName: string,
): string | undefined {
  const root = resolveCctbRoot(env);
  if (!root) {
    return undefined;
  }
  // Reject anything that isn't a plain instance directory name.
  if (!/^[A-Za-z0-9._-]+$/.test(instanceName) || instanceName.startsWith(".")) {
    return undefined;
  }
  return path.join(root, instanceName);
}
