# Slash Command Index

TaroCub exposes a shared in-chat command surface across Telegram and Feishu/Lark. Some commands are channel-specific because the platforms have different primitives: Telegram has forum topics, while Lark adds cards, Docs comments, thread-aware groups, and `lark-cli` workflows.

Use `/help` inside the bot for the live command list available to that chat. This file is the repository-level index.

## Basics

| Command | What It Does | Channels |
|---|---|---|
| `/help` | Show bot help in the current chat. Lark also accepts `/start` as an alias. | Telegram, Lark |
| `/status` | Show current engine, session binding, runtime state, and chat/thread context. | Telegram, Lark |
| `/usage` | Show cumulative usage for the current instance. | Telegram, Lark |
| `/btw <question>` | Ask a side question without touching the current session. | Telegram, Lark |
| `/ask <instance> <prompt>` | Delegate one prompt to a configured peer bot and return the result inline. | Telegram, Lark |

## Engine And Safety

| Command | What It Does | Channels |
|---|---|---|
| `/engine [claude\|codex\|antigravity]` | Inspect or switch the backend engine. | Telegram, Lark |
| `/model [name\|off]` | Inspect or set the engine model. Claude choices: `claude-opus-5[1m]` (Opus 5 with 1M context — the default), `fable`, `opus`, `sonnet`, `haiku`. | Telegram, Lark |
| `/effort [low\|medium\|high\|xhigh\|max\|ultra\|off]` | Inspect or set reasoning effort where supported. Codex GPT-5.6 Sol/Terra support `ultra`; Luna supports up to `max`. | Telegram, Lark |
| `/fast [on\|off\|status]` | Toggle Codex Fast Mode. Bare `/fast` shows status. | Telegram, Lark |
| `/yolo [on\|off\|unsafe\|status]` | Inspect or switch approval mode. There is no in-chat `/yolo` on Telegram — set it from the CLI (`telegram yolo [on\|off\|unsafe]`). | Lark |
| `/config` | Open the interactive settings card. | Lark |
| `/stream [on\|off]` | Toggle element-level typewriter streaming for answer cards (off = whole-card refresh). | Lark |
| `/timeout [on\|off]` | Single-turn 60-min time cap; `off` lifts it for long tasks (Codex/Antigravity only). Lark also accepts `status\|unlimited\|default`. | Telegram, Lark |
| `/steer [on\|off\|<seconds>\|unlimited\|default\|status]` | Mid-turn steering eligibility window (default 30s). Accepts seconds (`60`, `60s`) or minutes (`5m`/`5分钟`); `unlimited`/`0` lifts the window, `default` restores 30s. Within the window a plain-text follow-up injects into the running Codex turn (OK reaction); past it (or `off`) messages queue as their own turn. | Lark |
| `/account` | Show the Feishu app this instance is bound to. | Lark |

## Goals And Sessions

| Command | What It Does | Channels |
|---|---|---|
| `/goal <objective>` | Set the current conversation goal. Goals are unbounded by default unless a budget is provided. | Telegram, Lark |
| `/goal --budget <n> <objective>` | Set a goal with an explicit token budget. | Telegram, Lark |
| `/goal status` | Show the current goal and usage. | Telegram, Lark |
| `/goal clear` | Clear the active goal. | Telegram, Lark |
| `/resume` | Scan and resume local Claude sessions; Antigravity scans recent conversations. | Telegram, Lark |
| `/resume thread <thread-id>` | Bind a Codex thread explicitly. | Telegram, Lark |
| `/resume conversation <conversation-id>` | Bind an Antigravity conversation explicitly. | Telegram, Lark |
| `/detach` | Detach the current resumed Claude session, Codex thread, or Antigravity conversation. | Telegram, Lark |
| `/reset` | Reset the current chat/session binding. | Telegram, Lark |
| `/stop` | Stop the current running task (cancel a queued task from its queue card). | Telegram, Lark |
| `/q <message>` (alias `/queue <message>`) | Force the message to run as its own queued turn. Without it, plain text sent while a Codex turn is running is steered into that turn (within the `/steer` eligibility window, default 30s). | Lark |
| `/bg` | List engine/background processes for this instance; `/bg kill <pid>` stops a process tree; `/bg killall` cleans orphans. | Lark |
| `/continue` | Continue the latest waiting archive analysis. | Telegram, Lark |
| `/ws list\|save\|use\|remove` | Manage saved Lark workspace directories; `/ws use` resets the current Lark session binding to avoid stale context. | Lark |

## Claude-Specific Utilities

| Command | What It Does | Channels |
|---|---|---|
| `/context` | Show Claude context details where available. | Telegram, Lark |
| `/compact` | Trigger Claude context compaction workflow. | Telegram, Lark |
| `/ultrareview` | Run the dedicated deep review path for supported Claude models. | Telegram, Lark |

## Scheduled And Durable Work

| Command | What It Does | Channels |
|---|---|---|
| `/cron ...` | Manage reminders, recurring jobs, and scheduled agent tasks. | Telegram, Lark |
| `/cron list` | List jobs for the current chat/thread scope. | Telegram, Lark |
| `/cron add ...` | Create a one-shot or recurring scheduled job. | Telegram, Lark |
| `/cron rm <job-id>` | Remove a job by id. | Telegram, Lark |
| `/cron toggle <job-id>` | Enable or disable a job. | Telegram, Lark |
| `/cron mode <job-id> <reuse\|new_per_run>` | Change recurring job execution mode. | Telegram, Lark |
| `/cron run <job-id>` | Run a job immediately. | Telegram, Lark |
| `/board ...` (alias `/kanban ...`) | Manage durable Kanban tasks outside model memory. | Telegram, Lark |
| `/board add <task>` | Create a durable task. | Telegram, Lark |
| `/board plan <goal>` | Ask the current engine to decompose a goal into durable task cards. | Telegram, Lark |
| `/board list` | List board tasks. | Telegram, Lark |
| `/board show <id>` | Show one task card; Lark renders an interactive card with state-transition buttons. | Telegram, Lark |
| `/board run <id>` | Execute one ready task through its assignee or current context. | Telegram, Lark |
| `/board heartbeat <id>` / `/board recover [minutes]` | Track worker liveness and recover stale running tasks. | Telegram, Lark |
| `/board worktree <id> [path] [branch]` | Attach optional per-task worktree metadata for isolated code work. | Telegram, Lark |

## Multi-Agent Workflows

| Command | What It Does | Channels |
|---|---|---|
| `/mini ...` | Register group topics/threads as lightweight peer agents. | Telegram, Lark |
| `/mini here <name>` | Register the current topic/thread as a named peer. | Telegram, Lark |
| `/mini ask <name> <prompt>` | Ask a named peer. | Telegram, Lark |
| `/mini fan <prompt>` | Query registered peers in parallel. | Telegram, Lark |
| `/mini chain <prompt>` | Run registered peers sequentially. | Telegram, Lark |
| `/mini verify [name] <prompt>` | Execute locally, then ask a peer to verify. | Telegram, Lark |
| `/mini crew research-report <prompt>` | Run a fixed specialist workflow using registered peers. | Telegram, Lark |
| `/fan <prompt>` | Query the current bot plus configured Agent Bus peers in parallel. | Telegram, Lark |
| `/chain <prompt>` | Run the configured Agent Bus chain. | Telegram, Lark |
| `/verify <prompt>` | Execute locally, then send to the configured verifier. | Telegram, Lark |

## Groups And Lark Project Spaces

| Command | What It Does | Channels |
|---|---|---|
| `/group status` | Show current group authorization and mention mode. Bare `/group` is the same as `/group status`. | Telegram, Lark |
| `/group allow` | Allow the current group/thread context. | Telegram, Lark |
| `/group deny` | Deny the current group/thread context. | Telegram, Lark |
| `/group on` / `/group off` | Enable or disable group mode for the whole instance (`off` also clears every non-mention opt-in). | Telegram, Lark |
| `/group all` | Let ordinary non-mention group messages enter the bridge queue. | Telegram, Lark |
| `/group at` | Return to mention-required mode. | Telegram, Lark |
| `/invite group\|user @person` / `/remove group\|user @person` | Grant / revoke group or per-user authorization by @-mention. | Lark |
| `/newgroup <name>` | Create a fresh Lark group for a project/session space. | Lark |
| `/newgroup topic <name>` | Create a fresh Lark topic group. | Lark |
| `/newtopic <name>` | Shortcut for creating a Lark topic group. | Lark |

## Approvals And Fallbacks

| Command | What It Does | Channels |
|---|---|---|
| `/approve [session\|turn\|always]` | Approve the pending tool call in this chat; the argument approves it for the rest of the session. | Telegram, Lark |
| `/approve <request-id>` | Approve one specific pending request. | Telegram, Lark |
| `/approve-session <request-id>` | Approve one specific request for the rest of the session. | Lark |
| `/deny` | Deny the pending tool call in this chat. There is **no** `/deny session` form — only `/approve` takes that argument. | Telegram, Lark |
| `/deny <request-id>` | Deny one specific pending request. | Telegram, Lark |

## Voice And Media Keywords

These are message keywords, not slash commands.

| Keyword | What It Does | Channels |
|---|---|---|
| 强制本地转写 | Force the local ASR path for the audio/video in this message. | Telegram, Lark |
| 强制云端转写 | Force the Aliyun Tingwu cloud path (only when `TINGWU_ASR_DIR` is configured). | Telegram, Lark |

The keyword must travel **with** the media — as the caption of the same message, or as a text message in the same send burst, which the bridge merges into one turn. A bare voice note has no caption, and a keyword sent afterwards starts a new turn: it cannot reroute a transcription that is already running. Cloud ASR configuration (including where each env var must be set) is documented in the README's "Long-audio cloud ASR" section.

## Lark-Native Notes

Lark supports richer command UX than Telegram: cards, choice panels, Docs comment replies, Sheets/Docs/Drive actions through `lark-cli`, group thread routing, and `/newgroup` project spaces. For full Lark-native behavior, install and bind `lark-cli`, then verify with:

```bash
node dist/src/index.js lark doctor
node dist/src/index.js lark cli identity status
node dist/src/index.js lark auth status --verify
```
