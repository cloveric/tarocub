import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
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
  return (await isInstanceAlive(entry)) ? entry : null;
}

/**
 * True when a bus server is actually listening on the registered port.
 *
 * Earlier versions probed only the PID via `process.kill(pid, 0)`, but that
 * gives false positives in two common cases:
 * 1. The bot crashed but the PID has been recycled by an unrelated process.
 * 2. The bot's main process exists (as a zombie / during shutdown) but the
 *    bus server has already stopped accepting connections.
 *
 * A TCP connect probe catches both: if nothing is listening on the port,
 * we get ECONNREFUSED immediately. 500ms timeout is plenty for localhost.
 */
export async function isInstanceAlive(entry: BusRegistryEntry): Promise<boolean> {
  if (!Number.isInteger(entry.port) || entry.port <= 0 || entry.port > 65535) {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: entry.port });
    const done = (alive: boolean) => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

export async function listRegisteredInstances(
  channelRoot: string,
): Promise<Array<{ name: string } & BusRegistryEntry>> {
  const registry = await readRegistry(channelRoot);
  return Object.entries(registry.instances).map(([name, entry]) => ({ name, ...entry }));
}

/**
 * Like listRegisteredInstances but drops entries whose bus server no longer
 * answers. Use for cross-instance delegation and UI — callers that need a
 * live target should never see a corpse.
 */
export async function listActiveInstances(
  channelRoot: string,
): Promise<Array<{ name: string } & BusRegistryEntry>> {
  const all = await listRegisteredInstances(channelRoot);
  const checks = await Promise.all(all.map(async (entry) => ({ entry, alive: await isInstanceAlive(entry) })));
  return checks.filter(({ alive }) => alive).map(({ entry }) => entry);
}

/**
 * Remove entries whose port no longer answers. Safe to call at startup
 * before a fresh registerInstance, to keep `.bus-registry.json` from
 * accumulating corpses.
 */
export async function pruneStaleInstances(channelRoot: string): Promise<number> {
  const registry = await readRegistry(channelRoot);
  const entries = Object.entries(registry.instances);
  const checks = await Promise.all(entries.map(async ([name, entry]) => ({ name, alive: await isInstanceAlive(entry) })));
  let removed = 0;
  for (const { name, alive } of checks) {
    if (!alive) {
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
