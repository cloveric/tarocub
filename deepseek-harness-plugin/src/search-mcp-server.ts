import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import { createSearchRouter, type SearchMode } from "./search-router.js";
import {
  createBraveSearchProvider,
  createTavilySearchProvider,
  extractWithTavily,
  isHttpUrl,
} from "./search-providers.js";
import type { SearchRouterResult } from "./search-router.js";

type FetchLike = typeof fetch;

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

const HttpUrlSchema = z.string().trim().url().refine(isHttpUrl, {
  message: "Only HTTP(S) URLs are supported",
});

const ExtractToolInputSchema = z.object({
  url: HttpUrlSchema.optional(),
  urls: z.array(HttpUrlSchema).min(1).max(10).optional(),
  depth: z.enum(["basic", "advanced"]).optional(),
  format: z.enum(["markdown", "text"]).optional(),
  maxChars: z.number().int().min(1).max(60_000).optional(),
}).passthrough().refine((value) => value.url || value.urls, {
  message: "url or urls is required",
});

const HealthCheckInputSchema = z.object({
  provider: z.enum(["all", "brave", "tavily"]).optional(),
  query: z.string().trim().min(1).max(100).optional(),
}).passthrough();

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
type LiveProviderHealth = {
  configured: boolean;
  checked: boolean;
  healthy: boolean;
  status: "ok" | "not_configured" | "auth_error" | "rate_limited" | "timeout" | "error";
  detail?: string;
};
type LiveHealthCheckStatus = {
  checkedAt: string;
  live: true;
  query: string;
  providers: {
    brave?: LiveProviderHealth;
    tavily?: LiveProviderHealth;
  };
  note: string;
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

const SEARCH_CREDENTIAL_KEYS = ["BRAVE_API_KEY", "BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY"] as const;
type SearchCredentialKey = (typeof SEARCH_CREDENTIAL_KEYS)[number];

function stripTomlInlineComment(value: string): string {
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "\"" || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (char === "#" && quote === null) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function parseTomlString(value: string): string | undefined {
  const trimmed = stripTomlInlineComment(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    const parsed = trimmed.slice(1, -1).trim();
    return parsed || undefined;
  }
  return trimmed;
}

function searchCredentialsFromCodexConfig(raw: string): Partial<Record<SearchCredentialKey, string>> {
  const credentials: Partial<Record<SearchCredentialKey, string>> = {};
  let inMcpEnvSection = false;
  for (const line of raw.split(/\r?\n/)) {
    const section = line.match(/^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?$/)?.[1]?.trim();
    if (section !== undefined) {
      inMcpEnvSection = /^mcp_servers\..+\.env$/i.test(section);
      continue;
    }
    if (!inMcpEnvSection) {
      continue;
    }
    const entry = line.match(/^\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*=\s*(.+)$/);
    const key = entry?.[1];
    if (!key || !SEARCH_CREDENTIAL_KEYS.some((candidate) => candidate === key)) {
      continue;
    }
    const value = parseTomlString(entry![2]!);
    if (value && credentials[key as SearchCredentialKey] === undefined) {
      credentials[key as SearchCredentialKey] = value;
    }
  }
  return credentials;
}

export async function applyCodexSearchCredentialFallback(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const needsBrave = env.BRAVE_API_KEY === undefined && env.BRAVE_SEARCH_API_KEY === undefined;
  const needsTavily = env.TAVILY_API_KEY === undefined;
  if (!needsBrave && !needsTavily) {
    return [];
  }
  const codexHome = env.CODEX_HOME?.trim()
    || (env.HOME || env.USERPROFILE ? path.join((env.HOME ?? env.USERPROFILE)!, ".codex") : undefined);
  if (!codexHome) {
    return [];
  }
  let configured: Partial<Record<SearchCredentialKey, string>>;
  try {
    configured = searchCredentialsFromCodexConfig(
      await readFile(path.join(codexHome, "config.toml"), "utf8"),
    );
  } catch {
    return [];
  }
  const applied: string[] = [];
  if (needsBrave) {
    const key: "BRAVE_API_KEY" | "BRAVE_SEARCH_API_KEY" | undefined = configured.BRAVE_API_KEY
      ? "BRAVE_API_KEY"
      : configured.BRAVE_SEARCH_API_KEY
        ? "BRAVE_SEARCH_API_KEY"
        : undefined;
    if (key) {
      env[key] = configured[key];
      applied.push(key);
    }
  }
  if (needsTavily && configured.TAVILY_API_KEY) {
    env.TAVILY_API_KEY = configured.TAVILY_API_KEY;
    applied.push("TAVILY_API_KEY");
  }
  return applied;
}

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
      message: redactSearchMcpText(truncateTextToExactBudget(message, 4_000)),
    },
  }) + "\n");
}

function jsonContent(payload: unknown, isError = false): Record<string, unknown> {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [
      {
        type: "text",
        text: redactSearchMcpText(serialized),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

const NATIVE_SEARCH_FALLBACK_HINT = "If the runtime has a native web search tool, use it as a fallback and explicitly tell the user that Brave/Tavily Search MCP failed.";

export function renderSearchToolError(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  return jsonContent(
    `${truncateTextToExactBudget(message, 4_000)}\n\n${NATIVE_SEARCH_FALLBACK_HINT}`,
    true,
  );
}

function createRouterFromEnv() {
  const braveApiKey = process.env.BRAVE_API_KEY?.trim() || process.env.BRAVE_SEARCH_API_KEY?.trim() || "";
  const tavilyApiKey = process.env.TAVILY_API_KEY?.trim() ?? "";
  return createSearchRouter({
    brave: braveApiKey ? createBraveSearchProvider({ apiKey: braveApiKey }) : undefined,
    tavily: tavilyApiKey ? createTavilySearchProvider({ apiKey: tavilyApiKey }) : undefined,
  });
}

function providerKeysFromEnv(env: NodeJS.ProcessEnv): { braveApiKey: string; tavilyApiKey: string } {
  return {
    braveApiKey: env.BRAVE_API_KEY?.trim() || env.BRAVE_SEARCH_API_KEY?.trim() || "",
    tavilyApiKey: env.TAVILY_API_KEY?.trim() ?? "",
  };
}

function classifyHealthError(error: unknown): LiveProviderHealth["status"] {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.*key|forbidden/i.test(message)) {
    return "auth_error";
  }
  if (/\b429\b|rate.?limit|quota|too many requests/i.test(message)) {
    return "rate_limited";
  }
  if (/abort|timeout|timed out/i.test(message)) {
    return "timeout";
  }
  return "error";
}

export function redactSearchMcpText(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let redacted = input
    .replace(/(Authorization:\s*Bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(X-Subscription-Token:?\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:BRAVE|BRAVE_SEARCH|TAVILY)_API_KEY\s*[:=]\s*["']?)[^\s,;"'}\]]+/gi, "$1[redacted]")
    .replace(/(api[_-]?key=)[^&\s]+/gi, "$1[redacted]");

  for (const key of SEARCH_CREDENTIAL_KEYS) {
    const value = env[key]?.trim();
    if (value && value.length >= 8) {
      redacted = redacted.replaceAll(value, "[redacted]");
    }
  }
  return redacted;
}

function healthErrorDetail(error: unknown, env: NodeJS.ProcessEnv): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSearchMcpText(message, env);
}

async function checkConfiguredProvider(
  providerName: "brave" | "tavily",
  provider: ReturnType<typeof createBraveSearchProvider> | ReturnType<typeof createTavilySearchProvider>,
  query: string,
  env: NodeJS.ProcessEnv,
): Promise<LiveProviderHealth> {
  try {
    await provider.search({
      query,
      mode: "quick",
      maxResults: 1,
    });
    return {
      configured: true,
      checked: true,
      healthy: true,
      status: "ok",
    };
  } catch (error) {
    return {
      configured: true,
      checked: true,
      healthy: false,
      status: classifyHealthError(error),
      detail: `${providerName}: ${healthErrorDetail(error, env)}`,
    };
  }
}

export async function runSearchProviderHealthCheck(input: {
  env?: NodeJS.ProcessEnv;
  provider?: "all" | "brave" | "tavily";
  checkedAt?: string;
  fetchImpl?: FetchLike;
  fetchTimeoutMs?: number;
  query?: string;
} = {}): Promise<LiveHealthCheckStatus> {
  const env = input.env ?? process.env;
  const selectedProvider = input.provider ?? "all";
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const query = input.query ?? "OpenAI";
  const { braveApiKey, tavilyApiKey } = providerKeysFromEnv(env);
  const providers: LiveHealthCheckStatus["providers"] = {};
  const shouldCheckBrave = selectedProvider === "all" || selectedProvider === "brave";
  const shouldCheckTavily = selectedProvider === "all" || selectedProvider === "tavily";
  const checks: Array<Promise<void>> = [];

  if (shouldCheckBrave) {
    if (braveApiKey) {
      const provider = createBraveSearchProvider({
        apiKey: braveApiKey,
        fetchImpl: input.fetchImpl,
        fetchTimeoutMs: input.fetchTimeoutMs ?? 10_000,
      });
      checks.push(checkConfiguredProvider("brave", provider, query, env).then((result) => {
        providers.brave = result;
      }));
    } else {
      providers.brave = {
        configured: false,
        checked: false,
        healthy: false,
        status: "not_configured",
      };
    }
  }

  if (shouldCheckTavily) {
    if (tavilyApiKey) {
      const provider = createTavilySearchProvider({
        apiKey: tavilyApiKey,
        fetchImpl: input.fetchImpl,
        fetchTimeoutMs: input.fetchTimeoutMs ?? 10_000,
      });
      checks.push(checkConfiguredProvider("tavily", provider, query, env).then((result) => {
        providers.tavily = result;
      }));
    } else {
      providers.tavily = {
        configured: false,
        checked: false,
        healthy: false,
        status: "not_configured",
      };
    }
  }

  await Promise.all(checks);

  return {
    checkedAt,
    live: true,
    query,
    providers,
    note: "health_check performs live provider requests only when explicitly called; it may consume provider quota.",
  };
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

  const fallbacks = result.fallbacks.map((entry) => ({
    ...entry,
    error: redactSearchMcpText(truncateTextToExactBudget(entry.error, 2_000)),
  }));
  return {
    ...result,
    fallbacks,
    notice: `Search provider fallback used: ${fallbacks.map((entry) => `${entry.provider}: ${entry.error}`).join("; ")}. Disclose this if the answer relies on fallback results.`,
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
  const results = payload.results
    ?.filter((entry) => !entry.url || isHttpUrl(entry.url))
    .map((entry): EnrichedExtractEntry => {
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
    return renderSearchToolError(error);
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
    return renderSearchToolError(error);
  }
}

async function callProviderStatus(): Promise<Record<string, unknown>> {
  return jsonContent(getProviderStatusFromEnv());
}

async function callHealthCheck(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const parsed = HealthCheckInputSchema.safeParse(args);
  if (!parsed.success) {
    return jsonContent(`Invalid health_check input: ${parsed.error.message}`, true);
  }

  try {
    return jsonContent(await runSearchProviderHealthCheck({
      provider: parsed.data.provider,
      query: parsed.data.query,
    }));
  } catch (error) {
    return renderSearchToolError(error);
  }
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
        {
          name: "health_check",
          description: "Explicitly perform live Brave/Tavily health checks. Use sparingly because it calls provider APIs and may consume quota.",
          inputSchema: {
            type: "object",
            properties: {
              provider: {
                type: "string",
                enum: ["all", "brave", "tavily"],
                description: "Provider to check. Defaults to all configured providers.",
              },
              query: {
                type: "string",
                minLength: 1,
                maxLength: 100,
                description: "Optional harmless query for the live probe. Defaults to OpenAI.",
              },
            },
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
    if (toolName === "health_check") {
      sendResponse(message.id, await callHealthCheck(args));
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

  const bundledPath = fileURLToPath(new URL("../dist/search-mcp.js", import.meta.url));
  if (existsSync(bundledPath)) {
    return {
      command: process.execPath,
      args: [bundledPath],
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

  throw new Error(`Search MCP server entrypoint not found: ${jsPath} or ${bundledPath}`);
}

export async function runSearchMcpServer(): Promise<void> {
  await applyCodexSearchCredentialFallback();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > 1_048_576 && !/[\r\n]/.test(buffer)) {
      console.error("Search MCP input line exceeded 1 MiB and was discarded.");
      buffer = "";
      return;
    }
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > 1_048_576) continue;
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

async function isDirectExecution(): Promise<boolean> {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const [modulePath, executablePath] = await Promise.all([
      realpath(fileURLToPath(import.meta.url)),
      realpath(process.argv[1]),
    ]);
    return modulePath === executablePath;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (await isDirectExecution()) {
  void runSearchMcpServer();
}
