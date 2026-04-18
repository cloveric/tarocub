import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ConfigFileSchema } from "../state/config-file-schema.js";

export interface BusConfig {
  peers: "*" | string[] | false;
  maxDepth: number;
  port: number;
  secret: string;
  parallel: string[];
  chain: string[];
  verifier: string | null;
  crew: BusCrewConfig | null;
}

export interface BusCrewConfig {
  enabled: boolean;
  workflow: "research-report";
  coordinator: string;
  roles: {
    researcher: string;
    analyst: string;
    writer: string;
    reviewer: string;
  };
  maxResearchQuestions: number;
  maxRevisionRounds: number;
}

const DEFAULT_MAX_DEPTH = 3;

function parseCrewConfig(raw: unknown): BusCrewConfig | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  const enabled = obj.enabled === true;
  const workflow = obj.workflow === "research-report" ? "research-report" : null;
  const coordinator = typeof obj.coordinator === "string" && obj.coordinator.trim() ? obj.coordinator.trim() : null;
  const roles = typeof obj.roles === "object" && obj.roles !== null ? obj.roles as Record<string, unknown> : null;
  const researcher = typeof roles?.researcher === "string" && roles.researcher.trim() ? roles.researcher.trim() : null;
  const analyst = typeof roles?.analyst === "string" && roles.analyst.trim() ? roles.analyst.trim() : null;
  const writer = typeof roles?.writer === "string" && roles.writer.trim() ? roles.writer.trim() : null;
  const reviewer = typeof roles?.reviewer === "string" && roles.reviewer.trim() ? roles.reviewer.trim() : null;

  if (!enabled || !workflow || !coordinator || !researcher || !analyst || !writer || !reviewer) {
    return null;
  }

  const participants = [coordinator, researcher, analyst, writer, reviewer];
  if (new Set(participants).size !== participants.length) {
    return null;
  }

  const maxResearchQuestions =
    typeof obj.maxResearchQuestions === "number" && Number.isFinite(obj.maxResearchQuestions) && obj.maxResearchQuestions > 0
      ? Math.trunc(obj.maxResearchQuestions)
      : 5;

  const maxRevisionRounds =
    typeof obj.maxRevisionRounds === "number" && Number.isFinite(obj.maxRevisionRounds) && obj.maxRevisionRounds >= 0
      ? Math.trunc(obj.maxRevisionRounds)
      : 1;

  return {
    enabled,
    workflow,
    coordinator,
    roles: {
      researcher,
      analyst,
      writer,
      reviewer,
    },
    maxResearchQuestions,
    maxRevisionRounds,
  };
}

export function parseBusConfig(raw: unknown): BusConfig | null {
  if (raw === undefined || raw === null || raw === false) {
    return null;
  }

  if (raw === true) {
    return {
      peers: "*",
      maxDepth: DEFAULT_MAX_DEPTH,
      port: 0,
      secret: randomBytes(16).toString("hex"),
      parallel: [],
      chain: [],
      verifier: null,
      crew: null,
    };
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

  const chain = Array.isArray(obj.chain)
    ? obj.chain.filter((v): v is string => typeof v === "string")
    : [];

  const verifier = typeof obj.verifier === "string" && obj.verifier.trim() ? obj.verifier.trim() : null;
  const crew = parseCrewConfig(obj.crew);

  return { peers, maxDepth, port, secret, parallel, chain, verifier, crew };
}

export async function loadBusConfig(stateDir: string): Promise<BusConfig | null> {
  try {
    const raw = await readFile(path.join(stateDir, "config.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = ConfigFileSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return parseBusConfig(result.data.bus);
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
