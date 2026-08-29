# DeepSeek Harness Search Plugin Publication Design

## Goal

Publish TaroCub's Brave/Tavily search integration as a first-class native
DeepSeek Harness plugin while preserving the current TaroCub-managed DeepSeek
bot behavior.

The finished system has two public GitHub projects:

1. `cloveric/tarocub`, the Feishu/Lark-first agent gateway.
2. `cloveric/tarocub-deepseek-harness-plugin`, the standalone DeepSeek Harness
   plugin and Search MCP distribution.

Both repositories must be discoverable through the GitHub `dsh-plugin` topic.
The plugin repository must have professional English and Simplified Chinese
documentation and install directly through the native `dsh plugin` command.

## Product Boundary

The DeepSeek Harness plugin is specific to Harness. It must not replace the
native MCP configuration mechanisms used by Codex or Claude, and it must not
replace TaroCub's ACP injection for Kimi.

The Search MCP implementation remains protocol-compatible with TaroCub's
existing engine-neutral server, but this publication packages it for Harness:

- plain Harness users install one plugin and receive the search tools;
- TaroCub-managed DeepSeek bots use the plugin when it is installed;
- TaroCub-managed DeepSeek bots retain the current private-patch fallback when
  the plugin is absent or is an older companion-only version;
- native Harness web search, profiles, plugins, and unrelated MCP servers remain
  enabled.

Installing the plugin does not create a Feishu/Lark app, start TaroCub, or prove
that a TaroCub service is running.

## Repository And Publication Model

`deepseek-harness-plugin/` in the TaroCub repository is the canonical source.
The standalone repository is published from that directory with `git subtree`
so there is one maintained implementation rather than two hand-copied forks.

The standalone repository name is:

```text
cloveric/tarocub-deepseek-harness-plugin
```

The initial publication versions are:

- TaroCub: `v0.1.279`
- DeepSeek Harness plugin: `v0.2.0`

The plugin version moves from the old bridge-coupled version number to its own
semantic version because adding a standalone Search MCP is a material feature.

The initial public distribution is GitHub plus GitHub Releases. npm publication
is explicitly out of scope until it is separately requested and the package
ownership/name are confirmed.

The recommended installation command is:

```bash
dsh plugin --profile web add github:cloveric/tarocub-deepseek-harness-plugin
```

The existing installation source remains valid for compatibility:

```bash
dsh plugin --profile web add "github:cloveric/tarocub#path:deepseek-harness-plugin"
```

Both sources contain the same canonical plugin files at release time. New
documentation uses the standalone repository.

## Plugin Package

The package keeps the name `tarocub-deepseek-harness-plugin` so existing profile
state and update/remove commands remain understandable.

The package contains:

- a native `dsh.bundle` Cordis patch;
- the TaroCub Harness plugin and `/tarocub` operator command;
- a bundled stdio Search MCP entrypoint with no runtime install/build step;
- committed JavaScript artifacts required by GitHub installation;
- TypeScript source, tests, license, security policy, and bilingual docs;
- a machine-readable capability marker indicating that this version owns the
  Harness Search MCP registration.

The package manifest marker is:

```json
{
  "tarocub": {
    "searchMcp": true,
    "searchMcpProtocol": 1
  }
}
```

TaroCub uses this marker together with the installed package path to distinguish
the new plugin from pre-`v0.2.0` companion-only installations.

## Harness Configuration

The plugin's Cordis patch inserts two stable components:

1. `tarocub`, which loads the bounded system-prompt section and `/tarocub`.
2. `mcp-cctb-search`, which loads `@deepseek-ai/dsh-mcp-client` with server name
   `cctb_search` over stdio.

The MCP subprocess uses the running Node executable and the committed bundled
entrypoint under the installed `web` profile. No shell interpolation is used.
The supported baseline is the profile named `web`, matching the documented
Harness Web installation and TaroCub private Host configuration.

The MCP component is disabled only when
`TAROCUB_SEARCH_MCP_OWNER=bridge`. This flag is reserved for a
TaroCub-managed private Host that has selected its built-in compatibility
client; it is unset in ordinary Harness use.

The MCP client is non-fatal at startup. Missing provider keys leave
`provider_status` available and make provider-dependent tools return actionable
configuration errors rather than preventing Harness from starting.

## Search MCP Contract

The plugin exposes these tools through Harness as
`mcp__cctb_search__<tool-name>`:

- `web_search`: Brave/Tavily live search with `quick`, `deep`, and `verify`
  modes.
- `web_extract`: Tavily URL extraction with bounded output.
- `provider_status`: configuration status without provider requests or key
  disclosure.
- `health_check`: explicit live provider probes for auth, quota, rate-limit,
  timeout, and transport diagnosis.

The response contract preserves:

- `sourceLog`, `provider`, `domain`, `rank`, and access timestamps;
- `contentHash` and extraction timestamps for extracted content;
- `fallbacks` and `notice` when a provider fails and another path is used;
- an explicit native-search fallback hint when the MCP providers fail.

Exact user-supplied URLs remain extraction-first. Search is for discovery,
current context, or fallback after direct access fails.

## Credential And Security Boundary

Direct provider credentials are accepted from process environment:

- `BRAVE_API_KEY`
- `BRAVE_SEARCH_API_KEY`
- `TAVILY_API_KEY`

For compatibility with existing TaroCub installations, the server may resolve
the same named keys from an existing local Codex MCP environment section when
direct environment values are absent. Direct process values always win. No
other files or credential names are inspected.

The plugin must never:

- write provider keys into Harness profile files or Cordis patches;
- print keys in logs, diagnostics, status, or tool output;
- copy credentials into a workspace;
- perform live provider probes unless `health_check` is explicitly called;
- treat a successful package install as proof that provider credentials work.

The repository release gate includes secret scanning of both the worktree and
history.

## TaroCub Integration And Duplicate Prevention

TaroCub currently appends a private `mcp-cctb-search` client to every managed
DeepSeek Host. That behavior becomes conditional.

Before writing the private Cordis patch, TaroCub checks the installed `web`
profile package:

1. the package `tarocub-deepseek-harness-plugin` exists;
2. its manifest contains `tarocub.searchMcp: true`;
3. its declared Search MCP entrypoint exists inside the package;
4. its package-local `dsh.bundle.patch` exists and registers the declared
   entrypoint as `mcp-cctb-search` through `@deepseek-ai/dsh-mcp-client`.

When all checks pass, TaroCub starts the Host with
`TAROCUB_SEARCH_MCP_OWNER=plugin`; the plugin client is enabled and TaroCub does
not append a second client. Otherwise TaroCub starts the Host with
`TAROCUB_SEARCH_MCP_OWNER=bridge`, retains its current private client injection,
and the plugin Cordis patch disables its own MCP client through that ownership
flag. Plain Harness sessions do not set the flag, so the plugin client is
enabled by default.

This decision is local and read-only. TaroCub must not silently install,
upgrade, or download a plugin during bot startup. A malformed plugin that
claims the capability but lacks its entrypoint or registration patch produces a diagnostic, selects
`bridge` ownership, and uses the built-in fallback rather than silently
removing search or registering two clients.

The generated private patch continues to contain environment expressions only,
never literal provider secrets.

## Documentation And Homepage

The standalone repository contains:

- `README.md`: polished English landing page;
- `README.zh-CN.md`: complete Simplified Chinese counterpart;
- `SECURITY.md`: credential handling, supported versions, reporting process;
- `CONTRIBUTING.md`: local build, test, and release workflow;
- `LICENSE`: MIT license;
- a compact architecture diagram and tool matrix;
- install, update, remove, configuration, troubleshooting, and migration
  instructions;
- clear boundaries among plugin installation, provider configuration, TaroCub
  setup, and successful runtime verification.

The TaroCub README and reference docs must:

- recommend the standalone plugin repository;
- retain the old GitHub subdirectory command as a compatibility path;
- state accurately that managed DeepSeek bots already receive Search MCP and
  use the plugin registration when available;
- remove the stale claim that DeepSeek only uses a manually configured native
  profile MCP;
- keep long-media Tingwu routing and group/topic session boundaries described
  as channel-layer behavior before engine dispatch.

Both repositories receive relevant GitHub metadata, including at least:

- `dsh-plugin`
- `deepseek-harness`
- `deepseek`
- `mcp`
- `web-search`

The repositories must expose concise descriptions and GitHub Releases. Topic
API state is authoritative immediately; GitHub's topic index page is checked
after publication and any indexing delay is reported rather than hidden.

## CI And Release Automation

The canonical plugin directory includes a standalone GitHub Actions workflow.
It is inert while nested in TaroCub and becomes active when subtree-published at
the standalone repository root.

CI verifies:

- dependency installation with a lockfile;
- type checking and production bundle generation;
- unit and protocol tests;
- committed build artifacts match source;
- package contents contain all files needed by Git installation;
- no provider key literals or generated local configuration are committed.

A documented publication script performs a subtree split and pushes the
resulting commit to the standalone repository without rewriting TaroCub's main
branch. It refuses to publish from a dirty worktree or when plugin tests/build
artifacts are stale.

## Testing Strategy

Implementation follows test-driven development. Required regression coverage:

1. The standalone package manifest declares a valid Harness bundle and Search
   MCP capability marker.
2. The Cordis patch registers exactly one `cctb_search` MCP client.
3. A fresh GitHub installation into a temporary `DSH_HOME` resolves only the
   intended package and requires no build approval.
4. `dsh --profile web --dump-config` contains the plugin and MCP client with no
   literal provider secrets.
5. MCP initialization and `tools/list` expose all four tools.
6. `provider_status` works without network access or configured keys.
7. Search/extract routing, source metadata, fallback notices, hashes, timeout,
   quota, auth, and malformed-input behavior retain existing coverage.
8. TaroCub selects plugin ownership and skips its private Search MCP injection
   for a valid `v0.2.0` plugin.
9. TaroCub keeps private injection for no plugin and for the old companion-only
   plugin.
10. A corrupt capability claim selects bridge ownership, disables the plugin
    client, produces a diagnostic, and preserves a working fallback.
11. The old main-repository installation source remains installable.
12. The new standalone source installs, updates, removes, starts Harness, and
    shuts down cleanly.

The release gate runs the plugin suite, DeepSeek Host/adapter/protocol suites,
Lark intake/group/media suites, the full TaroCub suite, both builds, dependency
audits, package inspection, and secret scans.

## Deployment

After the TaroCub release, restart and verify the Lark fleet through the TaroCub
service manager. Telegram remains stopped unless explicitly requested.

For the local `web` Harness profile, migrate from the old source to the new
standalone source only after the release and fresh-install smoke test pass. Then
verify the effective configuration and run a provider-status/search smoke test
without printing credentials.

## Non-Goals

This release does not:

- publish to npm;
- configure or purchase Brave/Tavily credentials;
- remove native DeepSeek web search;
- alter Codex, Claude, or Kimi MCP registration mechanisms;
- silently install plugins for TaroCub users;
- claim GitHub topic-page indexing before it is observed;
- redesign TaroCub's Lark channel, long-media ASR, or group/topic semantics.

## Acceptance Criteria

The work is complete only when:

- both repositories are public and have verified releases at the intended
  commits;
- both repositories carry the `dsh-plugin` topic and are observed on the topic
  page, or a clearly identified GitHub indexing delay remains;
- the standalone plugin installs from a clean temporary Harness home;
- Harness lists the plugin's Search MCP tools;
- TaroCub-managed DeepSeek bots have exactly one Search MCP registration;
- provider keys are absent from repositories, generated patches, logs, and
  user-facing status;
- English and Chinese repository homepages render correctly and describe the
  same product boundary;
- all focused and full tests, builds, audits, and secret scans pass;
- TaroCub `v0.1.279` and plugin `v0.2.0` are committed and released;
- all Lark instances are healthy on the new TaroCub build while Telegram stays
  stopped.
