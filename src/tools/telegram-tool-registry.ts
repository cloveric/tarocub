import { executeCronAddTool } from "./cron-add-tool.js";
import {
  executeCronListTool,
  executeCronRemoveTool,
  executeCronRunTool,
  executeCronToggleTool,
} from "./cron-management-tools.js";
import {
  executeSendBatchTool,
  executeSendFileTool,
  executeSendImageTool,
} from "./send-file-tool.js";
import type {
  ExecuteTelegramToolInput,
  TelegramToolDefinition,
  TelegramToolInputSchema,
  TelegramToolResult,
} from "./telegram-tool-types.js";

function renderUnknownTool(name: string, locale: ExecuteTelegramToolInput["context"]["locale"]): TelegramToolResult {
  const detail = `unknown tool ${name}`;
  return {
    ok: false,
    status: "rejected",
    message: locale === "zh"
      ? `✗ 工具调用失败：${detail}`
      : `✗ Tool failed: ${detail}`,
    error: detail,
  };
}

function parseSchemaPayload(payload: unknown): unknown {
  return typeof payload === "string" ? JSON.parse(payload) : payload;
}

function numericConstraint(definition: Record<string, unknown>, key: string): number | undefined {
  const value = definition[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validateStringSchema(key: string, value: string, definition: Record<string, unknown>): string | null {
  const minLength = numericConstraint(definition, "minLength");
  if (minLength !== undefined && value.length < minLength) {
    return `${key} must be at least ${minLength} character(s)`;
  }
  const maxLength = numericConstraint(definition, "maxLength");
  if (maxLength !== undefined && value.length > maxLength) {
    return `${key} must be at most ${maxLength} character(s)`;
  }
  if (typeof definition.pattern === "string") {
    let re: RegExp;
    try {
      re = new RegExp(definition.pattern);
    } catch {
      return `${key} has an invalid schema pattern`;
    }
    if (!re.test(value)) {
      return `${key} must match pattern ${definition.pattern}`;
    }
  }
  if (definition.format === "date-time" && !Number.isFinite(new Date(value).getTime())) {
    return `${key} must be a valid date-time`;
  }
  return null;
}

function validateToolPayload(schema: TelegramToolInputSchema | undefined, payload: unknown): { ok: true; payload: unknown } | { ok: false; error: string } {
  if (!schema) {
    return { ok: true, payload };
  }
  let parsed: unknown;
  try {
    parsed = parseSchemaPayload(payload);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "payload must be a JSON object" };
  }
  const body = parsed as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (body[key] === undefined || body[key] === null || body[key] === "") {
      return { ok: false, error: `missing required field: ${key}` };
    }
  }
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set(Object.keys(schema.properties));
    const extra = Object.keys(body).find((key) => !allowed.has(key));
    if (extra) {
      return { ok: false, error: `unknown field: ${extra}` };
    }
  }
  for (const [key, definition] of Object.entries(schema.properties ?? {})) {
    const value = body[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (definition.type === "string" && typeof value !== "string") {
      return { ok: false, error: `${key} must be a string` };
    }
    if (definition.type === "string" && typeof value === "string") {
      const error = validateStringSchema(key, value, definition);
      if (error) {
        return { ok: false, error };
      }
    }
    if (definition.type === "array") {
      if (!Array.isArray(value)) {
        return { ok: false, error: `${key} must be an array` };
      }
      const itemDefinition = definition.items as Record<string, unknown> | undefined;
      if (itemDefinition?.type === "string" && value.some((item) => typeof item !== "string")) {
        return { ok: false, error: `${key} items must be strings` };
      }
      if (itemDefinition?.type === "string") {
        for (const [index, item] of value.entries()) {
          if (typeof item !== "string") {
            return { ok: false, error: `${key} items must be strings` };
          }
          const error = validateStringSchema(`${key}[${index}]`, item, itemDefinition);
          if (error) {
            return { ok: false, error };
          }
        }
      }
    }
    if (definition.type === "number" && typeof value !== "number") {
      return { ok: false, error: `${key} must be a number` };
    }
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    const matches = schema.oneOf.filter((entry) => {
      const required = Array.isArray(entry.required) ? entry.required : [];
      return required.every((key) => typeof key === "string" && body[key] !== undefined && body[key] !== null && body[key] !== "");
    }).length;
    if (matches !== 1) {
      return { ok: false, error: "payload must match exactly one schema branch" };
    }
  }
  return { ok: true, payload: parsed };
}

function renderInvalidPayload(name: string, detail: string, locale: ExecuteTelegramToolInput["context"]["locale"]): TelegramToolResult {
  const error = `invalid payload for ${name}: ${detail}`;
  return {
    ok: false,
    status: "rejected",
    message: locale === "zh" ? `✗ 工具参数无效：${error}` : `✗ Invalid tool payload: ${error}`,
    error,
  };
}

export class TelegramToolRegistry {
  private readonly tools = new Map<string, TelegramToolDefinition>();

  register(definition: TelegramToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, definition);
  }

  list(): TelegramToolDefinition[] {
    return Array.from(this.tools.values());
  }

  get(name: string): TelegramToolDefinition | undefined {
    return this.tools.get(name);
  }

  async execute(input: ExecuteTelegramToolInput): Promise<TelegramToolResult> {
    const tool = this.tools.get(input.name);
    if (!tool) {
      return renderUnknownTool(input.name, input.context.locale);
    }
    const validation = validateToolPayload(tool.inputSchema, input.payload);
    if (!validation.ok) {
      return renderInvalidPayload(input.name, validation.error, input.context.locale);
    }
    return tool.execute(validation.payload, input.context);
  }
}

export function createDefaultTelegramToolRegistry(): TelegramToolRegistry {
  const registry = new TelegramToolRegistry();
  registry.register({
    name: "send.file",
    description: "Delivers one readable absolute file path to the current Telegram chat.",
    examples: [
      { path: "/absolute/path" },
    ],
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        message: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: executeSendFileTool,
  });
  registry.register({
    name: "send.image",
    description: "Delivers one readable absolute image path to the current Telegram chat as a photo when possible.",
    examples: [
      { path: "/absolute/image.png" },
    ],
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        message: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: executeSendImageTool,
  });
  registry.register({
    name: "send.batch",
    description: "Delivers a message plus multiple readable absolute image/file paths to the current Telegram chat.",
    examples: [
      { message: "Done", images: ["/absolute/image.png"], files: ["/absolute/report.pdf"] },
    ],
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        images: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    execute: executeSendBatchTool,
  });
  registry.register({
    name: "cron.add",
    description: "Creates a Telegram-delivered reminder or recurring task.",
    examples: [
      { in: "10m", prompt: "check email" },
      { at: "2026-05-01T09:00:00Z", prompt: "Monday standup" },
      { cron: "0 9 * * 1", prompt: "weekly summary" },
    ],
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
        in: { type: "string", pattern: "^\\d{1,6}(s|m|h|d)$" },
        at: { type: "string", format: "date-time" },
        cron: { type: "string", maxLength: 120 },
        timezone: { type: "string", description: "Optional IANA timezone, for example Asia/Shanghai. Defaults to the bot instance timezone." },
        description: { type: "string", maxLength: 200 },
        maxFailures: { type: "number" },
        chatId: { type: "number", description: "Deprecated compatibility field; ignored in favor of the current Telegram chat context." },
        userId: { type: "number", description: "Deprecated compatibility field; ignored in favor of the current Telegram user context." },
        chatType: { type: "string", description: "Deprecated compatibility field; ignored in favor of the current Telegram chat context." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    execute: executeCronAddTool,
  });
  registry.register({
    name: "cron.list",
    description: "Lists Telegram scheduled tasks for the current chat.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: executeCronListTool,
  });
  registry.register({
    name: "cron.remove",
    description: "Removes a Telegram scheduled task in the current chat.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", pattern: "^[a-f0-9]{8}$" } },
      required: ["id"],
      additionalProperties: false,
    },
    execute: executeCronRemoveTool,
  });
  registry.register({
    name: "cron.toggle",
    description: "Enables or disables a Telegram scheduled task in the current chat.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", pattern: "^[a-f0-9]{8}$" } },
      required: ["id"],
      additionalProperties: false,
    },
    execute: executeCronToggleTool,
  });
  registry.register({
    name: "cron.run",
    description: "Triggers a Telegram scheduled task in the current chat immediately.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", pattern: "^[a-f0-9]{8}$" } },
      required: ["id"],
      additionalProperties: false,
    },
    execute: executeCronRunTool,
  });
  return registry;
}

export const defaultTelegramToolRegistry = createDefaultTelegramToolRegistry();
