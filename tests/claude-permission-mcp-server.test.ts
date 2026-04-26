import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { resolveClaudePermissionMcpServerInvocation } from "../src/codex/claude-permission-hook.js";

async function startJsonServer(payload: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    const body = JSON.stringify(payload);
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/approval`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

describe("Claude permission MCP server", () => {
  it("denies malformed approval bridge responses", async () => {
    const bridge = await startJsonServer({ behavior: "maybe" });
    const invocation = resolveClaudePermissionMcpServerInvocation();
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CCTB_CLAUDE_APPROVAL_URL: bridge.url,
      },
    });

    try {
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        let buffer = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          buffer += chunk;
          const line = buffer.split(/\r?\n/).find((value) => value.trim());
          if (line) {
            try {
              resolve(JSON.parse(line) as Record<string, unknown>);
            } catch (error) {
              reject(error);
            }
          }
        });
        child.once("error", reject);
      });

      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "approve",
          arguments: {
            tool_name: "Bash",
            input: { command: "npm test" },
          },
        },
      }) + "\n");

      await expect(response).resolves.toMatchObject({
        result: {
          content: [
            {
              type: "text",
              text: expect.stringContaining('"behavior":"deny"'),
            },
          ],
        },
      });
    } finally {
      child.kill();
      await bridge.close();
    }
  });
});
