import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { BusRegistryEntrySchema } from "./bus-registry-schema.js";

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
    const data = JSON.parse(raw) as unknown;
    if (typeof data === "object" && data !== null && "instances" in data) {
      const instances = (data as { instances?: unknown }).instances;
      if (typeof instances === "object" && instances !== null) {
        const filtered: Record<string, BusRegistryEntry> = {};
        for (const [name, entry] of Object.entries(instances as Record<string, unknown>)) {
          const result = BusRegistryEntrySchema.safeParse(entry);
          if (result.success) {
            filtered[name] = result.data;
          }
        }
        return { instances: filtered };
      }
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
  return (await isInstanceAlive(entry, instanceName)) ? entry : null;
}

/**
 * True when a cc-telegram-bridge bus server is actually listening on the
 * registered port and identifies as the expected instance.
 *
 * Bare TCP connect is not enough — any unrelated local service binding the
 * same port would pass, and the caller would then POST the bus secret to a
 * stranger. So we do a quick HTTP GET /api/health and verify the response
 * is JSON with our fingerprint (kind="cc-telegram-bridge") and the matching
 * instance name.
 *
 * 500ms timeout is plenty for localhost. On any failure (connect refused,
 * wrong port occupant, JSON mismatch) we return false and the caller treats
 * the entry as stale.
 */
export async function isInstanceAlive(entry: BusRegistryEntry, expectedName?: string): Promise<boolean> {
  if (!Number.isInteger(entry.port) || entry.port <= 0 || entry.port > 65535) {
    return false;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const res = await fetch(`http://127.0.0.1:${entry.port}/api/health`, { signal: controller.signal });
      if (!res.ok) return false;
      const body = (await res.json()) as { kind?: unknown; instance?: unknown; status?: unknown };
      if (body.kind !== "cc-telegram-bridge") return false;
      if (body.status !== "ok") return false;
      if (expectedName !== undefined && body.instance !== expectedName) return false;
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
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
  const checks = await Promise.all(all.map(async (entry) => ({ entry, alive: await isInstanceAlive(entry, entry.name) })));
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
  const checks = await Promise.all(entries.map(async ([name, entry]) => ({ name, alive: await isInstanceAlive(entry, name) })));
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
