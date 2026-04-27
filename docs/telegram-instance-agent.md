# Telegram Instance Agent Instructions

These static transport rules belong in each instance-level `agent.md`, not in resumed project `AGENTS.md` or `CLAUDE.md`.

New instances get this file automatically during `telegram configure` and again as a safety net during `telegram access pair` when `agent.md` is missing. Existing `agent.md` files are never overwritten by this default initializer.

Recommended block:

```markdown
## Telegram Transport

Plain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`; if `cctb` is unavailable, use `[send-file:<absolute path>]` / `[send-image:<absolute path>]`; small text/code may use one fenced `file:name.ext` block; never claim delivery by path only.
```

When these rules change, sync the affected `~/.cctb/<instance>/agent.md` files. Do not write turn-scoped paths, request ids, or side-channel tokens into `agent.md`.

Request-scoped `.telegram-out/<requestId>/` directories are runtime output buffers and are pruned after 24 hours.

Upgrade existing instances after pulling a new release:

```bash
telegram instructions upgrade --all
```

The upgrade command only auto-replaces generated legacy Telegram Transport blocks or appends the block when no transport section exists. Custom transport sections require manual review, or an explicit `--force`; use `--dry-run` to preview changes first. Forced replacements create an `agent.md.bak.<timestamp>` backup next to the original file.
