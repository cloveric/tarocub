import { Client, Domain } from "@larksuiteoapi/node-sdk";

import {
  TAROCUB_LARK_SLASH_COMMANDS,
  type LarkSlashCommandDefinition,
} from "./slash-command-registry.js";

export {
  TAROCUB_LARK_SLASH_COMMANDS,
  isTaroCubLarkSlashCommand,
} from "./slash-command-registry.js";
export type { LarkSlashCommandDefinition } from "./slash-command-registry.js";

export const LARK_SLASH_COMMAND_SCOPES = [
  "application:app_slash_command:read",
  "application:app_slash_command:write",
] as const;

export interface LarkSlashCommandApiClient {
  request<T = unknown>(payload: {
    method: string;
    url: string;
    data?: Record<string, unknown>;
  }): Promise<T>;
}

interface RemoteSlashCommand {
  command_id?: string;
  command?: string;
  description?: {
    default_value?: string;
    i18n?: Record<string, string>;
  };
}

export interface LarkSlashCommandSyncResult {
  created: number;
  updated: number;
  unchanged: number;
  preserved: number;
  dryRun: boolean;
}

const SLASH_COMMAND_PATH = "/open-apis/application/v7/app_slash_commands";

interface SlashApiResponse {
  code?: number;
  msg?: string;
}

export async function syncLarkSlashCommands(input: {
  client: LarkSlashCommandApiClient;
  commands?: readonly LarkSlashCommandDefinition[];
  dryRun?: boolean;
}): Promise<LarkSlashCommandSyncResult> {
  const commands = input.commands ?? TAROCUB_LARK_SLASH_COMMANDS;
  validateDefinitions(commands);
  const response = await requestSlashApi<{
    code?: number;
    msg?: string;
    data?: { items?: RemoteSlashCommand[] };
  }>(input.client, { method: "GET", url: SLASH_COMMAND_PATH }, "list slash commands");
  const items = Array.isArray(response?.data?.items) ? response.data.items : [];
  const byName = new Map(items.flatMap((item) =>
    typeof item.command === "string" ? [[item.command, item] as const] : []));
  const wanted = new Set(commands.map((command) => command.command));
  const result: LarkSlashCommandSyncResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    preserved: items.filter((item) => typeof item.command === "string" && !wanted.has(item.command)).length,
    dryRun: input.dryRun === true,
  };

  for (const definition of commands) {
    const existing = byName.get(definition.command);
    if (!existing) {
      result.created += 1;
      if (!result.dryRun) {
        await requestSlashApi(input.client, {
          method: "POST",
          url: SLASH_COMMAND_PATH,
          data: buildCreateBody(definition),
        }, `create /${definition.command}`);
      }
      continue;
    }
    if (descriptionMatches(existing.description, definition.description)) {
      result.unchanged += 1;
      continue;
    }
    if (!existing.command_id) {
      throw new Error(`Lark slash command /${definition.command} has no command_id; refusing an unsafe update.`);
    }
    result.updated += 1;
    if (!result.dryRun) {
      await requestSlashApi(input.client, {
        method: "PATCH",
        url: `${SLASH_COMMAND_PATH}/${encodeURIComponent(existing.command_id)}`,
        data: { description: buildDescription(definition) },
      }, `update /${definition.command}`);
    }
  }
  return result;
}

export async function syncLarkSlashCommandsForApp(input: {
  appId: string;
  appSecret: string;
  domain?: string;
  dryRun?: boolean;
}): Promise<LarkSlashCommandSyncResult> {
  const client = new Client({
    appId: input.appId,
    appSecret: input.appSecret,
    ...(input.domain ? { domain: resolveDomain(input.domain) } : {}),
    logger: silentLogger,
  }) as unknown as LarkSlashCommandApiClient;
  return syncLarkSlashCommands({ client, ...(input.dryRun ? { dryRun: true } : {}) });
}

function buildCreateBody(definition: LarkSlashCommandDefinition): Record<string, unknown> {
  return {
    command: definition.command,
    description: buildDescription(definition),
  };
}

function buildDescription(definition: LarkSlashCommandDefinition): Record<string, unknown> {
  return {
    default_value: definition.description.defaultValue,
    i18n: { ...definition.description.i18n },
  };
}

function descriptionMatches(
  actual: RemoteSlashCommand["description"],
  expected: LarkSlashCommandDefinition["description"],
): boolean {
  if (actual?.default_value !== expected.defaultValue) return false;
  const actualI18n = actual.i18n ?? {};
  const expectedEntries = Object.entries(expected.i18n);
  return Object.keys(actualI18n).length === expectedEntries.length &&
    expectedEntries.every(([lang, value]) => actualI18n[lang] === value);
}

function validateDefinitions(commands: readonly LarkSlashCommandDefinition[]): void {
  if (commands.length > 100) throw new Error("Lark supports at most 100 slash commands per app.");
  const seen = new Set<string>();
  for (const item of commands) {
    if (!item.command || item.command.startsWith("/") || /\s/.test(item.command)) {
      throw new Error(`Invalid Lark slash command name: ${JSON.stringify(item.command)}`);
    }
    if (seen.has(item.command)) throw new Error(`Duplicate Lark slash command: /${item.command}`);
    if (!item.description.defaultValue.trim()) throw new Error(`Missing description for /${item.command}`);
    seen.add(item.command);
  }
}

function assertApiSuccess(response: { code?: number; msg?: string } | undefined, action: string): void {
  if (typeof response?.code === "number" && response.code !== 0) {
    throw new Error(`Lark ${action} failed: ${response.code} ${response.msg ?? ""}`.trim());
  }
}

async function requestSlashApi<T extends SlashApiResponse = SlashApiResponse>(
  client: LarkSlashCommandApiClient,
  payload: { method: string; url: string; data?: Record<string, unknown> },
  action: string,
): Promise<T> {
  let response: T;
  try {
    response = await client.request<T>(payload);
  } catch (error) {
    throw normalizeRejectedSlashApiError(error, action);
  }
  assertApiSuccess(response, action);
  return response;
}

function normalizeRejectedSlashApiError(error: unknown, action: string): Error {
  const body = (error as { response?: { data?: unknown } } | undefined)?.response?.data;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as { code?: unknown; msg?: unknown; data?: unknown };
    const detail = record.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? record.data as { missing_scopes?: unknown }
      : {};
    const knownScopes = new Set<string>(LARK_SLASH_COMMAND_SCOPES);
    const nestedMissingScopes = Array.isArray(detail.missing_scopes)
      ? detail.missing_scopes.filter(
          (scope): scope is string => typeof scope === "string" && knownScopes.has(scope),
        )
      : [];
    const rawMessage = typeof record.msg === "string" ? record.msg.trim() : "";
    const messageScopes = (rawMessage.match(/[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.:-]*/gi) ?? [])
      .filter((scope) => knownScopes.has(scope));
    const missingScopes = [...new Set([...nestedMissingScopes, ...messageScopes])];
    const code = typeof record.code === "number" ? String(record.code) : "unknown";
    const message = missingScopes.length === 0 && rawMessage ? ` ${rawMessage}` : "";
    const missing = missingScopes.length > 0 ? `; missing scopes: ${missingScopes.join(", ")}` : "";
    const repair = missingScopes.length > 0
      ? `; run: node dist/src/index.js lark scopes add ${LARK_SLASH_COMMAND_SCOPES.join(" ")}`
      : "";
    return new Error(`Lark ${action} failed: ${code}${message}${missing}${repair}`);
  }
  return error instanceof Error ? error : new Error(`Lark ${action} failed: ${String(error)}`);
}

function resolveDomain(domain: string): Domain | string {
  const normalized = domain.trim().toLowerCase();
  if (normalized === "feishu") return Domain.Feishu;
  if (normalized === "lark") return Domain.Lark;
  return domain;
}

const silentLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};
