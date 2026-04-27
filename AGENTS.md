# Agent Entry

Before modifying this repository, read [docs/entrypoint-map.md](docs/entrypoint-map.md).

That file is the source of truth for:
- Telegram entry flow
- bus flow
- state/config ownership
- shared usage/budget/audit logic
- required regression tests by change area

If you change behavior rather than comments/docs, prefer focused tests first, then `npm run build`.

Static Telegram transport rules live in instance-level `~/.cctb/<instance>/agent.md`; see [docs/telegram-instance-agent.md](docs/telegram-instance-agent.md). When changing those rules or file-delivery behavior, update that doc and sync affected instance `agent.md` files. Do not put Telegram transport rules or turn-scoped paths into resumed project `AGENTS.md` / `CLAUDE.md`.
