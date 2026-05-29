<p align="center">
  <strong>English</strong>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="./README.zh-CN.md"><strong>中文文档</strong></a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="./docs/full-reference.md"><strong>Full Reference</strong></a>
</p>

<p align="center">
  <img src="./assets/github-banner.png" alt="TaroCub: local AI agents controlled from Telegram and Feishu/Lark" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/cloveric/tarocub/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cloveric/tarocub?style=flat-square&color=818cf8" alt="License"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/engines-Codex%20%7C%20Claude%20Code%20%7C%20Antigravity-F97316?style=flat-square" alt="Codex | Claude Code | Antigravity">
  <img src="https://img.shields.io/badge/channels-Telegram%20%7C%20Feishu%2FLark-2563eb?style=flat-square" alt="Telegram | Feishu/Lark">
</p>

<h1 align="center">TaroCub</h1>

<p align="center">
  <strong>Run Codex, Claude Code, and Antigravity locally. Control them from Telegram and Feishu/Lark.</strong><br>
  TaroCub runs real CLI agents on your own machine, then gives them durable chat surfaces, files, sessions, tasks, cron, audit logs, and multi-agent workflows.<br>
  Resume local sessions anytime from your phone, whether you are at your desk, commuting, or walking the dog.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#surfaces">Surfaces</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#core-highlights">Core Highlights</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#lark-setup">Lark Setup</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#operator-commands">Commands</a>&nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="#docs">Docs</a>
</p>

## What This Is

`TaroCub` is a local bridge, not a hosted agent product. It runs the real Codex, Claude Code, and Antigravity CLIs on your own computer, then gives them a durable messaging control surface across Telegram and Feishu/Lark.

This project was formerly named `cc-telegram-bridge`. The canonical repository is now `cloveric/tarocub`; GitHub redirects the old URL, and existing state directories plus the `cctb` shorthand remain supported for compatibility.

It is built for people who already use CLI agents heavily and want:

- phone-first operation through Telegram and Feishu/Lark;
- Feishu/Lark-native operation with cards, Docs comments, Sheets, and group workflows;
- durable state for sessions, cron jobs, file delivery, usage, timelines, audit logs, and multi-agent routing.

The intended setup flow is agent-assisted: clone the repo, open it in Codex, Claude Code, or Antigravity, and ask the agent to configure the bridge for you. The CLI exists so your local agent can do the boring setup work instead of making you hand-edit every file.

The old long README is preserved as [Full Reference](./docs/full-reference.md). This landing page is intentionally short.

## Quick Start

### Recommended: ask your local agent to configure it

Open this repository in Codex, Claude Code, or Antigravity and say:

```text
Read the README and configure TaroCub for me.
Use this Telegram bot token: <paste token>
Enable YOLO mode for my personal bot instance.
```

For Lark, say:

```text
Read the README and configure the Feishu/Lark bot for me.
Run the Lark wizard, check permissions, install/bind lark-cli, and tell me what I need to scan or approve.
```

That is the preferred path. Manual commands are still below for operators who want to see each step.

### Telegram

Create a Telegram bot with [@BotFather](https://t.me/BotFather), then run:

```bash
git clone https://github.com/cloveric/tarocub.git
cd tarocub
npm install
npm run build

npm run dev -- telegram configure <telegram-bot-token>
npm run dev -- telegram yolo unsafe
npm run dev -- telegram service start
```

`telegram yolo unsafe` is the recommended default for a personal, trusted bot instance. It maps to `approvalMode: "bypass"`: Codex runs with `--dangerously-bypass-approvals-and-sandbox`, Claude Code/Antigravity run with their unsafe skip-permissions flags, and the bridge will not ask for per-turn approval. Treat it as equivalent to bypassing the normal approval prompts and local sandbox. Use `telegram yolo off` only when you explicitly want approval prompts again.

Send any message to the bot. It will reply with a pairing code:

```bash
npm run dev -- telegram access pair <pairing-code>
```

You can now talk to your local CLI agent from Telegram.

### Feishu / Lark

For the full Lark-native setup, let the aggregate setup command install/bind `lark-cli >= 1.0.41`, run the QR wizard, provision permissions, and check the app:

```bash
npm install
npm run build

node dist/src/index.js lark setup --detached --install-cli --identity bot-only
node dist/src/index.js lark yolo unsafe
```

`--detached` is recommended when you are configuring from Telegram/Lark/Codex: it keeps the QR registration polling alive in tmux, prints one durable registration link, writes progress to `~/.cctb/<lark-instance>/lark-setup.log`, and starts the Lark service when setup completes. Use `--no-start-service` only when you explicitly want to prepare the app without listening yet.

New Telegram and Lark bot configs default to YOLO unsafe/bypass. The explicit `lark yolo unsafe` command is shown so readers understand this means bypassing normal approval prompts and local sandboxing for trusted personal bots.

If `lark doctor` reports missing app scopes, open the permission page URL it prints, bulk-import the JSON it prints, publish the app version, then run:

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
# Optional but recommended for each named Lark bot:
export CCTB_LARK_INSTANCE=ccfgg1

node dist/src/index.js lark setup --detached --install-cli --identity bot-only
node dist/src/index.js lark yolo unsafe
node dist/src/index.js lark auth start --recommend --domain docs,drive --scope "sheets:spreadsheet:create sheets:spreadsheet:write_only sheets:spreadsheet:read sheets:spreadsheet.meta:read"
node dist/src/index.js lark auth finish <device-code>
node dist/src/index.js lark service restart
```

`CCTB_LARK_INSTANCE=<name>` is the Lark-specific instance selector. Without an explicit `CCTB_LARK_STATE_DIR`, it stores that bot under `~/.cctb/<name>/lark.env`, so multiple Feishu/Lark bots do not fall back into the shared default `~/.cctb/lark` directory.

`lark setup` wraps the QR wizard, lark-cli preflight/bind, app provisioning, OAuth status check, `lark doctor`, and service start for new apps. Use `--detached` for chat-driven setup so the QR wizard keeps running after the current agent turn ends. If you already created the app and only want to re-check the local side, use `node dist/src/index.js lark setup --skip-wizard --install-cli --identity bot-only`. Add `--start-service` to that re-check command if you also want it to start/restart the listener.

Useful Lark commands:

```bash
node dist/src/index.js lark setup --detached --install-cli
node dist/src/index.js lark status
node dist/src/index.js lark permissions --missing
node dist/src/index.js lark access pair <code>
node dist/src/index.js lark send --chat oc_xxx --message "hello"
node dist/src/index.js lark timeline 20
node dist/src/index.js lark dashboard
```

Inside Lark, the bot supports the same core slash surface as Telegram: `/status`, `/usage`, `/engine`, `/model`, `/effort`, `/fast`, `/yolo`, `/goal`, `/resume`, `/detach`, `/stop`, `/reset`, `/cron`, `/board`, `/mini`, `/fan`, `/chain`, `/verify`, `/group`, `/invite`, `/remove`, `/ws`, `/newgroup`, `/newtopic`, and `/continue`.

Lark group/session semantics:

- Normal group chats share one parent-group session. Reply threads created inside a normal group stay on the parent group session unless that thread already has an explicit historical session binding.
- Topic-style Lark groups use one session per topic. A topic conversation key is `lark:<chat_id>:<thread_id>`, while the parent group key is `lark:<chat_id>`.
- `/invite group` and `/group allow` authorize the current group, not only the current thread. `/remove group` and `/group deny` remove the current group authorization.
- `known-chats.json` is diagnostic metadata for `/status`, `/config`, and dashboard labels. It never decides routing or access by itself.

Lark-native controls:

- Long-running Lark turns now send a native progress card and update it with thinking, tool calls, background notifications, and final result. The final plain reply is still delivered, so existing workflows do not depend on cards.
- Same-conversation messages still use conservative FIFO queueing by default. Optional preempt/batch behavior is off unless explicitly enabled with `CCTB_LARK_QUEUE_MODE=preempt`, `batch`, or `preempt-batch`; batch windows can be tuned with `CCTB_LARK_BATCH_WINDOW_MS=<ms>`.
- `/config` shows access and workspace guidance in the card. `/invite group`, `/remove group`, `/invite user @person`, and `/remove user @person` remain the safe in-chat access controls.
- `/ws list`, `/ws save <name> [absolute-path]`, `/ws use <name>`, and `/ws remove <name>` manage saved Lark workspace directories. `/ws use` resets the current conversation binding so a workspace switch does not silently keep stale project context.

## Operator Commands

### Telegram

```bash
telegram service start --instance work
telegram service restart --all
telegram service status --all
telegram engine codex --instance work
telegram yolo unsafe --instance work
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

See the full [Slash Command Index](./docs/slash-commands.md) for command groups, Telegram/Lark support, and examples.

## Current Release

- **v0.1.39** — deepens Lark-native UX: streaming run cards, stop-capable queue wait cards, optional preempt/batch queue mode (off by default), richer telemetry metrics, `/config` access/workspace guidance, and `/ws` workspace profiles.
- **v0.1.38** — sanitizes historical Lark `known-chats.json` entries on read so stale parent-group labels recorded from reply threads no longer mislead `/status`, `/config`, or dashboard.
- **v0.1.37** — tightens Lark group/topic UX: ordinary group reply threads no longer pollute known-chat labels as topic sessions, and unauthorized Lark group replies now include `/invite group` / `/group allow` guidance.
- **v0.1.36** — preserves existing Lark thread/topic sessions even when the platform later reports the chat mode as a plain group, preventing active group topics from appearing to forget prior context after restarts.
- **v0.1.35** — hardens Lark service shutdown/restart handling so direct Node process stops happen before tmux cleanup and stale locks are less likely after interrupted service turns.
- **v0.1.34** — adds Lark observability and control UX: optional telemetry adapters, Lark health/reconnect events, opt-in shared worker pooling, `/invite`/`/remove` access helpers, and known chat names in `/status`, `/config`, and `dashboard`.
- **v0.1.0** — resets the public product to **TaroCub**, renames the GitHub/package surface, adds the product thesis to the banner, and keeps `cctb` plus old state paths as compatibility surfaces.
- **v4.6.70** — transitional release that introduced the TaroCub family name before the full product reset.
- **v4.6.69** — makes Lark setup more self-healing: when user OAuth is missing, setup now prints the recommended Docs/Drive/Sheets auth command, and the docs clarify that `user-default` no longer force-rebinds existing lark-cli sessions.
- **v4.6.68** — deepens Lark-native reliability: safe running reactions, native @name resolution, card-to-text fallback, one-shot `lark setup`, clearer permission repair, and safer lark-cli binding that will not wipe user OAuth.
- **v4.6.67** — closes a Lark runtime secret-boundary gap: runtime `lark-cli` child processes now get `LARK_CHANNEL=1` without inheriting `LARK_APP_SECRET`.

See [GitHub Releases](https://github.com/cloveric/tarocub/releases) for the full changelog.

## Safety Model

The bridge is powerful because it controls local CLIs. Treat it like local automation, not a sandboxed SaaS bot.

- Run it only on machines and workspaces you trust.
- Use access pairing/allowlists before exposing private or group chats.
- Use YOLO unsafe/bypass only for trusted instances; it intentionally bypasses normal approval prompts and sandbox restrictions.
- Keep app secrets in bridge state, not prompts, argv, or child-process env.
- Use `doctor`, `timeline`, `audit`, and `dashboard` before guessing at failures.
- Telegram/Lark can share an optional machine-wide AI worker pool when you set `TAROCUB_MAX_CONCURRENT_TURNS=<n>`; it is off by default, and `0`/`off` keeps it disabled. Lark same-conversation preempt/batch is also off by default; opt in with `CCTB_LARK_QUEUE_MODE=preempt|batch|preempt-batch`.
- Lark records `service.health` events and reconnect attempts when health probes fail; telemetry adapters receive `ws_reconnect`, `pool_active`, `pool_waiting`, `run_e2e_ms`, token, cost, and error metrics when configured.
- Lark keeps a local `known-chats.json` cache so `/status`, `/config`, and `dashboard` can show friendly chat names instead of only opaque chat IDs.
- Optional local observability can be loaded with `TAROCUB_TELEMETRY_MODULE=/abs/path/adapter.mjs`; telemetry failures are swallowed so they cannot break user turns.

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

The project is TypeScript, Node.js >= 20, and Vitest. It stores runtime state under `~/.cctb/<instance>` for Telegram instances, `~/.cctb/lark` for the default Lark state dir, or `~/.cctb/<CCTB_LARK_INSTANCE>` for named Lark bots.

## License

MIT
