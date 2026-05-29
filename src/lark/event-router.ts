import { readdir } from "node:fs/promises";
import path from "node:path";

import { AccessStore } from "../state/access-store.js";
import {
  resolveLarkInstanceName,
  resolveLarkRuntimeConfig,
  type LarkRuntimeConfig,
  type LarkRuntimeEnv,
} from "./config.js";
import { loadLarkRuntimeEnv } from "./env-file.js";
import type { LarkNormalizedBridgeMessage } from "./message-normalizer.js";

export interface LarkPrivateMessageOwnerRoute {
  env: LarkRuntimeEnv;
  config: LarkRuntimeConfig;
  instanceName: string;
}

export async function findPrivateLarkMessageOwnerRoute(input: {
  env: LarkRuntimeEnv;
  currentStateDir: string;
  normalized: LarkNormalizedBridgeMessage;
}): Promise<LarkPrivateMessageOwnerRoute | null> {
  if (input.normalized.bridgeChatType !== "private") {
    return null;
  }

  let currentConfig: LarkRuntimeConfig;
  try {
    currentConfig = resolveLarkRuntimeConfig(input.env);
  } catch {
    return null;
  }

  const rootDir = path.dirname(currentConfig.stateDir);
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidateStateDir = path.join(rootDir, entry.name);
    if (path.resolve(candidateStateDir) === path.resolve(input.currentStateDir)) {
      continue;
    }

    const candidateEnv = await loadCandidateLarkEnv(input.env, candidateStateDir);
    let candidateConfig: LarkRuntimeConfig;
    try {
      candidateConfig = resolveLarkRuntimeConfig(candidateEnv);
    } catch {
      continue;
    }

    if (
      candidateConfig.appId !== currentConfig.appId ||
      candidateConfig.appSecret !== currentConfig.appSecret
    ) {
      continue;
    }

    const accessState = await new AccessStore(path.join(candidateConfig.stateDir, "access.json")).load().catch(() => null);
    if (!accessState) {
      continue;
    }

    if (
      accessState.pairedUsers.some((user) =>
        user.telegramChatId === input.normalized.bridgeAccessChatId &&
        user.telegramUserId === input.normalized.bridgeUserId
      ) ||
      (accessState.policy === "allowlist" && accessState.allowlist.includes(input.normalized.bridgeAccessChatId))
    ) {
      return {
        env: candidateEnv,
        config: candidateConfig,
        instanceName: resolveLarkInstanceName(candidateEnv),
      };
    }
  }

  return null;
}

async function loadCandidateLarkEnv(baseEnv: LarkRuntimeEnv, stateDir: string): Promise<LarkRuntimeEnv> {
  return await loadLarkRuntimeEnv({
    ...baseEnv,
    CCTB_LARK_STATE_DIR: stateDir,
    CCTB_LARK_INSTANCE: undefined,
    TAROCUB_INSTANCE: undefined,
    CODEX_TELEGRAM_INSTANCE: undefined,
  });
}
