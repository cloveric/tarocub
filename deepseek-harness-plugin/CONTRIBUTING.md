# Contributing

The canonical source lives under `deepseek-harness-plugin/` in [`cloveric/tarocub`](https://github.com/cloveric/tarocub). The standalone repository is a read-only publication target produced with `git subtree`; submit code changes to TaroCub unless a maintainer explicitly requests otherwise.

## Local Verification

```bash
npm ci
npm run verify
```

`npm run verify` performs strict TypeScript checks, unit/protocol tests, a deterministic committed-bundle comparison, and an npm package-content dry run. Provider-backed tests must use mocks. Do not add live API calls to CI.

If Search MCP source changes, regenerate the committed runtime artifact:

```bash
npm run build
npm run check:dist
```

## Pull Requests

- Add a failing regression test before changing behavior.
- Keep the MCP result contract backward-compatible unless a protocol version is intentionally raised.
- Never place credentials, local Harness homes, chat IDs, cookies, or generated user configuration in fixtures.
- Keep `README.md` and `README.zh-CN.md` behaviorally aligned.
- Verify a clean `dsh plugin --profile web add` installation before release.

## Publication

TaroCub maintainers publish from a clean, verified main branch using the repository script, which creates a `git subtree split` from `deepseek-harness-plugin/` and pushes it to the standalone remote. The plugin and TaroCub have independent semantic versions and GitHub Releases. npm publication is not part of the current release process.
