import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface BusRegistryEntry {
  port: number;
  pid: number;
  secret: string;
  updatedAt: string;
}

export interface BusRegistryData {
  instances: Record<string, BusRegistryEntry>;
}

function resolveRegistryPath(channelRoot: string): string {
  return path.join(channelRoot, ".bus-registry.json");
}

export function resolveChannelRoot(stateDir: string): string {
  return path.dirname(stateDir);
}

export async function readRegistry(channelRoot: string): Promise<BusRegistryData> {
  try {
    const raw = await readFile(resolveRegistryPath(channelRoot), "utf8");
    const data = JSON.parse(raw) as BusRegistryData;
    if (typeof data === "object" && data !== null && typeof data.instances === "object") {
      return data;
    }
    return { instances: {} };
  } catch {
    return { instances: {} };
  }
}

export async function registerInstance(
  channelRoot: string,
  instanceName: string,
  port: number,
  secret: string,
): Promise<void> {
  await mkdir(channelRoot, { recursive: true, mode: 0o700 });
  const registry = await readRegistry(channelRoot);
  registry.instances[instanceName] = {
    port,
    pid: process.pid,
    secret,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(resolveRegistryPath(channelRoot), JSON.stringify(registry, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

export async function deregisterInstance(
  channelRoot: string,
  instanceName: string,
): Promise<void> {
  const registry = await readRegistry(channelRoot);
  delete registry.instances[instanceName];
  await writeFile(resolveRegistryPath(channelRoot), JSON.stringify(registry, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

export async function lookupInstance(
  channelRoot: string,
  instanceName: string,
): Promise<BusRegistryEntry | null> {
  const registry = await readRegistry(channelRoot);
  const entry = registry.instances[instanceName];
  if (!entry) return null;
  return isInstanceAlive(entry) ? entry : null;
}

/**
 * True when the PID recorded in the registry entry still refers to a live
 * process. Using `process.kill(pid, 0)` is a no-op signal that probes
 * existence; ESRCH = no such process, EPERM = exists but owned by another
 * user (fine — still alive, just not ours to signal).
 */
export function isInstanceAlive(entry: BusRegistryEntry): boolean {
  if (!Number.isInteger(entry.pid) || entry.pid <= 0) return false;
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export async function listRegisteredInstances(
  channelRoot: string,
): Promise<Array<{ name: string } & BusRegistryEntry>> {
  const registry = await readRegistry(channelRoot);
  return Object.entries(registry.instances).map(([name, entry]) => ({ name, ...entry }));
}

/**
 * Like listRegisteredInstances but drops entries whose PID no longer exists.
 * Use for cross-instance delegation and UI — callers that need a live target
 * should never see a corpse.
 */
export async function listActiveInstances(
  channelRoot: string,
): Promise<Array<{ name: string } & BusRegistryEntry>> {
  const all = await listRegisteredInstances(channelRoot);
  return all.filter((entry) => isInstanceAlive(entry));
}

/**
 * Remove entries whose PID is gone. Safe to call at startup before a fresh
 * registerInstance, to keep `.bus-registry.json` from accumulating corpses.
 */
export async function pruneStaleInstances(channelRoot: string): Promise<number> {
  const registry = await readRegistry(channelRoot);
  let removed = 0;
  for (const [name, entry] of Object.entries(registry.instances)) {
    if (!isInstanceAlive(entry)) {
      delete registry.instances[name];
      removed++;
    }
  }
  if (removed > 0) {
    await mkdir(channelRoot, { recursive: true, mode: 0o700 });
    await writeFile(resolveRegistryPath(channelRoot), JSON.stringify(registry, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  }
  return removed;
}
