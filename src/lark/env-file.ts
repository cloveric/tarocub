import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveDefaultLarkStateDir, resolveLarkInstanceName, type LarkRuntimeEnv } from "./config.js";

export const LARK_ENV_FILE_NAME = "lark.env";

export function resolveLarkStateDir(env: Pick<LarkRuntimeEnv, "HOME" | "USERPROFILE" | "CCTB_LARK_INSTANCE" | "TAROCUB_INSTANCE" | "CCTB_LARK_STATE_DIR" | "CODEX_TELEGRAM_STATE_DIR">): string {
  if (env.CCTB_LARK_STATE_DIR) {
    return env.CCTB_LARK_STATE_DIR;
  }
  if (env.CCTB_LARK_INSTANCE || env.TAROCUB_INSTANCE) {
    return resolveDefaultLarkStateDir(env);
  }
  if (env.CODEX_TELEGRAM_STATE_DIR) {
    return env.CODEX_TELEGRAM_STATE_DIR;
  }
  return resolveDefaultLarkStateDir(env);
}

export function resolveLarkEnvFilePath(env: Pick<LarkRuntimeEnv, "HOME" | "USERPROFILE" | "CCTB_LARK_INSTANCE" | "TAROCUB_INSTANCE" | "CCTB_LARK_STATE_DIR" | "CODEX_TELEGRAM_STATE_DIR">): string {
  return path.join(resolveLarkStateDir(env), LARK_ENV_FILE_NAME);
}

/** Shared engine-credential file that sits next to the per-instance state dirs. */
export const SHARED_ENV_FILE_NAME = "shared.env";

/**
 * Path to the shared engine-credential file (e.g. `~/.cctb/shared.env`), resolved
 * from the default cctb root so it is the SAME file for every instance. Engine
 * credentials placed here (MCP API tokens such as `IFIND_TOKEN`) are inherited by
 * ALL instances — including newly-created ones — without any per-instance setup, so
 * a fresh bot is aligned by default. An instance's own lark.env value still wins, so
 * a per-instance override is always possible. Returns undefined if the root cannot
 * be resolved (e.g. no HOME), so callers can skip the shared layer gracefully.
 */
export function resolveSharedEnvFilePath(env: Pick<LarkRuntimeEnv, "HOME" | "USERPROFILE" | "CCTB_LARK_INSTANCE" | "TAROCUB_INSTANCE" | "CCTB_LARK_STATE_DIR" | "CODEX_TELEGRAM_STATE_DIR">): string | undefined {
  try {
    return path.join(path.dirname(resolveDefaultLarkStateDir(env)), SHARED_ENV_FILE_NAME);
  } catch {
    return undefined;
  }
}

export async function loadLarkRuntimeEnv(env: LarkRuntimeEnv): Promise<LarkRuntimeEnv> {
  let envPath: string;
  try {
    envPath = resolveLarkEnvFilePath(env);
  } catch {
    return env;
  }

  let parsed: Partial<LarkRuntimeEnv>;
  try {
    parsed = parseLarkEnvFile(await readFile(envPath, "utf8"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return env;
    }
    throw error;
  }

  const larkInstance = env.CCTB_LARK_INSTANCE
    ?? env.TAROCUB_INSTANCE
    ?? parsed.CCTB_LARK_INSTANCE
    ?? parsed.TAROCUB_INSTANCE
    ?? parsed.CODEX_TELEGRAM_INSTANCE;

  return {
    ...env,
    LARK_APP_ID: env.LARK_APP_ID ?? parsed.LARK_APP_ID,
    LARK_APP_SECRET: env.LARK_APP_SECRET ?? parsed.LARK_APP_SECRET,
    LARK_DOMAIN: env.LARK_DOMAIN ?? parsed.LARK_DOMAIN,
    CCTB_LARK_STATE_DIR: env.CCTB_LARK_STATE_DIR ?? parsed.CCTB_LARK_STATE_DIR,
    CCTB_LARK_INSTANCE: larkInstance,
    LARK_REQUIRE_MENTION_IN_GROUP: env.LARK_REQUIRE_MENTION_IN_GROUP ?? parsed.LARK_REQUIRE_MENTION_IN_GROUP,
    CCTB_LARK_DEBUG: env.CCTB_LARK_DEBUG ?? parsed.CCTB_LARK_DEBUG,
    TAROCUB_INSTANCE: env.TAROCUB_INSTANCE ?? larkInstance,
    CODEX_TELEGRAM_INSTANCE: env.CODEX_TELEGRAM_INSTANCE ?? parsed.CODEX_TELEGRAM_INSTANCE,
  };
}

/**
 * Pass non-whitelisted keys (engine credentials such as MCP API tokens like
 * `IFIND_TOKEN`) through into the process environment so the spawned engine
 * (claude/codex) — which inherits `{ ...process.env }` — can see them. Two layers are
 * read, in precedence order: an existing value in `target` (process.env) always wins,
 * then the instance's own lark.env, then the shared `~/.cctb/shared.env` fills any gaps
 * — so a freshly-created instance inherits shared tokens by default, while still being
 * able to override them per-instance. Whitelisted Lark keys and reserved bridge
 * namespaces are filtered out by parseLarkEnvExtras in BOTH files, so the shared layer
 * is no weaker than the per-instance one. Returns the names of the keys applied — names
 * only, since the values are secrets and must never be logged.
 */
export async function applyLarkEnvPassthrough(
  env: Pick<LarkRuntimeEnv, "HOME" | "USERPROFILE" | "CCTB_LARK_INSTANCE" | "TAROCUB_INSTANCE" | "CCTB_LARK_STATE_DIR" | "CODEX_TELEGRAM_STATE_DIR">,
  target: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const applied: string[] = [];
  const applyFrom = (content: string): void => {
    for (const [key, value] of Object.entries(parseLarkEnvExtras(content))) {
      // Never clobber a value already present (process.env wins; instance wins over shared).
      if (target[key] !== undefined) {
        continue;
      }
      target[key] = value;
      applied.push(key);
    }
  };

  // Instance lark.env first, so an instance's own token overrides the shared default.
  let instancePath: string | undefined;
  try {
    instancePath = resolveLarkEnvFilePath(env);
  } catch {
    instancePath = undefined;
  }
  if (instancePath) {
    const content = await readEnvFileOrUndefined(instancePath);
    if (content !== undefined) {
      applyFrom(content);
    }
  }

  // Then the shared engine-cred file fills any gaps a new/basic instance left open,
  // so a fresh bot inherits shared MCP tokens (IFIND_TOKEN, …) with no per-instance setup.
  const sharedPath = resolveSharedEnvFilePath(env);
  if (sharedPath && sharedPath !== instancePath) {
    const content = await readEnvFileOrUndefined(sharedPath);
    if (content !== undefined) {
      applyFrom(content);
    }
  }

  return applied;
}

async function readEnvFileOrUndefined(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeLarkEnvFile(
  env: Pick<LarkRuntimeEnv, "HOME" | "USERPROFILE" | "CCTB_LARK_INSTANCE" | "CCTB_LARK_STATE_DIR" | "CODEX_TELEGRAM_STATE_DIR" | "TAROCUB_INSTANCE" | "CODEX_TELEGRAM_INSTANCE">,
  values: {
    appId: string;
    appSecret: string;
    domain?: string;
    requireMentionInGroup?: boolean;
  },
): Promise<string> {
  const stateDir = resolveLarkStateDir(env);
  const instanceName = resolveLarkInstanceName(env);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const envPath = path.join(stateDir, LARK_ENV_FILE_NAME);
  // Preserve any extra (non-whitelisted) keys already in the file — e.g. MCP API
  // tokens like IFIND_TOKEN the operator added for the engine. Regenerating lark.env
  // on every service start must not silently drop them.
  let preservedExtras: Record<string, string> = {};
  try {
    preservedExtras = parseLarkEnvExtras(await readFile(envPath, "utf8"));
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }
  const lines = [
    "# Generated by TaroCub lark wizard. Do not commit this file.",
    `LARK_APP_ID=${quoteEnvValue(values.appId)}`,
    `LARK_APP_SECRET=${quoteEnvValue(values.appSecret)}`,
    ...(values.domain ? [`LARK_DOMAIN=${quoteEnvValue(values.domain)}`] : []),
    `CCTB_LARK_STATE_DIR=${quoteEnvValue(stateDir)}`,
    `CCTB_LARK_INSTANCE=${quoteEnvValue(instanceName)}`,
    `TAROCUB_INSTANCE=${quoteEnvValue(instanceName)}`,
    `LARK_REQUIRE_MENTION_IN_GROUP=${quoteEnvValue(values.requireMentionInGroup === false ? "false" : "true")}`,
    ...Object.entries(preservedExtras).map(([key, value]) => `${key}=${quoteEnvValue(value)}`),
    "",
  ];
  // lark.env is regenerated on EVERY service start and carries LARK_APP_SECRET plus
  // operator MCP tokens; a crash mid-write would truncate it and the extras-preserving
  // re-read above would then permanently lose those tokens. Write atomically.
  await writeFileAtomic(envPath, lines.join("\n"), 0o600);
  return envPath;
}

/** tmp file + fsync + atomic rename (the JsonStore.write pattern), so a crash mid-write
 * can never leave a truncated file at the target path. */
async function writeFileAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const directoryPath = path.dirname(filePath);
  const tmpPath = path.join(directoryPath, `${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(tmpPath, content, { encoding: "utf8", mode });
  try {
    const tmpHandle = await open(tmpPath, "r");
    try {
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close();
    }
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
  try {
    const dirHandle = await open(directoryPath, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (error) {
    // Windows cannot open/fsync directories; the rename itself is already atomic.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EACCES") {
      throw error;
    }
  }
}

function parseLarkEnvFile(content: string): Partial<LarkRuntimeEnv> {
  const result: Partial<LarkRuntimeEnv> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = parseEnvValue(line.slice(equalsIndex + 1).trim());
    if (isSupportedLarkEnvKey(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Parse the non-whitelisted (extra) keys from a lark.env file — e.g. MCP API tokens
 * like IFIND_TOKEN that the operator added for the engine. Whitelisted Lark keys are
 * excluded (those are owned by loadLarkRuntimeEnv / written by writeLarkEnvFile).
 * Used both to pass extras through to the engine env and to preserve them across the
 * lark.env regeneration that happens on every service start.
 */
function parseLarkEnvExtras(content: string): Record<string, string> {
  const extras: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    // Drop whitelisted Lark keys, invalid env-var names, and anything in a reserved
    // bridge namespace. lark.env extras may ONLY carry engine credentials (MCP API
    // tokens like IFIND_TOKEN) — they must never be able to set a variable the bridge
    // itself reads to control its own behaviour (send URL, active-turn state, doc/chat
    // identity, executables, thread ids, telemetry, …).
    if (isSupportedLarkEnvKey(key) || isReservedBridgeEnvKey(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    extras[key] = parseEnvValue(line.slice(equalsIndex + 1).trim());
  }
  return extras;
}

function isSupportedLarkEnvKey(key: string): key is keyof Pick<
  LarkRuntimeEnv,
  "LARK_APP_ID" | "LARK_APP_SECRET" | "LARK_DOMAIN" | "CCTB_LARK_STATE_DIR" | "CCTB_LARK_INSTANCE" | "LARK_REQUIRE_MENTION_IN_GROUP" | "CCTB_LARK_DEBUG" | "TAROCUB_INSTANCE" | "CODEX_TELEGRAM_INSTANCE"
> {
  return key === "LARK_APP_ID" ||
    key === "LARK_APP_SECRET" ||
    key === "LARK_DOMAIN" ||
    key === "CCTB_LARK_STATE_DIR" ||
    key === "CCTB_LARK_INSTANCE" ||
    key === "LARK_REQUIRE_MENTION_IN_GROUP" ||
    key === "CCTB_LARK_DEBUG" ||
    key === "TAROCUB_INSTANCE" ||
    key === "CODEX_TELEGRAM_INSTANCE";
}

// Namespaces the bridge process reads to control its OWN behaviour (transport, active-turn
// state, doc/chat identity, engine executables/home, thread ids, telemetry, queue tuning).
// lark.env passthrough must refuse these so an operator can't accidentally repoint or
// hijack the bridge by dropping a control var in lark.env — extras are engine creds only.
const RESERVED_BRIDGE_ENV_PREFIXES = [
  "CCTB_",
  "TAROCUB_",
  "LARK_",
  "CODEX_",
  "CLAUDE_",
  "ANTIGRAVITY_",
  "ASR_",
  "TELEGRAM_",
] as const;

function isReservedBridgeEnvKey(key: string): boolean {
  return RESERVED_BRIDGE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function parseEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\(["\\$`])/g, "$1").replace(/\\n/g, "\n");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  return value;
}

function quoteEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\$/g, "\\$").replace(/`/g, "\\`").replace(/\n/g, "\\n")}"`;
}
