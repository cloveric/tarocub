export type SearchMode = "quick" | "deep" | "verify";
export type SearchProviderName = "brave" | "tavily" | "mixed";

export interface SearchRequest {
  query: string;
  mode?: SearchMode;
  maxResults?: number;
}

export interface SearchProviderRequest {
  query: string;
  mode: SearchMode;
  maxResults: number;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  rank?: number;
  domain?: string;
  provider: Exclude<SearchProviderName, "mixed">;
  accessedAt?: string;
  score?: number;
  publishedAt?: string;
  source?: string;
  rawContent?: string;
}

export interface SearchProviderResult {
  provider: SearchProviderName;
  query: string;
  answer?: string;
  results: SearchResultItem[];
}

export interface SearchFallback {
  provider: Exclude<SearchProviderName, "mixed">;
  error: string;
}

export interface SearchRouterResult extends SearchProviderResult {
  fallbacks: SearchFallback[];
}

export interface SearchProvider {
  name: Exclude<SearchProviderName, "mixed">;
  search(input: SearchProviderRequest): Promise<SearchProviderResult>;
}

export interface SearchProviders {
  brave?: SearchProvider;
  tavily?: SearchProvider;
}

export interface SearchRouter {
  search(input: SearchRequest): Promise<SearchRouterResult>;
}

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;

function normalizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

function normalizeInput(input: SearchRequest): SearchProviderRequest {
  const query = input.query.trim();
  if (!query) {
    throw new Error("search query is required");
  }

  const requestedMaxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxResults = Math.min(
    MAX_RESULTS_LIMIT,
    Math.max(1, Number.isFinite(requestedMaxResults) ? Math.trunc(requestedMaxResults) : DEFAULT_MAX_RESULTS),
  );

  return {
    query,
    maxResults,
    mode: input.mode ?? "quick",
  };
}

function providersForMode(providers: SearchProviders, mode: SearchMode): SearchProvider[] {
  const brave = providers.brave;
  const tavily = providers.tavily;
  if (mode === "deep") {
    return [tavily, brave].filter((provider): provider is SearchProvider => provider !== undefined);
  }
  return [brave, tavily].filter((provider): provider is SearchProvider => provider !== undefined);
}

function hasUsefulResult(result: SearchProviderResult): boolean {
  return result.results.length > 0 || Boolean(result.answer?.trim());
}

async function runFallbackSearch(providers: SearchProvider[], request: SearchProviderRequest): Promise<SearchRouterResult> {
  const fallbacks: SearchFallback[] = [];
  for (const provider of providers) {
    try {
      const result = await provider.search(request);
      if (!hasUsefulResult(result)) {
        fallbacks.push({
          provider: provider.name,
          error: "no results",
        });
        continue;
      }
      return {
        ...result,
        fallbacks,
      };
    } catch (error) {
      fallbacks.push({
        provider: provider.name,
        error: normalizeError(error),
      });
    }
  }

  if (providers.length === 0) {
    throw new Error("No Brave or Tavily API key is configured. Set BRAVE_API_KEY and/or TAVILY_API_KEY.");
  }

  throw new Error(`All search providers failed: ${fallbacks.map((entry) => `${entry.provider}: ${entry.error}`).join("; ")}`);
}

async function runVerifySearch(providers: SearchProvider[], request: SearchProviderRequest): Promise<SearchRouterResult> {
  if (providers.length === 0) {
    throw new Error("No Brave or Tavily API key is configured. Set BRAVE_API_KEY and/or TAVILY_API_KEY.");
  }

  const successes: SearchProviderResult[] = [];
  const fallbacks: SearchFallback[] = [];
  const attempts = await Promise.all(providers.map(async (provider) => {
    try {
      return {
        ok: true as const,
        provider,
        result: await provider.search(request),
      };
    } catch (error) {
      return {
        ok: false as const,
        provider,
        error,
      };
    }
  }));

  for (const attempt of attempts) {
    if (attempt.ok) {
      if (hasUsefulResult(attempt.result)) {
        successes.push(attempt.result);
      } else {
        fallbacks.push({
          provider: attempt.provider.name,
          error: "no results",
        });
      }
    } else {
      fallbacks.push({
        provider: attempt.provider.name,
        error: normalizeError(attempt.error),
      });
    }
  }

  if (successes.length === 0) {
    throw new Error(`All search providers failed: ${fallbacks.map((entry) => `${entry.provider}: ${entry.error}`).join("; ")}`);
  }

  const mergedResults = new Map<string, SearchResultItem>();
  for (const success of successes) {
    for (const result of success.results) {
      if (!mergedResults.has(result.url)) {
        mergedResults.set(result.url, {
          ...result,
          source: result.source ?? success.provider,
        });
      }
    }
  }

  return {
    provider: successes.length > 1 ? "mixed" : successes[0]!.provider,
    query: request.query,
    answer: successes.map((success) => success.answer).filter(Boolean).join("\n\n") || undefined,
    results: Array.from(mergedResults.values()).slice(0, request.maxResults),
    fallbacks,
  };
}

export function createSearchRouter(providers: SearchProviders): SearchRouter {
  return {
    async search(input) {
      const request = normalizeInput(input);
      const orderedProviders = providersForMode(providers, request.mode);
      if (request.mode === "verify") {
        return await runVerifySearch(orderedProviders, request);
      }
      return await runFallbackSearch(orderedProviders, request);
    },
  };
}
