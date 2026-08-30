import { describe, expect, it, vi } from "vitest";

import {
  LARK_SLASH_COMMAND_SCOPES,
  TAROCUB_LARK_SLASH_COMMANDS,
  syncLarkSlashCommands,
  type LarkSlashCommandApiClient,
  type LarkSlashCommandDefinition,
} from "../src/lark/slash-commands.js";

const TEST_COMMANDS: readonly LarkSlashCommandDefinition[] = [
  {
    command: "status",
    description: {
      defaultValue: "Show current session status",
      i18n: { en_us: "Show current session status", zh_cn: "查看当前会话状态" },
    },
  },
  {
    command: "model",
    description: {
      defaultValue: "Inspect or change the model",
      i18n: { en_us: "Inspect or change the model", zh_cn: "查看或切换模型" },
    },
  },
];

describe("TaroCub Lark slash command catalog", () => {
  it("is unique, localized, and includes the primary control surface", () => {
    const names = TAROCUB_LARK_SLASH_COMMANDS.map((item) => item.command);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining([
      "help", "status", "usage", "model", "effort", "stop", "group", "newgroup", "meeting",
    ]));
    for (const item of TAROCUB_LARK_SLASH_COMMANDS) {
      expect(item.command).not.toMatch(/^\//);
      expect(item.description.defaultValue.trim()).not.toBe("");
      expect(item.description.i18n.en_us?.trim()).not.toBe("");
      expect(item.description.i18n.zh_cn?.trim()).not.toBe("");
    }
    expect(LARK_SLASH_COMMAND_SCOPES).toEqual([
      "application:app_slash_command:read",
      "application:app_slash_command:write",
    ]);
  });
});

describe("syncLarkSlashCommands", () => {
  it("creates missing commands, updates drifted commands, and preserves unrelated commands", async () => {
    const request = vi.fn(async (payload: { method: string; url: string }) => {
      if (payload.method === "GET") {
        return {
          data: {
            items: [
              {
                command_id: "cmd-status",
                command: "status",
                description: {
                  default_value: "Show current session status",
                  i18n: { en_us: "Show current session status", zh_cn: "查看当前会话状态" },
                },
              },
              {
                command_id: "cmd-model",
                command: "model",
                description: {
                  default_value: "old description",
                  i18n: { en_us: "old description", zh_cn: "旧说明" },
                },
              },
              { command_id: "cmd-custom", command: "custom", description: { default_value: "keep me" } },
            ],
          },
        };
      }
      return { data: {} };
    });
    const client = { request } as unknown as LarkSlashCommandApiClient;

    const result = await syncLarkSlashCommands({ client, commands: TEST_COMMANDS });

    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 1, preserved: 1, dryRun: false });
    expect(request).toHaveBeenCalledWith({
      method: "PATCH",
      url: "/open-apis/application/v7/app_slash_commands/cmd-model",
      data: {
        description: {
          default_value: "Inspect or change the model",
          i18n: { en_us: "Inspect or change the model", zh_cn: "查看或切换模型" },
        },
      },
    });
    expect(request.mock.calls.some(([payload]) => payload.method === "DELETE")).toBe(false);
  });

  it("plans changes without writing in dry-run mode", async () => {
    const request = vi.fn(async () => ({ data: { items: [] } }));
    const result = await syncLarkSlashCommands({
      client: { request } as unknown as LarkSlashCommandApiClient,
      commands: TEST_COMMANDS,
      dryRun: true,
    });

    expect(result).toMatchObject({ created: 2, updated: 0, unchanged: 0, dryRun: true });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      url: "/open-apis/application/v7/app_slash_commands",
    });
  });

  it("creates a missing command with the official v7 request shape", async () => {
    const request = vi.fn(async (payload: { method: string }) =>
      payload.method === "GET" ? { data: { items: [] } } : { data: {} });

    await syncLarkSlashCommands({
      client: { request } as unknown as LarkSlashCommandApiClient,
      commands: TEST_COMMANDS.slice(0, 1),
    });

    expect(request).toHaveBeenLastCalledWith({
      method: "POST",
      url: "/open-apis/application/v7/app_slash_commands",
      data: {
        command: "status",
        description: {
          default_value: "Show current session status",
          i18n: { en_us: "Show current session status", zh_cn: "查看当前会话状态" },
        },
      },
    });
  });

  it("surfaces Feishu error codes and missing scopes from rejected SDK requests", async () => {
    const request = vi.fn(async () => {
      const error = new Error("Request failed with status code 400") as Error & {
        response?: { data?: unknown };
      };
      error.response = {
        data: {
          code: 99991672,
          msg: "Access denied",
          data: { missing_scopes: ["application:app_slash_command:read"] },
        },
      };
      throw error;
    });

    await expect(syncLarkSlashCommands({
      client: { request } as unknown as LarkSlashCommandApiClient,
      commands: TEST_COMMANDS,
    })).rejects.toThrow(
      "99991672; missing scopes: application:app_slash_command:read",
    );
  });

  it("normalizes Feishu's message-only missing-scope response without echoing its auth URL", async () => {
    const request = vi.fn(async () => {
      const error = new Error("Request failed with status code 400") as Error & {
        response?: { data?: unknown };
      };
      error.response = {
        data: {
          code: 99991672,
          msg: "Access denied: [application:app_slash_command:read]. Apply at https://open.feishu.cn/app/cli_private/auth",
        },
      };
      throw error;
    });

    const rejection = syncLarkSlashCommands({
      client: { request } as unknown as LarkSlashCommandApiClient,
      commands: TEST_COMMANDS,
    });
    await expect(rejection).rejects.toThrow(
      "99991672; missing scopes: application:app_slash_command:read",
    );
    await expect(rejection).rejects.not.toThrow("open.feishu.cn");
  });

  it("filters unrelated colon fields and gives the one-command scope repair", async () => {
    const request = vi.fn(async () => {
      const error = new Error("Request failed with status code 400") as Error & {
        response?: { data?: unknown };
      };
      error.response = {
        data: {
          code: 99991672,
          msg: "Access denied app_id:cli_private tenant:t1 application:app_slash_command:read",
        },
      };
      throw error;
    });

    const rejection = syncLarkSlashCommands({
      client: { request } as unknown as LarkSlashCommandApiClient,
      commands: TEST_COMMANDS,
    });
    await expect(rejection).rejects.toThrow(
      "missing scopes: application:app_slash_command:read; run: node dist/src/index.js lark scopes add application:app_slash_command:read application:app_slash_command:write",
    );
    await expect(rejection).rejects.not.toThrow("app_id:cli_private");
    await expect(rejection).rejects.not.toThrow("tenant:t1");
  });
});
