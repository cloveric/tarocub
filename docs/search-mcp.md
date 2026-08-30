# Brave/Tavily Search MCP

TaroCub includes a local stdio MCP server for live web search:

```bash
node ./dist/src/index.js search-mcp
```

It exposes four tools:

- `web_search` - routed live search through Brave and/or Tavily.
- `web_extract` - Tavily-powered clean URL extraction.
- `provider_status` - local configuration status for Brave/Tavily without exposing API keys.
- `health_check` - optional live provider probes for auth, quota, rate limit, and timeout diagnostics.

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
cd /path/to/tarocub
npm run build
```

Then register the stdio MCP server:

```bash
codex mcp add web-search \
  --env BRAVE_API_KEY="$BRAVE_API_KEY" \
  --env TAVILY_API_KEY="$TAVILY_API_KEY" \
  -- node "$PWD/dist/src/index.js" search-mcp
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
  -- node "$PWD/dist/src/index.js" search-mcp
```

Check:

```bash
claude mcp list
```

## Kimi Code Runtime

Kimi instances need no manual registration for TaroCub search. The bridge
passes this stdio Search MCP in ACP `session/new` and `session/load`, while Kimi
continues to load its own user/project MCP files and plugins normally. Provider
keys are never copied into Kimi config. Explicit `BRAVE_API_KEY` /
`TAVILY_API_KEY` process values take precedence; when they are absent, the MCP
server can reuse those same keys from an existing local Codex
`[mcp_servers.<name>.env]` configuration without logging them.

The current compatibility baseline is Kimi Code 0.39.1. Both ACP session paths
were live-verified to start the stdio server. TaroCub does not silently retry
without stdio MCPs: an initialization failure is surfaced so missing search
capability cannot be mistaken for a healthy session.

## Bot Runtime

After registering native MCP servers, restart affected bot instances so new Codex/Claude/Antigravity turns inherit the tool configuration. Kimi receives TaroCub Search MCP automatically when its next ACP worker starts; no Kimi-side registration is required.

Codex-backed instances use Codex MCP registration. Claude-backed instances use Claude Code MCP registration. Kimi-backed instances receive TaroCub Search MCP through ACP and retain native Kimi MCP/plugins. DeepSeek should install `github:cloveric/deepseek-harness-web-search-plugin` in its `web` profile. Managed DeepSeek Hosts validate that plugin's capability marker, package-local entrypoint, and Harness patch registration: a valid plugin owns the client; an absent, capability-incomplete, or damaged plugin selects TaroCub's private bridge fallback. The former `tarocub-deepseek-harness-plugin` package name is still recognized when it carries a valid Search MCP capability. `TAROCUB_SEARCH_MCP_OWNER` disables one side so exactly one client is active. Plain Harness has no bridge fallback and therefore needs the plugin or an equivalent native profile configuration. Antigravity-backed instances use the MCP/plugin configuration loaded natively by `agy`; TaroCub's structured headless transport does not replace it.

Keep the native plugin systems separate. Do not import Claude or Codex native plugins into Antigravity as part of the default bridge setup. Shared bridge skills should live as reusable skill files/docs or engine-neutral MCP/tool guidance. Instance `agent.md` files may reference or absorb those skills, but the `agent.md` files themselves remain per-instance, not shared state.

For Codex process instances that will use MCP tools heavily from Telegram, prefer YOLO/full-auto/bypass approval mode. Plain non-interactive `codex exec` in read-only approval mode may cancel MCP tool calls before they run; the bridge's normal Telegram approval flow pre-approves the turn and then runs Codex with full-auto for that turn.

## Agent Guidance

Recommended usage policy:

- Do not search for purely local repo/log/debug questions.
- Only pass `http://` or `https://` URLs to `web_extract`; non-web schemes are rejected before a provider call.
- Use `web_search` with `mode: "quick"` for latest facts, docs, pricing, and broad discovery.
- Use `web_search` with `mode: "deep"` for research answers that need page content.
- Use `web_search` with `mode: "verify"` for important or uncertain claims.
- If the user provides exact URL(s), use `web_extract` or a direct browser read first; use `web_search` only to discover URLs, add background context, or recover from direct-read failure.
- Use `provider_status` when diagnosing whether Brave/Tavily is configured before a research task.
- Use `health_check` only when explicitly diagnosing provider health; it performs live API requests, may consume quota, and accepts an optional `query` probe term.
- `web_extract` accepts `maxChars` to bound returned source text; default is 20,000 characters and small budgets are valid.
- Prefer `sourceLog`, `domain`, `provider`, and `contentHash` fields when writing structured research outputs.
- If a `web_search` result includes `notice` or non-empty `fallbacks`, mention the fallback briefly in the answer.
- If `web_search` errors due to timeout, quota, rate limit, or provider outage and native search is used instead, disclose that native-search fallback clearly.
- Prefer cited answers when search tools are used.
