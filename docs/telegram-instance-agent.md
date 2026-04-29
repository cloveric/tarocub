# Telegram Instance Agent Instructions

These static transport rules belong in each instance-level `agent.md`, not in resumed project `AGENTS.md` or `CLAUDE.md`.

New instances get this file automatically during `telegram configure` and again as a safety net during `telegram access pair` when `agent.md` is missing. Existing `agent.md` files are never overwritten by this default initializer.

Recommended block:

```markdown
## Telegram Transport

Plain text only; ask in chat, not blocking prompt tools. For existing file delivery, emit one inline tool tag such as `[tool:{"name":"send.file","payload":{"path":"/absolute/path"}}]`, `[tool:{"name":"send.image","payload":{"path":"/absolute/image.png"}}]`, or `[tool:{"name":"send.batch","payload":{"message":"Done","images":["/absolute/image.png"],"files":["/absolute/report.pdf"]}}]`. Small text/code may use one fenced `file:name.ext` block; never claim delivery by path only.

## Scheduled Tasks

For reminders or recurring tasks, emit one inline tool tag, such as `[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]`, `[tool:{"name":"cron.add","payload":{"at":"2026-05-01T09:00:00Z","prompt":"Monday standup"}}]`, or `[tool:{"name":"cron.add","payload":{"cron":"0 9 * * 1","prompt":"weekly summary"}}]`. Use exactly one of `in`, `at`, or `cron`; optional `description` is shown in `/cron list`; never include `chatId` or `userId`. The bridge confirms success or failure; do not claim scheduling succeeded in your own words. Use native/session-local schedulers only if the user explicitly asks for non-Telegram scheduling.
```

The bridge also accepts an explicit fenced `tool-call` block with the same JSON envelope for payloads that are easier to emit on multiple lines. Plain fenced `tool` examples are treated as documentation, not executable calls.

When these rules change, sync the affected `~/.cctb/<instance>/agent.md` files. Do not write turn-scoped paths, request ids, or side-channel tokens into `agent.md`.

Request-scoped `.telegram-out/<requestId>/` directories are runtime output buffers and are pruned after 24 hours.

Upgrade existing instances after pulling a new release:

```bash
telegram instructions upgrade --all
```

The upgrade command only auto-replaces generated legacy Telegram Transport blocks or appends the block when no transport section exists. Custom transport sections require manual review, or an explicit `--force`; use `--dry-run` to preview changes first. Forced replacements create an `agent.md.bak.<timestamp>` backup next to the original file.
