import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  addSearchFallbackNotice,
  resolveSearchMcpServerInvocation,
  truncateExtractResult,
} from "../src/search/search-mcp-server.js";

async function readOneJsonLine(stdout: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    let buffer = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk) => {
      buffer += chunk;
      const line = buffer.split(/\r?\n/).find((value) => value.trim());
      if (!line) {
        return;
      }
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    stdout.once("error", reject);
  });
}

describe("search MCP server", () => {
  it("lists web search tools without API keys", async () => {
    const invocation = resolveSearchMcpServerInvocation();
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BRAVE_API_KEY: "",
        TAVILY_API_KEY: "",
      },
    });

    try {
      const response = readOneJsonLine(child.stdout);
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }) + "\n");

      await expect(response).resolves.toMatchObject({
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "web_search" }),
            expect.objectContaining({ name: "web_extract" }),
          ]),
        },
      });
    } finally {
      child.kill();
    }
  });

  it("returns an actionable error when no search provider is configured", async () => {
    const invocation = resolveSearchMcpServerInvocation();
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BRAVE_API_KEY: "",
        TAVILY_API_KEY: "",
      },
    });

    try {
      const response = readOneJsonLine(child.stdout);
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "web_search",
          arguments: {
            query: "telegram bot api streaming text",
            mode: "quick",
          },
        },
      }) + "\n");

      await expect(response).resolves.toMatchObject({
        result: {
          content: [
            {
              type: "text",
              text: expect.stringContaining("No Brave or Tavily API key is configured"),
            },
          ],
          isError: true,
        },
      });
      const payload = await response as {
        result?: {
          content?: Array<{ text?: string }>;
        };
      };
      const text = payload.result?.content?.[0]?.text ?? "";
      expect(text).toContain("use it as a fallback");
      expect(text).toContain("explicitly tell the user");
    } finally {
      child.kill();
    }
  });

  it("adds a visible notice when a provider fallback is used", () => {
    const result = addSearchFallbackNotice({
      provider: "tavily",
      query: "fallback test",
      results: [
        {
          title: "Recovered result",
          url: "https://example.test/recovered",
        },
      ],
      fallbacks: [
        {
          provider: "brave",
          error: "rate limited",
        },
      ],
    });

    expect(result.notice).toContain("Search provider fallback used");
    expect(result.notice).toContain("brave: rate limited");
  });

  it("keeps extracted content within the requested total character budget", () => {
    const result = truncateExtractResult({
      results: [
        { url: "https://example.test/1", raw_content: "a".repeat(90) },
        { url: "https://example.test/2", raw_content: "b".repeat(90) },
        { url: "https://example.test/3", raw_content: "c".repeat(90) },
      ],
    }, 100);

    const total = result.results
      ?.map((entry) => entry.raw_content?.length ?? 0)
      .reduce((sum, length) => sum + length, 0);

    expect(total).toBeLessThanOrEqual(100);
    expect(result.results?.[2]?.raw_content).toBe("");
  });
});
