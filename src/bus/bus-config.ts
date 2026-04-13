import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface BusConfig {
  peers: "*" | string[] | false;
  maxDepth: number;
  port: number;
  secret: string;
  parallel: string[];
  verifier: string | null;
}

const DEFAULT_MAX_DEPTH = 3;

export function parseBusConfig(raw: unknown): BusConfig | null {
  if (raw === undefined || raw === null || raw === false) {
    return null;
  }

  if (raw === true) {
    return { peers: "*", maxDepth: DEFAULT_MAX_DEPTH, port: 0, secret: randomBytes(16).toString("hex"), parallel: [], verifier: null };
  }

  if (typeof raw !== "object") {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  let peers: BusConfig["peers"] = false;

  if (obj.peers === "*" || obj.peers === true) {
    peers = "*";
  } else if (Array.isArray(obj.peers)) {
    peers = obj.peers.filter((v): v is string => typeof v === "string");
    if (peers.length === 0) {
      return null;
    }
  } else if (obj.peers === false || obj.peers === undefined) {
    return null;
  }

  const maxDepth =
    typeof obj.maxDepth === "number" && Number.isFinite(obj.maxDepth) && obj.maxDepth > 0
      ? Math.trunc(obj.maxDepth)
      : DEFAULT_MAX_DEPTH;

  const port =
    typeof obj.port === "number" && Number.isFinite(obj.port) && obj.port >= 0
      ? Math.trunc(obj.port)
      : 0;

  const secret = typeof obj.secret === "string" && obj.secret ? obj.secret : randomBytes(16).toString("hex");

  const parallel = Array.isArray(obj.parallel)
    ? obj.parallel.filter((v): v is string => typeof v === "string")
    : [];

  const verifier = typeof obj.verifier === "string" && obj.verifier.trim() ? obj.verifier.trim() : null;

  return { peers, maxDepth, port, secret, parallel, verifier };
}

export async function loadBusConfig(stateDir: string): Promise<BusConfig | null> {
  try {
    const raw = await readFile(path.join(stateDir, "config.json"), "utf8");
    const config = JSON.parse(raw) as { bus?: unknown };
    return parseBusConfig(config.bus);
  } catch {
    return null;
  }
}

export function isPeerAllowed(busConfig: BusConfig, peerName: string): boolean {
  if (busConfig.peers === "*") {
    return true;
  }

  if (Array.isArray(busConfig.peers)) {
    return busConfig.peers.includes(peerName);
  }

  return false;
}
