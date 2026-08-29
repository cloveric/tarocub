# Security Policy

## Supported Versions

Security fixes are applied to the latest published release. Upgrade before reporting behavior that is already fixed in a newer release.

## Credential Boundary

The Search MCP accepts `BRAVE_API_KEY`, `BRAVE_SEARCH_API_KEY`, and `TAVILY_API_KEY` from its process environment. Direct environment values take precedence. When they are absent, the compatibility fallback may read only the same named values from local Codex MCP environment sections.

The plugin must never log an API key, include it in tool output, write it into a Harness profile, copy it into a workspace, or commit it to this repository. `provider_status` reports booleans only. Every MCP text response redacts configured provider credentials and common authorization formats; provider error text is also bounded before delivery.

`web_extract` accepts only HTTP(S) URLs. Search results using non-web URL schemes are discarded before they can become agent citations.

Treat Harness profiles, process environments, and Codex configuration as local trust boundaries. Installing this plugin grants its JavaScript the same local permissions as the Harness process.

## Reporting A Vulnerability

Use GitHub's private security-advisory flow for `cloveric/deepseek-harness-web-search-plugin`. Do not open a public issue containing API keys, private paths, chat identifiers, logs with credentials, or exploit details.

Include the plugin version, DeepSeek Harness version, operating system, minimal reproduction, expected behavior, and redacted observed behavior. Do not test against third-party accounts or provider credentials you do not own.
