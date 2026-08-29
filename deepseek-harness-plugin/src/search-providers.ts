import type { SearchProvider, SearchProviderResult } from "./search-router.js";

type FetchLike = typeof fetch;
const DEFAULT_RAW_CONTENT_CHAR_LIMIT = 6_000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const MIN_TRUNCATION_LIMIT = 80;

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  profile?: {
    name?: string;
  };
}

interface BraveResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  raw_content?: string | null;
  published_date?: string;
}

interface TavilySearchResponse {
  query?: string;
  answer?: string;
  results?: TavilySearchResult[];
}

interface TavilyExtractResult {
  url?: string;
  raw_content?: string;
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[];
  failed_results?: unknown[];
}

function requiredFetch(fetchImpl?: FetchLike): FetchLike {
  return fetchImpl ?? fetch;
}

function timeoutSignal(timeoutMs = DEFAULT_FETCH_TIMEOUT_MS): AbortSignal | undefined {
  const boundedTimeoutMs = Math.max(1, Math.trunc(timeoutMs));
  return typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(boundedTimeoutMs)
    : undefined;
}

function extractErrorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function domainFromUrl(url: string): string | undefined {
  if (!isHttpUrl(url)) {
    return undefined;
  }
  return new URL(url).hostname;
}

export function truncateSearchText(text: string, maxChars = DEFAULT_RAW_CONTENT_CHAR_LIMIT): string {
  const boundedMaxChars = Math.max(MIN_TRUNCATION_LIMIT, Math.trunc(maxChars));
  if (text.length <= boundedMaxChars) {
    return text;
  }

  const marker = `... [truncated ${text.length - boundedMaxChars} chars]`;
  return `${text.slice(0, Math.max(0, boundedMaxChars - marker.length))}${marker}`;
}

async function readJsonResponse(response: Response, provider: string): Promise<unknown> {
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json() as { error?: unknown; message?: unknown; detail?: unknown };
      const candidate = payload.error ?? payload.message ?? payload.detail;
      if (typeof candidate === "string" && candidate.trim()) {
        detail = candidate;
      }
    } catch {
      // Keep the HTTP status line.
    }
    throw new Error(`${provider} request failed: ${detail}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${provider} returned invalid JSON: ${extractErrorDetail(error)}`);
  }
}

export function createBraveSearchProvider(input: {
  apiKey: string;
  fetchImpl?: FetchLike;
  fetchTimeoutMs?: number;
}): SearchProvider {
  const apiKey = input.apiKey.trim();
  const fetchImpl = requiredFetch(input.fetchImpl);
  return {
    name: "brave",
    async search(request): Promise<SearchProviderResult> {
      if (!apiKey) {
        throw new Error("BRAVE_API_KEY is not configured");
      }

      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", request.query);
      url.searchParams.set("count", String(request.maxResults));
      url.searchParams.set("text_decorations", "false");

      const response = await fetchImpl(url, {
        headers: {
          "Accept": "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal: timeoutSignal(input.fetchTimeoutMs),
      });
      const payload = await readJsonResponse(response, "Brave") as BraveResponse;
      const accessedAt = new Date().toISOString();

      return {
        provider: "brave",
        query: request.query,
        results: (payload.web?.results ?? [])
          .filter((result): result is BraveWebResult & { title: string; url: string } =>
            typeof result.title === "string" &&
            result.title.trim().length > 0 &&
            typeof result.url === "string" &&
            isHttpUrl(result.url.trim()),
          )
          .map((result, index) => ({
            title: result.title.trim(),
            url: result.url.trim(),
            snippet: typeof result.description === "string" ? result.description.trim() : undefined,
            rank: index + 1,
            domain: domainFromUrl(result.url.trim()),
            provider: "brave",
            accessedAt,
            publishedAt: typeof result.age === "string" ? result.age : undefined,
            source: result.profile?.name ?? "brave",
          })),
      };
    },
  };
}

export function createTavilySearchProvider(input: {
  apiKey: string;
  fetchImpl?: FetchLike;
  fetchTimeoutMs?: number;
  maxRawContentChars?: number;
}): SearchProvider {
  const apiKey = input.apiKey.trim();
  const fetchImpl = requiredFetch(input.fetchImpl);
  const maxRawContentChars = input.maxRawContentChars ?? DEFAULT_RAW_CONTENT_CHAR_LIMIT;
  return {
    name: "tavily",
    async search(request): Promise<SearchProviderResult> {
      if (!apiKey) {
        throw new Error("TAVILY_API_KEY is not configured");
      }

      const response = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: timeoutSignal(input.fetchTimeoutMs),
        body: JSON.stringify({
          query: request.query,
          max_results: request.maxResults,
          search_depth: request.mode === "quick" ? "basic" : "advanced",
          include_answer: request.mode !== "quick",
          include_raw_content: request.mode !== "quick",
        }),
      });
      const payload = await readJsonResponse(response, "Tavily") as TavilySearchResponse;
      const accessedAt = new Date().toISOString();

      return {
        provider: "tavily",
        query: payload.query ?? request.query,
        answer: typeof payload.answer === "string" && payload.answer.trim() ? payload.answer.trim() : undefined,
        results: (payload.results ?? [])
          .filter((result): result is TavilySearchResult & { title: string; url: string } =>
            typeof result.title === "string" &&
            result.title.trim().length > 0 &&
            typeof result.url === "string" &&
            isHttpUrl(result.url.trim()),
          )
          .map((result, index) => ({
            title: result.title.trim(),
            url: result.url.trim(),
            snippet: typeof result.content === "string" ? result.content.trim() : undefined,
            rank: index + 1,
            domain: domainFromUrl(result.url.trim()),
            provider: "tavily",
            accessedAt,
            score: typeof result.score === "number" ? result.score : undefined,
            publishedAt: typeof result.published_date === "string" ? result.published_date : undefined,
            rawContent: typeof result.raw_content === "string"
              ? truncateSearchText(result.raw_content, maxRawContentChars)
              : undefined,
            source: "tavily",
          })),
      };
    },
  };
}

export async function extractWithTavily(input: {
  apiKey: string;
  urls: string[];
  depth?: "basic" | "advanced";
  format?: "markdown" | "text";
  fetchImpl?: FetchLike;
  fetchTimeoutMs?: number;
}): Promise<TavilyExtractResponse> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("web_extract requires TAVILY_API_KEY");
  }

  const response = await requiredFetch(input.fetchImpl)("https://api.tavily.com/extract", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal: timeoutSignal(input.fetchTimeoutMs),
    body: JSON.stringify({
      urls: input.urls.length === 1 ? input.urls[0] : input.urls,
      extract_depth: input.depth ?? "basic",
      format: input.format ?? "markdown",
    }),
  });

  return await readJsonResponse(response, "Tavily extract") as TavilyExtractResponse;
}
