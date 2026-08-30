import { Client, Domain } from "@larksuiteoapi/node-sdk";

export const LARK_SLASH_COMMAND_SCOPES = [
  "application:app_slash_command:read",
  "application:app_slash_command:write",
] as const;

export interface LarkSlashCommandDefinition {
  command: string;
  description: {
    defaultValue: string;
    i18n: Record<string, string>;
  };
}

function defineCommand(command: string, en: string, zh: string): LarkSlashCommandDefinition {
  return {
    command,
    description: {
      defaultValue: en,
      i18n: { en_us: en, zh_cn: zh },
    },
  };
}

/** Canonical command panel. Aliases stay out so the native picker remains useful. */
export const TAROCUB_LARK_SLASH_COMMANDS: readonly LarkSlashCommandDefinition[] = [
  defineCommand("help", "Show TaroCub help and command groups", "查看 TaroCub 帮助与命令分类"),
  defineCommand("status", "Show engine, session, and runtime status", "查看引擎、会话与运行状态"),
  defineCommand("usage", "Show token usage and cost for this bot", "查看当前 Bot 的用量与成本"),
  defineCommand("btw", "Ask a side question without changing the session", "旁问一个不影响当前会话的问题"),
  defineCommand("ask", "Delegate a prompt to another configured bot", "把任务委托给另一个已配置 Bot"),
  defineCommand("engine", "Inspect or switch the agent engine", "查看或切换 Agent 引擎"),
  defineCommand("model", "Inspect or change the current model", "查看或切换当前模型"),
  defineCommand("effort", "Inspect or change reasoning effort", "查看或调整推理强度"),
  defineCommand("fast", "Inspect or toggle Codex Fast Mode", "查看或切换 Codex 快速模式"),
  defineCommand("yolo", "Inspect or change tool approval mode", "查看或调整工具审批模式"),
  defineCommand("config", "Open the interactive settings panel", "打开交互式设置面板"),
  defineCommand("stream", "Inspect or toggle typewriter streaming", "查看或切换打字机流式输出"),
  defineCommand("timeout", "Inspect or change runtime safeguards", "查看或调整任务超时保护"),
  defineCommand("steer", "Inspect or change the mid-turn steering window", "查看或调整任务中途引导窗口"),
  defineCommand("account", "Show the bound Feishu or Lark app", "查看当前绑定的飞书或 Lark 应用"),
  defineCommand("goal", "Set, inspect, or clear the conversation goal", "设置、查看或清除会话目标"),
  defineCommand("resume", "Find or bind an existing native agent session", "查找或绑定已有原生 Agent 会话"),
  defineCommand("detach", "Detach the current native agent session", "解绑当前原生 Agent 会话"),
  defineCommand("reset", "Reset the current chat session binding", "重置当前聊天的会话绑定"),
  defineCommand("stop", "Stop the current running task", "停止当前正在运行的任务"),
  defineCommand("q", "Force a message into the task queue", "强制把消息作为新任务排队"),
  defineCommand("bg", "Inspect or stop engine background processes", "查看或停止引擎后台进程"),
  defineCommand("continue", "Continue the latest waiting archive analysis", "继续最近一个等待中的压缩包分析"),
  defineCommand("ws", "List, save, use, or remove workspaces", "列出、保存、切换或删除工作区"),
  defineCommand("context", "Show engine context usage where supported", "查看支持引擎的上下文用量"),
  defineCommand("compact", "Compact the current native agent session", "压缩当前原生 Agent 会话"),
  defineCommand("ultrareview", "Run the Claude deep-review workflow", "运行 Claude 深度审查流程"),
  defineCommand("cron", "Manage reminders and scheduled agent tasks", "管理提醒与定时 Agent 任务"),
  defineCommand("board", "Manage durable Kanban tasks", "管理持久化看板任务"),
  defineCommand("mini", "Manage lightweight peer agents in threads", "管理话题中的轻量 Peer Agent"),
  defineCommand("fan", "Run a prompt across configured peers in parallel", "让已配置 Peer 并行执行同一任务"),
  defineCommand("chain", "Run a prompt through configured peers in sequence", "让已配置 Peer 串行执行任务"),
  defineCommand("verify", "Execute locally, then ask a peer to verify", "本地执行后再交给 Peer 复核"),
  defineCommand("group", "Manage group access and mention mode", "管理群授权与 @ 提及模式"),
  defineCommand("invite", "Grant group or user access by mention", "通过 @ 提及授予群或用户访问权"),
  defineCommand("remove", "Revoke group or user access by mention", "通过 @ 提及撤销群或用户访问权"),
  defineCommand("newgroup", "Create and authorize a new project group", "创建并授权新的项目群"),
  defineCommand("newtopic", "Create and authorize a new topic group", "创建并授权新的话题群"),
  defineCommand("approve", "Approve a pending tool request", "批准待处理的工具请求"),
  defineCommand("approve-session", "Approve a request for the whole session", "为整个会话批准指定请求"),
  defineCommand("deny", "Deny a pending tool request", "拒绝待处理的工具请求"),
  defineCommand("meeting", "Join, inspect, invite to, or end a meeting", "加入、查看、邀请成员或结束会议"),
];

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
