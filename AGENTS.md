# Agent Entry

Before modifying this repository, read [docs/entrypoint-map.md](docs/entrypoint-map.md).

That file is the source of truth for:
- Telegram entry flow
- bus flow
- state/config ownership
- shared usage/budget/audit logic
- required regression tests by change area

If you change behavior rather than comments/docs, prefer focused tests first, then `npm run build`.

Release rule: in this repo, "commit and release" means commit the intended changes, create/update the GitHub Release, then restart and verify the Telegram and Lark fleet. Do not include external package-registry publishing in the release flow. For Lark fleet restarts, use `node dist/src/index.js lark service restart --all`.

Stable Telegram transport rules are bridge-owned and injected at runtime from `src/telegram/agent-instructions.ts`; see [docs/telegram-instance-agent.md](docs/telegram-instance-agent.md). Instance-level `~/.cctb/<instance>/agent.md` is user-owned and should contain only persona/preferences. Do not put bridge transport rules or turn-scoped paths into instance `agent.md` or resumed project `AGENTS.md` / `CLAUDE.md`.
