<p align="center">
  <strong>English</strong>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="./README.zh-CN.md"><strong>中文文档</strong></a>
</p>

<p align="center">
  <img src="./assets/github-banner.png" alt="CC Telegram Bridge" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/cloveric/cc-telegram-bridge/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cloveric/cc-telegram-bridge?style=flat-square&color=818cf8" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D4?style=flat-square&logo=node.js&logoColor=white" alt="Windows | macOS | Linux">
  <img src="https://img.shields.io/badge/engines-Codex%20%7C%20Claude%20%7C%20Antigravity-F97316?style=flat-square" alt="Codex | Claude | Antigravity">
  <img src="https://img.shields.io/badge/tests-Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest">
</p>

<h3 align="center">
  A Telegram-first control plane for your local Codex, Claude Code, and Antigravity CLIs.<br>
  Resume desktop sessions from your phone, move files both ways, run scheduled work, and optionally expose the same bridge through Feishu/Lark.
</h3>

<p align="center">
  <a href="#start-here">Start Here</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#what-it-gives-you">What You Get</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#product-boundary">Boundary</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#core-workflows">Workflows</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#live-web-search-mcp-brave--tavily">Search MCP</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#agent-bus">Agent Bus</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#service-operations">Ops</a>
</p>

## Start Here

**cc-telegram-bridge is not another hosted agent UI.** It runs the real Codex, Claude Code, and Antigravity CLIs on your machine, then gives them a durable Telegram interface: access control, file delivery, voice transcription, scheduled tasks, session resume, multi-bot routing, and auditable long-running work.

The easiest setup path is to clone this repo, open it in Codex, Claude Code, or Antigravity, and tell the agent: *"read the README and configure a Telegram bot for me"*. The bridge is designed to be installed and operated by the same CLI agents it exposes.

```bash
npm install
npm run build
npm run dev -- telegram configure <telegram-bot-token>
npm run dev -- telegram yolo on
npm run dev -- telegram service start
```

Then send a message to the bot, run the pairing command it gives you, and continue from Telegram. See [Quick Start](#quick-start) for the full walkthrough.

> **Recommended runtime:** enable YOLO mode for hands-free Telegram instances you control: `telegram yolo on --instance <name>`. With YOLO off, the bridge can ask for approval in Telegram instead: Claude approvals are per tool request; Codex approvals are per turn because `codex exec` does not support mid-turn approval callbacks. Use unsafe modes only on a trusted machine and workspace.

## What It Gives You

| Capability | What it means in practice |
|---|---|
| **Remote control for real CLIs** | Put Codex, Claude Code, or Antigravity on Telegram without wrapping them in a fake chat backend. |
| **Session continuity** | Resume local Claude sessions, attach Codex threads, and bind Antigravity conversations from your phone, then continue on desktop later. |
| **Multimodal Telegram I/O** | Send files, images, generated artifacts, voice messages, and audio documents through one bridge protocol. |
| **Durable operations** | Keep cron jobs, audit logs, timeline logs, usage tracking, access checks, and service restart tooling outside model memory. |
| **Source-traceable research** | Use the optional Brave/Tavily MCP for `web_search`, `web_extract`, provider status, fallback notices, and source logs. |
| **Multi-agent coordination** | Use Agent Bus for instance-to-instance delegation, Mini Bus for topic-to-topic workflows, and Board for durable Kanban tasks. |
| **Feishu/Lark channel preview** | Reuse the same bridge runtime from Feishu/Lark via the official Lark Channel SDK, with streaming cards, stop buttons, approvals, and file/media delivery tags. |

## Feishu / Lark Channel Preview

Telegram remains the mature primary channel. Feishu/Lark support is a second entrypoint that reuses the same engine adapters, sessions, workspace, `agent.md`, approval model, and file-delivery tags.

```bash
npm run build
node dist/src/index.js lark wizard   # scan to create/bind a PersonalAgent app
node dist/src/index.js lark status
node dist/src/index.js lark doctor
node dist/src/index.js lark run
```

`lark wizard` uses the official Lark SDK PersonalAgent registration flow, prints a QR code, writes credentials to `~/.cctb/lark/lark.env` (or `CCTB_LARK_STATE_DIR/lark.env`), then checks the app for the bridge surface: message receive events, card callbacks, bot message/resource scopes, and Feishu Docs scopes. If the app has management permission, the wizard patches event/callback subscriptions; otherwise it reports the exact management scope needed. Environment variables still win if you prefer manual credentials:

```bash
export LARK_APP_ID="cli_xxx"
export LARK_APP_SECRET="..."
```

Optional environment:

| Variable | Meaning |
|---|---|
| `CCTB_LARK_STATE_DIR` | State/workspace directory for the Lark service. Defaults to `~/.cctb/lark`. |
| `CODEX_TELEGRAM_INSTANCE` | Instance name used by the shared engine config. Defaults to `lark`. |
| `LARK_DOMAIN` | Override Lark/Feishu API domain when needed. |
| `LARK_REQUIRE_MENTION_IN_GROUP` | Defaults to `true`; group messages must mention the bot unless disabled. |

The Lark channel currently supports:

- inbound p2p/group messages normalized into the same `Bridge.handleAuthorizedMessage` path, protected by the same pairing/allowlist access store as Telegram;
- topic/thread isolation through `conversationKey`;
- streaming interactive cards with a Card 2.0 callback stop button;
- approval cards for engine permission requests, with callback operators checked against bridge access policy before resolving;
- inbound image/file resources downloaded into the bridge workspace;
- outbound `[send-file:/abs/path]`, `[send-image:/abs/path]`, `send.audio`, `send.video`, and `send.batch` tool tags delivered back to Lark;
- rich Feishu posts through `lark.post` tool tags when plain Markdown is too limiting;
- custom interactive cards through `lark.card` tool tags, with button clicks fed back into the same bridge session;
- Feishu Docs creation through `lark.doc.create` for long specs and reviewable documents;
- merged forwarded Feishu messages preserved as `<forwarded_lark_messages>` task context for one-click handoff workflows;
- a per-state-dir service lock, so accidental duplicate `lark run` processes do not double-consume the same Lark events;
- timeline entries with `channel=lark`, so `telegram timeline --channel lark` and `lark status` diagnostics can separate Lark traffic from Telegram traffic.

Access control is intentionally shared with the existing bridge store. If a private Lark chat is not paired, the bot replies with the pairing/allowlist instruction instead of running the engine. For now, use the existing `telegram access ...` CLI to manage the shared store for the Lark state dir/instance; dedicated Lark aliases may be added later.

Lark-specific tool tags use the same compact JSON tag shape as Telegram side-channel tools:

```text
[tool:{"name":"lark.card","payload":{"title":"Choose","body":"What next?","actions":[{"label":"Continue","value":"continue"}]}}]
[tool:{"name":"lark.doc.create","payload":{"title":"Spec","content":"# Spec\n\nBody","docFormat":"markdown"}}]
[tool:{"name":"send.video","payload":{"path":"/absolute/path/demo.mp4"}}]
```

For raw `lark.card` payloads, bridge decorates ordinary button elements with Card 2.0 `behaviors: [{type:"callback", value: ...}]` routing metadata when a conversation is available. If you already provide callback metadata, that explicit payload is preserved.

`lark-cli` is useful inside agent turns for Feishu Docs/IM/Calendar operations, but it is not used as the inbound bot transport. Long-connection message delivery uses `@larksuiteoapi/node-sdk` because it exposes normalized message events, card callbacks, streaming cards, and media helpers directly.

## Product Boundary

| This project is | This project is not |
|---|---|
| A local bridge that exposes existing Codex, Claude Code, and Antigravity installations through Telegram and optionally Feishu/Lark. | A hosted SaaS agent platform or a replacement for Codex/Claude Code/Antigravity. |
| A control plane for sessions, files, approvals, scheduled tasks, and multi-agent routing. | A model provider, inference server, or standalone LLM runtime. |
| A practical ops layer for people who already use CLI agents heavily. | A generic chatbot framework for every messaging platform. |
| A place to keep delivery receipts, audit trails, and task state out of fragile prompts. | A promise that models will always finish tasks correctly without review. |

## Core Workflows

| Workflow | Entry point |
|---|---|
| **Personal mobile copilot** — talk to your local Codex/Claude/Antigravity while away from the computer. | [Quick Start](#quick-start), [Session Resume](#session-resume-codex-threads-and-antigravity-conversations) |
| **Research assistant** — search, extract exact URLs, preserve source logs, and return files to Telegram. | [Search MCP](#live-web-search-mcp-brave--tavily), [File Delivery](#file-delivery-from-agent-tasks) |
| **Topic-based mini crew** — use Telegram forum topics as planner/writer/reviewer peers in one group. | [Mini Bus](#mini-bus-topic-to-topic-workflows), [Telegram Groups And Topics](#telegram-groups-and-topics) |
| **Durable project board** — keep tasks, dependencies, runs, WIP limits, and review gates outside model context. | [Board](#board-durable-kanban-tasks) |
| **Multi-bot agent bus** — delegate work across isolated bot instances with health checks and versioned local protocol. | [Agent Bus](#agent-bus), [Crew Workflows](#crew-workflows-hub-and-spoke) |

## Release Highlights

- **v4.6.44** — teaches `lark wizard` to provision-check the app after QR registration: it verifies required scopes, requests admin approval for configured-but-unauthorized scopes, patches websocket event/callback subscriptions when app-management permission is available, and otherwise reports the missing management scope.
- **v4.6.43** — fixes Feishu/Lark wizard domain handling so saved `LARK_DOMAIN=feishu|lark` values map to the official SDK domains at runtime and to the correct account registration hosts during QR setup.
- **v4.6.42** — adds `lark wizard`, a QR-code PersonalAgent registration flow that saves Feishu/Lark app credentials to `lark.env` and lets `lark status/doctor/run` auto-load them.
- **v4.6.41** — aligns Feishu/Lark interactive cards with Card 2.0 callback `behaviors`, access-checks card operators before stop/approval/choice actions, and splits Lark chat/user numeric ID maps to reduce collision blast radius.
- **v4.6.40** — hardens the Feishu/Lark channel preview with a single-service lock, safer user-facing errors, Lark ID collision detection, raw card button routing, stronger `lark status` diagnostics, and more tolerant Feishu Docs CLI output parsing.
- **v4.6.39** — adds the Feishu/Lark channel preview: official Lark Channel SDK long connection, bridge runtime reuse, streaming/approval/custom cards, rich posts, Feishu Docs creation, merged-forward context, inbound resources, timeline diagnostics, and outbound file/media tags.
- **v4.6.22** — adds Antigravity CLI as a third backend engine, including Telegram `/engine antigravity`, YOLO/full-auto process execution, `/goal` passthrough, safe `/model` guardrails for print mode, conversation auto-binding, and `/resume conversation <id>`.
- **v4.6.18** — normalizes `/goal@botname` in Telegram groups so native engines receive a plain `/goal` command while Codex keeps structured goal handling.
- **v4.6.17** — passes Claude Code `/goal` through from Telegram instead of treating goals as Codex-only.
- **v4.6.16** — completes Telegram audio handling: direct `voice`, direct `audio/.m4a`, audio-like documents, and quoted audio documents all go through the same ASR transcription path.
- **v4.6.14** — hardens `/stop` and service restart cleanup so stale duplicate processes cannot keep typing or sending files after a restart.
- **v4.6.10** — promotes the optional Brave/Tavily Search MCP into a release-ready research add-on with `sourceLog`, provider metadata, fallback notices, `web_extract`, `provider_status`, and `health_check`.
- **v4.6.2** — adds `/board` durable Kanban tasks and `/mini` topic-to-topic workflows for same-group planner/writer/reviewer style coordination.

**Upgrading existing generated instance instructions:** refresh generated `agent.md` blocks after updating so old bots get the latest compact Telegram Transport block:

```bash
telegram instructions upgrade --all --dry-run
telegram instructions upgrade --all
telegram service restart --all
```

Use `--force` only for instances with a custom transport block you intentionally want to replace. Forced replacements create an `agent.md.bak.<timestamp>` backup next to the original file.

---

## Why This Bridge

- **Native CLI first.** The bridge runs the real Codex, Claude Code, and Antigravity CLIs, so local auth, project files, approvals, and engine-specific behavior remain the same as on your desktop.
- **Resume desktop work from anywhere.** Pick up an existing local Codex or Claude Code session from Telegram, send files or instructions while away, then continue the same project back on the desktop. Antigravity conversations are auto-bound after a successful turn and can also be attached with `/resume conversation <id>`.
- **Group topics become clean side conversations.** A single bot can serve private chat plus allowed Telegram groups; forum topics get separate sessions and cron scopes, so throwaway tasks and scheduled work do not pollute the main conversation. Topic peers can also be composed into a Mini Bus for same-group fan-out, chain, verify, or crew workflows, while `/board` keeps durable Kanban task state outside model memory.
- **Multi-engine without separate playbooks.** Each bot can choose Codex, Claude, or Antigravity while file delivery and scheduled tasks still go through the same schema-backed `[tool:{...}]` bridge protocol.
- **Telegram features live in the bridge, not in model memory.** File sending, cron persistence, receipts, access checks, and retries are handled by bridge code, so tasks keep working across model changes, restarts, and resumed sessions.
- **Short prompts, stable instructions.** Transport rules live in instance-level `agent.md`; per-turn prompts stay small and do not need request ids, temp directories, or side-channel secrets.
- **Receipts over claims.** File delivery and scheduled-task creation produce structured accepted/rejected receipts, so "done" only counts when the bridge actually delivered or scheduled something.
- **Operable by default.** Timeline logs, audit logs, doctor, dashboard, usage tracking, cron state, and generated-instruction upgrades make failures visible and recovery repeatable.

---

## Multi Engine: Codex + Claude Code + Antigravity

Each bot instance can run **OpenAI Codex**, **Claude Code**, or **Antigravity CLI** as its backend. Switch engines per-instance with one command:

```powershell
# Set an instance to use Claude Code
npm run dev -- telegram engine claude --instance review-bot

# Set another to use Codex
npm run dev -- telegram engine codex --instance helper-bot

# Set another to use Antigravity
npm run dev -- telegram engine antigravity --instance agy-bot

# Check current engine
npm run dev -- telegram engine --instance review-bot
```

Selecting Antigravity automatically sets that instance to YOLO/full-auto unless it was already in the explicit `bypass` mode, because `agy --print` is non-interactive in Telegram. Antigravity model selection is still owned by the native interactive CLI. `agy --print` does not run the interactive `/model` parser, so Telegram `/model` is handled locally with an explanation instead of being forwarded as a chat prompt. Set the model in local interactive `agy` until the CLI exposes a non-interactive model API.

| Feature | Codex Engine | Claude Engine | Antigravity Engine |
|---|---|---|---|
| CLI command | `codex exec --json` | `claude -p --output-format json` | `agy --print` |
| Session resume | `codex exec resume --json <id>` | `claude -p -r <session-id>` | Auto-binds the first logged conversation; `/resume` scans recent agy logs; `/resume conversation <id>` uses `agy --conversation` |
| Project instructions | `agent.md` (prepended to prompt) | `agent.md` (via `--system-prompt`) + `CLAUDE.md` (auto-loaded from workspace) | `agent.md` (prepended to prompt) |
| Streaming / early delivery | JSON stream events feed timeline and early file delivery | Claude stream events feed timeline and early file delivery | stdout chunks feed timeline and early file delivery when `agy --print` streams output |
| Telegram approval when YOLO is off | Pre-approve the turn, then run that turn with `--full-auto` | Inline approval buttons for Claude permission prompts | Pre-approve the turn, then run that turn with `--dangerously-skip-permissions` |
| YOLO mode | `--full-auto` / `--dangerously-bypass-approvals-and-sandbox` | `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` | `--dangerously-skip-permissions` |
| `/goal` | Bridge-native goal API with optional token budget | Passed through to Claude Code's native `/goal`; `--budget` becomes a native goal hint | Passed through to Antigravity's native `/goal`; `--budget` becomes a native goal hint |
| `/model` | Bridge config passed to Codex startup | Bridge config passed to Claude startup | Not available from Telegram in `agy --print`; use local interactive `agy /model` |
| `/compact` | Not needed (each exec is stateless) | Compresses session context to reduce token usage | Not supported by the bridge yet |
| Skills / plugins | Uses the configured Codex home; isolated homes symlink `skills/` back to the shared Codex skills dir | Uses the shared Claude config plus workspace `CLAUDE.md`, `skills/`, and `plugins/` | Uses Antigravity's own native CLI/plugin config. Reusable bridge skills should be shared as separate skill files/docs and referenced or copied per engine; each instance `agent.md` remains its own private instruction file. Do not import Claude/Codex native plugins into Antigravity unless you explicitly choose to. |
| Working directory | `workspace/` under instance dir | `workspace/` under instance dir (with `CLAUDE.md`) | `workspace/` under instance dir |
| Idle workers | Process exits after each turn | Stream workers are reaped after 30 minutes idle; sessions remain resumable | Process exits after each turn |

## Live Web Search MCP: Brave + Tavily

The bridge ships an optional local MCP server that gives Codex, Claude Code, and Antigravity the same source-traceable web research tools once each engine's own native MCP/plugin layer is configured:

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

Then restart affected bot instances so their Codex/Claude/Antigravity turns see the updated native MCP/plugin configuration. In unattended Codex process use, prefer YOLO/full-auto/bypass instances for MCP-heavy turns; plain non-interactive `codex exec` in read-only approval mode can cancel MCP calls instead of running them. More detail: [`docs/search-mcp.md`](./docs/search-mcp.md).

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
          │          cc-telegram-bridge              │
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

# Recommended: enable YOLO for Telegram/mobile use
npm run dev -- telegram yolo on --instance work

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
telegram send --chat 123456789 --file /absolute/path/to/report.pdf
telegram send --instance bot2 --chat 123456789 --image /absolute/path/to/image.png
```

Current delivery rules:

- Agents should use `[tool:...]` delivery tags for existing files, images, PDFs, decks, and other binary outputs. This is the only delivery tag format generated instance instructions teach.
- `[tool:...]` examples are generated from the registered tool schema/examples; explicit fenced `tool-call` blocks execute through the same parser.
- `cctb send` remains available for turn-scoped CLI workflows and is internally routed through the same send tool layer.
- Use `telegram send` when you need the same explicit delivery command outside an active turn, or when the turn-scoped `cctb` helper is unavailable.
- Explicit send commands accept any readable absolute file path.
- Legacy `[send-file:/absolute/path]` / `[send-image:/absolute/path]` tags are accepted only for older sessions and copied historical output. Do not use them in new agent instructions, system prompts, or examples.
- Small text/code files can still use the `file:name.ext` fenced-block form.
- The helper is scoped to one Telegram turn. It will not work after the turn finishes.
- Legacy fallback tags still validate that files live under the instance workspace or the active `/resume` project before sending.
- Accepted and rejected file deliveries are recorded as turn-level receipts, so the bridge can decide completion from structured delivery evidence instead of text claims.
- If a file was already sent by stream delivery or the side-channel helper, the final `.telegram-out` sweep skips that same real path to avoid duplicate Telegram attachments.
- Request-scoped `.telegram-out/<requestId>/` directories are runtime buffers and are pruned after 24 hours.
- The bridge no longer keeps manifest, pending-contract, or count-based state to infer future delivery intent across ordinary chat turns.
- Text-only tasks such as image analysis, image descriptions, or inline reports are not treated as file-delivery failures.

This works for Codex, Claude, Antigravity, process, and stream runtimes because the canonical path only requires the agent to emit text. File delivery is explicit: generate the file, emit the tool tag or call the send command, and rely on the resulting receipt.

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
```

One-shot `in` / `at` reminders default to direct Telegram notifications, so prompts such as `提醒我：给玉姐带尿布` are not sent back through the AI model at fire time. Recurring `cron` jobs default to AI-run tasks; set `deliveryMode:"notify"` for recurring plain reminders, or `deliveryMode:"agent"` when a one-shot scheduled item should run the AI.

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

For human operators, the CLI remains available for inspection and debugging, but generated `agent.md` instructions tell agents to use the `[tool:{...}]` layer so Claude/Codex/Antigravity process and stream runtimes behave consistently.

---

## YOLO Mode

For hands-free Telegram use, `telegram yolo on` is recommended. It keeps Codex/Claude/Antigravity moving without asking on each turn. If you keep YOLO off, the bridge will use Telegram approval buttons where the engine supports a headless path: Claude can approve individual permission prompts; Codex app-server mode maps YOLO settings to the app-server sandbox mode; Antigravity process mode gets a turn-level pre-approval. Keep `unsafe` for fully trusted local environments only.

Claude approval buttons use a short-lived localhost MCP bridge with a random URL token. This protects against blind local port scans, but the token is still visible to same-user local processes that can inspect process command lines. Treat YOLO-off approval as a single-user workstation convenience, not a multi-user isolation boundary.

```powershell
npm run dev -- telegram yolo on --instance work      # Safe auto-approve
npm run dev -- telegram yolo unsafe --instance work   # Skip ALL checks
npm run dev -- telegram yolo off --instance work      # Normal flow
npm run dev -- telegram yolo --instance work          # Check status
```

| Mode | Codex | Claude | Use case |
|---|---|---|---|
| `off` | Telegram pre-turn approval | Telegram tool approval | Default, safest |
| `on` | `--full-auto` | `--permission-mode bypassPermissions` | Mobile use |
| `unsafe` | `--dangerously-bypass-*` | `--dangerously-skip-permissions` | Trusted env only |

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

Claude reports exact USD cost. Codex reports tokens only (cost shows as "unknown").

---

## Turn Activity And Timeline

While a turn runs, the bridge sends Telegram typing actions and records structured events in `timeline.log.jsonl` / `audit.log.jsonl`. Long tool calls are not live-edited into the chat; inspect them with:

```bash
npm run dev -- telegram timeline --instance work
npm run dev -- telegram dashboard --instance work
npm run dev -- telegram service status --instance work
```

`telegram verbosity` is kept as a compatibility config knob, but the current Codex/Claude/Antigravity runtimes use typing actions plus timeline/audit events rather than live-editing partial model output into Telegram.

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

Send voice messages in Telegram — the bridge transcribes them locally before forwarding the text to the AI engine. No cloud ASR service required.

**How it works:**

1. User sends a voice message in Telegram
2. The bridge downloads the `.ogg` file
3. Transcribes it via a local ASR service (HTTP first, CLI fallback)
4. The transcript replaces the voice attachment as the user's text message
5. The AI engine processes it as a normal text request

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

To use a different ASR engine, modify the `createDefaultTranscribeVoice()` function in `src/telegram/message-input.ts`. The function receives the local path to an `.ogg` audio file and should return the transcribed text as a string.

---

## Session Resume, Codex Threads, and Antigravity Conversations

Started a task locally with Claude Code? Continue it on Telegram — no copy-paste, no re-explaining context. Using Codex or Antigravity instead? Attach an existing thread or conversation by ID and keep going from Telegram.

### Claude local session resume

```
/resume          ← Bot scans your local sessions from the past hour
```

The bot lists recent sessions with project names and timestamps:

```
Recent local sessions:
1. [cc-telegram-bridge] 64c2081c… (5m ago)
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

**Protocol v1** — every request and response is stamped with `protocolVersion`, declared `capabilities`, structured `errorCode`, and a `retryable` flag, so callers can tell transient failures (timeouts, unreachable peers) from terminal ones (disabled bus, peer not allowed). Legacy unversioned payloads are still accepted for rolling upgrades. Peer liveness is verified by probing `GET /api/health` and matching a `cc-telegram-bridge` fingerprint, so a reused local port cannot fake a live peer. Full spec: [`docs/bus-protocol.md`](./docs/bus-protocol.md).

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
- `/board review <id> <on|off> [reviewer]` — require review before `done`
- `/board approve <id>` / `/board reject <id> <reason>` — resolve tasks waiting in review
- `/board ready <id>` — move a task to ready if dependencies are complete
- `/board run <id>` — execute a ready task through its assignee; Mini Bus peers in the current group are preferred, otherwise the assignee is treated as an Agent Bus instance
- `/board start <id>` — mark a task running and create a lightweight run record
- `/board fail <id> <reason>` — close the active run as failed and block the task with the reason
- `/board runs <id>` — show run attempt history for one task
- `/board block <id> <reason>` / `/board unblock <id>` — manage blocked work
- `/board done <id> [summary]` — complete a task; dependents whose dependencies are all done are promoted to `ready`

This is not an autonomous dispatcher yet. It gives the bridge durable planning state first: richer task cards, WIP limits, run history, dependency promotion, review gates, and explicit one-task execution with `/board run <id>`. Automatic dispatch should build on this primitive rather than bypassing the task model.

### Mini Bus: topic-to-topic workflows

Inside an allowed Telegram group or forum, `/mini` lets one bot treat different topics as lightweight peers. Each peer keeps its own topic session, uses the same instance config and `agent.md`, and can be asked directly, queried in parallel, or chained sequentially. This is useful for temporary planning/review threads without creating new bot instances.

Use Mini Bus when you want separate working memory without separate bots:

- keep an `intake` topic for the coordinator and register `planner`, `writer`, `reviewer`, or `research` topics as peers
- run quick comparisons with `/mini fan`, where each peer answers the same prompt in parallel
- run staged work with `/mini chain`, where each topic receives the previous topic's output
- run a lightweight review loop with `/mini verify`
- run a fixed specialist workflow with `/mini crew research-report`

Prerequisites:

- the bot must be in an allowed Telegram group or forum topic
- if the group uses BotFather privacy mode, make the bot an admin so it can see ordinary group messages; otherwise mention/reply-to the bot or use commands
- register each topic from inside that topic with `/mini here <name>`

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

The practical benefit is isolation with low overhead: every topic has its own session and cron scope, but all topics share the same bot token, workspace, engine settings, budget tracking, approvals, timeline, and audit logs. That makes Mini Bus good for short-lived multi-agent work such as planning, drafting, review, research, or temporary cron/job conversations.

Mini Bus is intentionally scoped to the current Telegram group. It does not open another bot token or another workspace; if multiple topics edit the same files concurrently, the same workspace-conflict rules apply as any concurrent local agents.

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

> **TL;DR** — You only need to do two things on your phone: get a bot token from BotFather and send the pairing code. Everything else happens on your computer via Codex, Claude Code, or Antigravity CLI.

### Prerequisites

- **Node.js** >= 20
- **OpenAI Codex CLI**, **Claude Code CLI**, and/or **Antigravity CLI** installed and authenticated
- A **Telegram account** (phone)

### Step 1: Create a Telegram Bot (on your phone)

1. Open Telegram and search for **[@BotFather](https://t.me/BotFather)**
2. Send `/newbot`
3. Follow the prompts — give your bot a name and username
4. BotFather will reply with a **bot token** like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789`
5. Copy this token — you'll paste it in your terminal

### Step 2: Install & Configure (on your computer)

Open your terminal with Codex, Claude Code, or Antigravity, and tell it:

> *"Clone https://github.com/cloveric/cc-telegram-bridge and set up a Telegram bot with this token: `<paste your token>`"*

Or do it manually:

```bash
git clone https://github.com/cloveric/cc-telegram-bridge.git
cd cc-telegram-bridge
npm install
npm run build

# Configure with your bot token
npm run dev -- telegram configure <your-bot-token>

# Optional: switch engines (default is Codex)
npm run dev -- telegram engine claude
npm run dev -- telegram engine antigravity

# Recommended: enable YOLO mode for hands-free Telegram operation
npm run dev -- telegram yolo on

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

**Done!** You can now chat with Codex, Claude, or Antigravity from Telegram. Send text, voice messages, or files — the bot handles everything.

### Multiple Bots

```bash
# Create a second bot with BotFather, then:
npm run dev -- telegram configure --instance work <second-token>
npm run dev -- telegram engine claude --instance work
npm run dev -- telegram yolo on --instance work
npm run dev -- telegram service start --instance work
# Pair the same way: send a message, get the code, run `telegram access pair <code> --instance work`

# Or create a dedicated Antigravity bot
npm run dev -- telegram configure --instance agy-bot <third-token>
npm run dev -- telegram engine antigravity --instance agy-bot
npm run dev -- telegram yolo on --instance agy-bot
npm run dev -- telegram service start --instance agy-bot
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        cc-telegram-bridge                       │
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
    → Codex Exec, Claude -p, or agy --print (new or resume)
    → Typing action + timeline events → Final Render → Deliver → Audit
```

---

## Highlights

<table>
  <tr>
    <td width="50%">
      <h3>Three Native Engines</h3>
      <p>Switch between Codex, Claude Code, and Antigravity per instance. Mix and match — one bot on Codex, another on Claude, another on Antigravity, all managed from one CLI.</p>
    </td>
    <td width="50%">
      <h3>Per-Bot Personality</h3>
      <p>Each instance loads its own <code>agent.md</code> on every message. Claude instances also get <code>CLAUDE.md</code> project rules.</p>
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
      <p>Every instance has its own personality, workspace, sessions, access rules, inbox, audit trail, and workspace-keyed auto-memory. Each engine's own config dir (<code>~/.claude/</code> / <code>~/.codex/</code> / Antigravity's CLI config) is <em>shared</em> with your main CLI so OAuth refresh tokens don't race across instances — the trade-off is that that engine's native settings, plugins, and MCP state live in your real home, and full-auto / bypass mode can touch them.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Session Resume</h3>
      <p><code>/resume</code> picks up existing Claude Code local sessions, <code>/resume thread &lt;thread-id&gt;</code> attaches Codex threads, and <code>/resume conversation &lt;id&gt;</code> attaches Antigravity conversations, so you can continue desktop work from Telegram without losing context.</p>
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
      <p><code>/detach</code> returns to the pre-resume conversation when possible. Bridge instructions are injected per turn and are not written back into your local Claude, Codex, or Antigravity session files.</p>
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
      <p>Send voice messages — transcribed locally via pluggable ASR (e.g. Qwen3-ASR). HTTP server for fast inference, CLI fallback when offline.</p>
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
      <p>Local bot-to-bot calls speak a versioned <code>v1</code> protocol — <code>protocolVersion</code>, <code>capabilities</code>, structured <code>errorCode</code>, and a <code>retryable</code> flag so callers can tell transient failures from terminal ones. Peer liveness is a real <code>/api/health</code> probe, not just a PID check. See <a href="./docs/bus-protocol.md">docs/bus-protocol.md</a>.</p>
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
- `/engine [claude|codex|antigravity]` — switch engine for the current instance (the bridge resets stale bindings automatically)
- `/effort [low|medium|high|xhigh|max|off]` — set reasoning effort level (`max` is Claude-only; Codex uses `xhigh` instead)
- `/model [name|off]` — switch model for Codex/Claude; Antigravity explains the `agy --print` limitation and does not forward `/model` as chat
- `/fast [on|off|status]` — toggle Codex Fast Mode. Treat it as experimental in bridge instances; if Codex runtime failures appear, use `/fast off`, avoid repeated retries, then restart the instance once if the next simple turn still fails.
- `/goal <completion condition>` — set an engine goal. Codex also supports `/goal status`, `/goal clear`, and `--budget`; Claude Code and Antigravity pass through to their native `/goal` slash commands.
- `/btw <question>` — ask a side question without affecting the current session
- `/ask <instance> <prompt>` — delegate to a specific peer bot
- `/fan <prompt>` — query current bot plus configured parallel bots
- `/chain <prompt>` — run the configured sequential bot chain
- `/verify <prompt>` — execute locally, then auto-review with the verifier bot
- `/resume` — Claude: scan local sessions; Codex: use `/resume thread <thread-id>`; Antigravity: use `/resume conversation <conversation-id>`
- `/detach` — detach from resumed Claude session, current Codex thread, or current Antigravity conversation; restore the pre-resume conversation when one exists
- `/stop` — immediately stop the current running task
- `/continue` — resume the latest waiting archive summary
- `/compact` (Claude only — compresses context; Codex falls back to reset)
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
docker build -t cc-telegram-bridge .

# Run (configure first, then start)
docker run -v ~/.cctb:/root/.cctb cc-telegram-bridge telegram configure <token>
docker run -v ~/.cctb:/root/.cctb cc-telegram-bridge telegram service start
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

More detail: [`docs/runtime-env-troubleshooting.md`](./docs/runtime-env-troubleshooting.md)

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
You are the local operations supervisor for cc-telegram-bridge on this machine.

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

[MIT](./LICENSE)

---

<p align="center">
  <sub>Your agents. Your engines. Your rules.</sub>
</p>
