import { describe, expect, it, vi } from "vitest";

import { createSearchRouter, type SearchProvider } from "../src/search/search-router.js";

function provider(name: "brave" | "tavily", implementation: SearchProvider["search"]): SearchProvider {
  return {
    name,
    search: implementation,
  };
}

describe("search router", () => {
  it("uses Brave first for quick searches", async () => {
    const braveSearch = vi.fn<SearchProvider["search"]>().mockResolvedValue({
      provider: "brave",
      query: "telegram bot api",
      results: [
        {
          title: "Telegram Bot API",
          url: "https://core.telegram.org/bots/api",
          snippet: "Official Telegram Bot API docs.",
          provider: "brave",
        },
      ],
    });
    const tavilySearch = vi.fn<SearchProvider["search"]>().mockResolvedValue({
      provider: "tavily",
      query: "telegram bot api",
      results: [],
    });

    const router = createSearchRouter({
      brave: provider("brave", braveSearch),
      tavily: provider("tavily", tavilySearch),
    });

    const result = await router.search({ query: "telegram bot api", mode: "quick" });

    expect(result.provider).toBe("brave");
    expect(result.fallbacks).toEqual([]);
    expect(braveSearch).toHaveBeenCalledWith({
      query: "telegram bot api",
      maxResults: 5,
      mode: "quick",
    });
    expect(tavilySearch).not.toHaveBeenCalled();
  });

  it("falls back from Brave to Tavily when quick search fails", async () => {
    const router = createSearchRouter({
      brave: provider("brave", vi.fn<SearchProvider["search"]>().mockRejectedValue(new Error("brave down"))),
      tavily: provider("tavily", vi.fn<SearchProvider["search"]>().mockResolvedValue({
        provider: "tavily",
        query: "brave api",
        results: [
          {
            title: "Fallback result",
            url: "https://example.test/fallback",
            snippet: "Recovered by Tavily.",
            provider: "tavily",
          },
        ],
      })),
    });

    const result = await router.search({ query: "brave api", mode: "quick" });

    expect(result.provider).toBe("tavily");
    expect(result.fallbacks).toEqual([
      {
        provider: "brave",
        error: "brave down",
      },
    ]);
  });

  it("falls back when the primary provider returns no useful result", async () => {
    const router = createSearchRouter({
      brave: provider("brave", vi.fn<SearchProvider["search"]>().mockResolvedValue({
        provider: "brave",
        query: "obscure query",
        results: [],
      })),
      tavily: provider("tavily", vi.fn<SearchProvider["search"]>().mockResolvedValue({
        provider: "tavily",
        query: "obscure query",
        results: [
          {
            title: "Useful result",
            url: "https://example.test/useful",
            provider: "tavily",
          },
        ],
      })),
    });

    const result = await router.search({ query: "obscure query", mode: "quick" });

    expect(result.provider).toBe("tavily");
    expect(result.fallbacks).toEqual([
      {
        provider: "brave",
        error: "no results",
      },
    ]);
  });

  it("uses Tavily first for deep searches and falls back to Brave", async () => {
    const braveSearch = vi.fn<SearchProvider["search"]>().mockResolvedValue({
      provider: "brave",
      query: "model context protocol",
      results: [
        {
          title: "MCP",
          url: "https://modelcontextprotocol.io/",
          snippet: "Protocol docs.",
          provider: "brave",
        },
      ],
    });
    const tavilySearch = vi.fn<SearchProvider["search"]>().mockRejectedValue(new Error("tavily quota exceeded"));

    const router = createSearchRouter({
      brave: provider("brave", braveSearch),
      tavily: provider("tavily", tavilySearch),
    });

    const result = await router.search({ query: "model context protocol", mode: "deep", maxResults: 3 });

    expect(result.provider).toBe("brave");
    expect(tavilySearch).toHaveBeenCalledWith({
      query: "model context protocol",
      maxResults: 3,
      mode: "deep",
    });
    expect(braveSearch).toHaveBeenCalledWith({
      query: "model context protocol",
      maxResults: 3,
      mode: "deep",
    });
    expect(result.fallbacks).toEqual([
      {
        provider: "tavily",
        error: "tavily quota exceeded",
      },
    ]);
  });

  it("runs verify searches across providers in parallel and merges results", async () => {
    let resolveBrave: ((value: Awaited<ReturnType<SearchProvider["search"]>>) => void) | undefined;
    const braveSearch = vi.fn<SearchProvider["search"]>().mockImplementation(async () =>
      await new Promise((resolve) => {
        resolveBrave = resolve;
      }),
    );
    const tavilySearch = vi.fn<SearchProvider["search"]>().mockResolvedValue({
      provider: "tavily",
      query: "current api docs",
      results: [
        {
          title: "Tavily result",
          url: "https://example.test/tavily",
          snippet: "Tavily found it.",
          provider: "tavily",
        },
      ],
    });
    const router = createSearchRouter({
      brave: provider("brave", braveSearch),
      tavily: provider("tavily", tavilySearch),
    });

    const pending = router.search({ query: "current api docs", mode: "verify" });
    await Promise.resolve();

    expect(braveSearch).toHaveBeenCalled();
    expect(tavilySearch).toHaveBeenCalled();
    resolveBrave?.({
      provider: "brave",
      query: "current api docs",
      results: [
        {
          title: "Brave result",
          url: "https://example.test/brave",
          snippet: "Brave found it.",
          provider: "brave",
        },
      ],
    });

    const result = await pending;

    expect(result.provider).toBe("mixed");
    expect(result.fallbacks).toEqual([]);
    expect(result.results.map((entry) => entry.url)).toEqual([
      "https://example.test/brave",
      "https://example.test/tavily",
    ]);
  });

  it("keeps verify results when one provider fails", async () => {
    const router = createSearchRouter({
      brave: provider("brave", vi.fn<SearchProvider["search"]>().mockRejectedValue(new Error("brave timeout"))),
      tavily: provider("tavily", vi.fn<SearchProvider["search"]>().mockResolvedValue({
        provider: "tavily",
        query: "resilient verify",
        results: [
          {
            title: "Surviving result",
            url: "https://example.test/survives",
            provider: "tavily",
          },
        ],
      })),
    });

    const result = await router.search({ query: "resilient verify", mode: "verify" });

    expect(result.provider).toBe("tavily");
    expect(result.results).toHaveLength(1);
    expect(result.fallbacks).toEqual([
      {
        provider: "brave",
        error: "brave timeout",
      },
    ]);
  });

  it("ignores empty verify provider results when another provider has sources", async () => {
    const router = createSearchRouter({
      brave: provider("brave", vi.fn<SearchProvider["search"]>().mockResolvedValue({
        provider: "brave",
        query: "verify empty",
        results: [],
      })),
      tavily: provider("tavily", vi.fn<SearchProvider["search"]>().mockResolvedValue({
        provider: "tavily",
        query: "verify empty",
        results: [
          {
            title: "Only useful source",
            url: "https://example.test/source",
            provider: "tavily",
          },
        ],
      })),
    });

    const result = await router.search({ query: "verify empty", mode: "verify" });

    expect(result.provider).toBe("tavily");
    expect(result.results).toHaveLength(1);
    expect(result.fallbacks).toEqual([
      {
        provider: "brave",
        error: "no results",
      },
    ]);
  });
});
