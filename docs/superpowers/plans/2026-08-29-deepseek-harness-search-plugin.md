# DeepSeek Harness Search Plugin Implementation Plan

> **For Codex:** Execute this plan task by task with red-green-refactor discipline. Do not publish until every local and fresh-install gate passes.

**Goal:** Publish TaroCub's Search MCP as a native, standalone DeepSeek Harness plugin while preserving TaroCub's existing fallback and preventing duplicate MCP clients.

**Architecture:** `deepseek-harness-plugin/` remains the canonical source inside TaroCub and is subtree-published to `cloveric/tarocub-deepseek-harness-plugin`. The plugin registers its own stdio Search MCP for plain Harness. TaroCub detects a valid installed plugin marker and selects either plugin ownership or its existing private-patch fallback before starting a managed DeepSeek Host.

**Tech Stack:** TypeScript, Node.js ESM, Cordis/DeepSeek Harness bundle patches, MCP stdio, Vitest, esbuild, GitHub Actions, Git subtree, GitHub CLI.

---

## Task 1: Lock the standalone package contract

**Files:**
- Modify: `tests/deepseek-harness-plugin.test.ts`
- Modify: `deepseek-harness-plugin/package.json`
- Modify: `deepseek-harness-plugin/cordis.patch.yml`

1. Add failing tests that require plugin version `0.2.0`, the `tarocub.searchMcp` capability marker, a declared Search MCP entrypoint, and one conditional `mcp-cctb-search` Cordis component.
2. Run `npm test -- --run tests/deepseek-harness-plugin.test.ts` and confirm the new assertions fail for the old companion-only package.
3. Add the manifest marker and package file declarations. Add the Cordis MCP component, disabled only when `TAROCUB_SEARCH_MCP_OWNER=bridge`.
4. Re-run the focused test and confirm it passes without weakening the existing `/tarocub` behavior tests.

## Task 2: Make the plugin own the canonical Search MCP source

**Files:**
- Move: `src/search/search-mcp-server.ts` to `deepseek-harness-plugin/src/search-mcp-server.ts`
- Move: `src/search/search-providers.ts` to `deepseek-harness-plugin/src/search-providers.ts`
- Move: `src/search/search-router.ts` to `deepseek-harness-plugin/src/search-router.ts`
- Modify: `src/index.ts`
- Modify: `src/service.ts`
- Modify: `src/codex/kimi-acp-adapter.ts`
- Modify: `tests/search-mcp-server.test.ts`
- Modify: `tests/search-providers.test.ts`
- Modify: `tests/search-router.test.ts`
- Add: `deepseek-harness-plugin/tsconfig.json`
- Add: `deepseek-harness-plugin/vitest.config.ts`
- Add: `deepseek-harness-plugin/package-lock.json`
- Add: `deepseek-harness-plugin/dist/search-mcp.js`

1. Update imports and focused tests first so they point at the future canonical plugin source; run the three search test files and confirm resolution fails.
2. Move the source with `apply_patch`, preserving behavior and protocol contracts.
3. Add standalone build scripts that type-check and bundle the MCP server into a committed, dependency-free `dist/search-mcp.js` using esbuild.
4. Add a `check:dist` gate that rebuilds and fails when committed output differs.
5. Run focused search tests, plugin tests, standalone typecheck/build, and root build.

## Task 3: Add deterministic MCP ownership selection

**Files:**
- Modify: `tests/deepseek-harness-host.test.ts`
- Modify: `src/codex/deepseek-harness-host.ts`
- Modify: `src/service.ts`

1. Add failing tests for four installed states: no plugin, pre-marker plugin, valid marker plus entrypoint, and marker with missing entrypoint.
2. Require the valid case to omit TaroCub's private Search MCP patch and set `TAROCUB_SEARCH_MCP_OWNER=plugin`.
3. Require all invalid/legacy cases to retain the private patch and set `TAROCUB_SEARCH_MCP_OWNER=bridge`; malformed claims must emit an actionable diagnostic.
4. Implement a read-only detector against the actual `web` profile package and resolved declared entrypoint. Do not install or mutate plugin state.
5. Thread the selected owner into the child environment and patch generation, then run the focused Host/service tests.

## Task 4: Build professional bilingual distribution docs

**Files:**
- Add: `deepseek-harness-plugin/README.md`
- Add: `deepseek-harness-plugin/README.zh-CN.md`
- Add: `deepseek-harness-plugin/SECURITY.md`
- Add: `deepseek-harness-plugin/CONTRIBUTING.md`
- Add: `deepseek-harness-plugin/LICENSE`
- Add: `deepseek-harness-plugin/.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/search-mcp.md`
- Modify: `docs/full-reference.md`
- Modify: `docs/deepseek-harness-engine.md`

1. Add documentation assertions to the plugin package test for both languages, install/update/remove commands, credential names, verification commands, architecture, security boundaries, and the migration path.
2. Write the English landing page and full Chinese counterpart with matching sections and a clear distinction between installation, provider configuration, runtime verification, and TaroCub integration.
3. Add security, contribution, license, and standalone CI files.
4. Correct stale TaroCub documentation so DeepSeek ownership behavior matches implementation and the standalone repository is recommended.
5. Retain the legacy subdirectory install command as compatibility documentation.

## Task 5: Add reproducible subtree publication tooling

**Files:**
- Add: `scripts/publish-deepseek-harness-plugin.sh`
- Modify: `package.json`
- Modify: `deepseek-harness-plugin/CONTRIBUTING.md`

1. Add a testable shell script that refuses a dirty worktree, runs the plugin verification gate, creates a subtree split, and pushes only when an explicit remote is supplied.
2. Add a root npm script for plugin verification and document dry-run and publication usage.
3. Run shell syntax validation and a local subtree split without publishing.

## Task 6: Validate a clean DeepSeek Harness installation

**Files:**
- No repository edits unless a test exposes a defect.

1. Pack/copy the standalone subtree into a fresh temporary Git repository.
2. Install it into an isolated `DSH_HOME` web profile with `dsh plugin --profile web add`.
3. Verify `dsh --profile web --dump-config` contains exactly one `mcp-cctb-search` client and retains the TaroCub prompt plugin.
4. Start the MCP entrypoint and validate `initialize`, `tools/list`, and `provider_status` over stdio without exposing credentials.
5. Validate the legacy `github:cloveric/tarocub#path:deepseek-harness-plugin` package shape locally.

## Task 7: Run release gates and create versioned commits

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

1. Set TaroCub to `0.1.279`; keep the standalone plugin at `0.2.0`.
2. Run focused tests, standalone CI-equivalent checks, full root tests, root build, npm audit, and secret/history scans.
3. Inspect `git diff`, package contents, generated bundle, and repository status for unrelated or secret-bearing changes.
4. Commit the implementation as one reviewed release commit after the existing approved design commit.

## Task 8: Publish both public repositories and releases

**Files:**
- Remote GitHub state only.

1. Push TaroCub `main` and create release `v0.1.279` with concise bilingual-facing release notes.
2. Create public repository `cloveric/tarocub-deepseek-harness-plugin` if absent, set description/homepage, and subtree-push canonical plugin source.
3. Tag and publish plugin release `v0.2.0`; do not publish to npm.
4. Set both repositories' topics to include `dsh-plugin`, `deepseek-harness`, `deepseek`, `mcp`, and `web-search` while respecting GitHub's topic count limit.
5. Re-open both Releases and repository metadata through GitHub to verify publication rather than relying on command exit status.

## Task 9: Migrate the local profile and deploy safely

**Files:**
- Local DeepSeek Harness profile and TaroCub service state only.

1. Replace the local web profile's legacy subdirectory plugin source with the standalone repository only after fresh-install verification passes.
2. Verify the installed package marker, entrypoint, dump-config ownership, and one-client invariant.
3. Restart and verify all Lark/Feishu TaroCub instances on `v0.1.279` using the service operations runbook.
4. Confirm Telegram instances remain stopped.
5. Check `https://github.com/topics/dsh-plugin`; if GitHub topic indexing lags despite correct API metadata, report the delay explicitly.

## Task 10: Final evidence review

1. Confirm both repository URLs, release URLs, exact commits/tags, local plugin source, and live Lark process versions.
2. Report test counts, fresh-install checks, ownership behavior, topic state, and any indexing delay or residual limitation.
3. Do not claim npm publication, provider credential health, or topic-page indexing unless separately verified.
