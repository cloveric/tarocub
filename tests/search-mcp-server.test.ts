import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  addExtractSourceMetadata,
  addSearchFallbackNotice,
  addSearchSourceLog,
  applyCodexSearchCredentialFallback,
  getProviderStatusFromEnv,
  runSearchProviderHealthCheck,
  resolveSearchMcpServerInvocation,
  truncateExtractResult,
} from "../src/search/search-mcp-server.js";
import { childProcessTestEnv } from "./helpers/temp-files.js";

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
  it("reuses configured Codex Search MCP credentials when direct env values are absent", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "search-mcp-codex-home-"));
    const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
    try {
      await writeFile(path.join(codexHome, "config.toml"), [
        "[mcp_servers.web-search]",
        "command = \"node\"",
        "",
        "[mcp_servers.web-search.env]",
        "BRAVE_API_KEY = \"brave-from-codex\"",
        "TAVILY_API_KEY = 'tavily-from-codex'",
        "",
      ].join("\n"), "utf8");

      await expect(applyCodexSearchCredentialFallback(env)).resolves.toEqual([
        "BRAVE_API_KEY",
        "TAVILY_API_KEY",
      ]);
      expect(env.BRAVE_API_KEY).toBe("brave-from-codex");
      expect(env.TAVILY_API_KEY).toBe("tavily-from-codex");

      const explicitEnv: NodeJS.ProcessEnv = {
        CODEX_HOME: codexHome,
        BRAVE_API_KEY: "",
        TAVILY_API_KEY: "explicit-tavily",
      };
      await expect(applyCodexSearchCredentialFallback(explicitEnv)).resolves.toEqual([]);
      expect(explicitEnv.BRAVE_API_KEY).toBe("");
      expect(explicitEnv.TAVILY_API_KEY).toBe("explicit-tavily");
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it("lists web search tools without API keys", async () => {
    const invocation = resolveSearchMcpServerInvocation();
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childProcessTestEnv({
        ...process.env,
        BRAVE_API_KEY: "",
        TAVILY_API_KEY: "",
      }),
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
            expect.objectContaining({
              name: "web_extract",
              inputSchema: expect.objectContaining({
                properties: expect.objectContaining({
                  maxChars: expect.objectContaining({ minimum: 1 }),
                }),
              }),
            }),
            expect.objectContaining({ name: "provider_status" }),
            expect.objectContaining({ name: "health_check" }),
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
      env: childProcessTestEnv({
        ...process.env,
        BRAVE_API_KEY: "",
        TAVILY_API_KEY: "",
      }),
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
          provider: "tavily",
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

  it("adds a source log to search responses", () => {
    const result = addSearchSourceLog({
      provider: "brave",
      query: "docs",
      results: [
        {
          title: "Docs",
          url: "https://docs.example.com/page",
          snippet: "Snippet",
          rank: 1,
          domain: "docs.example.com",
          provider: "brave",
          accessedAt: "2026-05-09T10:00:00.000Z",
        },
      ],
      fallbacks: [],
    });

    expect(result.sourceLog).toEqual([
      {
        sourceId: "src_001",
        query: "docs",
        provider: "brave",
        url: "https://docs.example.com/page",
        domain: "docs.example.com",
        title: "Docs",
        snippet: "Snippet",
        rank: 1,
        accessedAt: "2026-05-09T10:00:00.000Z",
        status: "success",
      },
    ]);
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

  it("adds source metadata and content hashes to extract responses", () => {
    const result = addExtractSourceMetadata({
      results: [
        {
          url: "https://docs.example.com/page",
          raw_content: "hello world",
        },
      ],
    }, "2026-05-09T10:00:00.000Z");

    expect(result.results?.[0]).toMatchObject({
      url: "https://docs.example.com/page",
      domain: "docs.example.com",
      provider: "tavily",
      status: "success",
      extractedAt: "2026-05-09T10:00:00.000Z",
    });
    expect(result.results?.[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceLog?.[0]).toMatchObject({
      sourceId: "src_001",
      provider: "tavily",
      url: "https://docs.example.com/page",
      domain: "docs.example.com",
      status: "success",
      extractedAt: "2026-05-09T10:00:00.000Z",
    });
  });

  it("reports provider configuration without exposing API keys", () => {
    const status = getProviderStatusFromEnv({
      BRAVE_API_KEY: "brave-secret",
      TAVILY_API_KEY: "",
    }, "2026-05-09T10:00:00.000Z");

    expect(status).toEqual({
      checkedAt: "2026-05-09T10:00:00.000Z",
      providers: {
        brave: {
          configured: true,
          healthy: "unknown",
        },
        tavily: {
          configured: false,
          healthy: false,
        },
      },
    });
    expect(JSON.stringify(status)).not.toContain("brave-secret");
  });

  it("runs an explicit live health check without exposing API keys", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("api.search.brave.com")) {
        return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
      }
      if (url.includes("api.tavily.com")) {
        return new Response(JSON.stringify({ error: "quota exceeded" }), { status: 429, statusText: "Too Many Requests" });
      }
      throw new Error(`unexpected health check URL: ${url}`);
    };

    const status = await runSearchProviderHealthCheck({
      env: {
        BRAVE_API_KEY: "brave-secret",
        TAVILY_API_KEY: "tavily-secret",
      },
      checkedAt: "2026-05-10T10:00:00.000Z",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(calls.find((call) => call.url.includes("api.tavily.com"))?.init?.headers).toMatchObject({
      Authorization: "Bearer tavily-secret",
    });
    expect(status).toMatchObject({
      checkedAt: "2026-05-10T10:00:00.000Z",
      live: true,
      providers: {
        brave: {
          configured: true,
          checked: true,
          healthy: true,
          status: "ok",
        },
        tavily: {
          configured: true,
          checked: true,
          healthy: false,
          status: "rate_limited",
        },
      },
    });
    expect(JSON.stringify(status)).not.toContain("brave-secret");
    expect(JSON.stringify(status)).not.toContain("tavily-secret");
  });

  it("passes a custom health check query to the selected provider", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
    };

    const status = await runSearchProviderHealthCheck({
      env: {
        BRAVE_API_KEY: "brave-secret",
        TAVILY_API_KEY: "tavily-secret",
      },
      provider: "brave",
      query: "custom health probe",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(status.query).toBe("custom health probe");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!).searchParams.get("q")).toBe("custom health probe");
    expect(status.providers.tavily).toBeUndefined();
  });

  it("redacts leaked provider secrets from live health check errors", async () => {
    const fetchImpl = async () => {
      throw new Error("network failed Authorization: Bearer tavily-secret X-Subscription-Token: brave-secret BRAVE_API_KEY=brave-env TAVILY_API_KEY=tavily-env");
    };

    const status = await runSearchProviderHealthCheck({
      env: {
        BRAVE_API_KEY: "brave-secret",
        TAVILY_API_KEY: "tavily-secret",
      },
      provider: "tavily",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const detail = status.providers.tavily?.detail ?? "";
    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain("tavily-secret");
    expect(detail).not.toContain("brave-secret");
    expect(detail).not.toContain("brave-env");
    expect(detail).not.toContain("tavily-env");
  });
});
