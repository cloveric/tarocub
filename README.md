<p align="center">
  <strong>English</strong>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="./README.zh-CN.md"><strong>中文文档</strong></a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="./docs/full-reference.md"><strong>Full Reference</strong></a>
</p>

<p align="center">
  <img src="./assets/github-banner.png" alt="CC Agent Bridge for Telegram and Feishu/Lark" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/cloveric/cc-telegram-bridge/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cloveric/cc-telegram-bridge?style=flat-square&color=818cf8" alt="License"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/engines-Codex%20%7C%20Claude%20Code%20%7C%20Antigravity-F97316?style=flat-square" alt="Codex | Claude Code | Antigravity">
  <img src="https://img.shields.io/badge/channels-Telegram%20%7C%20Feishu%2FLark-2563eb?style=flat-square" alt="Telegram | Feishu/Lark">
</p>

<h3 align="center">
  Local control plane for Codex, Claude Code, and Antigravity.<br>
  Run real CLI agents on your machine, operate them from Telegram or Feishu/Lark, and keep sessions, files, tasks, and audit logs durable.
</h3>

<p align="center">
  <a href="#quick-start">Quick Start</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#surfaces">Surfaces</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#core-highlights">Core Highlights</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#lark-setup">Lark Setup</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#operator-commands">Commands</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#docs">Docs</a>
</p>

## What This Is

`cc-telegram-bridge` is a local bridge, not a hosted agent product. It runs the real Codex, Claude Code, and Antigravity CLIs on your own computer, then gives them a durable messaging control surface.

It is built for people who already use CLI agents heavily and want:

- phone-first operation through Telegram;
- Feishu/Lark-native operation with cards, Docs comments, Sheets, and group workflows;
- durable state for sessions, cron jobs, file delivery, usage, timelines, audit logs, and multi-agent routing.

The old long README is preserved as [Full Reference](./docs/full-reference.md). This landing page is intentionally short.

## Quick Start

### Telegram

Create a Telegram bot with [@BotFather](https://t.me/BotFather), then run:

```bash
git clone https://github.com/cloveric/cc-telegram-bridge.git
cd cc-telegram-bridge
npm install
npm run build

npm run dev -- telegram configure <telegram-bot-token>
npm run dev -- telegram yolo on
npm run dev -- telegram service start
```

Send any message to the bot. It will reply with a pairing code:

```bash
npm run dev -- telegram access pair <pairing-code>
```

You can now talk to your local CLI agent from Telegram.

### Feishu / Lark

For the full Lark-native setup, install `lark-cli >= 1.0.41`, then run the wizard:

```bash
npm install
npm run build

node dist/src/index.js lark wizard
node dist/src/index.js lark cli preflight --install --identity bot-only
node dist/src/index.js lark doctor
node dist/src/index.js lark service start
```

If `lark doctor` reports missing app scopes, copy the JSON it prints into the Feishu/Lark app permission page, publish the app version, then run:

```bash
node dist/src/index.js lark provision
node dist/src/index.js lark doctor
```

## Surfaces

| Surface | Best for | Status |
|---|---|---|
| **Telegram** | Mobile control, voice input, file delivery, multi-bot operations, cron, Agent Bus | Primary and deepest-tested |
| **Feishu/Lark** | Team chat, interactive cards, Docs comments, Sheets/Docs/Drive workflows, group/thread workflows | Production-capable with `lark-cli` |
| **Local CLI** | Operations, setup, debugging, status, backups, direct sends | First-class operator interface |

## Core Highlights

| Highlight | Why it matters |
|---|---|
| **Real CLI engines, not a fake chat backend** | Codex, Claude Code, and Antigravity run as their native local CLIs, so your real auth, local files, project instructions, MCP/plugins, and engine behavior stay intact. |
| **Session Resume** | Continue existing work instead of starting over: Claude local sessions, Codex threads, and Antigravity conversations can be attached from chat and detached later. |
| **Telegram as a mobile control plane** | Talk to agents from your phone, send files and screenshots, record voice messages, approve work, stop stuck turns, inspect status, and restart instances. |
| **Feishu/Lark as a native work surface** | Lark adds what Telegram cannot: Card 2.0 choices, approval cards, Docs comment @mentions, Sheets/Docs/Drive workflows through `lark-cli`, `/newgroup`, and thread-aware group work. |
| **ASR for voice/audio/video** | Telegram and Lark voice/audio/video resources can be downloaded, locally transcribed, and passed into the engine as normal task context. |
| **File and artifact delivery** | Agents can return generated images, PDFs, reports, decks, source bundles, and other files through structured `send.file`, `send.image`, `send.batch`, audio, and video tags. |
| **Scheduled work and reminders** | `/cron` and `cron.add` persist one-shot reminders, recurring jobs, and agent-run scheduled tasks outside model memory, with chat/thread routing preserved. |
| **Agent Bus** | Multiple bot instances can call each other as local workers for delegation, fan-out, chain, verifier, and coordinator-led crew workflows. |
| **Mini Bus** | Telegram topics or Lark threads can become lightweight named peers, so one group can run planner/writer/reviewer-style workflows without separate bots. |
| **Board** | Durable Kanban state for tasks, dependencies, WIP, review gates, and execution history, instead of relying on a model to remember project state. |
| **Search MCP** | Optional Brave/Tavily MCP gives source-traceable `web_search`, `web_extract`, provider status, fallback notices, and source logs. |
| **Operational visibility** | `status`, `doctor`, `timeline`, `audit`, `dashboard`, usage tracking, service locks, and backups make failures inspectable instead of mysterious. |

## Feature Map

| Feature | Telegram | Feishu/Lark | Local CLI |
|---|---:|---:|---:|
| Codex / Claude Code / Antigravity engines | Yes | Yes | Yes |
| Session resume / detach | Yes | Yes | Yes |
| Voice, audio, and video ASR | Yes | Yes | Inspect/debug |
| File and image delivery | Yes | Yes | `telegram send` / `lark send` |
| Stop and approvals | Inline buttons | Interactive cards | Service controls |
| Plan Mode-style choices | Limited buttons | Rich choice cards | Tool/debug path |
| Cron reminders and agent jobs | Yes | Yes | Manage/list/run |
| Board durable tasks | Yes | Yes | Inspect/export |
| Agent Bus fan/chain/verify | Yes | Yes | Configure peers |
| Mini Bus topic/thread workflows | Telegram topics | Lark threads | Inspect state |
| Docs comments and Sheets workflows | Not applicable | Yes, with `lark-cli` | Provision/auth/doctor |
| Timeline, audit, dashboard, usage | Yes | Yes | Primary ops surface |

## Lark Setup

Lark has two levels:

| Level | What works |
|---|---|
| **SDK transport only** | Long-connection receive/send, access checks, ordinary replies, stop/approval cards, media intake. |
| **Full Lark-native mode** | Docs/Drive/Calendar/Sheets actions, `/newgroup`, document creation/auto-grant, user OAuth, richer agent workflows. Requires `lark-cli >= 1.0.41`. |

Recommended production flow:

```bash
node dist/src/index.js lark wizard
node dist/src/index.js lark cli preflight --install --identity bot-only
node dist/src/index.js lark auth start --recommend --domain docs,drive --scope "sheets:spreadsheet:create sheets:spreadsheet:write_only sheets:spreadsheet:read sheets:spreadsheet.meta:read"
node dist/src/index.js lark auth finish <device-code>
node dist/src/index.js lark doctor
node dist/src/index.js lark service restart
```

Useful Lark commands:

```bash
node dist/src/index.js lark status
node dist/src/index.js lark permissions --missing
node dist/src/index.js lark access pair <code>
node dist/src/index.js lark send --chat oc_xxx --message "hello"
node dist/src/index.js lark timeline 20
node dist/src/index.js lark dashboard
```

Inside Lark, the bot supports the same core slash surface as Telegram: `/status`, `/usage`, `/engine`, `/model`, `/effort`, `/fast`, `/yolo`, `/goal`, `/resume`, `/detach`, `/stop`, `/reset`, `/cron`, `/board`, `/mini`, `/fan`, `/chain`, `/verify`, `/group`, `/newgroup`, `/newtopic`, and `/continue`.

## Operator Commands

### Telegram

```bash
telegram service start --instance work
telegram service restart --all
telegram service status --all
telegram engine codex --instance work
telegram yolo on --instance work
telegram usage --instance work
telegram timeline --instance work
telegram dashboard --instance work
telegram backup --instance work --out ./work.cctb.gz
```

### Lark

```bash
lark service start
lark service restart
lark doctor
lark access status
lark cli identity status
lark auth status --verify
lark send --chat oc_xxx --message "hello"
```

### In-chat slash commands

```text
/status
/usage
/engine codex
/model gpt-5.5
/effort xhigh
/fast off
/goal ship this with tests
/resume
/detach
/stop
/cron list
/board
/mini
/fan compare these approaches
/verify implement and review this
```

## Current Release

- **v4.6.67** — closes a Lark runtime secret-boundary gap: runtime `lark-cli` child processes now get `LARK_CHANNEL=1` without inheriting `LARK_APP_SECRET`.
- **v4.6.66** — documents and surfaces the `lark-cli >= 1.0.41` floor for current document creation flags.
- **v4.6.65** — completes the Lark-native CLI layer for Docs, `/newgroup`, Sheets workflows, wizard/provisioning, and OAuth guidance.
- **v4.6.64** — makes reminder tool failures user-safe and prevents accidental reminder tags when the user did not ask to schedule anything.
- **v4.6.63** — adds `/newgroup` / `/newtopic`, forwarded-message expansion, Plan Mode choice cards, and Lark CLI production guidance.

See [GitHub Releases](https://github.com/cloveric/cc-telegram-bridge/releases) for the full changelog.

## Safety Model

The bridge is powerful because it controls local CLIs. Treat it like local automation, not a sandboxed SaaS bot.

- Run it only on machines and workspaces you trust.
- Use access pairing/allowlists before exposing private or group chats.
- Use YOLO/full-auto only for trusted instances.
- Keep app secrets in bridge state, not prompts, argv, or child-process env.
- Use `doctor`, `timeline`, `audit`, and `dashboard` before guessing at failures.

More detail: [Security Boundaries](./docs/security-boundaries.md), [State Model](./docs/state-model.md), and [Full Reference](./docs/full-reference.md).

## Docs

| Need | Link |
|---|---|
| Complete old README / full operations reference | [docs/full-reference.md](./docs/full-reference.md) |
| Release process | [docs/release-checklist.md](./docs/release-checklist.md) |
| Runtime architecture notes | [docs/architecture-notes.md](./docs/architecture-notes.md) |
| State files and persistence | [docs/state-model.md](./docs/state-model.md) |
| Security model | [docs/security-boundaries.md](./docs/security-boundaries.md) |
| Agent Bus protocol | [docs/bus-protocol.md](./docs/bus-protocol.md) |
| Search MCP setup | [docs/search-mcp.md](./docs/search-mcp.md) |
| Runtime env troubleshooting | [docs/runtime-env-troubleshooting.md](./docs/runtime-env-troubleshooting.md) |

## Development

```bash
npm install
npm run build
npm test -- --run
```

The project is TypeScript, Node.js >= 20, and Vitest. It stores runtime state under `~/.cctb/<instance>` for Telegram instances and `~/.cctb/lark` for the default Lark state dir.

## License

MIT
