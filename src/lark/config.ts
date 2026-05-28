import path from "node:path";

import { Domain, type LarkChannelOptions } from "@larksuiteoapi/node-sdk";
import { normalizeInstanceName } from "../instance.js";

export interface LarkRuntimeEnv {
  HOME?: string;
  APPDATA?: string;
  USERPROFILE?: string;
  CODEX_HOME?: string;
  CLAUDE_CONFIG_DIR?: string;
  TAROCUB_INSTANCE?: string;
  CODEX_TELEGRAM_INSTANCE?: string;
  CODEX_TELEGRAM_STATE_DIR?: string;
  CODEX_EXECUTABLE?: string;
  CLAUDE_EXECUTABLE?: string;
  ANTIGRAVITY_EXECUTABLE?: string;
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  LARK_DOMAIN?: string;
  CCTB_LARK_STATE_DIR?: string;
  LARK_REQUIRE_MENTION_IN_GROUP?: string;
  CCTB_LARK_DEBUG?: string;
  CCTB_LARK_REACTION_EMOJI?: string;
  LARK_REACTION_EMOJI?: string;
  CCTB_LARK_DONE_EMOJI?: string;
  LARK_DONE_EMOJI?: string;
  CCTB_LARK_FAILURE_EMOJI?: string;
  LARK_FAILURE_EMOJI?: string;
  CCTB_LARK_RESOLVE_MENTIONS?: string;
  LARK_RESOLVE_MENTIONS?: string;
}

export interface LarkRuntimeConfig {
  appId: string;
  appSecret: string;
  domain?: LarkChannelOptions["domain"];
  stateDir: string;
  requireMentionInGroup: boolean;
}

export function resolveLarkInstanceName(env: Pick<LarkRuntimeEnv, "TAROCUB_INSTANCE">, fallback = "lark"): string {
  return normalizeInstanceName(env.TAROCUB_INSTANCE ?? fallback);
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
    stateDir: env.CCTB_LARK_STATE_DIR ?? env.CODEX_TELEGRAM_STATE_DIR ?? path.join(homeDir!, ".cctb", "lark"),
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
  return /^(?:1|true|yes|on)$/i.test(value.trim());
}
