# CC Telegram Bridge Instructions

## Mission

This repository is not in maintenance mode. The active objective is:

`recreate Claude Code's Telegram plugin behavior as closely as practical for Codex, and keep improving until parity or better operational stability is reached`

Do not treat "feature implemented" as "work complete" unless the current milestone has been verified end-to-end.

## Persistence Rule

When you feel the urge to stop, summarize, or hand back partially-finished work:

1. Run `.\scripts\pre-complete-hook.ps1`
2. If it fails, fix the failures
3. If it passes but known parity/stability gaps remain, continue with the highest-value next task
4. Only stop when:
   - the current milestone is actually complete, or
   - you hit a real blocker that cannot be resolved locally

Do not stop just because:

- tests are passing
- one bug is fixed
- one feature was merged
- a bot replied once

This project should be driven toward:

- stronger service stability
- tighter access control
- better session continuity
- cleaner operator experience
- closer Claude-plugin parity

## Verification Standard

Before claiming meaningful progress, prefer evidence over assertion:

- `npm test`
- `npm run build`
- focused runtime checks for the area touched

## Operator Priorities

When choosing the next task without asking:

1. Fix correctness or security bugs
2. Fix duplicate replies, dropped updates, broken service lifecycle, or bad session continuity
3. Improve operator controls and observability
4. Improve GitHub presentation and documentation

## File Delivery: Claude vs Codex Engine Differences

The two engines reference files differently in their output. The delivery layer (`src/telegram/delivery.ts`) must handle **all** formats:

| Engine | Format | Example |
|--------|--------|---------|
| Claude | `[send-file:/path]` tag | `[send-file:/Users/me/img.png]` |
| Codex | Markdown image `![alt](/path)` | `![cover](/Users/me/img.png)` |
| Codex | Markdown link `[name](/path.ext)` | `[img.png](/Users/me/img.png)` |
| Both | Inline text file block | `` ```file:report.txt\ncontent\n``` `` |

**When modifying file delivery logic:**

1. Always test with BOTH engines — Claude uses explicit bridge tags, Codex uses standard Markdown syntax.
2. File path patterns must match both Unix (`/Users/...`) and Windows (`C:\Users\...`) absolute paths.
3. The `sendFileOrPhoto` helper auto-detects image extensions and uses `sendPhoto` (Telegram compresses) with `sendDocument` fallback.
4. Multiple images are sent as a Telegram album via `sendMediaGroup`.
5. Never break the `deliverTelegramResponse` function without re-running the regex test cases (see commit `7dad7a4`).

## Security: No Private Data in Commits

Before committing or pushing, verify that **none** of the following appear in code, docs, or examples:

- **Bot tokens** — use placeholder `123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789`
- **API keys** — `ghp_*`, `sk-ant-*`, `ANTHROPIC_API_KEY`, etc.
- **Pairing codes** — real 6-char codes like `38J63T`
- **Chat IDs / User IDs** — real Telegram numeric IDs
- **File paths containing usernames** — use `~/` or `%USERPROFILE%` instead of `/Users/realname/`
- **`.env` files, `access.json`, `session.json`** — must be in `.gitignore`

Run this check before pushing:
```bash
git diff --cached | grep -iE 'ghp_|sk-ant-|bot[0-9]{8,}:[A-Za-z0-9_-]{30,}|TELEGRAM_BOT_TOKEN=' 
```
If it matches anything, fix before committing.

## Repo Notes

- Windows-first project
- One Telegram bot per instance
- One instance per process
- State lives under `%USERPROFILE%\.cctb\<instance>\`
