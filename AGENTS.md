# Agent Entry

Before modifying this repository, read [docs/entrypoint-map.md](docs/entrypoint-map.md).

That file is the source of truth for:
- Telegram entry flow
- bus flow
- state/config ownership
- shared usage/budget/audit logic
- required regression tests by change area

If you change behavior rather than comments/docs, prefer focused tests first, then `npm run build`.
