import { describe, expect, it } from "vitest";

import {
  createClaudePermissionMcpConfig,
  renderClaudePermissionPromptToolResponse,
  startClaudePermissionHookServer,
} from "../src/codex/claude-permission-hook.js";

describe("Claude permission prompt MCP tool", () => {
  it("builds MCP config for the permission prompt tool", () => {
    expect(createClaudePermissionMcpConfig({
      command: "node",
      args: ["/tmp/claude-permission-mcp-server.js"],
      approvalUrl: "http://127.0.0.1:1234/claude-permission",
    })).toEqual({
      mcpServers: {
        cctb_approval: {
          type: "stdio",
          command: "node",
          args: ["/tmp/claude-permission-mcp-server.js"],
          env: {
            CCTB_CLAUDE_APPROVAL_URL: "http://127.0.0.1:1234/claude-permission",
          },
        },
      },
    });
  });

  it("allows with the original tool input", () => {
    expect(renderClaudePermissionPromptToolResponse(
      { behavior: "allow", scope: "once" },
      {
        tool_input: {
          command: "npm test",
        },
      },
    )).toEqual({
      behavior: "allow",
      updatedInput: {
        command: "npm test",
      },
    });
  });

  it("renders a denial decision", () => {
    expect(renderClaudePermissionPromptToolResponse({ behavior: "deny" }, {})).toEqual({
      behavior: "deny",
      message: "Denied from Telegram.",
    });
  });

  it("aborts a pending approval request when the hook server closes", async () => {
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const server = await startClaudePermissionHookServer((request) => (
      new Promise((resolve) => {
        markEntered?.();
        request.abortSignal?.addEventListener("abort", () => {
          resolve({ behavior: "deny" });
        }, { once: true });
      })
    ));

    const responsePromise = fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_name: "Write",
        input: { file_path: "/tmp/example.txt" },
      }),
    });

    await entered;
    await server.close();

    await expect(responsePromise).resolves.toMatchObject({ ok: true });
  });
});
