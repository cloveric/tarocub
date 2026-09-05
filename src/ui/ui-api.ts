// Feature 1 web config UI — JSON API. Kept as a pure request→response function
// (no node:http here) so it is fully unit-testable; ui-server.ts wraps it with
// the loopback + token transport.

import path from "node:path";

import {
  applyEngineSelection,
  getEngineEffortValidationError,
  isEffortLevel,
  loadInstanceConfig,
  updateInstanceConfig,
  type EffortLevel,
  type InstanceConfig,
} from "../telegram/instance-config.js";
import { SessionStore } from "../state/session-store.js";
import {
  listCctbInstances,
  resolveInstanceStateDir,
  type CctbInstanceSummary,
  type IsProcessAlive,
} from "./instance-discovery.js";

export interface UiApiEnv {
  HOME?: string;
  USERPROFILE?: string;
}

export interface UiApiResult {
  status: number;
  json: unknown;
}

export interface UiApiDeps {
  isProcessAlive?: IsProcessAlive;
  updateInstanceConfig?: (
    stateDir: string,
    updater: (config: Record<string, unknown>) => void,
  ) => Promise<void>;
}

/** Fields the UI may edit. Anything else in the body is ignored (never trusted). */
const EDITABLE_FIELDS = ["engine", "model", "effort", "locale", "verbosity", "budgetUsd"] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

const VALID_ENGINES = new Set(["codex", "claude", "antigravity", "kimi", "deepseek"]);

class UiConfigValidationError extends Error {}

function configEngine(config: Record<string, unknown>): InstanceConfig["engine"] {
  return config.engine === "claude" || config.engine === "antigravity" ||
      config.engine === "kimi" || config.engine === "deepseek"
    ? config.engine
    : "codex";
}

function applyUiConfigPatch(
  config: Record<string, unknown>,
  applied: Partial<Record<EditableField, unknown>>,
): void {
  const targetEngine = typeof applied.engine === "string"
    ? applied.engine as InstanceConfig["engine"]
    : configEngine(config);
  if (typeof applied.engine === "string") {
    applyEngineSelection(config, targetEngine);
  }
  for (const [field, value] of Object.entries(applied)) {
    if (field === "engine") continue;
    if (value === undefined) delete config[field];
    else config[field] = value;
  }

  const compatibilityChanged = "engine" in applied || "model" in applied || "effort" in applied;
  if (!compatibilityChanged || config.effort === undefined) return;
  if (!isEffortLevel(config.effort)) {
    throw new UiConfigValidationError("invalid effort value");
  }
  const effortError = getEngineEffortValidationError(
    configEngine(config),
    config.effort as EffortLevel,
    typeof config.model === "string" ? config.model : undefined,
  );
  if (effortError) throw new UiConfigValidationError(effortError);
}

function ok(json: unknown): UiApiResult {
  return { status: 200, json };
}
function error(status: number, message: string): UiApiResult {
  return { status, json: { error: message } };
}

function publicConfig(config: InstanceConfig): Record<string, unknown> {
  // Only the editable/display surface; never leak resume workspace internals here.
  return {
    engine: config.engine,
    model: config.model ?? null,
    effort: config.effort ?? null,
    locale: config.locale,
    verbosity: config.verbosity,
    budgetUsd: config.budgetUsd ?? null,
    meetingEnabled: config.meeting.enabled,
  };
}

/**
 * Handle a UI API request. `pathname` is the path after the origin (e.g.
 * "/api/instances"), `method` is upper-case, `body` is the parsed JSON body (or
 * undefined). Returns a status + JSON payload.
 */
export async function handleUiApiRequest(
  method: string,
  pathname: string,
  body: unknown,
  env: UiApiEnv,
  deps: UiApiDeps = {},
): Promise<UiApiResult> {
  // GET /api/instances — list every instance with config + running state.
  if (method === "GET" && pathname === "/api/instances") {
    const instances = await listCctbInstances(env, deps.isProcessAlive);
    return ok({ instances: instances.map(summaryToJson) });
  }

  const configMatch = pathname.match(/^\/api\/instances\/([^/]+)\/config$/);
  if (configMatch) {
    const instanceName = decodeURIComponent(configMatch[1]!);
    const stateDir = resolveInstanceStateDir(env, instanceName);
    if (!stateDir) {
      return error(400, "invalid instance name");
    }
    if (method === "GET") {
      const config = await loadInstanceConfig(stateDir);
      return ok({ instance: instanceName, config: publicConfig(config) });
    }
    if (method === "POST" || method === "PUT") {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return error(400, "body must be a JSON object");
      }
      const patch = body as Record<string, unknown>;
      const applied: Partial<Record<EditableField, unknown>> = {};
      for (const field of EDITABLE_FIELDS) {
        if (!(field in patch)) {
          continue;
        }
        const value = patch[field];
        if (field === "engine" && typeof value === "string" && VALID_ENGINES.has(value)) {
          applied.engine = value;
        } else if (field === "model") {
          applied.model = typeof value === "string" && value.trim() ? value.trim() : undefined;
        } else if (field === "effort") {
          const normalized = typeof value === "string" ? value.trim() : "";
          if (normalized && !isEffortLevel(normalized)) {
            return error(400, "invalid effort value");
          }
          applied.effort = normalized || undefined;
        } else if (field === "locale" && (value === "en" || value === "zh")) {
          applied.locale = value;
        } else if (field === "verbosity" && (value === 0 || value === 1 || value === 2)) {
          applied.verbosity = value;
        } else if (field === "budgetUsd") {
          applied.budgetUsd = typeof value === "number" && value > 0 ? value : undefined;
        }
      }
      if (Object.keys(applied).length === 0) {
        return error(400, "no editable fields in body");
      }
      try {
        const currentConfig = await loadInstanceConfig(stateDir);
        const prospectiveConfig: Record<string, unknown> = {
          engine: currentConfig.engine,
          ...(currentConfig.model ? { model: currentConfig.model } : {}),
          ...(currentConfig.effort ? { effort: currentConfig.effort } : {}),
        };
        applyUiConfigPatch(prospectiveConfig, applied);

        const targetEngine = configEngine(prospectiveConfig);
        const persistConfig = async (): Promise<void> => {
          await (deps.updateInstanceConfig ?? updateInstanceConfig)(stateDir, (config) => {
            applyUiConfigPatch(config, applied);
          });
        };
        if (targetEngine !== currentConfig.engine) {
          let configWriteStarted = false;
          try {
            await new SessionStore(path.join(stateDir, "session.json")).clearAllThen(async () => {
              configWriteStarted = true;
              await persistConfig();
            });
          } catch (cause) {
            if (configWriteStarted) {
              throw cause;
            }
            console.error(
              `Failed to clear UI session bindings before switching ${instanceName} to ${targetEngine}:`,
              cause instanceof Error ? cause.message : cause,
            );
            return error(409, "could not switch engine because session bindings could not be reset");
          }
        } else {
          await persistConfig();
        }
      } catch (cause) {
        if (cause instanceof UiConfigValidationError) return error(400, cause.message);
        throw cause;
      }
      const config = await loadInstanceConfig(stateDir);
      // Disk-only: the change applies to the instance on its next restart.
      return ok({ instance: instanceName, config: publicConfig(config), appliesOn: "next-restart" });
    }
    return error(405, "method not allowed");
  }

  return error(404, "not found");
}

function summaryToJson(summary: CctbInstanceSummary): Record<string, unknown> {
  return {
    name: summary.name,
    engine: summary.engine,
    model: summary.model ?? null,
    effort: summary.effort ?? null,
    locale: summary.locale,
    running: summary.running,
    pid: summary.pid ?? null,
    hasLarkEnv: summary.hasLarkEnv,
  };
}
