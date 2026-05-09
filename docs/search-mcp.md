# Brave/Tavily Search MCP

`cc-telegram-bridge` includes a local stdio MCP server for live web search:

```bash
node /Users/cloveric/projects/cc-telegram-bridge/dist/src/index.js search-mcp
```

It exposes three tools:

- `web_search` - routed live search through Brave and/or Tavily.
- `web_extract` - Tavily-powered clean URL extraction.
- `provider_status` - local configuration status for Brave/Tavily without exposing API keys.

## Provider Routing

The MCP server gives agents one stable entrypoint instead of making them choose vendors directly.

| Mode | Provider order | Use case |
|---|---|---|
| `quick` | Brave -> Tavily | Broad discovery, latest facts, docs, pricing, news |
| `deep` | Tavily -> Brave | Research tasks, source reading, extraction-oriented answers |
| `verify` | Brave + Tavily | Important claims that should be cross-checked |

Fallback is reliability-focused:

- If Brave fails, `quick` falls back to Tavily.
- If Tavily fails, `deep` falls back to Brave.
- If one provider fails during `verify`, the result includes the working provider and a fallback note.
- If neither provider is configured, the tool returns an actionable error and does not crash the MCP server.
- If a provider fallback happens, the result includes `fallbacks` and a short `notice`.
- If both Brave and Tavily fail, agents should use native runtime search only as fallback and explicitly tell the user that Brave/Tavily Search MCP failed.

## Source Metadata

Search results include source metadata:

- `rank`
- `domain`
- `provider`
- `accessedAt`
- `sourceLog`

Extracted pages include:

- `domain`
- `provider`
- `status`
- `extractedAt`
- `contentHash`
- `sourceLog`

Use `sourceLog` when writing source packs, audit notes, or structured research artifacts.

## Environment

Set either or both keys:

```bash
export BRAVE_API_KEY="..."
export TAVILY_API_KEY="..."
```

`BRAVE_SEARCH_API_KEY` is also accepted as an alias for `BRAVE_API_KEY`.

## Register With Codex

Build first:

```bash
cd /Users/cloveric/projects/cc-telegram-bridge
npm run build
```

Then register the stdio MCP server:

```bash
codex mcp add web-search \
  --env BRAVE_API_KEY="$BRAVE_API_KEY" \
  --env TAVILY_API_KEY="$TAVILY_API_KEY" \
  -- node /Users/cloveric/projects/cc-telegram-bridge/dist/src/index.js search-mcp
```

Check:

```bash
codex mcp list
```

## Register With Claude Code

```bash
claude mcp add web-search \
  -e BRAVE_API_KEY="$BRAVE_API_KEY" \
  -e TAVILY_API_KEY="$TAVILY_API_KEY" \
  -- node /Users/cloveric/projects/cc-telegram-bridge/dist/src/index.js search-mcp
```

Check:

```bash
claude mcp list
```

## Telegram Bot Runtime

After registering MCP servers, restart the affected bot instances so new Codex/Claude turns inherit the tool configuration.

Codex-backed instances use the Codex MCP registration. Claude-backed instances use the Claude Code MCP registration.

For Codex process instances that will use MCP tools heavily from Telegram, prefer YOLO/full-auto/bypass approval mode. Plain non-interactive `codex exec` in read-only approval mode may cancel MCP tool calls before they run; the bridge's normal Telegram approval flow pre-approves the turn and then runs Codex with full-auto for that turn.

## Agent Guidance

Recommended usage policy:

- Do not search for purely local repo/log/debug questions.
- Use `web_search` with `mode: "quick"` for latest facts, docs, pricing, and broad discovery.
- Use `web_search` with `mode: "deep"` for research answers that need page content.
- Use `web_search` with `mode: "verify"` for important or uncertain claims.
- Use `web_extract` after search when a specific URL should be read cleanly.
- Use `provider_status` when diagnosing whether Brave/Tavily is configured before a research task.
- `web_extract` accepts `maxChars` to bound returned source text; default is 20,000 characters and small budgets are valid.
- Prefer `sourceLog`, `domain`, `provider`, and `contentHash` fields when writing structured research outputs.
- If a `web_search` result includes `notice` or non-empty `fallbacks`, mention the fallback briefly in the answer.
- If `web_search` errors due to timeout, quota, rate limit, or provider outage and native search is used instead, disclose that native-search fallback clearly.
- Prefer cited answers when search tools are used.
