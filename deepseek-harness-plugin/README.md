# TaroCub Search MCP for DeepSeek Harness

[![CI](https://github.com/cloveric/tarocub-deepseek-harness-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/cloveric/tarocub-deepseek-harness-plugin/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/cloveric/tarocub-deepseek-harness-plugin)](https://github.com/cloveric/tarocub-deepseek-harness-plugin/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f766e.svg)](./LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-native%20plugin-f97316.svg)](https://github.com/topics/dsh-plugin)

**Source-traceable Brave and Tavily web research, packaged as a native DeepSeek Harness plugin.**

[简体中文](./README.zh-CN.md) · [TaroCub](https://github.com/cloveric/tarocub) · [Security](./SECURITY.md) · [Releases](https://github.com/cloveric/tarocub-deepseek-harness-plugin/releases)

This plugin installs one native Harness bundle into the `web` profile. It adds:

- `web_search` for routed Brave/Tavily live search;
- `web_extract` for clean Tavily URL extraction;
- `provider_status` for local, secret-safe configuration checks;
- `health_check` for explicit live auth/quota/rate-limit/timeout probes;
- `/tarocub` for accurate companion setup and verification guidance.

It works in plain DeepSeek Harness. TaroCub is optional.

## Why This Plugin

Native model search is useful, but research workflows also need a stable tool contract and an inspectable source trail. This plugin returns provider, domain, rank, access time, source logs, extraction hashes, and visible fallback notices instead of hiding provider routing.

| Tool | Provider behavior | Best for |
|---|---|---|
| `web_search` `quick` | Brave, then Tavily fallback | Current docs, URLs, prices, news, broad discovery |
| `web_search` `deep` | Tavily, then Brave fallback | Research and extraction-oriented answers |
| `web_search` `verify` | Brave + Tavily in parallel | Important claims that need cross-checking |
| `web_extract` | Tavily Extract | Reading exact URLs supplied by the user |
| `provider_status` | No provider request | Checking whether keys are available |
| `health_check` | Explicit live provider request | Diagnosing auth, quota, rate limits, or timeouts |

When one provider fails, results include `fallbacks` and `notice`. Extracted content includes `contentHash`. If a user gives an exact URL, read or extract that URL first; use search for discovery or background context.

## Architecture

```text
DeepSeek Harness web profile
└── tarocub-deepseek-harness-plugin
    ├── tarocub                 bounded guidance + /tarocub
    └── mcp-cctb-search         @deepseek-ai/dsh-mcp-client
        └── node dist/search-mcp.js
            ├── Brave Search API
            └── Tavily Search + Extract APIs
```

The committed MCP bundle is self-contained. A Git installation does not need a build step and does not add runtime npm dependencies.

## Install

Prerequisites:

- DeepSeek Harness `dsh` with the `web` profile;
- Node.js 20 or newer;
- at least one Brave or Tavily key for provider-backed tools.

```bash
dsh plugin --profile web add github:cloveric/tarocub-deepseek-harness-plugin
```

Restart Harness after installation. Installing the plugin does not configure provider credentials, create a Feishu/Lark app, or start TaroCub.

## Configure Providers

Set one or both credentials in the environment that starts Harness:

```bash
export BRAVE_API_KEY="..."
export TAVILY_API_KEY="..."
dsh web
```

`BRAVE_SEARCH_API_KEY` is accepted as an alias for `BRAVE_API_KEY`. Direct process environment values win. For compatibility with an existing local TaroCub/Codex setup, the MCP may read only these same named values from a Codex MCP environment section when direct values are absent.

The plugin never writes keys into a Harness profile, copies them into a workspace, or returns them from `provider_status`. It performs no provider request until a provider-backed tool or the explicit `health_check` tool is called.

## Verify

Confirm that the bundle contributes exactly one Search MCP client:

```bash
dsh --profile web --dump-config | grep -A18 -B2 mcp-cctb-search
```

In a Harness session, ask it to call `mcp__cctb_search__provider_status`. This verifies configuration visibility without consuming provider quota. Use `mcp__cctb_search__health_check` only when you want a real provider probe.

Expected tools:

```text
mcp__cctb_search__web_search
mcp__cctb_search__web_extract
mcp__cctb_search__provider_status
mcp__cctb_search__health_check
```

## Update Or Remove

```bash
dsh plugin --profile web update tarocub-deepseek-harness-plugin
dsh plugin --profile web remove tarocub-deepseek-harness-plugin
```

Restart Harness after either operation and re-run `dsh --profile web --dump-config`.

## TaroCub Integration

[TaroCub](https://github.com/cloveric/tarocub) is a separate Feishu/Lark-first local agent gateway. Its managed DeepSeek Hosts link the same `web` profile.

- With plugin `v0.2.0+`, TaroCub validates the package capability marker and bundled entrypoint, then lets the plugin own `mcp-cctb-search`.
- With no plugin, an older companion-only plugin, or a damaged entrypoint, TaroCub retains its private Search MCP fallback.
- TaroCub sets `TAROCUB_SEARCH_MCP_OWNER=plugin` or `bridge` for its private Host so exactly one client is active.
- Plain Harness does not set this internal ownership flag, so the plugin is enabled by default.

Do not set `TAROCUB_SEARCH_MCP_OWNER` manually in normal Harness use. Plugin installation and TaroCub service deployment are separate operations.

### Migration From The TaroCub Subdirectory

The original source remains compatible:

```bash
dsh plugin --profile web add "github:cloveric/tarocub#path:deepseek-harness-plugin"
```

New installations should use the standalone repository. To migrate, remove the package, add the standalone source, restart Harness, and verify the one-client invariant:

```bash
dsh plugin --profile web remove tarocub-deepseek-harness-plugin
dsh plugin --profile web add github:cloveric/tarocub-deepseek-harness-plugin
dsh --profile web --dump-config | grep -c "id: mcp-cctb-search"
```

The final count must be `1`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Tools are absent | Restart Harness, inspect `--dump-config`, and confirm the plugin is installed in the `web` profile. |
| `provider_status` says not configured | Export a supported key in the environment that launches `dsh`, not only in an unrelated shell. |
| Search returns auth/quota/rate-limit errors | Call `health_check` explicitly and inspect its redacted status. |
| Two `mcp-cctb-search` entries appear | Remove manual duplicate profile patches; a normal plugin or TaroCub-managed Host registers only one owner. |
| TaroCub reports a damaged plugin entrypoint | Update/reinstall the plugin; TaroCub safely uses its bridge fallback meanwhile. |
| A provider fallback was used | Preserve the returned `notice` in the user-facing answer. |

## Scope And Security

This project is an MCP and DeepSeek Harness plugin. It does not proxy model traffic, manage a Feishu/Lark tenant, persist provider credentials, or replace Harness-native plugins/search. See [SECURITY.md](./SECURITY.md) for the credential boundary and reporting process.

## Development

```bash
npm ci
npm run verify
```

Canonical development happens in `deepseek-harness-plugin/` inside [TaroCub](https://github.com/cloveric/tarocub), then is published to this repository with `git subtree`. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
