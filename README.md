<p align="center">
  <strong>English</strong>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="./README.zh-CN.md"><strong>中文文档</strong></a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="./docs/full-reference.md"><strong>Full Reference</strong></a>
</p>

<p align="center">
  <img src="./assets/github-banner.png" alt="TaroCub: Feishu/Lark-first control for local AI agents" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/cloveric/tarocub/blob/main/LICENSE"><img src="https://img.shields.io/github/license/cloveric/tarocub?style=flat-square&color=818cf8" alt="License"></a>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/engines-Codex%20%7C%20Claude%20%7C%20Kimi%20%7C%20DeepSeek%20%7C%20Antigravity-F97316?style=flat-square" alt="Codex | Claude Code | Kimi Code | DeepSeek Harness | Antigravity">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-native%20plugin-0f766e?style=flat-square" alt="Native DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/channels-Feishu%2FLark%20%7C%20Telegram-2563eb?style=flat-square" alt="Feishu/Lark | Telegram">
</p>

<h1 align="center">TaroCub</h1>

<p align="center">
  <strong>A Feishu/Lark-first gateway for Codex, Claude Code, Kimi Code, DeepSeek Harness, and Antigravity running on your own machine.</strong><br>
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

`TaroCub` is a local bridge, not a hosted agent product. It runs the real Codex, Claude Code, Kimi Code, DeepSeek Harness, and Antigravity CLIs on your own computer, then gives them a durable messaging control surface in Feishu/Lark, with Telegram retained as an optional compatibility channel.

> **Feishu/Lark is the primary platform.** The maintainer has not used Telegram as a day-to-day control surface for a long time. Telegram remains available for existing deployments, but new installations should start with Feishu/Lark.

This project was formerly named `cc-telegram-bridge`. The canonical repository is now `cloveric/tarocub`; GitHub redirects the old URL, and existing state directories plus the `cctb` shorthand remain supported for compatibility.

It is built for people who already use CLI agents heavily and want:

- Feishu/Lark-native operation with cards, Docs comments, Sheets, Drive, and group/thread workflows;
- optional phone-first Telegram operation for existing personal-bot deployments;
- durable state for sessions, cron jobs, file delivery, usage, timelines, audit logs, and multi-agent routing.

The intended setup flow is agent-assisted: clone the repo, open it in Codex, Claude Code, Kimi Code, DeepSeek Harness, or Antigravity, and ask the agent to configure the bridge for you. The CLI exists so your local agent can do the boring setup work instead of making you hand-edit every file.

The old long README is preserved as [Full Reference](./docs/full-reference.md). This landing page is intentionally short.

## Quick Start

### Recommended: ask your local agent to configure it

Open this repository in Codex, Claude Code, Kimi Code, DeepSeek Harness, or Antigravity and say:

```text
Read the README and configure TaroCub for me.
Run the Lark wizard, check permissions, install/bind lark-cli, and tell me what I need to scan or approve.
```

That is the preferred path. Manual commands are still below for operators who want to see each step. If you explicitly need the legacy-compatible Telegram channel, ask the agent to configure it with a BotFather token instead.

### Feishu / Lark (recommended)

```bash
git clone https://github.com/cloveric/tarocub.git
cd tarocub
npm install
npm run build

node dist/src/index.js lark setup --detached --install-cli --identity bot-only
node dist/src/index.js lark yolo unsafe
```

`--detached` keeps QR registration alive in tmux, prints one durable registration link, writes progress to `~/.cctb/<lark-instance>/lark-setup.log`, and starts the Lark service when setup completes. Use `--no-start-service` only when you explicitly want to prepare the app without listening yet.

If `lark doctor` reports missing app scopes, open the permission page URL it prints and grant the JSON it prints. PersonalAgent apps activate the grant immediately after confirmation; enterprise custom apps may still require a version publish. Then run:

```bash
node dist/src/index.js lark provision
node dist/src/index.js lark doctor
node dist/src/index.js lark slash sync
```

### DeepSeek Harness web search plugin (native bundle)

Install the standalone native plugin into the `web` profile used by ordinary
Harness and by TaroCub's private Harness hosts:

```bash
dsh plugin --profile web add github:cloveric/deepseek-harness-web-search-plugin
```

The plugin adds source-traceable Brave/Tavily live search and URL extraction.
TaroCub integration and `/tarocub` guidance are optional. Installing it does
**not** create a Feishu/Lark app or start the bridge. The canonical TaroCub
subdirectory source remains compatible. Check, update, or remove it with:

```bash
dsh --profile web --dump-config | grep -A18 -B2 mcp-cctb-search
dsh plugin --profile web update deepseek-harness-web-search-plugin
dsh plugin --profile web remove deepseek-harness-web-search-plugin
```

TaroCub still recognizes installations made under the former
`tarocub-deepseek-harness-plugin` package name so they can be migrated without
breaking managed bots.

### Telegram (optional compatibility channel)

Create a Telegram bot with [@BotFather](https://t.me/BotFather), then run:

```bash
npm run dev -- telegram configure <telegram-bot-token>
npm run dev -- telegram yolo unsafe
npm run dev -- telegram service start
```

`telegram yolo unsafe` maps to `approvalMode: "bypass"`: Codex uses its bypass sandbox mode, Claude Code/Antigravity use their unsafe skip-permissions modes, Kimi selects ACP `auto`, and DeepSeek selects Harness `danger-full-access`. Treat it as equivalent to bypassing normal approval prompts and local sandbox controls.

Send any message to the bot. It will reply with a pairing code:

```bash
npm run dev -- telegram access pair <pairing-code>
```

## Surfaces

| Surface | Best for | Status |
|---|---|---|
| **Feishu/Lark** | Team chat, interactive cards, Docs comments, Sheets/Docs/Drive workflows, group/thread workflows | **Recommended** — the primary, actively-developed channel |
| **Telegram** | Mobile control, voice input, file delivery, multi-bot operations, cron, Agent Bus | Fully supported; longest-tested, but no longer the day-to-day focus |
| **Local CLI** | Operations, setup, debugging, status, backups, direct sends | First-class operator interface |

## Core Highlights

| Highlight | Why it matters |
|---|---|
| **Real CLI engines, not a fake chat backend** | Codex, Claude Code, Kimi Code, DeepSeek Harness, and Antigravity run as their native local CLIs, so your real auth, local files, project instructions, MCP/plugins, and engine behavior stay intact. |
| **DeepSeek Harness web search plugin** | Install `github:cloveric/deepseek-harness-web-search-plugin`; its self-contained runtime adds Brave/Tavily live search and URL extraction, while TaroCub integration remains optional. |
| **DeepSeek Search MCP** | Plain Harness gets Search MCP from the plugin. Managed DeepSeek bots use that registration when valid and otherwise retain TaroCub's private fallback, so exactly one `mcp-cctb-search` client is active while native Harness search remains available. |
| **Engine-neutral Lark intake** | Long-media Tingwu routing and group/topic session boundaries are resolved before dispatch, so DeepSeek follows the same 15-minute ASR threshold and chat/thread isolation rules as Codex, Claude, and Kimi. |
| **Session Resume** | Continue existing work instead of starting over: Claude local sessions, Codex threads, Kimi ACP sessions, DeepSeek Harness sessions, and Antigravity conversations can be attached from chat and detached later. Bindings and resumed workspace roots are scoped to the private chat, group, or topic that created them, so another conversation cannot silently switch projects. |
| **Mid-turn steering** | While a Codex or DeepSeek turn is running on Lark, a plain-text follow-up sent within the steer eligibility window (default 30s, `/steer` to tune/disable/unlimit) is injected straight into it so the engine course-corrects without a second turn — acked with an OK reaction. Past the window (or with `/q <message>`) it queues as its own turn. Files, quoted replies, and queued backlogs keep normal FIFO order automatically. |
| **Feishu/Lark as a native work surface** | Lark adds what Telegram cannot: Card 2.0 choices, approval cards, Docs comment @mentions, Sheets/Docs/Drive workflows through `lark-cli`, `/newgroup`, and thread-aware group work. |
| **Optional Telegram control plane** | Existing deployments can still send files and screenshots, record voice messages, approve work, stop turns, inspect status, and operate multiple personal bots. |
| **Engine-native progress and diagnostics** | Codex consumes authoritative `turn/completed` summaries before any read fallback. Claude forwards child-agent text into the matching live tool panel without contaminating the parent answer. Kimi preserves ACP task/review lifecycles, DeepSeek replays ordered Harness history/projections, and Antigravity maps native structured session/text/tool/result events without posting protocol or thinking output as an answer. |
| **ASR for voice/audio/video** | Telegram and Lark voice/audio/video resources, plus recordings forwarded as ordinary files/documents, are downloaded and transcribed automatically before any Claude/Codex/Kimi/DeepSeek/Antigravity adapter runs. Media documents are recognized from their declared name or downloaded path, so Telegram files without `file_name` still work. Short audio uses local Qwen ASR, and (when `TINGWU_ASR_DIR` is configured) audio/video **≥ 15 minutes** uses Aliyun Tingwu cloud transcription, with chunked local fallback on cloud failure. If bridge transcription is unavailable, the original media file remains attached with an explicit fallback note instead of being silently treated as already transcribed. `/stop` cancels probing/chunking, CLI or cloud processes, aborts the local HTTP wait, and never starts a fallback after cancellation. Send 强制本地转写 / 强制云端转写 **with** the audio (same message or burst) to force a route. See [Long-audio cloud ASR](#long-audio-cloud-asr) for configuration. |
| **File and artifact delivery** | Agents can return generated images, PDFs, reports, decks, source bundles, and other files through structured `send.file`, `send.image`, `send.batch`, audio, and video tags. |
| **Scheduled work and reminders** | `/cron` and `cron.add` persist one-shot reminders, recurring jobs, and agent-run scheduled tasks outside model memory, with chat/thread routing preserved. |
| **Agent Bus** | Multiple bot instances can call each other as local workers for delegation, fan-out, chain, verifier, and coordinator-led crew workflows. |
| **Mini Bus** | Telegram topics or Lark threads can become lightweight named peers, so one group can run planner/writer/reviewer-style workflows without separate bots. |
| **Board** | Durable Kanban state for tasks, model-assisted planning, dependencies, WIP, review gates, workspaces, heartbeats, stale-run recovery, Lark task cards, and execution history. |
| **Search MCP** | Optional Brave/Tavily MCP gives source-traceable `web_search`, `web_extract`, provider status, fallback notices, and source logs. |
| **Operational visibility** | `status`, `doctor`, `timeline`, `audit`, `dashboard`, usage tracking, service locks, and backups make failures inspectable instead of mysterious. |
| **Web config console** | `cctb ui` opens a loopback-only, token-gated web console that lists every instance (engine, model, service liveness) and edits the safe config subset on disk with next-restart semantics. |
| **VC meeting attendance (experimental)** | On Feishu/Lark, the bot can join a video meeting, follow the live transcript, answer when addressed, invite participants, and explicitly end a hosted meeting (`/meeting join/status/ask/leave/invite/end`). Off by default; requires Feishu's bot-join beta allowlist. |

## Feature Map

| Feature | Feishu/Lark | Telegram | Local CLI |
|---|---:|---:|---:|
| Codex / Claude Code / Kimi Code / DeepSeek Harness / Antigravity engines | Yes | Yes | Yes |
| Session resume / detach | Yes | Yes | Yes |
| Voice, audio, and video ASR | Yes | Yes | Inspect/debug |
| File and image delivery | Yes | Yes | `lark send` / `telegram send` |
| Stop and approvals | Interactive cards | Inline buttons | Service controls |
| Mid-turn steering + `/q` queue escape | Yes (Codex and DeepSeek) | Planned | Native in the corresponding CLI |
| Plan Mode-style choices | Rich choice cards | Sequential buttons, including multi-select | Tool/debug path |
| Cron reminders and agent jobs | Yes | Yes | Manage/list/run |
| Board durable tasks | Yes | Yes | Inspect/export |
| Agent Bus fan/chain/verify | Yes | Yes | Configure peers |
| Mini Bus topic/thread workflows | Lark threads | Telegram topics | Inspect state |
| Docs comments and Sheets workflows | Yes, with `lark-cli` | Not applicable | Provision/auth/doctor |
| VC meeting attendance (gated beta) | `/meeting` commands | Not applicable | Config + preflight |
| Web config console | — | — | `cctb ui` (loopback + token) |
| Timeline, audit, dashboard, usage | Yes | Yes | Primary ops surface |

### Kimi Code engine

Select Kimi in either chat channel with `/engine kimi` (or use
`telegram engine kimi --instance <name>` for a Telegram instance). The service
resolves `KIMI_EXECUTABLE` first and otherwise
falls back to `~/.kimi-code/bin/kimi`; Kimi Code must already be authenticated
locally. TaroCub uses the persistent `kimi acp` protocol, not prompt-mode text
scraping.

Kimi supports streamed text/thought/tool events, `/stop`, tool approvals,
single-choice Lark and Telegram questions, `/compact`, model/effort/mode
options, and `/resume` session scanning/selection. TaroCub loads instance and
channel guidance through a workspace `.kimi-code/agents/agent.md` main-agent
override that retains Kimi's `${base_prompt}` and `${plugin_sections}`. It also
exposes local Codex skills to bridge-owned Kimi workspaces and injects the
built-in Search MCP alongside Kimi's native MCP/plugins.

The current compatibility baseline is **Kimi Code 0.39.1**. A live, no-prompt
ACP probe verified that both `session/new` and `session/load` accept the
schema-valid stdio Search MCP and actually start its child process. TaroCub
therefore always supplies the complete configured MCP list and fails closed if
Kimi rejects session initialization; it no longer retries by silently removing
stdio search. Native Kimi user/project MCP files and plugins remain independent.

TaroCub implements the ACP terminal lifecycle used by Kimi for delegated
Bash/process work (`create`, bounded UTF-8 output, wait, kill, and release), and
cleans up unreleased terminals when a worker exits. `KIMI_CODE_LEGACY_FLAG=1`
remains a rollback escape hatch, not the recommended Bot configuration.

Kimi's plugin manager is not part of the ACP surface used by TaroCub. Optional
official capabilities such as Kimi Computer Use and Kimi WebBridge must be
installed or updated once in the local interactive Kimi TUI, then activated
for the Bot with a fresh TaroCub session (`/reset`). Plugins are user-wide and
may add browser/computer-control MCP servers, so TaroCub deliberately does not
auto-install them.

With Kimi Code 0.32 or newer, TaroCub also installs an inert local hook plugin
under `KIMI_CODE_HOME` and activates it only for bridge-owned ACP subprocesses.
`TaskStarted`, background-task `Notification`, `SubagentStop`, `TurnStarted`,
`Stop`, `StopFailure`, and `Interrupt` feed the existing run cards, worker
retention, and restart guard. Kimi 0.33 introduced a completed-process review
flow in a synthetic task-origin turn where it may inspect bad output and retry.
TaroCub
retains that autonomous ACP stream after the original user turn has ended,
keeps intermediate process failures in the audit timeline without sending
misleading failure cards, and delivers only Kimi's final reviewed conclusion.
If no review turn arrives, a bounded fallback delivers the real task output;
accepted relay events are drained before that fallback decides no review exists,
and lost reviews expire instead of blocking that session forever.

Tool-result metadata remains the start-event fallback; terminal task tombstones
reject late/duplicate start events, and detached Bash notices read the real
bounded `output.log` tail from that Kimi session instead of showing only a
generic completion title. Successful background output that explicitly ends
with `saved` / `wrote` / `generated` plus a supported workspace artifact path is
normalized into the shared file/image delivery layer; failed, missing, hidden,
unsupported, or workspace-escaping paths remain plain text. Agents are also
told to validate actual output rather than trust exit status, and to emit exact
delivery tags instead of treating a saved path as delivery. Accepted hooks are
drained before the ACP worker is destroyed, and timeline identity stays scoped
by conversation, session, and task across ordinary messages, card actions,
comments, and bus turns. The relay deliberately ignores `SessionHeartbeat`: it
proves only that the Kimi process is alive, not that a turn or task is making
progress. Existing Kimi credentials, sessions, skills, MCP servers, and
`config.toml` are not replaced.

While detached work is retained, TaroCub never assumes that a quiet task is
dead and never kills its ACP worker merely to apply model, effort, or instruction
changes. Same-workspace non-security changes are deferred while later turns keep
using the existing worker. Workspace and approval-mode changes fail closed until
the task finishes (or the operator explicitly uses `/reset`); after terminal or
six-hour safety expiry, the next turn applies the pending configuration normally.

The current Kimi ACP surface still does not expose structured per-turn token/cost
usage, mid-turn steering, a direct client-supplied system-prompt field, or a
`/goal` command; TaroCub reports those gaps instead of simulating support. See
[Kimi Engine Notes](./docs/kimi-engine-notes.md) for protocol evidence and the
[Kimi Capability Matrix](./docs/kimi-capability-matrix.md) for Kimi's
cross-engine release contract.

Telegram renders structured `AskUserQuestion` requests in one editable inline
flow: multiple questions advance sequentially, while multi-select questions use
toggle buttons plus an explicit Submit action. Kimi's current ACP permission
protocol still advertises only one single-choice question at a time; the richer
flow applies when an engine such as Claude supplies it.

### DeepSeek Harness engine

Select DeepSeek in either channel with `/engine deepseek` (or use
`telegram engine deepseek --instance <name>`). Install and authenticate `dsh`
first; TaroCub resolves `DSH_EXECUTABLE` and otherwise uses `dsh` from `PATH`.
The verified compatibility baseline is **DeepSeek Harness 0.1.1-rc.2**.

Install the standalone native Harness bundle:

```bash
dsh plugin --profile web add github:cloveric/deepseek-harness-web-search-plugin
```

The shared `web` profile is linked into each private bot home, so the plugin is
available in both ordinary Harness Web and TaroCub-backed sessions. It provides
Search MCP directly, with optional `/tarocub` guidance. TaroCub validates the plugin marker, bundled
entrypoint, and the Harness patch that registers the MCP client; if any part is
absent or damaged, the private Host safely retains its built-in Search MCP
fallback instead of registering two clients. Plugin activation remains separate
from installing, configuring, or starting the Feishu/Lark bridge.

TaroCub owns a private loopback-only `dsh web --no-open --host 127.0.0.1
--port 0` process per bot instance and uses Harness's official HTTP RPC plus
event WebSockets. Credentials and profiles are linked from the configured
`DSH_HOME`, while mutable settings and bridge instructions remain isolated in
the instance state directory. Both event downlinks must open within 15 seconds,
so a half-open WebSocket upgrade cannot block startup forever. A crashed host
is restarted and active sessions
recover from ordered history/projection watermarks; incomplete or malformed
recovery fails closed rather than silently skipping events.

The adapter supports streamed text/reasoning/tools, correlated tool results,
per-tool and session approvals, structured `AskUserQuestion`, `/stop`, Lark
mid-turn steering, `/compact`, `/context`, model/effort selection, native
durable Goals (including token budgets), background-job review, session
scan/resume/detach, files, and image payloads. Image transport is implemented,
but actual vision support is determined by the selected Harness model; the
tested default `deepseek-v4-flash` rejected image input with
`MODEL_DOES_NOT_SUPPORT_IMAGES`.

Harness reports structured token usage but not per-turn USD cost, so dollar
budgets cannot constrain DeepSeek turns. `/ultrareview` remains a Claude-only
workflow. See [DeepSeek Harness Engine](./docs/deepseek-harness-engine.md) for
the verified capability and limitation matrix.

### Antigravity engine

Select Antigravity with `/engine antigravity`. The verified baseline is
**Antigravity CLI 1.1.22**. TaroCub uses native NDJSON `stream-json` input and
output through one persistent worker per live conversation. Later turns reuse
the warm process; idle workers are reaped after two hours, while a crash or a
startup-setting change recreates the worker with the same authoritative
conversation ID. TaroCub maps session/text/tool/result events separately and
records current-turn step usage instead of the cumulative usage returned when a
conversation is resumed. Unstructured stdout, a mismatched input echo, a missing
or inconsistent conversation ID, or a missing final result fails closed rather
than appearing in chat as an answer.

`/model <id>` passes a model listed by `agy models`, and `/effort` supports
`low`, `medium`, `high`, or `off`. Native `/goal` uses direct `-p` prompt mode
because Antigravity does not accept slash commands through stream input; TaroCub
recycles the idle worker first and resumes the same conversation in a new stream
worker afterward. Conversation resume, shared media ASR, files, delivery tags,
and native MCP/plugin configuration remain available.
`full-auto` auto-approves the turn inside Antigravity's sandbox; explicit
`bypass` remains the unsandboxed escape hatch.

Current upstream boundaries are explicit: the headless CLI does not expose
per-tool remote approvals, mid-turn steering, post-result background-task
lifecycle, or a manual compact/context API. Normal approval therefore remains
a single whole-turn confirmation. See the verified
[Antigravity Engine matrix](./docs/antigravity-engine.md).

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
node dist/src/index.js lark slash sync
node dist/src/index.js lark service restart
```

`CCTB_LARK_INSTANCE=<name>` is the Lark-specific instance selector. Without an explicit `CCTB_LARK_STATE_DIR`, it stores that bot under `~/.cctb/<name>/lark.env`, so multiple Feishu/Lark bots do not fall back into the shared default `~/.cctb/lark` directory.

`lark setup` wraps the QR wizard, lark-cli preflight/bind, app provisioning, OAuth status check, `lark doctor`, and service start for new apps. Use `--detached` for chat-driven setup so the QR wizard keeps running after the current agent turn ends. If you already created the app and only want to re-check the local side, use `node dist/src/index.js lark setup --skip-wizard --install-cli --identity bot-only`. Add `--start-service` to that re-check command if you also want it to start/restart the listener.

Useful Lark commands:

```bash
node dist/src/index.js lark setup --detached --install-cli
node dist/src/index.js lark status
node dist/src/index.js lark permissions --missing
node dist/src/index.js lark slash sync --dry-run
node dist/src/index.js lark slash sync
node dist/src/index.js lark access pair <code>
node dist/src/index.js lark send --chat oc_xxx --message "hello"
node dist/src/index.js lark timeline 20
node dist/src/index.js lark dashboard
```

Inside Lark, the bot supports the same core slash surface as Telegram: `/status`, `/usage`, `/engine`, `/model`, `/effort`, `/fast`, `/goal`, `/resume`, `/detach`, `/stop`, `/reset`, `/cron`, `/board`, `/mini`, `/fan`, `/chain`, `/verify`, `/group`, `/invite`, `/remove`, `/ws`, `/newgroup`, `/newtopic`, and `/continue` — plus the Lark-only `/yolo`, `/q`, `/config`, `/stream`, `/steer`, `/bg`, `/account`, `/approve-session`, and gated `/meeting` controls.

Native Feishu/Lark slash autocomplete is app metadata, separate from command handling. Grant `application:app_slash_command:read` and `application:app_slash_command:write`, then run `lark slash sync`; use `--all` to sync every configured app. Sync is idempotent, preserves unrelated app commands, and may take about five minutes to appear in the client.

Lark group/session semantics:

Whether a Lark group isolates each topic into its own session follows the group's **message form** (the "Group message form" setting in Lark) — read from `im.v1.chat.get` and cached for ~30s, so switching the form takes effect within ~30s without a service restart:

| Chat type | Feishu signal | Topic context (session) |
|---|---|---|
| 1:1 main timeline | `chat_mode = p2p`, no `thread_id` | One continuous main session. |
| 1:1 thread/topic | `chat_mode = p2p` + `thread_id` | Each thread is its **own isolated** session. |
| Topic group | `chat_mode = topic` | Each topic is its **own isolated** session. |
| Conversation group switched to the topic message form | `chat_mode = group` + `group_message_type = thread` | Each topic is its **own isolated** session. |
| Conversation group, default form | `chat_mode = group` + `group_message_type = chat` | Topic replies **share the one** group session. |

- "Isolated" means a topic's context does not bleed into other topics or the group's main timeline. "Shared" means a topic reply continues the group's single session.
- A thread conversation key is `lark:<chat_id>:<thread_id>`; a main 1:1 timeline or shared conversation-group key is `lark:<chat_id>`. A private thread isolates whenever Lark supplies `thread_id`; a group thread isolates only when the group uses topic message form.
- `chat_mode` alone cannot tell a toggled topic group (`chat_mode = group` + `group_message_type = thread`) from a plain conversation group, so `group_message_type` is the decisive signal.
- `/invite group` and `/group allow` authorize the current group, not only the current thread. `/remove group` and `/group deny` remove the current group authorization.
- `/newgroup <name>`, `/newgroup topic <name>`, and `/newtopic <name>` use the instance bot by default and invite the requester; explicit user-OAuth mode creates as the OAuth user instead. Both paths ensure the instance bot joins and automatically authorize the new group. They do **not** enable listen-all: the safer @bot trigger remains until `/group all` is sent inside that group.
- **Group reply mode is per-group.** By default the bot replies in a group only when it is **@-mentioned**. `/group all` opts a single group into replying to ordinary (non-`@`) messages too — handy for a private, you-only project group — and needs the app's `im:message` + `im:message.group_msg` scopes. `/group at` returns that one group to mention-required, and `/group status` shows its current mode. These switches are per-group and never affect other groups.
- **Access is still enforced per user** in groups: even under `/group all`, only an authorized user (paired, or on the allowlist) can drive the bot — a newly added member cannot. So when a private group gains other people, `/group at` is the clean lock: the bot then silently ignores every non-`@` message instead of replying.
- `known-chats.json` is diagnostic metadata for `/status`, `/config`, and dashboard labels. It never decides routing or access by itself.

Lark-native controls:

- Long-running Lark turns now send a native progress card and update it with thinking, tool calls, background notifications, and final result. The final plain reply is still delivered, so existing workflows do not depend on cards.
- Same-conversation messages still use conservative FIFO queueing by default. Optional preempt/batch behavior is off unless explicitly enabled with `CCTB_LARK_QUEUE_MODE=preempt`, `batch`, or `preempt-batch`; batch windows can be tuned with `CCTB_LARK_BATCH_WINDOW_MS=<ms>`.
- `/config` shows access and workspace guidance in the card. `/invite group`, `/remove group`, `/invite user @person`, and `/remove user @person` remain the safe in-chat access controls.
- `/ws list`, `/ws save <name> [absolute-path]`, `/ws use <name>`, and `/ws remove <name>` manage saved Lark workspace directories. `/ws use` resets the current conversation binding so a workspace switch does not silently keep stale project context.

## Operator Commands

### Lark

```bash
lark service start
lark service restart
lark service restart --all
lark doctor
lark service status --all
lark access status
lark cli identity status
lark auth status --verify
lark send --chat oc_xxx --message "hello"
```

When `lark service restart --all` is run from inside an active Lark turn, the current Lark instance is deferred and restarted last so the reply can finish before the bot stops its own process. Avoid hand-rolled shell loops that restart Lark instances from inside a Lark bot.

### Telegram (optional compatibility channel)

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

### In-chat slash commands

The complete command surface, grouped. Unless marked **Lark**, commands work on both channels. (Same list with examples: [Slash Command Index](./docs/slash-commands.md).)

**Sessions & tasks**

| Command | What it does |
|---|---|
| `/status` | Current engine, session binding, runtime state |
| `/stop` | Stop the running task (queued tasks cancel from their queue card) |
| `/reset` | Reset the chat/session binding |
| `/resume [n]` · `/resume thread <id>` · `/resume session <id>` · `/resume conversation <id>` | Resume Claude/Kimi/DeepSeek sessions / bind a Codex thread / an Antigravity conversation |
| `/detach` | Detach the resumed session/thread/conversation |
| `/goal <objective>` · `/goal --budget <n> …` · `/goal status` · `/goal clear` | Conversation goal (structured native pursuit on Codex and DeepSeek; native CLI goal on Claude/Antigravity) |
| `/btw <question>` | Isolated side question on a fresh temporary session; it neither changes nor inherits the current session |
| `/q <message>` (alias `/queue`) | **Lark** — force a queued turn (skip mid-turn steering) |
| `/steer [on\|off\|<seconds>\|unlimited\|default\|status]` | **Lark** — mid-turn steering eligibility window (default 30s; past it messages queue; accepts `5m` minutes, `0`=unlimited) |
| `/continue` | Continue the waiting archive analysis |
| `/bg` · `/bg kill <pid>` · `/bg killall` | **Lark** — list/stop engine & background processes |

**Settings**

| Command | What it does |
|---|---|
| `/config` | **Lark** — interactive settings card (recommended) |
| `/engine [claude\|codex\|kimi\|deepseek\|antigravity]` | Inspect/switch backend engine |
| `/model [name\|off]` | Inspect/set engine model. Claude has named choices; Kimi/DeepSeek accept native provider IDs; Antigravity accepts IDs listed by `agy models` |
| `/effort [low\|medium\|high\|xhigh\|max\|ultra\|off]` | Reasoning effort (model-dependent) |
| `/fast [on\|off\|status]` | Codex Fast Mode |
| `/yolo [on\|off\|unsafe\|status]` | **Lark** — approval mode (Telegram sets it from the CLI: `telegram yolo …`) |
| `/stream [on\|off]` | **Lark** — typewriter streaming for answer cards |
| `/timeout [on\|off]` | Toggle the current engine's hard-cap/inactivity safeguards; `/timeout status` explains the exact engine policy |
| `/usage` | Cumulative usage for this instance |
| `/account` | **Lark** — bound Feishu app |

**Groups & access**

| Command | What it does |
|---|---|
| `/group [status\|allow\|deny\|on\|off\|all\|at]` | Group authorization & reply mode (`on`/`off` = group mode for the whole instance, `all` = reply without @, `at` = @-only) |
| `/invite group\|user @person` · `/remove …` | **Lark** — grant/revoke group or per-user access |
| `/newgroup <name>` · `/newgroup topic <name>` · `/newtopic <name>` | **Lark** — create project groups / topic groups |

**Scheduled & durable work**

| Command | What it does |
|---|---|
| `/cron …` (`list`/`add`/`rm`/`toggle`/`mode`/`run`) | Reminders, recurring jobs, scheduled agent tasks |
| `/board …` (alias `/kanban`) (`add`/`plan`/`list`/`show`/`run`/`heartbeat`/`recover`/`worktree`) | Durable Kanban tasks outside model memory |

**Multi-agent**

| Command | What it does |
|---|---|
| `/ask <instance> <prompt>` | Delegate one prompt to a peer bot |
| `/fan` · `/chain` · `/verify` | Agent Bus parallel / sequential / verify |
| `/mini …` (`here`/`ask`/`fan`/`chain`/`verify`/`crew`) | Topic/thread-level peer agents |

**Context utilities & approvals**

| Command | What it does |
|---|---|
| `/context` | Claude or DeepSeek context details |
| `/compact` | Compact Claude, Kimi, or DeepSeek session context |
| `/ultrareview` | Deep code review (Claude only) |
| `/approve [session\|turn\|always]` · `/approve <request-id>` | Text fallback when approval buttons are unavailable |
| `/deny` · `/deny <request-id>` | Deny a pending tool call (there is no `/deny session` form) |
| `/approve-session <request-id>` | **Lark** — approve a request for the rest of the session |
| `/help` (alias `/start` on **Lark**) | Bot help in the current chat |
| `/ws list\|save\|use\|remove` | **Lark** — saved workspace directories |
| 强制本地转写 · 强制云端转写 | Message keywords (not commands): send them **in the same message/burst as the audio** (e.g. as its caption) to force the local or cloud ASR path. A keyword sent afterwards is a new turn and cannot reroute a transcription already running |

## Long-audio Cloud ASR

Short audio is transcribed by the local Qwen ASR. Audio/video at or above the threshold (default 15 minutes) is routed to Aliyun Tongyi Tingwu through the operator's standalone python script; any cloud failure falls back to chunked local transcription. Recordings sent as ordinary Telegram documents or Lark files enter the same router based on their declared filename or downloaded path. This routing runs at the channel layer, before engine selection, so Claude, Codex, Kimi, DeepSeek, and Antigravity receive the same transcript behavior. A promoted media file whose transcription fails or returns empty is still passed to the engine with an explicit bridge fallback note. `/stop` aborts the bridge-side local HTTP wait or terminates CLI/chunking/cloud work, and never starts a fallback after cancellation. The local HTTP server may still finish an already-running model kernel before it notices that its client disconnected.

| Variable | Default | Meaning |
|---|---|---|
| `TINGWU_ASR_DIR` | *(unset — cloud path fully disabled)* | Directory containing `tingwu_transcribe.py` and `.venv/`. |
| `ASR_CLOUD_THRESHOLD_SECONDS` | `900` | Duration at or above which a file routes to the cloud. |
| `ASR_CLOUD_TASK_TIMEOUT_SECONDS` | `7200` for the script's own `--timeout` | When set explicitly it also becomes the child process's wall-clock bound. Unset, the child is still killed after **15 minutes** so one stuck job cannot hold a chat's queue slot for hours. |
| `ASR_CLOUD_JOB_RETENTION_DAYS` | `7` | `<stateDir>/asr-jobs/<id>/` dirs older than this are pruned on each new job. |

**Where to set them.** On Lark, put them in `~/.cctb/<instance>/lark.env` — they are read through the *whitelisted config channel* (`loadLarkRuntimeEnv`, the same one that carries `LARK_APP_ID`), and a service start preserves them when it regenerates the file. They can also be exported in the service process environment, which wins over the file.

Note the distinction inside `lark.env`: these four ride the **whitelist**, not the *extras passthrough*. The passthrough (which forwards engine credentials such as `IFIND_TOKEN` into the engine child) refuses every reserved bridge namespace — `CCTB_`, `TAROCUB_`, `LARK_`, `CODEX_`, `CLAUDE_`, `DSH_`, `KIMI_`, `ANTIGRAVITY_`, `ASR_`, `TELEGRAM_`, `TINGWU_` — precisely because those control the bridge's own behavior (`TINGWU_ASR_DIR` names a directory the bridge *executes a script from*), so an engine-written extra can never redirect it. `DSH_EXECUTABLE` is an explicit bridge-config whitelist key; `DSH_HOME`, endpoints, and future Harness controls remain blocked from extras. The only `KIMI_` extras admitted are the explicit credential allowlist: `KIMI_API_KEY`, `KIMI_MODEL_API_KEY`, `KIMI_REGISTRY_API_KEY`, `KIMI_WEB_FETCH_API_KEY`, and `KIMI_WEB_SEARCH_API_KEY`; endpoint, OAuth-host, custom-header, home, marketplace, and future unknown controls remain blocked. A refused extra is logged at startup as `[lark] lark.env: ignored bridge-reserved keys …`.

**Secrets stay outside any engine workspace.** The Tingwu script loads its own Aliyun credentials from its `.env.local`; the bridge never reads, copies, or logs them. Keep that directory **outside** every engine workspace — the convention on this machine is `~/.tarocub-secrets/tingwu_asr` — so an agent working in `~/.cctb/<instance>/workspace` cannot read, commit, or exfiltrate the credentials.

## Safety Model

The bridge is powerful because it controls local CLIs. Treat it like local automation, not a sandboxed SaaS bot.

- Run it only on machines and workspaces you trust.
- Use access pairing/allowlists before exposing private or group chats.
- Use YOLO unsafe/bypass only for trusted instances; it intentionally bypasses normal approval prompts and sandbox restrictions.
- Keep app secrets in bridge state, not prompts, argv, or child-process env.
- Use `doctor`, `timeline`, `audit`, and `dashboard` before guessing at failures.
- Telegram/Lark can share an optional machine-wide AI worker pool when you set `TAROCUB_MAX_CONCURRENT_TURNS=<n>`; it is off by default, and `0`/`off` keeps it disabled. Agent Bus independently limits each process to 8 active `/api/talk` delegations and returns retryable `server_busy` when saturated. Lark same-conversation preempt/batch is also off by default; opt in with `CCTB_LARK_QUEUE_MODE=preempt|batch|preempt-batch`.
- Telegram and Lark refuse credential-shaped files such as `.env*`, `*.pem`, `*.key`, `id_rsa`, and `id_ed25519` even when they are inside an otherwise allowed workspace. Telegram inbound attachments are pruned after 3 days by default; set `TELEGRAM_INBOUND_FILE_RETENTION_DAYS` to change the retention window.
- Lark records `service.health` events and reconnect attempts when health probes fail; telemetry adapters receive `ws_reconnect`, `pool_active`, `pool_waiting`, `run_e2e_ms`, token, cost, and error metrics when configured.
- Lark keeps a local `known-chats.json` cache so `/status`, `/config`, and `dashboard` can show friendly chat names instead of only opaque chat IDs.
- Optional local observability can be loaded with `TAROCUB_TELEMETRY_MODULE=/abs/path/adapter.mjs`; telemetry failures are swallowed so they cannot break user turns.

More detail: [Security Boundaries](./docs/security-boundaries.md), [State Model](./docs/state-model.md), and [Full Reference](./docs/full-reference.md).

## Release Contract

In this repo, "commit and release" is not done at a GitHub tag alone. A complete TaroCub release means: commit the intended changes, create/update the GitHub Release, then restart and verify the local Telegram and Lark fleet. Keep external package-registry publishing out of the release flow.

Use [docs/release-checklist.md](./docs/release-checklist.md) as the source of truth for release verification. For Lark fleet restarts, use `node dist/src/index.js lark service restart --all` rather than manual per-instance loops.

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
