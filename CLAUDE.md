# TaroCub Instructions

## Read First

Before modifying Telegram flow, Feishu/Lark flow, bus flow, state/config handling, usage/budget/audit logic, or file delivery, read:

- `docs/entrypoint-map.md`
- `docs/telegram-instance-agent.md` when changing static Telegram transport instructions

That file is the source of truth for codebase navigation and test selection.

Static Telegram transport rules belong in instance-level `~/.cctb/<instance>/agent.md`, not in resumed project `AGENTS.md` or `CLAUDE.md`. If those rules change, update `docs/telegram-instance-agent.md` and sync affected instance `agent.md` files.

## Mission

This repository is not in maintenance mode. The active objective is:

`make TaroCub a reliable local control surface for Codex, Claude Code, and Antigravity across Telegram and Feishu/Lark, keeping parity where possible and using each platform's native strengths where it is better`

Do not treat "feature implemented" as "work complete" unless the current milestone has been verified end-to-end.

## Release Rule

When the operator says "commit and release", do not stop at a commit, tag, or GitHub Release. A complete TaroCub release requires:

1. Commit the intended changes without unrelated runtime state or secrets.
2. Create or update the GitHub Release with accurate notes.
3. Restart and verify the Telegram and Lark fleet.

Do not include external package-registry publishing in the release flow. For Lark fleet restarts, use `node dist/src/index.js lark service restart --all`; do not hand-roll per-instance restart loops.

## Persistence Rule

When you feel the urge to stop, summarize, or hand back partially-finished work:

1. Run `./scripts/pre-complete-hook.sh` (or `.\scripts\pre-complete-hook.ps1` on Windows)
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
- closer cross-channel parity with Telegram and Lark-native UX where Lark is stronger

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

The two engines surface files differently. The delivery layer (`src/telegram/delivery.ts` → `response-delivery.ts`) handles these formats:

| Engine | Format | Example | Notes |
|--------|--------|---------|-------|
| Both | `[send-file:/path]` / `[send-image:/path]` tag | `[send-file:/Users/me/img.png]` | The only response-text delivery tag. `[send-image:]` prefers `sendPhoto`. |
| Both | Inline text file block | `` ```file:report.txt\ncontent\n``` `` | **Only honored when it is the entire response** — a fenced `file:` block surrounded by other text is treated as an explanatory example, not an attachment. |
| Codex | telegram-out auto-delivery | files written under `workspace/.telegram-out/<req>/` | Codex's primary file path: the message-turn loop auto-delivers files the engine produced in the current request output dir. |

**Codex does NOT use Markdown image/link extraction.** That extraction was removed: `deliverTelegramResponse` leaves Markdown absolute links (`![alt](/path)`, `[name](/path)`) as ordinary chat text (codified by the `"leaves markdown absolute links as ordinary chat text"` test in `tests/telegram-response-delivery.test.ts`). Codex delivers files via telegram-out auto-delivery, generated-image `[send-image:]` tags, and the `cctb send` side channel — not Markdown syntax.

**When modifying file delivery logic:**

1. Test both the response-text tag path (`[send-file:]` / `[send-image:]`, both engines) and the Codex telegram-out auto-delivery path.
2. File path patterns must match both Unix (`/Users/...`) and Windows (`C:\Users\...`) absolute paths.
3. The `sendFileOrPhoto` helper auto-detects image extensions and uses `sendPhoto` (Telegram compresses) with a `sendDocument` fallback.
4. Multiple images are sent **one-by-one** (each via `sendFileOrPhoto`). `sendMediaGroup` exists on the API but currently has **zero call sites** — there is no album batching today; do not assume it.
5. Never break the `deliverTelegramResponse` function without re-running its test cases (`tests/telegram-response-delivery.test.ts`, see commit `7dad7a4`).

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

- Cross-platform (macOS / Linux / Windows). Primary development target is macOS; Windows support is maintained.
- One Telegram bot per instance; one Lark app/service surface for the Lark channel
- One instance per process
- State lives under `~/.cctb/<instance>/` (POSIX) or `%USERPROFILE%\.cctb\<instance>\` (Windows)
