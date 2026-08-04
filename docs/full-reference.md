<p align="center">
  <a href="../README.md"><strong>Short README</strong></a>&nbsp;&nbsp;|&nbsp;&nbsp;<strong>Full Reference</strong>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="../README.zh-CN.md"><strong>中文文档</strong></a>
</p>

> This is the long-form reference that used to live on the GitHub landing page. The shorter README keeps the repo homepage readable; this file keeps the full operational detail.

<p align="center">
  <img src="../assets/github-banner.png" alt="TaroCub for Telegram and Feishu/Lark" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/cloveric/tarocub/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cloveric/tarocub?style=flat-square&color=818cf8" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4?style=flat-square&logo=node.js&logoColor=white" alt="Windows | macOS | Linux">
  <img src="https://img.shields.io/badge/engines-Codex%20%7C%20Claude%20%7C%20Kimi%20%7C%20Antigravity-F97316?style=flat-square" alt="Codex | Claude | Kimi | Antigravity">
  <img src="https://img.shields.io/badge/tests-Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest">
</p>

<h3 align="center">
  TaroCub runs Codex, Claude Code, Kimi Code, and Antigravity locally, then lets you control them from Telegram and Feishu/Lark.<br>
  Resume desktop sessions from your phone, move files both ways, run scheduled work, and expose the same bridge through team chat.
</h3>

<p align="center">
  <a href="#start-here">Start Here</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#what-it-gives-you">What You Get</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#product-boundary">Boundary</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#core-workflows">Workflows</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#live-web-search-mcp-brave--tavily">Search MCP</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#agent-bus">Agent Bus</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#service-operations">Ops</a>
</p>

## Start Here

**TaroCub is not another hosted agent UI.** It runs the real Codex, Claude Code, Kimi Code, and Antigravity CLIs on your machine, then gives them durable Telegram and Feishu/Lark surfaces: access control, file delivery, voice transcription, scheduled tasks, session resume, multi-bot routing, and auditable long-running work.

This project was formerly named `cc-telegram-bridge`. The canonical repository is now `cloveric/tarocub`; GitHub redirects the old URL, and existing state directories plus the `cctb` shorthand remain supported for compatibility.

The easiest setup path is to clone this repo, open it in Codex, Claude Code, Kimi Code, or Antigravity, and tell the agent: *"read the README and configure a Telegram bot for me"*. The bridge is designed to be installed and operated by the same CLI agents it exposes.

```bash
npm install
npm run build
npm run dev -- telegram configure <telegram-bot-token>
npm run dev -- telegram yolo unsafe
npm run dev -- telegram service start
```

Then send a message to the bot, run the pairing command it gives you, and continue from Telegram. See [Quick Start](#quick-start) for the full walkthrough.

> **Recommended runtime:** use YOLO unsafe/bypass for hands-free personal instances you control: `telegram yolo unsafe --instance <name>`. This maps to `approvalMode: "bypass"` and intentionally bypasses the normal approval prompts and local sandbox. Use it only on a trusted machine and workspace; use `telegram yolo off` if you want approval prompts again.

## What It Gives You

| Capability | What it means in practice |
|---|---|
| **Remote control for real CLIs** | Put Codex, Claude Code, Kimi Code, or Antigravity on Telegram without wrapping them in a fake chat backend. |
| **Session continuity** | Resume local Claude or Kimi sessions, attach Codex threads, and bind Antigravity conversations from your phone, then continue on desktop later. |
| **Multimodal Telegram I/O** | Send files, images, generated artifacts, voice messages, and audio documents through one bridge protocol. |
| **Durable operations** | Keep cron jobs, audit logs, timeline logs, usage tracking, access checks, and service restart tooling outside model memory. |
| **Source-traceable research** | Use the optional Brave/Tavily MCP for `web_search`, `web_extract`, provider status, fallback notices, and source logs. |
| **Multi-agent coordination** | Use Agent Bus for instance-to-instance delegation, Mini Bus for topic-to-topic workflows, and Board for durable Kanban tasks. |
| **Feishu/Lark channel** | Reuse the same bridge runtime from Feishu/Lark via the official Lark Channel SDK, with direct final replies, stop buttons, approvals, file/media delivery tags, Docs comments, cron, Board, Mini Bus, and Agent Bus. |

## Feishu / Lark Channel

Feishu/Lark is the recommended, actively-developed channel. Telegram remains fully supported and is the longest-tested path, but is no longer the day-to-day focus. Both reuse the same engine adapters, sessions, workspace, `agent.md`, approval model, file-delivery tags, scheduled jobs, Board, Mini Bus, Agent Bus, and timeline/dashboard machinery.

```bash
npm run build
node dist/src/index.js lark wizard   # scan to create/bind a PersonalAgent app
node dist/src/index.js lark setup --detached --install-cli --identity bot-only # durable QR wizard + lark-cli + provision + doctor + service start
node dist/src/index.js lark provision # re-check/provision an existing app
node dist/src/index.js lark permissions # print copyable Lark permission JSON
node dist/src/index.js lark permissions --missing # print only currently missing scopes
node dist/src/index.js lark status
node dist/src/index.js lark doctor
node dist/src/index.js lark service start # normally only needed after --no-start-service or manual stop
node dist/src/index.js lark service logs 80
node dist/src/index.js lark service restart
node dist/src/index.js lark send --chat oc_xxx --message "hello from CLI"
node dist/src/index.js lark send --chat oc_xxx --reply-to om_xxx --thread --stdin
node dist/src/index.js lark timeline 20
node dist/src/index.js lark audit 20
node dist/src/index.js lark dashboard
node dist/src/index.js lark instructions path
node dist/src/index.js lark instructions set ./lark-agent.md
node dist/src/index.js lark engine claude
node dist/src/index.js lark yolo unsafe
node dist/src/index.js lark budget set 12.50
node dist/src/index.js lark locale zh
node dist/src/index.js lark verbosity 2
node dist/src/index.js lark usage
node dist/src/index.js lark session list
node dist/src/index.js lark task list
node dist/src/index.js lark backup --out ./lark-state.cctb.gz
```

`lark wizard` uses the official Lark SDK PersonalAgent registration flow, prints a QR code, writes credentials to `~/.cctb/lark/lark.env`, `~/.cctb/<CCTB_LARK_INSTANCE>/lark.env`, or `CCTB_LARK_STATE_DIR/lark.env`, then checks the app for the bridge surface: message receive events, card callbacks, bot message/resource scopes including the base `im:message` permission, reaction write scope for running feedback, Feishu Docs scopes, document collaborator auto-grant (`docs:permission.member:create`), Feishu Sheets scopes, cloud-doc comment scopes, chat-creation scopes for `/newgroup`, chat-member read scope for optional native `@name` resolution, and the group-all message scope required for `/group all`. It also tries to bind the local `lark-cli` through a `lark-channel` source config and exec-provider secret getter, so agents can use Docs/Drive/Calendar/Sheets-style CLI operations without putting the app secret in argv or child-process env; if that binding fails, the bot can still run basic chat transport, but the app is not considered fully configured until `lark-cli` is installed and bound. If the app has management permission, the wizard patches event/callback subscriptions; otherwise it reports the exact management scope needed. The PersonalAgent QR template does not currently guarantee `im:message.group_msg`, `im:message.reactions:write_only`, chat-creation scopes, `im:chat.members:read`, `docs:permission.member:create`, or all Sheets scopes; if you want ordinary non-mention group messages through `/group all`, running-feedback reactions, fresh project groups through `/newgroup`, native outgoing `@name` resolution, bot-created documents that can be auto-granted back to the requester, or spreadsheet creation/read/write through `lark-cli sheets`, add or bulk-import those scopes in the Feishu/Lark app permissions UI and rerun `lark provision`. Environment variables still win if you prefer manual credentials:

```bash
export LARK_APP_ID="cli_xxx"
export LARK_APP_SECRET="..."
```

Optional environment:

| Variable | Meaning |
|---|---|
| `CCTB_LARK_INSTANCE` | Lark-specific instance selector. If `CCTB_LARK_STATE_DIR` is unset, non-default names use `~/.cctb/<name>` so each Feishu/Lark bot can have its own `lark.env`. |
| `CCTB_LARK_STATE_DIR` | Explicit state/workspace directory for the Lark service. Defaults to `~/.cctb/lark`, or `~/.cctb/<CCTB_LARK_INSTANCE>` when the Lark-specific instance selector is set. |
| `TAROCUB_INSTANCE` | Shared runtime instance name used by engine config. Lark prefers `CCTB_LARK_INSTANCE` when both are set; old `lark.env` files with `CODEX_TELEGRAM_INSTANCE` are read and rewritten on the next service start. |
| `LARK_DOMAIN` | Override Lark/Feishu API domain when needed. |
| `LARK_REQUIRE_MENTION_IN_GROUP` | Defaults to `true`; group messages must mention the bot unless the specific chat is switched with `/group all`. |
| `CCTB_LARK_DOC_CREATE_AS` / `LARK_DOC_CREATE_AS` | Optional `user`/`bot` override for `lark.doc.create`; default is `bot`. |
| `CCTB_LARK_CHAT_CREATE_AS` / `LARK_CHAT_CREATE_AS` | Optional `user`/`bot` override for `/newgroup` and `/newtopic`; default is `bot`, which invites the requesting `ou_` user and sets the bot as manager when supported. |

The Lark channel currently supports:

- inbound p2p/group messages normalized into the same `Bridge.handleAuthorizedMessage` path, protected by the same pairing/allowlist access store as Telegram;
- basic chat commands: `/help`, `/status`, `/usage`, `/model`, `/effort`, `/fast`, `/engine`, `/yolo`, `/goal`, `/btw`, `/ask`, `/reset`, `/detach`, Claude/Antigravity `/resume` scan and explicit `/resume thread ...` / `/resume conversation ...`, `/ws list|save|use|remove`, `/newgroup`, `/newtopic`, `/cron`, `/group status|allow|deny|on|off|all|at`, `/board`, `/mini`, `/fan`, `/chain`, `/verify`, `/continue`, and `/stop`;
- topic/thread isolation through `conversationKey`: private-chat threads are isolated from the private main timeline; topic-form group threads are isolated from each other; conversation-form group replies stay in the shared group session. Replied-message context enrichment keeps short follow-ups such as "继续" or "就这个" tied to the quoted Lark message. `/newgroup <name>`, `/newgroup topic <name>`, and `/newtopic <name>` create fresh Lark project spaces with the instance bot by default (or the OAuth user in explicit user mode), ensure the instance bot joins, and automatically authorize the new group without enabling listen-all;
- native progress cards for long-running turns, plus queue-wait cards with a stop button. Same-conversation messages remain FIFO by default; optional `CCTB_LARK_QUEUE_MODE=preempt|batch|preempt-batch` enables preempt/batch behavior only when explicitly configured;
- `/ws list`, `/ws save <name> [absolute-path]`, `/ws use <name>`, and `/ws remove <name>` manage saved Lark workspace directories. `/ws use` resets the current conversation binding so a workspace switch does not silently continue with stale project context;
- ordinary tasks return the final answer directly; interactive cards are reserved for stop controls, approvals, `lark.choice` / card choices, and archive continuation;
- approval cards for engine permission requests, with callback operators checked against bridge access policy before resolving;
- inbound image/file resources downloaded into the bridge workspace for the current turn, then cleaned up after staging/transcription; inbound Lark audio/video resources use the same ASR router as Telegram before engine execution (short media via local Qwen, long media via Tingwu when configured);
- outbound `[send-file:/abs/path]`, `[send-image:/abs/path]`, `send.audio`, `send.video`, `send.batch`, and whole-response fenced `file:name.ext` blocks delivered back to Lark;
- rich Feishu posts through `lark.post` tool tags when plain Markdown is too limiting;
- bridge-managed user choice cards through `lark.choice`, plus custom interactive cards through `lark.card`; button clicks are access-checked, audited, and fed back into the same bridge session;
- Feishu Docs creation through `lark.doc.create` for long specs and reviewable documents; the default creator identity is the app/bot, with opt-in `as:"user"` when you really want the local `lark-cli` user identity;
- Feishu Docs comment mentions: when a cloud-doc comment @mentions the bot, the bridge fetches comment context, marks the triggering reply with a temporary Typing reaction when possible, runs the same engine, replies in-thread or falls back to a top-level comment when the document does not allow thread replies, and can execute `lark.doc.create`; chat-only delivery/reminder tools are reported as unsupported instead of being silently swallowed;
- Lark-delivered scheduled reminders/tasks through `/cron` or `cron.add` tool tags, with raw Lark chat/thread routing stored on each job so scheduler fires can return to the correct Lark conversation;
- archive summaries with a Lark `Continue Analysis` card button and `/continue` fallback, matching Telegram's pause-then-continue archive workflow;
- durable Kanban task state through `/board`, backed by the same `board.json` model as Telegram while writing timeline entries with `channel=lark`;
- thread-to-thread Mini Bus workflows through `/mini`, so Lark group threads can be registered as named peers for ask/fan/chain/verify/crew flows;
- Agent Bus delegation through `/fan`, `/chain`, and `/verify`, reusing the same configured `bus.parallel`, `bus.chain`, and `bus.verifier` peers as Telegram;
- merged forwarded Feishu messages are expanded through the Lark message API and preserved as `<forwarded_lark_messages>` task context for one-click handoff workflows, so the engine sees the forwarded child messages instead of only Feishu's `Merged and Forwarded Message` placeholder;
- a per-state-dir service lock plus `lark service start|stop|restart|status|logs|doctor`, so accidental duplicate `lark run` processes do not double-consume the same Lark events and recovery is operator-friendly;
- `lark send --chat <oc_xxx>`, the Lark-side sibling of Telegram `send`, for operator-initiated text/file/image delivery from the local CLI using saved app credentials without guessing a target chat;
- timeline entries with `channel=lark`, plus Lark-scoped `lark timeline`, `lark audit`, `lark dashboard`, `lark instructions`, `lark engine`, `lark yolo`, `lark budget`, `lark locale`, `lark verbosity`, `lark usage`, `lark session`, and `lark task` aliases, so Lark traffic, agent instructions, runtime config, session bindings, and file workflows can be inspected without routing through the Telegram CLI surface.

### Lark vs Telegram parity boundary

Most bridge-level features now exist on both channels. The remaining differences are platform-driven and should be treated as product constraints, not hidden bugs:

| Area | Telegram | Feishu/Lark |
|---|---|---|
| Ordinary private chat | Supported | Supported after `lark access pair` / allowlist |
| Group self-service | `/group allow`, `/group all`, `/group at` | Same commands; `/group all` also needs the app scopes `im:message` and `im:message.group_msg`; multi-agent @bot groups should also grant `im:message.group_at_msg.include_bot:readonly` |
| Running feedback | Native `typing...` action | Best-effort message reactions: `OnIt` while processing, `DONE` on success, `ERROR` on uncaught failure; ordinary turns still return final answers directly |
| Scheduled work | `/cron` and `cron.add` return to the Telegram chat/topic | `/cron` and `cron.add` preserve raw Lark chat/thread routing |
| Files and media | Files/images/voice/audio/video, subject to Telegram Bot API limits | Files/images/audio/video through Lark resources and the shared Qwen/Tingwu ASR router |
| Interactive workflows | Inline buttons for stop, approvals, and continue-analysis | Card 2.0 callbacks for stop, approvals, choices, and continue-analysis |
| Outgoing @mentions | Telegram text mentions | Optional native `@name` resolution with `CCTB_LARK_RESOLVE_MENTIONS=1` and `im:chat.members:read` |
| Docs comments | Not a Telegram concept | Feishu Docs comment @mentions can run the bridge and reply in-thread |
| Observability | `telegram status`, `doctor`, `timeline`, `audit`, `dashboard`, `instructions`, `session`, `task`, `backup`, `restore`, `send` | `lark status`, `doctor`, `timeline`, `audit`, `dashboard`, `instructions`, `session`, `task`, `backup`, `restore`, `send` use the Lark state dir and saved app credentials |

If `lark doctor` reports `im:message` or `im:message.group_msg` missing, Lark group slash commands and @mentions can still work, but ordinary non-mention group messages may never reach the bridge because Feishu/Lark filters them before the local service sees them. If it reports `im:message.reactions:write_only` missing, the bridge still answers normally but cannot add running-feedback reactions. If it reports `im:chat` or `im:chat:create` missing, `/newgroup` / `/newtopic` will fail before creating a fresh Lark group with the default bot identity. `im:chat.members:read` is needed for optional native `@name` resolution in outgoing bot replies. `im:chat:create_by_user` is only needed if you opt into user-identity chat creation with `CCTB_LARK_CHAT_CREATE_AS=user` or `LARK_CHAT_CREATE_AS=user`. If it reports `sheets:spreadsheet:*` scopes missing, agents may still talk in Lark but cannot create, inspect, read, or update Feishu spreadsheets through `lark-cli sheets`. TaroCub can automatically request approval for scopes that already exist in the app config, and it can patch events/callbacks when the app has app-management permission. Scopes that are not present in the app config are still a Feishu/Lark Developer Console permission-page action: open the `Permissions page:` URL printed by `lark doctor` or `lark permissions --missing`, choose the bulk import/open flow, and paste the compact JSON, for example:

```json
{"scopes":{"tenant":["im:message","im:message.group_msg","im:message.reactions:write_only","im:chat","im:chat:create","im:chat.members:read","sheets:spreadsheet:create","sheets:spreadsheet:read","sheets:spreadsheet:write_only","sheets:spreadsheet.meta:read"]}}
```

Access control is intentionally shared with the existing bridge store. If a private Lark chat is not paired, the bot replies with the pairing/allowlist instruction instead of running the engine. Use the Lark-specific alias against the Lark state dir: `node dist/src/index.js lark access pair <code>`, `lark access allow <numeric-chat-id>`, `lark access policy allowlist`, and `lark access status`.

Lark-specific tool tags use the same compact JSON tag shape as Telegram side-channel tools:

```text
[tool:{"name":"lark.choice","payload":{"prompt":"What next?","options":[{"label":"Continue","value":"continue"},{"label":"Rewrite","value":"rewrite"}]}}]
[tool:{"name":"lark.card","payload":{"title":"Choose","body":"What next?","actions":[{"label":"Continue","value":"continue"}]}}]
[tool:{"name":"lark.doc.create","payload":{"title":"Spec","content":"# Spec\n\nBody","docFormat":"markdown"}}]
[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]
[tool:{"name":"send.video","payload":{"path":"/absolute/path/demo.mp4"}}]
```

Fenced `tool-call` blocks can also use the same bridge-managed choice renderer for Plan Mode-style requests:

```tool-call
{"name":"request_user_input","payload":{"questions":[{"header":"Direction","id":"direction","question":"What next?","options":[{"label":"Continue","description":"Keep the current plan and proceed."},{"label":"Rewrite","description":"Change direction before coding."}]}]}}
```

Use `lark.choice` or `request_user_input` for ordinary “pick one option” workflows, including Plan Mode-style choices where Codex/Claude asks the user to pick a direction before continuing. Long option text belongs in `label`/`description`; the bridge renders each option as a readable section and keeps the actual button short (`Choose` / `选择`) so Feishu mobile clients do not truncate the decision text. Use raw `lark.card` only when you need a custom Card 2.0 layout.

For raw `lark.card` payloads, bridge decorates ordinary button elements with Card 2.0 `behaviors: [{type:"callback", value: ...}]` routing metadata when a conversation is available. If you already provide callback metadata, that explicit payload is preserved.

`lark-cli` is required for the full Lark-native experience: Feishu Docs/IM/Calendar/Drive/Sheets operations, `lark.doc.create`, `/newgroup`, and other local CLI-backed actions. Use `lark-cli >= 1.0.41`; older versions do not expose the v2 document creation flags (`--api-version v2`, `--content`, `--doc-format`, `--parent-token`, `--parent-position`) that this bridge now calls. It is not required for the bare long-connection transport, ordinary replies, access checks, stop/approval cards, `lark.choice`, or inbound media handling. In practice, treat `lark-cli` as a required installation step for production setups, with the SDK-only path kept as a degraded fallback. `/status` and `lark doctor` report whether the local CLI is visible to the service.

Bridge-managed `lark-cli` helpers:

```bash
node dist/src/index.js lark cli init
node dist/src/index.js lark cli preflight --install --identity bot-only # recommended for first-time setup
node dist/src/index.js lark cli bind --identity bot-only
node dist/src/index.js lark cli identity status
node dist/src/index.js lark cli identity user-default
node dist/src/index.js lark cli identity bot-only
node dist/src/index.js lark secrets list
printf '{"protocolVersion":1,"ids":["app-<app_id>"]}\n' | node dist/src/index.js lark secrets get
node dist/src/index.js lark auth start --recommend --domain docs,drive --scope "sheets:spreadsheet:create sheets:spreadsheet:write_only sheets:spreadsheet:read sheets:spreadsheet.meta:read"
node dist/src/index.js lark auth finish <device-code>
node dist/src/index.js lark auth status --verify
```

`lark cli preflight` checks for `lark-cli`, optionally installs `@larksuite/cli`, writes the `lark-channel` source profile, binds it, and applies the requested identity policy. `bot-only` is the safe default: `default-as bot` plus `strict-mode bot`. `user-default` is an explicit opt-in for user-identity operations: it sets `default-as user` and relaxes strict mode to `off` so agent turns can use user-backed Docs/Drive/Calendar/Sheets actions when the user has authorized them. It does not force-rebind by default, so it will not wipe an existing user OAuth session; use explicit `lark cli bind --identity user-default --force` only when you intentionally want to rebuild the binding. `lark cli identity ...` switches the same policy later without recreating the app. In all modes, the app secret stays in the bridge Lark state dir and is resolved only through `lark secrets get`; it is not passed in child-process argv/env. If `lark.doc.create` succeeds but warns that auto-grant was skipped, or `lark-cli sheets` reports missing user scopes, run `lark auth start ...` / `lark auth finish ...` for the `lark-channel` profile so the CLI can act as the authorized user.

`lark cli init` remains available when you explicitly want to initialize lark-cli directly from the app credentials through stdin. OAuth is intentionally two-step: start returns a device-flow URL immediately, and finish polls the device code in the foreground after the user confirms authorization. Do not start OAuth from a group chat; send device-flow URLs only in private chats.

### Lark Production Smoke Checklist

Before calling a Lark app production-ready, run these checks against the real app created by `lark wizard` or rechecked by `lark provision`:

1. `node dist/src/index.js lark status` shows configured credentials without printing secrets.
2. `node dist/src/index.js lark doctor` reports the long-connection, message, card, resource, Docs, comment, reply-context, and group-all scopes as configured or tells you the exact missing admin scope.
3. In a private Lark chat, send `test`; the bot should reply directly with the final answer, not a long-running placeholder card.
4. Send `/status`, `/help`, `/usage`, `/goal 写发布说明`, `/goal status`, `/stop`, and `/reset`; each should reply in the same chat/thread.
5. In a disposable Lark test space, send `/newgroup CCTB smoke test` or `/newtopic CCTB smoke test`; the bot should create a new group/topic chat, post a welcome message there, and reply with the new chat id/link.
6. In a Lark group, confirm the default mention-only behavior, then use `/group all` and `/group at` to switch ordinary-message handling on and off.
7. Send an image, a file, an audio resource, and a video resource; files should enter the workspace, while audio/video should be transcribed before the engine runs.
8. Ask the agent to create a reminder and verify the emitted `cron.add` tool tag creates a Lark-routed job; then run or wait for the job and confirm it returns to the same Lark chat/thread.
9. Trigger a permission request, a `lark.choice` / `lark.card` choice button, and an archive `Continue Analysis` card; every button should callback exactly once and respect Lark access checks.
10. Create a Feishu Docs comment that @mentions the bot; it should fetch comment context and reply in the comment thread.

## Product Boundary

| This project is | This project is not |
|---|---|
| A local bridge that exposes existing Codex, Claude Code, Kimi Code, and Antigravity installations through Telegram and optionally Feishu/Lark. | A hosted SaaS agent platform or a replacement for Codex/Claude Code/Kimi Code/Antigravity. |
| A control plane for sessions, files, approvals, scheduled tasks, and multi-agent routing. | A model provider, inference server, or standalone LLM runtime. |
| A practical ops layer for people who already use CLI agents heavily. | A generic chatbot framework for every messaging platform. |
| A place to keep delivery receipts, audit trails, and task state out of fragile prompts. | A promise that models will always finish tasks correctly without review. |

## Core Workflows

| Workflow | Entry point |
|---|---|
| **Personal mobile copilot** — talk to your local Codex/Claude/Kimi/Antigravity while away from the computer. | [Quick Start](#quick-start), [Session Resume](#session-resume-codex-threads-kimi-sessions-and-antigravity-conversations) |
| **Research assistant** — search, extract exact URLs, preserve source logs, and return files to Telegram. | [Search MCP](#live-web-search-mcp-brave--tavily), [File Delivery](#file-delivery-from-agent-tasks) |
| **Topic-based mini crew** — use Telegram forum topics as planner/writer/reviewer peers in one group. | [Mini Bus](#mini-bus-topic-to-topic-workflows), [Telegram Groups And Topics](#telegram-groups-and-topics) |
| **Durable project board** — keep tasks, dependencies, runs, WIP limits, and review gates outside model context. | [Board](#board-durable-kanban-tasks) |
| **Multi-bot agent bus** — delegate work across isolated bot instances with health checks and versioned local protocol. | [Agent Bus](#agent-bus), [Crew Workflows](#crew-workflows-hub-and-spoke) |

## Release Highlights

- **v0.1.0** — resets the public product to **TaroCub**, renames the GitHub/package surface, adds the product thesis to the banner, and keeps `cctb` plus old state paths as compatibility surfaces.
- **v4.6.70** — transitional release that introduced the TaroCub family name before the full product reset.
- **v4.6.69** — makes Lark setup more self-healing after real OAuth smoke testing: missing user identity now prints the exact recommended Docs/Drive/Sheets `lark auth start` command plus `finish <device-code>`, and the lark-cli guidance now matches the safer non-forcing `user-default` behavior.
- **v4.6.68** — deepens Lark-native reliability: authorized engine turns can show best-effort `OnIt` / `DONE` / `ERROR` reactions, optional native `@name` resolution maps members through `im:chat.members:read`, card sends fall back to redacted plain text with approval command alternatives, `lark setup` ties wizard/preflight/provision/auth/doctor into one flow, and setup/preflight no longer force-rebinds lark-cli in a way that can wipe user OAuth.
- **v4.6.67** — closes a Lark runtime secret-boundary gap: `lark-cli` child processes launched from document and `/newgroup` workflows now get `LARK_CHANNEL=1` without inheriting `LARK_APP_SECRET`, keeping the runtime path aligned with the bridge secret-provider model.
- **v4.6.66** — documents and surfaces the `lark-cli >= 1.0.41` requirement for the new Lark document flags, so wizard and doctor guide users to upgrade before Docs/Sheets-native workflows fail on older machines.
- **v4.6.65** — completes the Lark-native CLI layer: `lark-channel` now carries safe bridge credentials into Docs, `/newgroup`, and Sheets workflows; wizard/provisioning covers document auto-grant plus spreadsheet scopes; user OAuth guidance is built into setup; and Lark agent instructions prefer `lark-cli sheets` for real spreadsheet create/read/write/append/export instead of treating sheets as plain docs.
- **v4.6.64** — makes reminder tool failures user-safe: invalid `cron.add` natural-language times such as `at:"午后"` now render clear localized guidance instead of raw validator text, legacy `[cron-add:...]` failures no longer keep misleading "scheduled" prose, and Telegram/Lark agent instructions only permit reminder tool tags when the user explicitly asks to schedule one.
- **v4.6.63** — brings Lark project workflows to parity: `/newgroup` / `/newtopic` replace the ambiguous `/new chat`, bot/user chat creation invites the requester correctly, merged forwarded messages expand into child-message context, Plan Mode `request_user_input` renders as readable choice cards, and `lark-cli` is documented and surfaced as required for full Lark-native functionality.
- **v4.6.61** — polishes Lark operator UX: `/config` is now mobile-first with full-width choices and explicit Codex defaults, Lark/CLI status expands `default` to the underlying Codex config (`model` / `model_reasoning_effort`), `/goal` distinguishes unbounded budgets from missing data, `/usage` records completed turns whose engine omits token details without pretending they cost 0 tokens, and `/compact` is blocked on non-Claude engines instead of being forwarded as a normal prompt.
- **v4.6.58** — fixes Lark `/group all` ordinary group delivery by disabling SDK-level mention gating inside the bridge, adds safe raw/reject diagnostics, and updates `lark wizard` / `lark provision` to require both `im:message` and `im:message.group_msg`.
- **v4.6.56** — sharpens Lark as a native control surface: interactive `/config` cards, bridge-managed `lark.choice` buttons, lark-cli status/init/bind/secrets/OAuth helpers, and safer cron management where `cron.remove` / `cron.toggle` can act by unique query without inventing task IDs.
- **v4.6.53** — tightens the Feishu/Lark product edge: Telegram `service --all` no longer mistakes `~/.cctb/lark` for a Telegram bot, transient Lark attachments are cleaned after each turn, `lark send` requires an explicit `--chat`, Docs creation defaults to bot identity, and Lark doctor uses the shared secret redactor.
- **v4.6.51–v4.6.52** — closes the main Lark parity gap: direct final replies, Lark-routed `/cron`, `/board`, `/mini`, `/fan`, `/chain`, `/verify`, `/goal`, service/audit/dashboard aliases, Telegram Markdown delivery hardening, and Lark-native running/done cards where the platform needs cards.
- **v4.6.42–v4.6.46** — adds the QR `lark wizard`, `lark provision`, domain-safe PersonalAgent setup, permission/subscription checks, and Feishu Docs comment @mention support with in-thread replies.
- **v4.6.39–v4.6.41** — introduces the Feishu/Lark channel preview on the official Channel SDK, including message/card callbacks, app credentials, Lark service locks, safer errors, resource delivery, Docs creation, and Card 2.0 callback behaviors.
- **v4.6.22** — adds Antigravity CLI as a third backend engine with `/engine antigravity`, YOLO/full-auto process execution, conversation binding, and safe print-mode model guardrails.
- **v4.6.10–v4.6.18** — hardens core Telegram operations: `/goal` routing for Codex/Claude, audio/video ASR intake, stale-process `/stop` cleanup, and optional Search MCP with `web_extract`, provider metadata, source logs, and health checks.
- **v4.6.2** — adds `/board` durable Kanban state and `/mini` topic/thread workflows for lightweight multi-agent collaboration.

**Upgrading existing generated instance instructions:** refresh generated `agent.md` blocks after updating so old bots get the latest compact Telegram Transport block:

```bash
telegram instructions upgrade --all --dry-run
telegram instructions upgrade --all
telegram service restart --all
```

Use `--force` only for instances with a custom transport block you intentionally want to replace. Forced replacements create an `agent.md.bak.<timestamp>` backup next to the original file.

---

## Why This Bridge

- **Native CLI first.** The bridge runs the real Codex, Claude Code, Kimi Code, and Antigravity CLIs, so local auth, project files, approvals, and engine-specific behavior remain the same as on your desktop.
- **Resume desktop work from anywhere.** Pick up an existing local Codex, Claude Code, or Kimi Code session from Telegram, send files or instructions while away, then continue the same project back on the desktop. Antigravity conversations are auto-bound after a successful turn and can also be attached with `/resume conversation <id>`.
- **Group topics become clean side conversations.** A single bot can serve private chat plus allowed Telegram groups; forum topics get separate sessions and cron scopes, so throwaway tasks and scheduled work do not pollute the main conversation. Topic peers can also be composed into a Mini Bus for same-group fan-out, chain, verify, or crew workflows, while `/board` keeps durable Kanban task state outside model memory.
- **Multi-engine without separate playbooks.** Each bot can choose Codex, Claude, Kimi, or Antigravity while file delivery and scheduled tasks still go through the same schema-backed `[tool:{...}]` bridge protocol.
- **Telegram features live in the bridge, not in model memory.** File sending, cron persistence, receipts, access checks, and retries are handled by bridge code, so tasks keep working across model changes, restarts, and resumed sessions.
- **Short prompts, stable instructions.** Transport rules live in instance-level `agent.md`; per-turn prompts stay small and do not need request ids, temp directories, or side-channel secrets.
- **Receipts over claims.** File delivery and scheduled-task creation produce structured accepted/rejected receipts, so "done" only counts when the bridge actually delivered or scheduled something.
- **Operable by default.** Timeline logs, audit logs, doctor, dashboard, usage tracking, cron state, and generated-instruction upgrades make failures visible and recovery repeatable.

---

## Multi Engine: Codex + Claude Code + Kimi Code + Antigravity

Each bot instance can run **OpenAI Codex**, **Claude Code**, **Kimi Code**, or **Antigravity CLI** as its backend. Switch engines per-instance with one command:

```powershell
# Set an instance to use Claude Code
npm run dev -- telegram engine claude --instance review-bot

# Set another to use Codex
npm run dev -- telegram engine codex --instance helper-bot

# Set another to use Kimi Code
npm run dev -- telegram engine kimi --instance kimi-bot

# Set another to use Antigravity
npm run dev -- telegram engine antigravity --instance agy-bot

# Check current engine
npm run dev -- telegram engine --instance review-bot
```

Selecting Antigravity automatically sets that instance to YOLO/full-auto unless it was already in the explicit `bypass` mode, because `agy --print` is non-interactive in Telegram. Antigravity model selection is still owned by the native interactive CLI. `agy --print` does not run the interactive `/model` parser, so Telegram `/model` is handled locally with an explanation instead of being forwarded as a chat prompt. Set the model in local interactive `agy` until the CLI exposes a non-interactive model API.

| Feature | Codex Engine | Claude Engine | Kimi Engine | Antigravity Engine |
|---|---|---|---|---|
| CLI command | `codex exec --json` | `claude -p --output-format json` | Persistent `kimi acp` | `agy --print` |
| Session resume | `codex exec resume --json <id>` | `claude -p -r <session-id>` | `/resume` lists native ACP sessions; `/resume session <id>` validates with `session/load` and resumes in the original real-path workspace | Auto-binds the first logged conversation; `/resume` scans recent agy logs; `/resume conversation <id>` uses `agy --conversation` |
| Project instructions | `agent.md` (prepended to prompt) | `agent.md` appended to Claude's system prompt + `CLAUDE.md` auto-loaded from workspace | Bot-owned workspaces use a native `.kimi-code/agents/agent.md` main-agent override while preserving `${base_prompt}` and `${plugin_sections}`; external workspaces are not modified and use a text-turn fallback | `agent.md` (prepended to prompt) |
| Streaming / early delivery | JSON stream events feed timeline and early file delivery | Claude stream events feed timeline and early file delivery | ACP session updates feed the timeline, tool state, questions, and early delivery | stdout chunks feed timeline and early file delivery when `agy --print` streams output |
| Telegram approval when YOLO is off | Pre-approve the turn, then run that turn with `--full-auto` | Inline approval buttons for Claude permission prompts | ACP permission requests become native channel buttons; ACP question options remain distinct from approvals | Pre-approve the turn, then run that turn with `--dangerously-skip-permissions` |
| YOLO mode | `--full-auto` / `--dangerously-bypass-approvals-and-sandbox` | `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` | `full-auto` maps to ACP `yolo`; unsafe/bypass maps to ACP `auto` | `--dangerously-skip-permissions` |
| `/goal` | Bridge-native goal API; defaults to no token budget unless `--budget` is provided | Passes through to Claude Code's native `/goal`; `--budget` becomes a native goal hint | Not exposed by Kimi ACP 0.31.1; rejected explicitly instead of being sent as ordinary text | Passes through to Antigravity's native `/goal`; `--budget` becomes a native goal hint |
| `/model` | Bridge config passed to Codex startup | Bridge config passed to Claude startup | Applied through ACP-advertised configuration values on the next turn | Not available from Telegram in `agy --print`; use local interactive `agy /model` |
| `/compact` | Not needed (each exec is stateless) | Compresses session context to reduce token usage | Forwarded as Kimi's native slash command | Not supported by the bridge yet |
| Skills / plugins / MCP | Uses the configured Codex home; isolated homes link `skills/` to the shared Codex skills dir | Uses shared Claude config plus workspace `CLAUDE.md`, skills, plugins, and native MCP | Keeps Kimi's native `~/.agents/skills`, project skills, plugins, and MCP; bot workspaces also expose `~/.codex/skills`, and TaroCub injects Search MCP on ACP new/load | Uses Antigravity's native CLI/plugin config; do not import other engines' native plugins unless explicitly chosen |
| Working directory | Instance `workspace/`, or the validated resumed thread workspace | Instance `workspace/` | Instance `workspace/`, or the authoritative real-path `cwd` returned by ACP for a resumed session | Instance `workspace/` |
| Idle workers | Process exits after each turn | Stream workers are reaped after 30 minutes idle; sessions remain resumable | Persistent ACP workers are reaped after 2 hours idle; sessions remain resumable | Process exits after each turn |

## Live Web Search MCP: Brave + Tavily

The bridge ships an optional local MCP server that gives all four engines source-traceable web research tools. Codex, Claude Code, and Antigravity use their native MCP/plugin configuration; TaroCub injects the server into Kimi ACP `session/new` and `session/load` while preserving Kimi's native MCP and plugins:

- `web_search` routes live search through Brave and/or Tavily.
- `web_extract` uses Tavily Extract to read known URLs cleanly.
- `provider_status` reports whether Brave/Tavily keys are configured without exposing the keys.
- `health_check` optionally performs live Brave/Tavily probes when you explicitly want to diagnose auth, quota, rate limit, or timeout issues; pass `query` if you want a non-default probe term.
- When a user provides exact URL(s), agents should read those URL(s) directly before using search for discovery or surrounding context.

Why use it instead of only native model search:

- Brave is good for URL discovery, current docs, pricing pages, news, and broad search.
- Tavily is good for extraction-oriented research and clean page text.
- `verify` mode cross-checks both providers when a claim matters.
- Results include source metadata: `sourceLog`, `provider`, `domain`, `rank`, `accessedAt`, `extractedAt`, and `contentHash` for extracted pages.
- If Brave or Tavily fails and the other provider is used, the result includes `fallbacks` plus a `notice` so the agent can disclose the fallback.

Register it after setting local API keys:

```bash
export BRAVE_API_KEY="..."
export TAVILY_API_KEY="..."
npm run build

codex mcp add web-search \
  --env BRAVE_API_KEY="$BRAVE_API_KEY" \
  --env TAVILY_API_KEY="$TAVILY_API_KEY" \
  -- node "$PWD/dist/src/index.js" search-mcp

claude mcp add web-search \
  -e BRAVE_API_KEY="$BRAVE_API_KEY" \
  -e TAVILY_API_KEY="$TAVILY_API_KEY" \
  -- node "$PWD/dist/src/index.js" search-mcp
```

For Antigravity, use Antigravity's own native MCP/plugin configuration when needed. Do not import Claude or Codex native plugins as part of the default bridge setup. The bridge can reuse the same skill documents and tool guidance across engines, but each instance `agent.md` and each engine's native plugin system remain separate.

Kimi does not need a manual TaroCub Search MCP registration. The bridge injects it into each ACP session and, when direct search environment variables are absent, reads only the known Brave/Tavily keys from Codex MCP environment sections in `CODEX_HOME/config.toml`; explicit process environment values always win and credentials are never copied into Kimi config or logs.

Then restart affected bot instances so their native MCP/plugin configuration is reloaded; Kimi receives the injected Search MCP when its next ACP worker starts. In unattended Codex process use, prefer YOLO/full-auto/bypass instances for MCP-heavy turns; plain non-interactive `codex exec` in read-only approval mode can cancel MCP calls instead of running them. More detail: [`docs/search-mcp.md`](./search-mcp.md).

### Claude Engine: CLAUDE.md Support

When using the Claude engine, each instance gets a `workspace/` directory. Drop a `CLAUDE.md` in there for project-level instructions that Claude Code reads natively:

```
~/.cctb/review-bot/
├── agent.md              ← "You are a strict code reviewer"
├── workspace/
│   └── CLAUDE.md         ← "TypeScript project. Use ESLint. Never modify tests."
├── config.json           ← { "engine": "claude", "approvalMode": "full-auto" }
└── .env
```

Two layers of instructions, no conflict:
- **agent.md** → Your bot personality (injected via `--system-prompt`)
- **CLAUDE.md** → Project rules (Claude auto-discovers from working directory)

---

## Multi-Bot Setup

Run as many bots as you need. Each instance is fully isolated — its own engine, token, personality, threads, access rules, inbox, and audit trail. By default, each instance is meant for one Telegram chat; multi-chat access is opt-in.

```
          ┌─────────────────────────────────────────────┐
          │                 TaroCub                 │
          └────────────┬──────────────┬─────────────────┘
                       │              │
        ┌──────────────┼──────────────┼──────────────┐
        ▼              ▼              ▼              ▼
 ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
 │  "default" │ │   "work"   │ │ "reviewer" │ │ "research" │
 │  engine:   │ │  engine:   │ │  engine:   │ │  engine:   │
 │   codex    │ │   codex    │ │   claude   │ │   claude   │
 │            │ │            │ │            │ │            │
 │ agent.md:  │ │ agent.md:  │ │ agent.md:  │ │ agent.md:  │
 │ "General   │ │ "Reply in  │ │ "Strict    │ │ "Deep      │
 │  helper"   │ │  Chinese"  │ │  reviewer" │ │  research" │
 └────────────┘ └────────────┘ └────────────┘ └────────────┘
   PID 4821       PID 5102       PID 5340       PID 5520
```

### Deploy in 30 Seconds

```bash
# Configure each instance
npm run dev -- telegram configure <token-A>
npm run dev -- telegram configure --instance work <token-B>
npm run dev -- telegram configure --instance reviewer <token-C>

# Set engines
npm run dev -- telegram engine claude --instance reviewer

# Set personalities
npm run dev -- telegram instructions set --instance reviewer ./reviewer-instructions.md

# Recommended: enable unsafe/bypass for trusted Telegram/mobile use
npm run dev -- telegram yolo unsafe --instance work

# Start them all
npm run dev -- telegram service start
npm run dev -- telegram service start --instance work
npm run dev -- telegram service start --instance reviewer
```

---

## Agent Instructions

Each bot has its own `agent.md`. Hot-reloaded on every message — edit anytime, no restart needed.

```powershell
npm run dev -- telegram instructions show --instance work
npm run dev -- telegram instructions set --instance work ./my-instructions.md
npm run dev -- telegram instructions path --instance work
```

Or edit directly:

```powershell
# Windows
notepad %USERPROFILE%\.cctb\work\agent.md

# macOS
open -e ~/.cctb/work/agent.md
```

---

## File Delivery From Agent Tasks

During each active Telegram turn, the bridge can deliver generated files through the registered Telegram tool layer. The canonical agent-facing form is an inline tool tag:

```text
[tool:{"name":"send.file","payload":{"path":"/absolute/path/to/report.pdf"}}]
[tool:{"name":"send.image","payload":{"path":"/absolute/path/to/image.png"}}]
[tool:{"name":"send.batch","payload":{"message":"Done","images":["/absolute/path/to/image.png"],"files":["/absolute/path/to/report.pdf"]}}]
```

For larger or quote-heavy payloads, the same tool envelope can be emitted as a fenced block:

````text
```tool-call
{"name":"send.file","payload":{"path":"/absolute/path/to/report.pdf"}}
```
````

For CLI workflows, the bridge also injects a stable `cctb` command into turn-scoped engine processes:

```bash
cctb send --image /absolute/path/to/image.png
cctb send --file /absolute/path/to/report.pdf
cctb send --message "Done" --file /absolute/path/to/report.pdf
```

Inside an active Telegram turn, `cctb send` uses the turn-scoped side-channel and preserves the current chat/session context. The same delivery path is also available through the repository CLI outside an active turn, where it falls back to the configured instance and active Telegram session:

```bash
telegram send --image /absolute/path/to/image.png
telegram send --file /absolute/path/to/report.pdf
# NOTE: `telegram send` is turn-scoped only — it works from INSIDE an engine
# turn (the bridge injects CCTB_SEND_URL/CCTB_SEND_TOKEN) and targets that
# turn's own chat. `--chat` / `--instance <other>` are refused, and files must
# live under the workspace sandbox.
telegram send --file /absolute/path/inside/workspace/report.pdf
telegram send --instance bot2 --chat 123456789 --image /absolute/path/to/image.png
```

Current delivery rules:

- Agents should use `[tool:...]` delivery tags for existing files, images, PDFs, decks, and other binary outputs. This is the only delivery tag format generated instance instructions teach.
- `[tool:...]` examples are generated from the registered tool schema/examples; explicit fenced `tool-call` blocks execute through the same parser.
- `cctb send` remains available for turn-scoped CLI workflows and is internally routed through the same send tool layer.
- Use `telegram send` when you need the same explicit delivery command outside an active turn, or when the turn-scoped `cctb` helper is unavailable.
- In-turn side-channel sends accept any readable absolute path; the `cctb send` CLI wrapper does not (workspace sandbox applies).
- Legacy `[send-file:/absolute/path]` / `[send-image:/absolute/path]` tags are accepted only for older sessions and copied historical output. Do not use them in new agent instructions, system prompts, or examples.
- Small text/code files can still use the `file:name.ext` fenced-block form.
- The helper is scoped to one Telegram turn. It will not work after the turn finishes.
- Legacy fallback tags still validate that files live under the instance workspace or the active `/resume` project before sending.
- Accepted and rejected file deliveries are recorded as turn-level receipts, so the bridge can decide completion from structured delivery evidence instead of text claims.
- If a file was already sent by stream delivery or the side-channel helper, the final `.telegram-out` sweep skips that same real path to avoid duplicate Telegram attachments.
- Request-scoped `.telegram-out/<requestId>/` directories are runtime buffers and are pruned after 24 hours.
- The bridge no longer keeps manifest, pending-contract, or count-based state to infer future delivery intent across ordinary chat turns.
- Text-only tasks such as image analysis, image descriptions, or inline reports are not treated as file-delivery failures.

This works for Codex, Claude, Kimi, Antigravity, process, stream, and ACP runtimes because the canonical path only requires the agent to emit text. File delivery is explicit: generate the file, emit the tool tag or call the send command, and rely on the resulting receipt.

When upgrading from v4.5.0 or earlier, refresh generated instance instructions with:

```bash
telegram instructions upgrade --all --dry-run
telegram instructions upgrade --all
```

This safely replaces old generated Telegram Transport blocks and appends the block when missing. Custom transport sections are left untouched unless you rerun with `--force`. Forced replacements create an `agent.md.bak.<timestamp>` backup next to the original file.

---

## Scheduled Tasks / Cron

Agents can schedule Telegram-delivered reminders and recurring tasks through the same tool layer used for file delivery:

```text
[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]
[tool:{"name":"cron.add","payload":{"at":"2026-05-01T09:00:00Z","prompt":"Monday standup"}}]
[tool:{"name":"cron.add","payload":{"cron":"0 9 * * 1","prompt":"weekly summary"}}]
[tool:{"name":"cron.list","payload":{}}]
[tool:{"name":"cron.remove","payload":{"query":"weekly summary"}}]
[tool:{"name":"cron.remove","payload":{"id":"<job-id>"}}]
[tool:{"name":"cron.toggle","payload":{"id":"<job-id>"}}]
```

One-shot `in` / `at` reminders default to direct Telegram notifications, so prompts such as `提醒我：给玉姐带尿布` are not sent back through the AI model at fire time. Recurring `cron` jobs default to AI-run tasks; set `deliveryMode:"notify"` for recurring plain reminders, or `deliveryMode:"agent"` when a one-shot scheduled item should run the AI.

When a user asks to cancel or pause an existing scheduled task and did not provide a job ID, agents can call `cron.remove` or `cron.toggle` with a `query` if the wording uniquely identifies one current chat/thread job. If the request is ambiguous, call `cron.list` first and ask the user which ID to change. Agents must not invent job IDs.

Users can also manage tasks directly in Telegram:

```text
/cron list
/cron add 0 9 * * 1 weekly summary
/cron rm <job-id>
/cron toggle <job-id>
/cron mode <job-id> new_per_run
/cron run <job-id>
```

Cron behavior is designed for Telegram delivery, not session-local reminders:

- Jobs are persisted in the instance state and survive bot restarts.
- `chatId`, `userId`, and `chatType` are injected by the bridge, not trusted from the agent payload.
- Relative reminders (`in`), absolute reminders (`at`), and recurring 5-field cron expressions (`cron`) are supported.
- Each job stores timezone information; by default it follows the server/instance environment where the bot runs.
- Missed one-shot reminders older than the grace window are marked missed instead of firing as a burst after long downtime.
- Recurring jobs track failures, keep capped run history, and can be disabled after repeated failures.
- Scheduled jobs default to `sessionMode: "new_per_run"` so each run starts from a clean context instead of inheriting the chat that created it. Use `sessionMode: "reuse"` only for explicit continuation-style jobs.
- Jobs created before this default was introduced keep their stored mode; use `/cron mode <job-id> new_per_run` to upgrade an older recurring task without deleting it.
- Per-chat job caps prevent accidental recursive job creation from growing without bound.

For human operators, the CLI remains available for inspection and debugging, but generated instructions tell agents to use the `[tool:{...}]` layer so Claude/Codex/Kimi/Antigravity process, stream, and ACP runtimes behave consistently.

---

## YOLO Mode

For hands-free personal bot use, `telegram yolo unsafe` is recommended. It keeps Codex/Claude/Kimi/Antigravity moving without asking on each turn by setting `approvalMode: "bypass"`: Codex bypasses approvals and sandboxing, Claude/Antigravity use unsafe skip-permission flags, and Kimi maps bypass to ACP `auto`. If you keep YOLO off, the bridge uses channel approval buttons where the engine supports a headless path: Claude and Kimi can approve individual tool requests, Codex app-server mode maps YOLO settings to its sandbox mode, and Antigravity process mode gets a turn-level pre-approval. Use unsafe/bypass only on fully trusted local environments.

Claude approval buttons use a short-lived localhost MCP bridge with a random URL token. This protects against blind local port scans, but the token is still visible to same-user local processes that can inspect process command lines. Treat YOLO-off approval as a single-user workstation convenience, not a multi-user isolation boundary.

```powershell
npm run dev -- telegram yolo on --instance work      # Sandboxed auto-approve
npm run dev -- telegram yolo unsafe --instance work   # Skip ALL checks
npm run dev -- telegram yolo off --instance work      # Normal flow
npm run dev -- telegram yolo --instance work          # Check status
```

| Mode | Codex | Claude | Kimi | Antigravity | Use case |
|---|---|---|---|---|---|
| `off` | Telegram pre-turn approval or app-server sandbox | Telegram tool approval | ACP tool approval | Telegram pre-turn approval | Default, safest |
| `on` | `--full-auto` | `--permission-mode bypassPermissions` | ACP `yolo` | `--dangerously-skip-permissions` | Mobile use |
| `unsafe` | `--dangerously-bypass-*` | `--dangerously-skip-permissions` | ACP `auto` | `--dangerously-skip-permissions` | Trusted env only |

---

## Usage Tracking

Track token consumption and cost per instance:

```bash
npm run dev -- telegram usage                    # Default instance
npm run dev -- telegram usage --instance work    # Named instance
```

Output:
```
Instance: work
Requests: 42
Input tokens: 185,230
Output tokens: 12,450
Cached tokens: 96,000
Estimated cost: $0.3521
Last updated: 2026-04-09T10:00:00Z
```

Claude reports exact USD cost. Codex reports tokens without an exact bridge-side price. Kimi ACP 0.31.1 does not expose structured turn token/cost telemetry, so Kimi usage and budget accounting cannot be treated as complete until the protocol adds it.

---

## Turn Activity And Timeline

While a turn runs, the bridge sends Telegram typing actions and records structured events in `timeline.log.jsonl` / `audit.log.jsonl`. Long tool calls are not live-edited into the chat; inspect them with:

```bash
npm run dev -- telegram timeline --instance work
npm run dev -- telegram dashboard --instance work
npm run dev -- telegram service status --instance work
```

`telegram verbosity` is kept as a compatibility config knob, but the current Codex/Claude/Kimi/Antigravity runtimes use typing actions plus timeline/audit events rather than live-editing partial model output into Telegram.

---

## Budget Control

Set a per-instance spending cap. When total cost reaches the limit, new requests are blocked until the budget is raised or cleared.

```bash
npm run dev -- telegram budget show --instance work     # Current spend vs limit
npm run dev -- telegram budget set 10 --instance work   # Cap at $10
npm run dev -- telegram budget clear --instance work    # Remove cap
```

Budget is enforced in real-time — the bot replies with a bilingual message when the limit is hit.

---

## Voice Input (ASR)

Send voice/audio/video in Telegram, or audio/video resources through Lark. The bridge transcribes them before forwarding text to the selected engine: short media uses the local Qwen ASR, while media at or above the configured threshold (15 minutes by default) uses Aliyun Tongyi Tingwu when enabled. Cloud ASR is optional; without it, all media stays local.

**How it works:**

1. User sends a voice/audio/video message in Telegram or a Lark audio/video resource
2. The bridge downloads the media and probes its duration
3. Short media uses local Qwen ASR (HTTP first, CLI fallback); long media uses Tingwu when configured, with safe chunked local fallback on cloud failure
4. The transcript is appended to the user's text message
5. Claude, Codex, Kimi, or Antigravity processes it as a normal text request

The route is selected before the engine adapter runs, so it is identical across all four engines. `/stop` propagates through duration probing, ffmpeg chunking, local HTTP/CLI transcription, and the Tingwu child process. An operator cancellation is never treated as a cloud failure and never starts a local fallback. The bridge aborts its local HTTP request promptly; the standalone ASR server may still finish an already-running model kernel before observing the disconnected client.

**Setup with Qwen3-ASR (example):**

```bash
# Clone and install the ASR model
git clone https://github.com/nicoboss/qwen3-asr-python
cd qwen3-asr-python
python -m venv venv
source venv/bin/activate
pip install -e .

# Download a model (0.6B is fast enough for voice messages)
huggingface-cli download Qwen/Qwen3-ASR-0.6B --local-dir models/Qwen3-ASR-0.6B
```

The bridge looks for the ASR service at two locations (in order):

| Method | Endpoint / Path | Latency | Notes |
|---|---|---|---|
| HTTP server | `POST http://127.0.0.1:8412/transcribe` | ~2-3s | Model stays in memory. Recommended. |
| CLI fallback | `~/projects/qwen3-asr/transcribe.py <file>` | ~30s | Loads model each time. No server needed. |

**Start the HTTP server (recommended):**

```bash
python ~/projects/qwen3-asr/server.py
# Qwen3-ASR server listening on http://127.0.0.1:8412
```

**Optional ASR watchdog:**

By default the bridge does not start arbitrary ASR processes. If you want it to repair a local ASR server after repeated HTTP failures, add an explicit command to the instance `.env`:

```bash
ASR_SERVICE_COMMAND='curl -fsS --max-time 2 -X POST http://127.0.0.1:8412/shutdown >/dev/null 2>&1 || true; sleep 2; cd "$HOME/projects/qwen3-asr" && exec "$HOME/projects/qwen3-asr/venv/bin/python3" "$HOME/projects/qwen3-asr/server.py" >> "$HOME/.cctb/asr-server.log" 2>&1'
ASR_RESTART_AFTER_FAILURES=2
ASR_RESTART_COOLDOWN_MS=60000
```

The watchdog only covers the warm HTTP ASR path. CLI fallback still exists for transcription, but it is not daemon-managed.

**Custom ASR integration:**

To use a different ASR engine, modify the shared `createDefaultTranscribeVoice()` router in `src/telegram/message-input.ts` or inject `transcribeMedia` in the Lark runtime tests. The function receives the local media path plus routing/cancellation options and returns the transcript as a string.

---

## Session Resume, Codex Threads, Kimi Sessions, and Antigravity Conversations

Started a task locally with Claude Code or Kimi Code? Continue it on Telegram without re-explaining context. Codex threads and Antigravity conversations can also be attached and continued from Telegram.

### Claude local session resume

```
/resume          ← Bot scans your local sessions from the past hour
```

The bot lists recent sessions with project names and timestamps:

```
Recent local sessions:
1. [tarocub] 64c2081c… (5m ago)
2. [my-app] a3f8b21e… (32m ago)

Reply /resume <number> to continue that session.
```

Pick one:

```
/resume 1        ← Bot symlinks the session, switches workspace, binds session ID
```

Now every message you send goes through the original session — same context, same project directory, same conversation history. When you're done:

```
/detach          ← Unbinds session, restores the pre-/resume conversation when one exists
```

**How it works under the hood:**

1. Scans `CLAUDE_CONFIG_DIR/projects/` when set, otherwise `~/.claude/projects/`, for `.jsonl` files modified in the last hour
2. Binds the session ID and overrides the workspace to point at your real project path
3. Claude CLI resumes with `-r <sessionId>` in the original directory
4. `/detach` returns to the pre-/resume conversation when one exists; otherwise it falls back to the default workspace without touching the original local session file

**No pollution:** bridge and instance instructions are passed per invocation and are not written back into local session files.

### Codex thread attach

Codex does not expose the same local session scan flow as Claude. If you already know the thread ID, attach it explicitly:

```text
/resume thread thread_abc123
```

That binds the current Telegram chat to the existing Codex thread. From then on:

- new Telegram messages continue that thread
- `/status` shows the current thread ID
- `/detach` unbinds the thread and restores the pre-attach conversation when one exists

This is an attach flow, not a local session import: the thread stays server-side and the bridge only binds the known thread ID to the current chat.

Note: the default Codex app-server runtime validates `/resume thread <thread-id>` through the local Codex runtime. Thread IDs unknown to the local machine still fail closed instead of being guessed.

### Kimi ACP session resume

Kimi exposes native `session/list` and `session/load` methods through ACP. Send plain `/resume` to list recent sessions, then choose one by number:

```text
/resume
/resume 1
```

If you already know the session ID, attach it explicitly:

```text
/resume session <session-id>
```

Before changing the chat binding, the bridge starts a short-lived ACP control connection, loads the session, and uses the authoritative `cwd` returned by Kimi. The directory is resolved through `realpath` and must still exist. Invalid IDs, unavailable validation, and missing workspaces fail closed without altering the current session or config. `/detach` restores the pre-resume conversation when available.

For bot-owned workspaces, generated bridge instructions live in Kimi's native `.kimi-code/agents/agent.md` main-agent override and preserve `${base_prompt}` plus `${plugin_sections}`. External resumed projects are never modified; ordinary text turns use a prompt fallback because ACP 0.31.1 has no direct arbitrary system-prompt field. Raw slash commands such as `/compact` are not prefixed.

### Antigravity conversation attach

Antigravity print mode writes the active conversation ID to its CLI log. The bridge reads those logs, binds the current conversation to the Telegram chat after a successful turn, and resumes later turns with:

```text
agy --conversation <conversation-id>
```

If you already know an Antigravity conversation ID, attach it explicitly:

```text
/resume conversation fdfc8ab1-7936-4599-98b0-d8ba2593c250
```

If you do not know the ID, send plain `/resume`. The bridge scans recent Antigravity CLI logs and returns a numbered list; reply `/resume 1` to attach one.

From then on:

- new Telegram messages continue that Antigravity conversation
- `/status` shows the current conversation ID
- `/detach` unbinds the conversation and restores the pre-attach conversation when one exists

This still uses Antigravity's native session model. The bridge does not invent model or effort flags. Because `agy --print` cannot run the interactive `/model` parser, set the model in local interactive `agy`; Telegram `/model` will explain the limitation instead of sending the command to the model as a normal prompt.

---

## Instance Management

List, rename, or delete instances from the CLI. The service must be stopped before renaming or deleting.

```bash
npm run dev -- telegram instance list                          # Show all instances
npm run dev -- telegram instance rename old-name new-name      # Rename
npm run dev -- telegram instance delete staging --yes          # Delete (requires --yes)
```

---

## Backup & Restore

Back up an instance's entire state directory to a single `.cctb.gz` archive. Restore atomically with rollback on failure.

```bash
npm run dev -- telegram backup --instance work                 # Creates timestamped .cctb.gz
npm run dev -- telegram backup --instance work --out ./bak.cctb.gz
npm run dev -- telegram restore ./bak.cctb.gz --instance work  # Restore (instance must not exist)
npm run dev -- telegram restore ./bak.cctb.gz --instance work --force  # Overwrite existing
```

The archive format is a pure-Node gzipped binary — no `tar` dependency, works on Windows/macOS/Linux identically.

---

## Agent Bus

Enable bot-to-bot communication via local HTTP IPC. The bus now supports point delegation, fan-out, sequential chains, auto-review, and coordinator-led crew workflows. It handles routing, peer validation, loop prevention, and local auth.

**Protocol v1** — every request and response is stamped with `protocolVersion`, declared `capabilities`, structured `errorCode`, and a `retryable` flag, so callers can tell transient failures (timeouts, unreachable peers) from terminal ones (disabled bus, peer not allowed). Legacy unversioned payloads are still accepted for rolling upgrades. Peer liveness is verified by probing `GET /api/health` and matching a `cc-telegram-bridge` fingerprint, so a reused local port cannot fake a live peer. Full spec: [`docs/bus-protocol.md`](./bus-protocol.md).

### Enable

Add `bus` to each instance's `config.json`:

```json
{ "engine": "codex", "bus": { "peers": "*" } }
```

| Field | Description |
|---|---|
| `peers` | `"*"` = talk to all bus-enabled bots. `["a", "b"]` = specific bots only. Omit or `false` = isolated. |
| `maxDepth` | Max delegation hops (default `3`). Prevents A→B→C→A loops. |
| `port` | Local HTTP port. `0` = auto-assign (default). |
| `secret` | Shared secret for Bearer token authentication (optional). |
| `parallel` | List of instances for `/fan` parallel queries (e.g. `["sec-bot", "perf-bot"]`). |
| `chain` | Ordered list of instances for `/chain` sequential handoff (e.g. `["reviewer", "writer"]`). |
| `verifier` | Instance name for `/verify` auto-verification (e.g. `"reviewer"`). |
| `crew` | Fixed coordinator workflow config for hub-and-spoke specialist orchestration. |

Both sides must allow each other — unilateral bus config is rejected.

### Usage

In any bot's Telegram chat:

```
/ask reviewer Please review this function for security issues
/fan Analyze this code for bugs, security issues, and performance
/chain Improve this answer step by step
/verify Write a function to sort an array
```

- `/ask <instance> <prompt>` — delegate to a specific bot, result inline
- `/fan <prompt>` — query current bot + all `parallel` bots simultaneously, combined results
- `/chain <prompt>` — run a configured sequential pipeline, each stage receiving the previous stage output explicitly
- `/verify <prompt>` — execute on current bot, then auto-send to `verifier` for review

`/chain` is the lightweight pipeline. `crew` is the heavier hub-and-spoke mode.

### Board: durable Kanban tasks

`/board` adds a small Hermes-inspired Kanban layer on top of Telegram. It is intentionally state-first: tasks, dependencies, assignees, blocked reasons, and completion summaries are stored in `board.json`, not only in the model conversation. This makes it useful for coordinating Mini Bus or Agent Bus work without relying on "remember what we were doing".

```
/board add Draft launch plan
/board plan Ship the onboarding flow
/board desc B1 Write launch messaging and rollout tasks
/board accept B1 README updated
/board priority B1 high
/board labels B1 docs launch
/board check B1 add Update README
/board list
/board show B1
/board assign B1 writer
/board dep B2 B1
/board limits global 3
/board worktree B1 /tmp/tarocub-board/B1 board/B1
/board heartbeat B1 still working
/board recover 15
/board review B1 on reviewer
/board ready B2
/board run B2
/board start B2
/board fail B2 tests failed
/board runs B2
/board block B2 waiting on API docs
/board unblock B2
/board approve B1
/board reject B1 needs more tests
/board done B1 design accepted
```

- `/board add <task>` — create a durable task with a stable id like `B1`
- `/board plan <goal>` — ask the current engine to return a JSON task graph, then persist it as Board cards with dependencies
- `/board desc <id> <description>` — set task card description
- `/board accept <id> <criterion>` — append an acceptance criterion
- `/board priority <id> <low|normal|high|urgent>` — set priority
- `/board labels <id> <labels...>` — replace task labels
- `/board check <id> add <item>` / `/board check <id> done <C1>` — manage checklist items
- `/board list [todo|ready|running|blocked|done]` — list board tasks
- `/board show <id>` — show one task with source chat/topic metadata
- `/board assign <id> <assignee>` — label the task with a Mini Bus peer, bot instance, or free-form owner
- `/board dep <id> <depends-on-id>` — declare that one task waits for another
- `/board limits [global|assignee|conversation] <n>` — set WIP limits; defaults are `global=3`, `assignee=1`, `conversation=1`
- `/board worktree <id> [path] [branch]` / `/board workspace <id> <default|dir|worktree|scratch> [path]` — attach optional workspace metadata; Mini Bus runs use the task workspace path when set
- `/board heartbeat <id> [note]` — update the active run's liveness timestamp
- `/board recover [minutes]` — fail and block running tasks with no heartbeat/new activity older than the threshold; default is 15 minutes
- `/board review <id> <on|off> [reviewer]` — require review before `done`
- `/board approve <id>` / `/board reject <id> <reason>` — resolve tasks waiting in review
- `/board ready <id>` — move a task to ready if dependencies are complete
- `/board run <id>` — execute a ready task through its assignee; Mini Bus peers in the current group are preferred, otherwise the assignee is treated as an Agent Bus instance
- `/board start <id>` — mark a task running and create a lightweight run record
- `/board fail <id> <reason>` — close the active run as failed and block the task with the reason
- `/board runs <id>` — show run attempt history for one task
- `/board block <id> <reason>` / `/board unblock <id>` — manage blocked work
- `/board done <id> [summary]` — complete a task; dependents whose dependencies are all done are promoted to `ready`

This is not a hidden autonomous dispatcher. It gives the bridge durable planning state first: model-assisted task graph creation, richer task cards, WIP limits, workspace metadata, run heartbeats, stale-run recovery, dependency promotion, review gates, and explicit one-task execution with `/board run <id>`. Lark `/board show <id>` renders an interactive task card with safe state-transition buttons; card actions route back through the same `/board` command path and access checks.

### Mini Bus: topic/thread-to-topic/thread workflows

Inside an allowed Telegram group/forum or Lark group thread, `/mini` lets one bot treat different topics/threads as lightweight peers. Each peer keeps its own session, uses the same instance config and `agent.md`, and can be asked directly, queried in parallel, or chained sequentially. This is useful for temporary planning/review threads without creating new bot instances.

Use Mini Bus when you want separate working memory without separate bots:

- keep an `intake` topic for the coordinator and register `planner`, `writer`, `reviewer`, or `research` topics as peers
- run quick comparisons with `/mini fan`, where each peer answers the same prompt in parallel
- run staged work with `/mini chain`, where each topic receives the previous topic's output
- run a lightweight review loop with `/mini verify`
- run a fixed specialist workflow with `/mini crew research-report`

Prerequisites:

- the bot must be in an allowed Telegram group or forum topic
- if the group uses BotFather privacy mode, make the bot an admin so it can see ordinary group messages; otherwise mention/reply-to the bot or use commands
- register each Telegram topic or Lark thread from inside that topic/thread with `/mini here <name>`

Typical setup:

```
/mini here planner
/mini here writer
/mini status
/mini ask planner Break this task into steps
/mini fan Compare these options
/mini chain Turn this rough idea into a final answer
/mini verifier reviewer
/mini verify Write the final answer
/mini role researcher research
/mini role analyst analyst
/mini role writer writer
/mini role reviewer reviewer
/mini crew research-report Analyze this market
```

After setup, use the coordinator topic to call the peers:

```
/mini ask planner Break this into tickets
/mini fan Find risks in this plan
/mini chain Turn this plan into final copy
/mini verify reviewer Is this ready to ship?
```

- `/mini here <name>` — register the current topic as a named peer for the current group
- `/mini order <names...>` — set the default `/mini chain` order
- `/mini parallel <names...>` — set the default `/mini fan` target list
- `/mini verifier <name|off>` — set the verifier used by `/mini verify`
- `/mini role <researcher|analyst|writer|reviewer> <name>` — bind a crew role to a named topic peer
- `/mini crew research-report <prompt>` — run the full coordinator-led `research-report` workflow using topic peers as specialists
- `/mini ask <name> <prompt>` — send one prompt to a named topic peer
- `/mini fan <prompt>` — run all registered peer topics except the current topic in parallel
- `/mini chain <prompt>` — run registered peer topics in registration order, passing each output to the next stage
- `/mini verify [name] <prompt>` — execute in the current topic, then ask the configured or named verifier topic to review it
- `/mini rm <name>` — remove a topic peer

The practical benefit is isolation with low overhead: every topic/thread has its own session and cron scope, but all peers share the same bot/app, workspace, engine settings, budget tracking, approvals, timeline, and audit logs. That makes Mini Bus good for short-lived multi-agent work such as planning, drafting, review, research, or temporary cron/job conversations.

Mini Bus is intentionally scoped to the current Telegram group or Lark group. It does not open another bot token/app or another workspace; if multiple topics/threads edit the same files concurrently, the same workspace-conflict rules apply as any concurrent local agents.

Mini crew is the topic-scoped version of Agent Bus crew: the coordinator runs in the current topic context, decomposes the task, sends research sub-questions to the `researcher` topic in parallel, then routes analysis, writing, review, and any revision loop through the configured role topics. It uses the same `crew-runs/*.json`, timeline, audit, budget, approval, and topic-session boundaries as the instance-level workflow.

### Topology Patterns

**Hub & Spoke** — one commander, multiple workers:

```
              ┌──────────┐
              │  main    │
              │ peers: * │
              └──┬────┬──┘
                 │    │
         ┌───────┘    └───────┐
         ▼                    ▼
   ┌──────────┐        ┌──────────┐
   │ reviewer │        │ researcher│
   │peers:    │        │peers:     │
   │ ["main"] │        │ ["main"]  │
   └──────────┘        └──────────┘
```

Workers only talk to the hub. The hub dispatches and aggregates.

**Pipeline** — sequential handoff:

```
┌────────┐     ┌────────┐     ┌────────┐
│ intake │────▶│ coder  │────▶│ review │
│peers:  │     │peers:  │     │peers:  │
│["coder"]│    │["intake",│   │["coder"]│
└────────┘    │"review"]│    └────────┘
              └────────┘
```

Each bot only knows its neighbors. Tasks flow left to right.

**Parallel** — fan-out to multiple specialists:

```
                    /fan "analyze this code"
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
      ┌──────────┐  ┌──────────┐  ┌──────────┐
      │ sec-bot  │  │ perf-bot │  │ style-bot│
      └──────────┘  └──────────┘  └──────────┘
            │              │              │
            └──────────────┼──────────────┘
                           ▼
                   Combined result
```

```json
{ "bus": { "peers": "*", "parallel": ["sec-bot", "perf-bot", "style-bot"] } }
```

**Verification** — execute then auto-review:

```
/verify "write a sort function"
         │
         ▼
   ┌──────────┐    result    ┌──────────┐
   │  coder   │ ───────────▶ │ reviewer │
   └──────────┘              └──────────┘
                                  │
                             verification
                                  │
                                  ▼
                        Both shown to user
```

```json
{ "bus": { "peers": "*", "verifier": "reviewer" } }
```

<a id="crew-workflow"></a>

### Crew Workflows (Hub and Spoke)

For heavier multi-agent work, one instance can act as a dedicated coordinator while fixed specialist instances do focused work. This follows the article-style hub-and-spoke pattern:

- the user talks directly to the coordinator bot
- specialists never talk to each other directly
- all context is passed explicitly by the coordinator
- the coordinator keeps the run state, stage progress, and final assembly

Current built-in workflow is `research-report`:

`coordinator -> researcher -> analyst -> writer -> reviewer`

If the reviewer asks for changes, the coordinator can send the draft back to the writer for one or more revision rounds.

Example config on the coordinator instance:

```json
{
  "bus": {
    "peers": ["researcher", "analyst", "writer", "reviewer"],
    "crew": {
      "enabled": true,
      "workflow": "research-report",
      "coordinator": "coordinator",
      "roles": {
        "researcher": "researcher",
        "analyst": "analyst",
        "writer": "writer",
        "reviewer": "reviewer"
      },
      "maxResearchQuestions": 4,
      "maxRevisionRounds": 2
    }
  }
}
```

Behavior notes:

- only the coordinator instance should have this `crew` block
- the five roles must all be distinct
- ordinary text messages sent to the coordinator bot will run the crew workflow automatically
- crew runs are persisted under `crew-runs/*.json`
- stage progress is also written to `timeline.log.jsonl`

**Mesh** — full interconnect:

```json
// Every instance
{ "bus": { "peers": "*" } }
```

All bots can talk to all bots. Simplest config, best for small teams (3-5 bots).

---

## Quick Start

> **TL;DR** — You only need to do two things on your phone: get a bot token from BotFather and send the pairing code. Everything else happens on your computer via Codex, Claude Code, Kimi Code, or Antigravity CLI.

### Prerequisites

- **Node.js** >= 20
- **OpenAI Codex CLI**, **Claude Code CLI**, **Kimi Code CLI**, and/or **Antigravity CLI** installed and authenticated
- A **Telegram account** (phone)

### Step 1: Create a Telegram Bot (on your phone)

1. Open Telegram and search for **[@BotFather](https://t.me/BotFather)**
2. Send `/newbot`
3. Follow the prompts — give your bot a name and username
4. BotFather will reply with a **bot token** like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789`
5. Copy this token — you'll paste it in your terminal

### Step 2: Install & Configure (on your computer)

Open your terminal with Codex, Claude Code, Kimi Code, or Antigravity, and tell it:

> *"Clone https://github.com/cloveric/tarocub and set up a Telegram bot with this token: `<paste your token>`"*

Or do it manually:

```bash
git clone https://github.com/cloveric/tarocub.git
cd tarocub
npm install
npm run build

# Configure with your bot token
npm run dev -- telegram configure <your-bot-token>

# Optional: switch engines (default is Codex)
npm run dev -- telegram engine claude
npm run dev -- telegram engine kimi
npm run dev -- telegram engine antigravity

# Recommended: enable unsafe/bypass for trusted Telegram operation
npm run dev -- telegram yolo unsafe

# Start the service
npm run dev -- telegram service start
```

### Step 3: Pair Your Phone (on your phone)

1. Open Telegram and find your new bot (search its username)
2. Send any message — the bot will reply with a **6-character pairing code** like `38J63T`
3. Go back to your terminal and run:

```bash
npm run dev -- telegram access pair 38J63T
```

**Done!** You can now chat with Codex, Claude, Kimi, or Antigravity from Telegram. Send text, voice messages, or files — the bot handles everything.

### Multiple Bots

```bash
# Create a second bot with BotFather, then:
npm run dev -- telegram configure --instance work <second-token>
npm run dev -- telegram engine claude --instance work
npm run dev -- telegram yolo unsafe --instance work
npm run dev -- telegram service start --instance work
# Pair the same way: send a message, get the code, run `telegram access pair <code> --instance work`

# Or create a dedicated Antigravity bot
npm run dev -- telegram configure --instance agy-bot <third-token>
npm run dev -- telegram engine antigravity --instance agy-bot
npm run dev -- telegram yolo unsafe --instance agy-bot
npm run dev -- telegram service start --instance agy-bot
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                              TaroCub                            │
├─────────────┬──────────────┬──────────────────┬─────────────────────┤
│  Telegram   │   Runtime    │     AI Engine    │      State          │
│  Layer      │   Layer      │     Layer        │      Layer          │
├─────────────┼──────────────┼──────────────────┼─────────────────────┤
│ api.ts      │ bridge.ts    │ adapter.ts       │ access-store.ts     │
│ delivery.ts │ chat-queue.ts│ process-adapter  │ session-store.ts    │
│ update-     │ session-     │   .ts (Codex)    │ runtime-state.ts    │
│ normalizer  │ manager.ts   │ claude-adapter   │ instance-lock.ts    │
│   .ts       │              │   .ts (Claude)   │ json-store.ts       │
│ message-    │              │ antigravity-     │ audit-log.ts        │
│ renderer.ts │              │   adapter.ts     │ timeline-log.ts     │
│             │              │ agent.md + config│ usage-store.ts      │
│             │              │                  │ crew-run-store.ts   │
└─────────────┴──────────────┴──────────────────┴─────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Bus Layer  (local HTTP, loopback, protocol v1)                     │
├─────────────────────────────────────────────────────────────────────┤
│  bus-server.ts  · bus-client.ts  · bus-handler.ts                   │
│  bus-protocol.ts (envelope, errors, zod)  · bus-registry.ts         │
│  bus-config.ts  · delegation-commands.ts  · crew-workflow.ts        │
└─────────────────────────────────────────────────────────────────────┘
```

**Data flow:**

```
Telegram Update → Normalize → Access Check → Chat Queue (serialized)
    → Load config.json (engine) → Load agent.md → Session Lookup
    → Codex Exec, Claude stream, Kimi ACP, or agy --print (new or resume)
    → Typing action + timeline events → Final Render → Deliver → Audit
```

---

## Highlights

<table>
  <tr>
    <td width="50%">
      <h3>Four Native Engines</h3>
      <p>Switch between Codex, Claude Code, Kimi Code, and Antigravity per instance. Mix engines across bots while managing all of them from one CLI.</p>
    </td>
    <td width="50%">
      <h3>Per-Bot Personality</h3>
      <p>Each instance loads its own <code>agent.md</code>. Claude also reads workspace <code>CLAUDE.md</code>; Kimi bot workspaces receive a managed native main-agent override that preserves Kimi's base and plugin prompt sections.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Multi-Bot Support</h3>
      <p>Run multiple Telegram bots from one repo. Each instance has its own token, engine, workspace, access rules, session binding, audit trail, and service lifecycle.</p>
    </td>
    <td>
      <h3>Agent Bus</h3>
      <p>Local bot-to-bot calls enable delegation, fan-out, chains, verification, and coordinator-led crew workflows without mixing each bot's Telegram chat context.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>YOLO Mode</h3>
      <p>One command to auto-approve everything across supported engines. Per-instance, hot-reloadable.</p>
    </td>
    <td>
      <h3>Per-Bot Isolation</h3>
      <p>Every instance has its own personality, workspace, sessions, access rules, inbox, audit trail, and workspace-keyed auto-memory. Each engine's own config dir (<code>~/.claude/</code> / <code>~/.codex/</code> / <code>~/.kimi-code/</code> / Antigravity's CLI config) remains shared with your main CLI so OAuth refresh tokens do not race across instances. Native settings, plugins, MCP state, and full-auto effects therefore still belong to your real local account.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Session Resume</h3>
      <p><code>/resume</code> scans Claude Code, Kimi ACP, or Antigravity sessions according to the current engine; explicit Codex thread, Kimi session, and Antigravity conversation IDs can also be attached safely.</p>
    </td>
    <td>
      <h3>Runtime Visibility</h3>
      <p>Telegram shows typing while a turn runs, and structured timeline/audit events record sessions, tool calls, file receipts, retries, and completion status for debugging.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Production Resilience</h3>
      <p>Long polling (~0ms latency), exponential backoff, 429 auto-retry, 409 conflict auto-shutdown, graceful SIGTERM/SIGINT, fault-tolerant batch processing.</p>
    </td>
    <td>
      <h3>Safe Detach</h3>
      <p><code>/detach</code> returns to the pre-resume conversation when possible. External resumed projects are not modified; Kimi's native managed instruction file is written only inside bot-owned workspaces.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Usage Tracking</h3>
      <p>Per-instance token counts (input/output/cached) and USD cost. <code>telegram usage</code> to check spend anytime.</p>
    </td>
    <td>
      <h3>Timeline & Dashboard</h3>
      <p><code>telegram timeline</code>, <code>telegram service status</code>, and <code>telegram dashboard</code> expose current turn state, recent failures, file receipts, and crew snapshots.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Budget Control</h3>
      <p>Set a per-instance cost cap. Requests are blocked when the limit is hit — with bilingual messages.</p>
    </td>
    <td>
      <h3>File Delivery</h3>
      <p>Generated images, PDFs, decks, and reports are delivered through registered <code>[tool:...]</code> send tags, with <code>cctb send</code> and <code>telegram send</code> as CLI entrypoints.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Backup & Restore</h3>
      <p>One command to archive or restore an instance. Zero-dependency binary format, cross-platform, with atomic rollback.</p>
    </td>
    <td>
      <h3>Instance Management</h3>
      <p>List, rename, and delete instances from the CLI. Running-instance guards prevent data corruption.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Voice Input</h3>
      <p>Send voice/audio/video — short media uses local Qwen ASR; long media uses Aliyun Tingwu when configured, with safe local fallback.</p>
    </td>
    <td>
      <h3>Full Audit Trail</h3>
      <p>Every action recorded per-instance in append-only JSONL — filterable by type, chat, and outcome. Auto-rotated at 10MB.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Docker Ready</h3>
      <p>Multi-stage Dockerfile included. Build once, deploy anywhere.</p>
    </td>
    <td>
      <h3>Structured Bus Protocol</h3>
      <p>Local bot-to-bot calls speak a versioned <code>v1</code> protocol — <code>protocolVersion</code>, <code>capabilities</code>, structured <code>errorCode</code>, and a <code>retryable</code> flag so callers can tell transient failures from terminal ones. Peer liveness is a real <code>/api/health</code> probe, not just a PID check. See <a href="./bus-protocol.md">docs/bus-protocol.md</a>.</p>
    </td>
  </tr>
</table>

---

## Service Operations

| Command | Description |
|---|---|
| `telegram service start` | Acquire lock, load state, begin long-polling |
| `telegram service stop` | Graceful shutdown (SIGTERM/SIGINT) |
| `telegram service status` | Running state, PID, engine, bot identity, timeline summary, latest crew run |
| `telegram service restart` | Stop + start with clean consumer reset |
| `telegram service restart --all` | Restart every configured instance; `start`, `stop`, `status`, and `doctor` also accept `--all` |
| `telegram service restart --instance <name> --defer` | Schedule a one-shot detached restart after the current reply, useful when a bot needs to restart itself |
| `telegram service logs` | Tail stdout/stderr logs |
| `telegram service doctor` | Health check across all subsystems, including timeline, crew state, shared engine env, and stale launchd leftovers |
| `lark service restart --all` | Restart every configured Lark instance; when run inside an active Lark turn, defer the current instance until after the reply |
| `telegram engine [codex\|claude\|antigravity]` | Switch AI engine per instance |
| `telegram yolo [on\|off\|unsafe]` | Toggle auto-approval mode |
| `telegram usage` | Show token usage and estimated cost |
| `telegram verbosity [0\|1\|2]` | Store the legacy verbosity setting; current process runtimes use typing actions plus timeline/audit events |
| `telegram budget [show\|set\|clear]` | Per-instance cost cap (blocks requests when exceeded) |
| `telegram timeline` | Inspect structured lifecycle events with filters |
| `telegram instance [list\|rename\|delete]` | Manage instances from the CLI |
| `telegram backup [--instance <name>]` | Archive instance state to `.cctb.gz` |
| `telegram restore <archive>` | Restore instance from backup (with `--force` to overwrite) |
| `telegram logs rotate` | Manually trigger log rotation |
| `telegram dashboard` | Generate and open an HTML status dashboard with timeline and latest crew snapshot |
| `telegram help` | Show all available commands |

All commands accept `--instance <name>` to target a specific bot.

When `telegram service restart --all` is run from inside an active bot turn, the current instance is restarted last through a one-shot detached helper so the reply can finish before the bot kills its own process. `telegram service stop --all` still skips the current instance; stop it from a terminal if needed.

For Lark fleets, use `lark service restart --all` instead of hand-written restart loops. The Lark command applies the same self-safe pattern: non-current Lark instances restart immediately, while the Lark instance handling the active turn is scheduled through the deferred helper.

## Stable Beta Commands

- `telegram service doctor --instance <name>`
- `telegram session list --instance <name>`
- `telegram session inspect --instance <name> <chat-id>`
- `telegram session reset --instance <name> <chat-id>`
- `telegram task list --instance <name>`
- `telegram task inspect --instance <name> <upload-id>`
- `telegram task clear --instance <name> <upload-id>`

Telegram users can also use:

- `/status`
- `/engine [claude|codex|kimi|antigravity]` — switch engine for the current instance (the bridge resets stale bindings automatically)
- `/effort [low|medium|high|xhigh|max|ultra|off]` — set reasoning effort level; Kimi applies only ACP-advertised thinking values, and other engines still enforce their own model-specific limits
- `/model [name|off]` — switch model for Codex/Claude/Kimi; Kimi validates ACP-advertised provider values on the next turn, while Antigravity explains the `agy --print` limitation
- `/fast [on|off|status]` — toggle Codex Fast Mode. Treat it as experimental in bridge instances; if Codex runtime failures appear, use `/fast off`, avoid repeated retries, then restart the instance once if the next simple turn still fails.
- `/goal <completion condition>` — set an engine goal. Goals default to no token budget unless you provide `--budget`; Codex stores the budget structurally, while Claude Code and Antigravity receive explicit budgets as native goal guidance. Kimi ACP 0.31.1 does not expose goals, so the bridge rejects this command explicitly.
- `/btw <question>` — ask a side question without affecting the current session
- `/ask <instance> <prompt>` — delegate to a specific peer bot
- `/fan <prompt>` — query current bot plus configured parallel bots
- `/chain <prompt>` — run the configured sequential bot chain
- `/verify <prompt>` — execute locally, then auto-review with the verifier bot
- `/resume` — scan/pick Claude, Kimi, or Antigravity sessions according to the current engine; Codex uses `/resume thread <thread-id>`, and Kimi also accepts `/resume session <session-id>`
- `/detach` — detach from a resumed Claude/Kimi session, current Codex thread, or current Antigravity conversation; restore the pre-resume conversation when one exists
- `/stop` — immediately stop the current running task
- `/continue` — resume the latest waiting archive summary
- `/compact` (Claude/Kimi — native context compression; Codex falls back to reset)
- `/context` (Claude only) — show current context fill level; use it to decide when to `/compact`
- `/ultrareview` (Claude Opus 4.7+ only) — dedicated code-review pass, typically paired with `/resume` into a local project
- `/reset`
- `/help`

For archive summaries, the intended continuation path is to reply to that summary or press its Continue Analysis button; bare `/continue` only resumes the latest waiting archive.

Recovery behavior on unreadable state:

- `telegram service status` and `telegram service doctor` degrade to `unknown (...)` warnings instead of crashing when `session.json`, `file-workflow.json`, `timeline.log.jsonl`, or `crew-runs/` state is unreadable.
- `telegram session inspect` and `telegram task inspect` report unreadable state and stop instead of pretending the record is missing.
- `telegram session reset`, `telegram task clear`, and Telegram `/reset` only self-heal corruption/schema-invalid state. Before writing a default empty file, the unreadable original is quarantined as a backup beside the state file.
- Telegram `/status` shows `unknown (...)` for session/task state when the backing JSON is unreadable.

### Shell Helpers

**Windows (PowerShell):**

```powershell
.\scripts\start-instance.ps1 [-Instance work]
.\scripts\status-instance.ps1 [-Instance work]
.\scripts\stop-instance.ps1 [-Instance work]
```

**macOS / Linux (bash):**

```bash
./scripts/start-instance.sh [work]
./scripts/status-instance.sh [work]
./scripts/stop-instance.sh [work]
```

Legacy cleanup after older autostart builds:

```bash
bash scripts/cleanup-legacy-launchd.sh --all
```

Claude auth smoke test:

```bash
npm run smoke:claude-auth
```

Shared engine env rule:

- `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are only forwarded when you explicitly export them.
- If you change either one, restart the affected instance from that same shell.
- `telegram service doctor` now flags both shared-env mismatches and stale launchd plists.

---

## Access Control

Per-instance, two layers: **pairing** + **allowlist**.

Default behavior is intentionally conservative:

- One instance is locked to **one Telegram chat by default**
- A second chat will not be paired or allowlisted unless you explicitly enable multi-chat
- This keeps `/resume`, workspace overrides, local files, and session state from bleeding across chats by accident

```bash
npm run dev -- telegram access pair <code>
npm run dev -- telegram access policy allowlist
npm run dev -- telegram access allow <chat-id>
npm run dev -- telegram access revoke <chat-id>
npm run dev -- telegram access multi on
npm run dev -- telegram access multi off
npm run dev -- telegram status [--instance work]
```

Use `telegram access multi on --instance <name>` only when you really want one bot instance to serve multiple chats. New and legacy instances both default to `off` unless you explicitly change it.

### Telegram Groups And Topics

Group usage has a second allow layer: the Telegram user must already be authorized, and the group chat must be explicitly allowed from inside that group:

```text
/group status
/group allow
/group deny
/group on
/group off
/group all
/group at
```

By default, ordinary group messages are ignored unless they mention the bot username or reply to one of the bot's messages. Slash commands still work. Use `/group all` inside a group if you want that allowed group to behave like an always-listening shared chat; use `/group at` in the same group to return to the safer default. For `/group all` to hear ordinary messages, promote the bot to admin in that group so Telegram actually delivers ordinary group messages to it. BotFather privacy mode can also affect delivery, but group admin is the practical setup path. Unauthorized group messages are silent and only audited, so strangers cannot make the bot spam a group.

Forum topics are isolated conversations: each topic gets its own engine session and cron scope. Within the same topic, authorized users share that topic's session context; use a separate topic when you want a separate temporary conversation.

### Lark Groups And Threads

Lark private chats are paired through `lark access`. The private main timeline uses `lark:<chat_id>`, while a private thread carrying `thread_id` uses `lark:<chat_id>:<thread_id>` and gets its own engine session, queue, goal, cron route, and card callbacks. Access checks still use the parent private chat, so opening a thread never bypasses pairing.

For groups, topic form (`chat_mode=topic` or `group_message_type=thread`) isolates each topic; conversation form (`group_message_type=chat`) deliberately shares one group session even when a message is a reply/thread. Authorized Lark users can enable a group from inside that group, matching Telegram's self-service group setup:

```text
/group status
/group allow
/group deny
/group on
/group off
/group all
/group at
```

By default, ordinary Lark group messages must mention the bot, but explicit slash commands are still accepted so authorized users can recover with commands such as `/group on`. Use `/group allow` to authorize the current group, `/group all` to let ordinary group messages enter the bridge queue, and `/group at` to return to the safer mention-only mode. Both switches are stored against the base group and therefore apply across all topics in that group. `/newgroup` and `/newtopic` automatically authorize the created group, but intentionally leave it in mention-only mode. Trigger mode is stored in the Lark state directory as `lark-group-mode.json`, while allowed Lark group numeric ids are stored in the Lark instance config; neither affects Telegram `groupMode`. `/group all` also requires the Feishu/Lark app scopes `im:message` and `im:message.group_msg`; `lark doctor` and `lark provision` report those scopes explicitly when the app is still mention-only at the platform layer and print a compact bulk-import JSON for missing scopes. The QR wizard may create a working PersonalAgent app without that ordinary-group scope, so add it manually or by permission import if you need non-mention group traffic.

---

## Audit Trail

Per-instance append-only JSONL log with filterable queries:

```bash
npm run dev -- telegram audit [--instance work]
npm run dev -- telegram audit 50                                    # Last 50 entries
npm run dev -- telegram audit --type update.handle --outcome error  # Filter by type/outcome
npm run dev -- telegram audit --chat 688567588                      # Filter by chat
```

`audit.log.jsonl` records **what the bridge did** — `update.handle`, `bus.reply`, `budget.blocked` — one line per external action, rotated at 10MB.

### Timeline

Parallel to audit, the bridge emits a **lifecycle** stream (`timeline.log.jsonl`) describing the shape of each turn — `turn.started`, `turn.completed`, `budget.threshold_reached`, `crew.stage.*`, bus delegations, etc. Same JSONL shape, different axis:

```bash
npm run dev -- telegram timeline [--instance work]
npm run dev -- telegram timeline --type turn.completed --outcome error
npm run dev -- telegram timeline --chat 688567588 --limit 100
```

Think of it this way: audit answers *"what action did we take"*, timeline answers *"how did this turn go"*. `telegram service status` and `telegram dashboard` pull summaries from timeline.

---

## State Layout

```
# Windows: %USERPROFILE%\.cctb\<instance>\
# macOS/Linux: ~/.cctb/<instance>/

<instance>/
├── agent.md                # Bot personality & instructions
├── config.json             # Engine, YOLO mode, verbosity, bus
├── usage.json              # Token usage and cost tracking
├── workspace/              # Per-bot working directory
│   └── CLAUDE.md           # Claude Code project instructions (Claude only)
├── .env                    # Bot token
├── access.json             # Pairing + allowlist data
├── session.json            # Chat-to-thread bindings
├── file-workflow.json      # Pending file-upload follow-ups
├── runtime-state.json      # Watermarks, offsets
├── instance.lock.json      # Process lock
├── audit.log.jsonl         # Structured audit stream (rotates to .1, .2, ...)
├── timeline.log.jsonl      # Lifecycle events (turn.started, budget.*, crew.stage.*)
├── crew-runs/              # Coordinator-led crew run state (coordinator only)
│   └── <run-id>.json
├── service.stdout.log      # Service stdout
├── service.stderr.log      # Service stderr
└── inbox/                  # Downloaded attachments
```

---

## Development

```bash
npm run dev -- <command>     # Development mode
npm test                     # Run tests
npm run test:watch           # Watch mode
npm run build                # Build for production
npm start                    # Start production build
```

---

## Docker

```bash
# Build
docker build -t tarocub .

# Run (configure first, then start)
docker run -v ~/.cctb:/root/.cctb tarocub telegram configure <token>
docker run -v ~/.cctb:/root/.cctb tarocub telegram service start
```

Mount `~/.cctb` to persist state across container restarts.

---

## Troubleshooting

<details>
<summary><strong>Bot does not reply</strong></summary>

1. Run `telegram service doctor --instance <name>` to diagnose
2. Check `telegram service logs` for errors
3. Verify the engine is installed: `codex --version`, `claude --version`, or `agy --help`
4. If the instance uses Claude, run `npm run smoke:claude-auth`
5. If `service doctor` reports `legacy-launchd`, clean it with `bash scripts/cleanup-legacy-launchd.sh --all`

</details>

<details>
<summary><strong>Codex Fast Mode causes engine-runtime failures</strong></summary>

Fast Mode is a Codex CLI feature, but in unattended bridge instances it can surface upstream Codex diagnostics such as plugin warm-cache or Cloudflare challenge failures. The bridge preserves a completed assistant response when Codex only reports non-blocking plugin diagnostics, but real Codex errors still fail the turn.

1. Send `/fast off` in the affected bot.
2. Try one simple message such as `hi`.
3. If it still fails, restart that bot instance once after the current turn is idle.
4. Avoid force-restarting the same bot while it is generating a reply; that can kill the active Codex child process and appear as `codex exited with code null`.

</details>

<details>
<summary><strong>Claude works in Terminal but not in the bot</strong></summary>

1. Check shell auth first: `claude auth status`
2. Run `npm run smoke:claude-auth`
3. Run `telegram service doctor --instance <name>`
4. If you recently changed `CLAUDE_CONFIG_DIR`, restart the instance from that same shell
5. If `doctor` reports `legacy-launchd`, run `bash scripts/cleanup-legacy-launchd.sh --all`

More detail: [`docs/runtime-env-troubleshooting.md`](./runtime-env-troubleshooting.md)

</details>

<details>
<summary><strong>Switching to Claude engine</strong></summary>

1. `telegram engine claude --instance <name>`
2. Restart the service: `telegram service restart --instance <name>`
3. Optionally add a `CLAUDE.md` in the workspace directory

</details>

<details>
<summary><strong>Bot sends duplicate replies</strong></summary>

A 409 Conflict means two processes are polling the same bot token. The service auto-detects this and shuts down. Run `telegram service status` to check, then `telegram service stop` and `telegram service start` to clean restart.

</details>

<details>
<summary><strong>agent.md changes not taking effect</strong></summary>

No restart needed — loaded fresh on every message. Verify path with `telegram instructions path --instance <name>`.

</details>

---

## Optional: Run a Local Supervisor Agent

This project is already usable, but it is still evolving quickly. If you run several instances on one machine, a **local supervisor agent** can be a practical extra safety layer. This is optional, not required.

Use it for:
- checking instance health
- reading `service status` / `service doctor` / timeline before you touch anything
- restarting only the affected instance when something is clearly down
- reporting what happened instead of silently changing config

Do **not** use it as a second product agent. Its job should be operations only: monitor, diagnose, restart, and report.

### Suggested Brief

You can give a local supervisor agent a brief like this:

```text
You are the local operations supervisor for TaroCub on this machine.

Your job is to keep bot instances healthy and easy to diagnose.

Primary responsibilities:
1. Check instance health
2. Diagnose failures before taking action
3. Restart only the affected instance when needed
4. Report conclusions, evidence, and actions clearly

Default operating rules:
- Assume one instance serves one chat unless the instance is explicitly configured for multi-chat.
- Do not change engine, model, yolo/approval mode, pairing, access, or multi-chat unless the user explicitly asks.
- Do not clear tasks unless the user explicitly asks, or the task is confirmed stale and the user already approved cleanup.
- Do not edit project code or README unless the user explicitly asks.
- Prefer the smallest recovery action. Do not restart all instances unless necessary.

Default diagnostic order:
1. Check service status
2. Check service doctor
3. Check recent timeline/audit evidence
4. Check stdout/stderr logs only if needed
5. Decide whether the issue is:
   - process not running
   - engine/runtime failure
   - Telegram delivery failure
   - stale task/workflow residue
   - auth/config problem
6. Then decide whether a restart is justified

Preferred commands:
- `node dist/src/index.js telegram service status --instance <name>`
- `node dist/src/index.js telegram service doctor --instance <name>`
- `node dist/src/index.js telegram timeline --instance <name>`
- `bash scripts/start-instance.sh <name>`
- `bash scripts/stop-instance.sh <name>`

Response format:
- Conclusion
- Evidence
- Action taken or recommended
```

If you already use a local agent such as Hermes, that is a good fit for this role.

---

## License

[MIT](../LICENSE)

---

<p align="center">
  <sub>Your agents. Your engines. Your rules.</sub>
</p>
