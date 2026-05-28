# Slash Command Index

TaroCub exposes a shared in-chat command surface across Telegram and Feishu/Lark. Some commands are channel-specific because the platforms have different primitives: Telegram has forum topics, while Lark adds cards, Docs comments, thread-aware groups, and `lark-cli` workflows.

Use `/help` inside the bot for the live command list available to that chat. This file is the repository-level index.

## Basics

| Command | What It Does | Channels |
|---|---|---|
| `/help` | Show bot help in the current chat. | Telegram, Lark |
| `/status` | Show current engine, session binding, runtime state, and chat/thread context. | Telegram, Lark |
| `/usage` | Show cumulative usage for the current instance. | Telegram, Lark |
| `/btw <question>` | Ask a side question without touching the current session. | Telegram, Lark |
| `/ask <instance> <prompt>` | Delegate one prompt to a configured peer bot and return the result inline. | Telegram, Lark |

## Engine And Safety

| Command | What It Does | Channels |
|---|---|---|
| `/engine [claude\|codex\|antigravity]` | Inspect or switch the backend engine. | Telegram, Lark |
| `/model [name\|off]` | Inspect or set the engine model. | Telegram, Lark |
| `/effort [low\|medium\|high\|xhigh\|max\|off]` | Inspect or set reasoning effort where supported. | Telegram, Lark |
| `/fast [on\|off\|status]` | Toggle Codex Fast Mode. | Telegram, Lark |
| `/yolo [on\|off\|unsafe]` | Inspect or switch approval mode. | Telegram, Lark |
| `/config` | Open the interactive settings card. | Lark |

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
| `/stop` | Stop the current running or queued task. | Telegram, Lark |
| `/continue` | Continue the latest waiting archive analysis. | Telegram, Lark |

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
| `/cron mode <job-id> <same_session\|new_per_run>` | Change recurring job execution mode. | Telegram, Lark |
| `/cron run <job-id>` | Run a job immediately. | Telegram, Lark |
| `/board ...` | Manage durable Kanban tasks outside model memory. | Telegram, Lark |
| `/board add <task>` | Create a durable task. | Telegram, Lark |
| `/board list` | List board tasks. | Telegram, Lark |
| `/board show <id>` | Show one task card. | Telegram, Lark |
| `/board run <id>` | Execute one ready task through its assignee or current context. | Telegram, Lark |

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
| `/group status` | Show current group authorization and mention mode. | Telegram, Lark |
| `/group allow` | Allow the current group/thread context. | Telegram, Lark |
| `/group deny` | Deny the current group/thread context. | Telegram, Lark |
| `/group all` | Let ordinary non-mention group messages enter the bridge queue. | Telegram, Lark |
| `/group at` | Return to mention-required mode. | Telegram, Lark |
| `/newgroup <name>` | Create a fresh Lark group for a project/session space. | Lark |
| `/newgroup topic <name>` | Create a fresh Lark topic group. | Lark |
| `/newtopic <name>` | Shortcut for creating a Lark topic group. | Lark |

## Approvals And Fallbacks

| Command | What It Does | Channels |
|---|---|---|
| `/approve [session]` | Approve a pending tool call when buttons/cards are unavailable. | Telegram, Lark |
| `/deny [session]` | Deny a pending tool call when buttons/cards are unavailable. | Telegram, Lark |

## Lark-Native Notes

Lark supports richer command UX than Telegram: cards, choice panels, Docs comment replies, Sheets/Docs/Drive actions through `lark-cli`, group thread routing, and `/newgroup` project spaces. For full Lark-native behavior, install and bind `lark-cli`, then verify with:

```bash
node dist/src/index.js lark doctor
node dist/src/index.js lark cli identity status
node dist/src/index.js lark auth status --verify
```
