import path from "node:path";

import { Domain, type LarkChannelOptions } from "@larksuiteoapi/node-sdk";
import { normalizeInstanceName } from "../instance.js";

export interface LarkRuntimeEnv {
  HOME?: string;
  APPDATA?: string;
  USERPROFILE?: string;
  CODEX_HOME?: string;
  CLAUDE_CONFIG_DIR?: string;
  CCTB_LARK_INSTANCE?: string;
  TAROCUB_INSTANCE?: string;
  CODEX_TELEGRAM_INSTANCE?: string;
  CODEX_TELEGRAM_STATE_DIR?: string;
  CODEX_EXECUTABLE?: string;
  CLAUDE_EXECUTABLE?: string;
  DSH_EXECUTABLE?: string;
  DSH_HOME?: string;
  KIMI_EXECUTABLE?: string;
  KIMI_CODE_HOME?: string;
  ANTIGRAVITY_EXECUTABLE?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  LARK_DOMAIN?: string;
  CCTB_LARK_STATE_DIR?: string;
  LARK_REQUIRE_MENTION_IN_GROUP?: string;
  // Long-audio cloud ASR (Aliyun Tingwu). Whitelisted bridge config — these are
  // read from lark.env through loadLarkRuntimeEnv, NOT through the extras
  // passthrough (extras must never set a variable the bridge itself acts on;
  // TINGWU_/ASR_ are reserved prefixes there).
  TINGWU_ASR_DIR?: string;
  ASR_CLOUD_THRESHOLD_SECONDS?: string;
  ASR_CLOUD_TASK_TIMEOUT_SECONDS?: string;
  ASR_CLOUD_JOB_RETENTION_DAYS?: string;
  /**
   * Longest single request the local ASR accepts, in seconds. The bridge never
   * hits this (it chunks at ASR_CHUNK_SECONDS), but the injected agent
   * instruction quotes it so an engine transcribing a file ITSELF knows the
   * boundary. Keep it equal to the ASR service's own ASR_MAX_AUDIO_SECONDS:
   * a long request there wedges the shared model and blocks every instance.
   */
  ASR_MAX_AUDIO_SECONDS?: string;
  /** Days inbound attachment downloads stay on disk (default 3; 0 = delete at turn end). */
  LARK_INBOUND_FILE_RETENTION_DAYS?: string;
  CCTB_LARK_DEBUG?: string;
  CCTB_LARK_REACTION_EMOJI?: string;
  LARK_REACTION_EMOJI?: string;
  CCTB_LARK_DONE_EMOJI?: string;
  LARK_DONE_EMOJI?: string;
  CCTB_LARK_FAILURE_EMOJI?: string;
  LARK_FAILURE_EMOJI?: string;
  CCTB_LARK_RESOLVE_MENTIONS?: string;
  LARK_RESOLVE_MENTIONS?: string;
  TAROCUB_MAX_CONCURRENT_TURNS?: string;
  CODEX_TELEGRAM_MAX_CONCURRENT_TURNS?: string;
  TAROCUB_TURN_POOL_PATH?: string;
  TAROCUB_TELEMETRY_MODULE?: string;
  LARK_CHANNEL_TELEMETRY_MODULE?: string;
  CCTB_LARK_HEALTH_INTERVAL_MS?: string;
  CCTB_LARK_HEALTH_FAILURE_THRESHOLD?: string;
  CCTB_LARK_QUEUE_MODE?: string;
  TAROCUB_LARK_QUEUE_MODE?: string;
  CCTB_LARK_BATCH_WINDOW_MS?: string;
  TAROCUB_LARK_BATCH_WINDOW_MS?: string;
  CCTB_LARK_ACTIVE_TURN?: string;
  CCTB_LARK_ACTIVE_INSTANCE?: string;
  CCTB_LARK_ACTIVE_STATE_DIR?: string;
}

export interface LarkRuntimeConfig {
  appId: string;
  appSecret: string;
  domain?: LarkChannelOptions["domain"];
  stateDir: string;
  requireMentionInGroup: boolean;
}

export function resolveLarkInstanceName(env: Pick<LarkRuntimeEnv, "CCTB_LARK_INSTANCE" | "TAROCUB_INSTANCE">, fallback = "lark"): string {
  return normalizeInstanceName(env.CCTB_LARK_INSTANCE ?? env.TAROCUB_INSTANCE ?? fallback);
}

export function resolveDefaultLarkStateDir(env: Pick<LarkRuntimeEnv, "HOME" | "USERPROFILE" | "CCTB_LARK_INSTANCE" | "TAROCUB_INSTANCE">): string {
  const homeDir = env.HOME ?? env.USERPROFILE;
  if (!homeDir) {
    throw new Error(process.platform === "win32" ? "USERPROFILE or HOME is required" : "HOME or USERPROFILE is required");
  }
  const instanceName = resolveLarkInstanceName(env);
  return path.join(homeDir, ".cctb", instanceName);
}

export function resolveLarkRuntimeConfig(env: LarkRuntimeEnv): LarkRuntimeConfig {
  if (!env.LARK_APP_ID) {
    throw new Error("LARK_APP_ID is required");
  }
  if (!env.LARK_APP_SECRET) {
    throw new Error("LARK_APP_SECRET is required");
  }
  const homeDir = env.HOME ?? env.USERPROFILE;
  if (!env.CCTB_LARK_STATE_DIR && !env.CODEX_TELEGRAM_STATE_DIR && !homeDir) {
    throw new Error(process.platform === "win32" ? "USERPROFILE or HOME is required" : "HOME or USERPROFILE is required");
  }

  return {
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    ...(env.LARK_DOMAIN ? { domain: resolveLarkClientDomain(env.LARK_DOMAIN) } : {}),
    stateDir: env.CCTB_LARK_STATE_DIR
      ?? (env.CCTB_LARK_INSTANCE || env.TAROCUB_INSTANCE ? resolveDefaultLarkStateDir(env) : env.CODEX_TELEGRAM_STATE_DIR)
      ?? resolveDefaultLarkStateDir(env),
    requireMentionInGroup: parseBooleanEnv(env.LARK_REQUIRE_MENTION_IN_GROUP, true),
  };
}

function resolveLarkClientDomain(domain: string): LarkChannelOptions["domain"] {
  const normalized = domain.trim().toLowerCase();
  if (normalized === "feishu") {
    return Domain.Feishu;
  }
  if (normalized === "lark") {
    return Domain.Lark;
  }
  return domain;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim();
  if (/^(?:1|true|yes|on)$/i.test(normalized)) return true;
  if (/^(?:0|false|no|off)$/i.test(normalized)) return false;
  return fallback;
}
