import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import { createSearchRouter, type SearchMode } from "./search-router.js";
import { createBraveSearchProvider, createTavilySearchProvider, extractWithTavily } from "./search-providers.js";
import type { SearchRouterResult } from "./search-router.js";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    protocolVersion?: string;
  };
};

export interface SearchMcpServerInvocation {
  command: string;
  args: string[];
}

const SearchToolInputSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(["quick", "deep", "verify"]).optional(),
  maxResults: z.number().int().min(1).max(10).optional(),
}).passthrough();

const ExtractToolInputSchema = z.object({
  url: z.string().url().optional(),
  urls: z.array(z.string().url()).min(1).max(10).optional(),
  depth: z.enum(["basic", "advanced"]).optional(),
  format: z.enum(["markdown", "text"]).optional(),
  maxChars: z.number().int().min(1).max(60_000).optional(),
}).passthrough().refine((value) => value.url || value.urls, {
  message: "url or urls is required",
});

type ProviderStatus = {
  checkedAt: string;
  providers: {
    brave: {
      configured: boolean;
      healthy: "unknown" | false;
    };
    tavily: {
      configured: boolean;
      healthy: "unknown" | false;
    };
  };
};
type TavilyExtractPayload = Awaited<ReturnType<typeof extractWithTavily>>;
type TavilyExtractEntry = NonNullable<TavilyExtractPayload["results"]>[number];
type SourceLogEntry = {
  sourceId: string;
  query?: string;
  provider?: string;
  url?: string;
  domain?: string;
  title?: string;
  snippet?: string;
  rank?: number;
  accessedAt?: string;
  extractedAt?: string;
  contentHash?: string;
  status: "success" | "failed";
};
type EnrichedExtractEntry = TavilyExtractEntry & {
  domain?: string;
  provider: "tavily";
  status: "success";
  extractedAt: string;
  contentHash: string;
};
type EnrichedExtractPayload = Omit<TavilyExtractPayload, "results"> & {
  results?: EnrichedExtractEntry[];
  sourceLog: SourceLogEntry[];
};

function sendResponse(id: string | number | undefined, result: Record<string, unknown>): void {
  if (id === undefined) {
    return;
  }

  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  }) + "\n");
}

function sendError(id: string | number | undefined, code: number, message: string): void {
  if (id === undefined) {
    return;
  }

  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  }) + "\n");
}

function jsonContent(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

const NATIVE_SEARCH_FALLBACK_HINT = "If the runtime has a native web search tool, use it as a fallback and explicitly tell the user that Brave/Tavily Search MCP failed.";

function renderToolError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return jsonContent(`${message}\n\n${NATIVE_SEARCH_FALLBACK_HINT}`, true);
}

function createRouterFromEnv() {
  const braveApiKey = process.env.BRAVE_API_KEY?.trim() || process.env.BRAVE_SEARCH_API_KEY?.trim() || "";
  const tavilyApiKey = process.env.TAVILY_API_KEY?.trim() ?? "";
  return createSearchRouter({
    brave: braveApiKey ? createBraveSearchProvider({ apiKey: braveApiKey }) : undefined,
    tavily: tavilyApiKey ? createTavilySearchProvider({ apiKey: tavilyApiKey }) : undefined,
  });
}

function domainFromUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function truncateTextToExactBudget(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  const marker = `... [truncated ${text.length - maxChars} chars]`;
  if (marker.length >= maxChars) {
    return text.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - marker.length)}${marker}`;
}

export function truncateExtractResult(payload: Awaited<ReturnType<typeof extractWithTavily>>, maxChars: number): Awaited<ReturnType<typeof extractWithTavily>> {
  let remaining = maxChars;
  return {
    ...payload,
    results: payload.results?.map((result) => {
      if (typeof result.raw_content !== "string") {
        return result;
      }
      const raw_content = truncateTextToExactBudget(result.raw_content, remaining);
      remaining = Math.max(0, remaining - raw_content.length);
      return {
        ...result,
        raw_content,
      };
    }),
  };
}

export function addSearchFallbackNotice(result: SearchRouterResult): SearchRouterResult & { notice?: string } {
  if (result.fallbacks.length === 0) {
    return result;
  }

  return {
    ...result,
    notice: `Search provider fallback used: ${result.fallbacks.map((entry) => `${entry.provider}: ${entry.error}`).join("; ")}. Disclose this if the answer relies on fallback results.`,
  };
}

export function addSearchSourceLog(result: SearchRouterResult): SearchRouterResult & { sourceLog: SourceLogEntry[] } {
  return {
    ...result,
    sourceLog: result.results.map((entry, index) => ({
      sourceId: `src_${String(index + 1).padStart(3, "0")}`,
      query: result.query,
      provider: entry.provider,
      url: entry.url,
      domain: entry.domain ?? domainFromUrl(entry.url),
      title: entry.title,
      snippet: entry.snippet,
      rank: entry.rank ?? index + 1,
      accessedAt: entry.accessedAt,
      status: "success",
    })),
  };
}

export function addExtractSourceMetadata(
  payload: TavilyExtractPayload,
  extractedAt = new Date().toISOString(),
): EnrichedExtractPayload {
  const results = payload.results?.map((entry): EnrichedExtractEntry => {
    const rawContent = entry.raw_content ?? "";
    return {
      ...entry,
      domain: entry.url ? domainFromUrl(entry.url) : undefined,
      provider: "tavily",
      status: "success",
      extractedAt,
      contentHash: contentHash(rawContent),
    };
  });

  return {
    ...payload,
    results,
    sourceLog: (results ?? []).map((entry, index): SourceLogEntry => ({
      sourceId: `src_${String(index + 1).padStart(3, "0")}`,
      provider: "tavily",
      url: entry.url,
      domain: entry.domain,
      status: entry.status,
      extractedAt: entry.extractedAt,
      contentHash: entry.contentHash,
    })),
  };
}

export function getProviderStatusFromEnv(env: NodeJS.ProcessEnv = process.env, checkedAt = new Date().toISOString()): ProviderStatus {
  const braveConfigured = Boolean(env.BRAVE_API_KEY?.trim() || env.BRAVE_SEARCH_API_KEY?.trim());
  const tavilyConfigured = Boolean(env.TAVILY_API_KEY?.trim());
  return {
    checkedAt,
    providers: {
      brave: {
        configured: braveConfigured,
        healthy: braveConfigured ? "unknown" : false,
      },
      tavily: {
        configured: tavilyConfigured,
        healthy: tavilyConfigured ? "unknown" : false,
      },
    },
  };
}

async function callWebSearch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = SearchToolInputSchema.safeParse(args);
  if (!parsed.success) {
    return jsonContent(`Invalid web_search input: ${parsed.error.message}`, true);
  }

  try {
    const result = await createRouterFromEnv().search({
      query: parsed.data.query,
      mode: parsed.data.mode as SearchMode | undefined,
      maxResults: parsed.data.maxResults,
    });
    return jsonContent(addSearchSourceLog(addSearchFallbackNotice(result)));
  } catch (error) {
    return renderToolError(error);
  }
}

async function callWebExtract(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = ExtractToolInputSchema.safeParse(args);
  if (!parsed.success) {
    return jsonContent(`Invalid web_extract input: ${parsed.error.message}`, true);
  }

  try {
    const urls = parsed.data.urls ?? [parsed.data.url!];
    const result = await extractWithTavily({
      apiKey: process.env.TAVILY_API_KEY ?? "",
      urls,
      depth: parsed.data.depth,
      format: parsed.data.format,
    });
    return jsonContent(addExtractSourceMetadata(truncateExtractResult(result, parsed.data.maxChars ?? 20_000)));
  } catch (error) {
    return renderToolError(error);
  }
}

async function callProviderStatus(): Promise<Record<string, unknown>> {
  return jsonContent(getProviderStatusFromEnv());
}

async function handleRequest(message: JsonRpcRequest): Promise<void> {
  if (message.method === "initialize") {
    sendResponse(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "cctb_search",
        version: "1.0.0",
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    sendResponse(message.id, {
      tools: [
        {
          name: "web_search",
          description: "Search the live web through a Brave/Tavily router. Use quick for broad discovery, deep for Tavily-first extraction-oriented research, and verify for cross-provider checks.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "The search query." },
              mode: {
                type: "string",
                enum: ["quick", "deep", "verify"],
                description: "quick uses Brave first, deep uses Tavily first, verify tries all configured providers.",
              },
              maxResults: { type: "number", minimum: 1, maximum: 10, description: "Maximum results to return." },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        {
          name: "web_extract",
          description: "Extract clean page content from one or more URLs using Tavily Extract. Use after search when the answer needs source text.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "One URL to extract." },
              urls: {
                type: "array",
                items: { type: "string" },
                minItems: 1,
                maxItems: 10,
                description: "Multiple URLs to extract.",
              },
              depth: { type: "string", enum: ["basic", "advanced"] },
              format: { type: "string", enum: ["markdown", "text"] },
              maxChars: {
                type: "number",
                minimum: 1,
                maximum: 60000,
                description: "Maximum total extracted content characters to return.",
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: "provider_status",
          description: "Report whether Brave and Tavily API keys are configured without exposing secret values. This does not perform paid live health checks.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }

  if (message.method === "tools/call") {
    const toolName = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (toolName === "web_search") {
      sendResponse(message.id, await callWebSearch(args));
      return;
    }
    if (toolName === "web_extract") {
      sendResponse(message.id, await callWebExtract(args));
      return;
    }
    if (toolName === "provider_status") {
      sendResponse(message.id, await callProviderStatus());
      return;
    }
    sendError(message.id, -32601, "Unknown tool");
    return;
  }

  if (message.id !== undefined) {
    sendError(message.id, -32601, "Method not found");
  }
}

export function resolveSearchMcpServerInvocation(): SearchMcpServerInvocation {
  const jsPath = fileURLToPath(new URL("./search-mcp-server.js", import.meta.url));
  if (existsSync(jsPath)) {
    return {
      command: process.execPath,
      args: [jsPath],
    };
  }

  const tsPath = fileURLToPath(new URL("./search-mcp-server.ts", import.meta.url));
  const localTsx = path.resolve(process.cwd(), "node_modules/.bin/tsx");
  if (existsSync(tsPath) && existsSync(localTsx)) {
    return {
      command: localTsx,
      args: [tsPath],
    };
  }

  throw new Error(`Search MCP server entrypoint not found: ${jsPath}`);
}

export async function runSearchMcpServer(): Promise<void> {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        continue;
      }
      void handleRequest(message).catch((error) => {
        sendError(message.id, -32603, error instanceof Error ? error.message : "Internal error");
      });
    }
  });

  await new Promise<void>(() => {});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runSearchMcpServer();
}
