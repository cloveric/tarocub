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
  return registry.instances[instanceName] ?? null;
}

export async function listRegisteredInstances(
  channelRoot: string,
): Promise<Array<{ name: string } & BusRegistryEntry>> {
  const registry = await readRegistry(channelRoot);
  return Object.entries(registry.instances).map(([name, entry]) => ({ name, ...entry }));
}
