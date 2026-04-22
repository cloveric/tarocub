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
  <img src="https://img.shields.io/badge/engines-Codex%20%7C%20Claude-F97316?style=flat-square" alt="Codex | Claude">
  <img src="https://img.shields.io/badge/tests-Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest">
</p>

<h3 align="center">
  Put the real Codex and Claude Code CLI on Telegram.<br>
  Not an API wrapper — the actual CLI, with native sessions, local files, and real tool use.<br>
  Run one bot or a small bot team: isolated instances by default, Agent Bus when you need delegation, fan-out, pipelines, or a coordinator-led crew.
</h3>

<p align="center">
  <em>Runs the native CLI harness directly — Codex or Claude per instance, hot-reloaded instructions, voice/file input, local resume, structured timeline/audit logs, service doctor, and dashboard included.<br>No reimplemented API wrappers, no fake chat layer.</em>
</p>

<p align="center">
  <a href="#dual-engine-codex--claude-code">Dual Engine</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#multi-bot-setup">Multi-Bot</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#agent-bus">Agent Bus</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#crew-workflow">Crew</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#voice-input-asr">Voice</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#session-resume">Resume</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#budget-control">Budget</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#quick-start">Quick Start</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#service-operations">Ops</a>
</p>

> **RULE 1:** Let your Claude Code or Codex CLI set this up for you. Clone the repo, open it in your terminal, and tell your AI agent: *"read the README and configure a Telegram bot for me"*. It will handle the rest.

### What Changed Recently

- The Telegram runtime was split into smaller modules instead of one giant `delivery.ts`.
- Agent collaboration now covers `/ask`, `/fan`, `/chain`, `/verify`, and a coordinator-led `crew` workflow.
- The bridge now keeps structured `timeline.log.jsonl` and `crew-runs/*.json` state for better visibility and recovery.
- `telegram service status`, `telegram service doctor`, `telegram timeline`, and `telegram dashboard` now expose much richer runtime health.
- **v4.3.1** — preserves pending pairing codes when single-chat mode blocks redemption, refuses to turn multi-chat off while another chat is still pending pairing, and makes service startup/runtime config parsing use the same validated config reader.
- **Current default** — Codex instances now use the process runtime in Telegram for better stability under long-running bot sessions; Claude keeps its existing process runtime.
- **v4.3.0** — makes single-chat-per-instance the default, adds explicit `telegram access multi on|off` control, and exposes `/engine` switching directly in Telegram.
- **v4.2.0** — adds Claude auth smoke checks, stronger service environment diagnostics, and cleanup guidance for stale legacy launchd plists after removing the old autostart path.
- **v4.1.0** — adds coordinator-led `crew` runs with persisted run state, plus a round of state/runtime hardening around schemas, file delivery, and shared state writes.
- **v4.0.0** — the bus now speaks a compatibility-first `v1` protocol: protocol versioning, explicit capabilities, structured error codes, and `retryable` flags. See [`docs/bus-protocol.md`](./docs/bus-protocol.md).
- Peer liveness is probed via `GET /api/health` with a `cc-telegram-bridge` fingerprint, so a reused local port can no longer fake a live peer.
- All state files are zod-validated and written atomically (stage-then-rename); `UsageStore` writes are serialized to eliminate concurrent-turn races.

---

## Dual Engine: Codex + Claude Code

Each bot instance can run either **OpenAI Codex** or **Claude Code** as its backend. Switch engines per-instance with one command:

```powershell
# Set an instance to use Claude Code
npm run dev -- telegram engine claude --instance review-bot

# Set another to use Codex
npm run dev -- telegram engine codex --instance helper-bot

# Check current engine
npm run dev -- telegram engine --instance review-bot
```

| Feature | Codex Engine | Claude Engine |
|---|---|---|
| CLI command | `codex exec --json` | `claude -p --output-format json` |
| Session resume | `codex exec resume --json <id>` | `claude -p -r <session-id>` |
| Project instructions | `agent.md` (prepended to prompt) | `agent.md` (via `--system-prompt`) + `CLAUDE.md` (auto-loaded from workspace) |
| YOLO mode | `--full-auto` / `--dangerously-bypass-approvals-and-sandbox` | `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` |
| `/compact` | Not needed (each exec is stateless) | Compresses session context to reduce token usage |
| Working directory | `workspace/` under instance dir | `workspace/` under instance dir (with `CLAUDE.md`) |

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

# Enable YOLO for mobile use
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

## YOLO Mode

```powershell
npm run dev -- telegram yolo on --instance work      # Safe auto-approve
npm run dev -- telegram yolo unsafe --instance work   # Skip ALL checks
npm run dev -- telegram yolo off --instance work      # Normal flow
npm run dev -- telegram yolo --instance work          # Check status
```

| Mode | Codex | Claude | Use case |
|---|---|---|---|
| `off` | Normal approvals | Normal approvals | Default, safest |
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

## Verbosity Control

Control how much streaming progress you see:

```bash
npm run dev -- telegram verbosity 0 --instance work   # Quiet — no live updates
npm run dev -- telegram verbosity 1 --instance work   # Normal — update every 2s (default)
npm run dev -- telegram verbosity 2 --instance work   # Detailed — update every 1s
npm run dev -- telegram verbosity --instance work      # Check current level
```

Stored in `config.json`, hot-reloadable.

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

**Custom ASR integration:**

To use a different ASR engine, modify the `transcribeVoice()` function in `src/telegram/delivery.ts`. The function receives the local path to an `.ogg` audio file and should return the transcribed text as a string.

---

## Session Resume & Codex Thread Attach

Started a task locally with Claude Code? Continue it on Telegram — no copy-paste, no re-explaining context. Using Codex instead? Attach an existing thread by ID and keep going from Telegram.

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

**No pollution:** `--append-system-prompt` is per-invocation and doesn't persist in session files. The bridge instructions won't leak into your local session.

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

Note: the default Codex process runtime validates `/resume thread <thread-id>` against the local Codex session index. Thread IDs unknown to the local machine still fail closed instead of being guessed.

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

> **TL;DR** — You only need to do two things on your phone: get a bot token from BotFather and send the pairing code. Everything else happens on your computer via Claude Code or Codex CLI.

### Prerequisites

- **Node.js** >= 20
- **OpenAI Codex CLI** and/or **Claude Code CLI** installed and authenticated
- A **Telegram account** (phone)

### Step 1: Create a Telegram Bot (on your phone)

1. Open Telegram and search for **[@BotFather](https://t.me/BotFather)**
2. Send `/newbot`
3. Follow the prompts — give your bot a name and username
4. BotFather will reply with a **bot token** like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz0123456789`
5. Copy this token — you'll paste it in your terminal

### Step 2: Install & Configure (on your computer)

Open your terminal with Claude Code or Codex, and tell it:

> *"Clone https://github.com/cloveric/cc-telegram-bridge and set up a Telegram bot with this token: `<paste your token>`"*

Or do it manually:

```bash
git clone https://github.com/cloveric/cc-telegram-bridge.git
cd cc-telegram-bridge
npm install
npm run build

# Configure with your bot token
npm run dev -- telegram configure <your-bot-token>

# Optional: switch to Claude engine (default is Codex)
npm run dev -- telegram engine claude

# Enable YOLO mode for hands-free operation
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

**Done!** You can now chat with Codex or Claude from Telegram. Send text, voice messages, or files — the bot handles everything.

### Multiple Bots

```bash
# Create a second bot with BotFather, then:
npm run dev -- telegram configure --instance work <second-token>
npm run dev -- telegram engine claude --instance work
npm run dev -- telegram yolo on --instance work
npm run dev -- telegram service start --instance work
# Pair the same way: send a message, get the code, run `telegram access pair <code> --instance work`
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
│ message-    │              │                  │ audit-log.ts        │
│ renderer.ts │              │ agent.md + config│ timeline-log.ts     │
│             │              │                  │ usage-store.ts      │
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
    → Codex Exec or Claude -p (new or resume)
    → Stream progress to placeholder (every 2s) → Final Render → Deliver → Audit
```

---

## Highlights

<table>
  <tr>
    <td width="50%">
      <h3>Dual Engine</h3>
      <p>Switch between Codex and Claude Code per instance. Mix and match — one bot on Codex, another on Claude, managed from one CLI.</p>
    </td>
    <td width="50%">
      <h3>Per-Bot Personality</h3>
      <p>Each instance loads its own <code>agent.md</code> on every message. Claude instances also get <code>CLAUDE.md</code> project rules.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>YOLO Mode</h3>
      <p>One command to auto-approve everything — works with both engines. Per-instance, hot-reloadable.</p>
    </td>
    <td>
      <h3>Per-Bot Isolation</h3>
      <p>Every instance has its own personality, workspace, sessions, access rules, inbox, audit trail, and workspace-keyed auto-memory. The engine config dir (<code>~/.claude/</code> / <code>~/.codex/</code>) is <em>shared</em> with your main CLI so OAuth refresh tokens don't race across instances — the trade-off is that settings, plugins, and MCP state live in your real home, and full-auto / bypass mode can touch it.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Streaming Progress</h3>
      <p>See AI responses as they're generated — the Telegram message updates live every 2 seconds during Codex/Claude execution, instead of waiting for completion.</p>
    </td>
    <td>
      <h3>Production Resilience</h3>
      <p>Long polling (~0ms latency), exponential backoff, 429 auto-retry, 409 conflict auto-shutdown, graceful SIGTERM/SIGINT, fault-tolerant batch processing.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Usage Tracking</h3>
      <p>Per-instance token counts (input/output/cached) and USD cost. <code>telegram usage</code> to check spend anytime.</p>
    </td>
    <td>
      <h3>Verbosity Control</h3>
      <p>Per-instance output level: 0 = quiet, 1 = normal (2s), 2 = detailed (1s). <code>telegram verbosity 2</code> to see more.</p>
    </td>
  </tr>
  <tr>
    <td>
      <h3>Budget Control</h3>
      <p>Set a per-instance cost cap. Requests are blocked when the limit is hit — with bilingual messages.</p>
    </td>
    <td>
      <h3>Session Resume</h3>
      <p><code>/resume</code> scans Claude local sessions; <code>/resume thread &lt;thread-id&gt;</code> attaches an existing Codex thread. <code>/detach</code> restores the pre-resume conversation when one exists.</p>
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
| `telegram service logs` | Tail stdout/stderr logs |
| `telegram service doctor` | Health check across all subsystems, including timeline, crew state, shared engine env, and stale launchd leftovers |
| `telegram engine [codex\|claude]` | Switch AI engine per instance |
| `telegram yolo [on\|off\|unsafe]` | Toggle auto-approval mode |
| `telegram usage` | Show token usage and estimated cost |
| `telegram verbosity [0\|1\|2]` | Set streaming progress level |
| `telegram budget [show\|set\|clear]` | Per-instance cost cap (blocks requests when exceeded) |
| `telegram timeline` | Inspect structured lifecycle events with filters |
| `telegram instance [list\|rename\|delete]` | Manage instances from the CLI |
| `telegram backup [--instance <name>]` | Archive instance state to `.cctb.gz` |
| `telegram restore <archive>` | Restore instance from backup (with `--force` to overwrite) |
| `telegram logs rotate` | Manually trigger log rotation |
| `telegram dashboard` | Generate and open an HTML status dashboard with timeline and latest crew snapshot |
| `telegram help` | Show all available commands |

All commands accept `--instance <name>` to target a specific bot.

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
- `/engine [claude|codex]` — switch engine for the current instance (the bridge resets stale bindings automatically)
- `/effort [low|medium|high|xhigh|max|off]` — set reasoning effort level (`xhigh` is Opus 4.7+ only)
- `/model [name|off]` — switch model
- `/btw <question>` — ask a side question without affecting the current session
- `/ask <instance> <prompt>` — delegate to a specific peer bot
- `/fan <prompt>` — query current bot plus configured parallel bots
- `/chain <prompt>` — run the configured sequential bot chain
- `/verify <prompt>` — execute locally, then auto-review with the verifier bot
- `/resume` — Claude: scan local sessions; Codex: use `/resume thread <thread-id>` to attach an existing thread
- `/detach` — detach from resumed Claude session or current Codex thread; restore the pre-resume conversation when one exists
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
3. Verify the engine is installed: `codex --version` or `claude --version`
4. If the instance uses Claude, run `npm run smoke:claude-auth`
5. If `service doctor` reports `legacy-launchd`, clean it with `bash scripts/cleanup-legacy-launchd.sh --all`

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
