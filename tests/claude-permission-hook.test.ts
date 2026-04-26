import { describe, expect, it, vi } from "vitest";

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
      approvalUrl: "http://127.0.0.1:1234/claude-permission/token",
    })).toEqual({
      mcpServers: {
        cctb_approval: {
          type: "stdio",
          command: "node",
          args: ["/tmp/claude-permission-mcp-server.js"],
          env: {
            CCTB_CLAUDE_APPROVAL_URL: "http://127.0.0.1:1234/claude-permission/token",
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

  it("requires the random approval URL path token", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "once" });
    const server = await startClaudePermissionHookServer(onApprovalRequest);

    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/claude-permission\/[A-Za-z0-9_-]+$/);
      const baseUrl = new URL(server.url);
      baseUrl.pathname = "/claude-permission";
      const rejected = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_name: "Write",
          input: { file_path: "/tmp/example.txt" },
        }),
      });

      expect(rejected.status).toBe(404);
      expect(onApprovalRequest).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("reuses session approvals for equivalent object inputs regardless of key order", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "session" });
    const server = await startClaudePermissionHookServer(onApprovalRequest);

    try {
      const first = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_name: "Write",
          input: { file_path: "/tmp/example.txt", content: "hello" },
        }),
      });
      const second = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_name: "Write",
          input: { content: "hello", file_path: "/tmp/example.txt" },
        }),
      });

      await expect(first.json()).resolves.toMatchObject({ behavior: "allow" });
      await expect(second.json()).resolves.toMatchObject({ behavior: "allow" });
      expect(onApprovalRequest).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("denies malformed hook request bodies before prompting Telegram", async () => {
    const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "once" });
    const server = await startClaudePermissionHookServer(onApprovalRequest);

    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not", "an", "object"]),
      });

      await expect(response.json()).resolves.toMatchObject({ behavior: "deny" });
      expect(onApprovalRequest).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
