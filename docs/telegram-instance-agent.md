# Telegram Instance Agent Instructions

These static transport rules belong in each instance-level `agent.md`, not in resumed project `AGENTS.md` or `CLAUDE.md`.

New instances get this file automatically during `telegram configure` and again as a safety net during `telegram access pair` when `agent.md` is missing. Existing `agent.md` files are never overwritten by this default initializer.

Recommended block:

```markdown
## Telegram Transport

Plain text; ask in chat. Tags when needed: file/image `[tool:{"name":"send.file","payload":{"path":"/absolute/path"}}]` (`send.image` same); batch fenced `tool-call` JSON `{name:"send.batch",payload:{message?,images?,files?}}`; reminder `[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]` with one of `in`/`at`/`cron`, optional `description`, no `chatId`/`userId`. Let bridge confirm; native schedulers only if explicitly asked.
```

The bridge also accepts an explicit fenced `tool-call` block with the same JSON envelope for payloads that are easier to emit on multiple lines. Plain fenced `tool` examples are treated as documentation, not executable calls.

When these rules change, sync the affected `~/.cctb/<instance>/agent.md` files. Do not write turn-scoped paths, request ids, or side-channel tokens into `agent.md`.

Request-scoped `.telegram-out/<requestId>/` directories are runtime output buffers and are pruned after 24 hours.

Upgrade existing instances after pulling a new release:

```bash
telegram instructions upgrade --all
```

The upgrade command only auto-replaces generated legacy Telegram Transport blocks or appends the block when no transport section exists. Custom transport sections require manual review, or an explicit `--force`; use `--dry-run` to preview changes first. Forced replacements create an `agent.md.bak.<timestamp>` backup next to the original file.
