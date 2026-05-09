import { describe, expect, it, vi } from "vitest";

import { createBraveSearchProvider, createTavilySearchProvider, extractWithTavily, truncateSearchText } from "../src/search/search-providers.js";

describe("search providers", () => {
  it("truncates long raw content with an omission marker", () => {
    const text = "a".repeat(7000);

    const truncated = truncateSearchText(text, 100);

    expect(truncated).toHaveLength(100);
    expect(truncated).toMatch(/\.\.\. \[truncated \d+ chars\]$/);
  });

  it("bounds Tavily raw search content returned to agents", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      query: "large page",
      results: [
        {
          title: "Large page",
          url: "https://example.test/large",
          content: "snippet",
          raw_content: "x".repeat(9000),
        },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const provider = createTavilySearchProvider({
      apiKey: "tvly-test",
      fetchImpl,
      maxRawContentChars: 1200,
    });

    const result = await provider.search({
      query: "large page",
      mode: "deep",
      maxResults: 1,
    });

    expect(result.results[0]?.rawContent).toHaveLength(1200);
    expect(result.results[0]?.rawContent).toContain("[truncated");
  });

  it("passes timeout signals to Brave, Tavily search, and Tavily extract fetches", async () => {
    const braveFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      web: { results: [] },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const tavilyFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      results: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const extractFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      results: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await createBraveSearchProvider({ apiKey: "brave", fetchImpl: braveFetch, fetchTimeoutMs: 1234 }).search({
      query: "timeout",
      mode: "quick",
      maxResults: 1,
    });
    await createTavilySearchProvider({ apiKey: "tavily", fetchImpl: tavilyFetch, fetchTimeoutMs: 1234 }).search({
      query: "timeout",
      mode: "deep",
      maxResults: 1,
    });
    await extractWithTavily({
      apiKey: "tavily",
      urls: ["https://example.test"],
      fetchImpl: extractFetch,
      fetchTimeoutMs: 1234,
    });

    expect((braveFetch.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect((tavilyFetch.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect((extractFetch.mock.calls[0]?.[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});
