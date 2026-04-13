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
  Not an API wrapper — the actual CLI, with sessions, memory, and file handling.<br>
  Run multiple bots, each with its own engine, personality, and state — isolated by default, connected via Agent Bus when you need them to collaborate.
</h3>

<p align="center">
  <em>Why not use Claude Code and Codex's own harness? Better, stronger, more stable.<br>When you can spin up 10 native bots on Telegram, who still needs <a href="https://github.com/openclaw">OpenClaw</a>?</em>
</p>

<p align="center">
  <a href="#dual-engine-codex--claude-code">Dual Engine</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#multi-bot-setup">Multi-Bot</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#agent-bus">Agent Bus</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#yolo-mode">YOLO</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#voice-input-asr">Voice</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#budget-control">Budget</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#localization">i18n</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#backup--restore">Backup</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#quick-start">Quick Start</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="#service-operations">Ops</a>
</p>

> **RULE 1:** Let your Claude Code or Codex CLI set this up for you. Clone the repo, open it in your terminal, and tell your AI agent: *"read the README and configure a Telegram bot for me"*. It will handle the rest.

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

Run as many bots as you need. Each instance is fully isolated — its own engine, token, personality, threads, access rules, inbox, and audit trail.

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

## Localization

Switch the bot's UI language per instance. All Telegram replies, error messages, and status output are rendered in the selected language.

```bash
npm run dev -- telegram locale zh --instance work   # Chinese
npm run dev -- telegram locale en --instance work   # English (default)
npm run dev -- telegram locale --instance work       # Check current
```

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

Enable bot-to-bot communication via local HTTP IPC. Bots delegate tasks to each other with `/ask`, and the bus handles routing, peer validation, and loop prevention.

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
| `verifier` | Instance name for `/verify` auto-verification (e.g. `"reviewer"`). |

Both sides must allow each other — unilateral bus config is rejected.

### Usage

In any bot's Telegram chat:

```
/ask reviewer Please review this function for security issues
/fan Analyze this code for bugs, security issues, and performance
/verify Write a function to sort an array
```

- `/ask <instance> <prompt>` — delegate to a specific bot, result inline
- `/fan <prompt>` — query current bot + all `parallel` bots simultaneously, combined results
- `/verify <prompt>` — execute on current bot, then auto-send to `verifier` for review

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
│ renderer.ts │              │ agent.md + config│                     │
└─────────────┴──────────────┴──────────────────┴─────────────────────┘
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
      <h3>Full Isolation</h3>
      <p>Every instance: own engine, token, access, sessions, threads, inbox, audit trail, <strong>and engine memory</strong>. One bot's learned context never leaks to another.</p>
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
      <h3>Localization (en/zh)</h3>
      <p>All bot replies, errors, and status messages can be switched to Chinese per instance.</p>
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
    <td></td>
  </tr>
</table>

---

## Service Operations

| Command | Description |
|---|---|
| `telegram service start` | Acquire lock, load state, begin long-polling |
| `telegram service stop` | Graceful shutdown (SIGTERM/SIGINT) |
| `telegram service status` | Running state, PID, engine, bot identity, audit health |
| `telegram service restart` | Stop + start with clean consumer reset |
| `telegram service logs` | Tail stdout/stderr logs |
| `telegram service doctor` | Health check across all subsystems |
| `telegram engine [codex\|claude]` | Switch AI engine per instance |
| `telegram yolo [on\|off\|unsafe]` | Toggle auto-approval mode |
| `telegram usage` | Show token usage and estimated cost |
| `telegram verbosity [0\|1\|2]` | Set streaming progress level |
| `telegram budget [show\|set\|clear]` | Per-instance cost cap (blocks requests when exceeded) |
| `telegram locale [en\|zh]` | Set bot UI language per instance |
| `telegram instance [list\|rename\|delete]` | Manage instances from the CLI |
| `telegram backup [--instance <name>]` | Archive instance state to `.cctb.gz` |
| `telegram restore <archive>` | Restore instance from backup (with `--force` to overwrite) |
| `telegram logs rotate` | Manually trigger log rotation |
| `telegram dashboard` | Generate and open an HTML status dashboard |
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
- `/effort [low|medium|high|max|off]` — set reasoning effort level
- `/model [name|off]` — switch model
- `/btw <question>` — ask a side question without affecting the current session
- `/stop` — immediately stop the current running task
- `/continue`
- `/compact` (Claude only — compresses context; Codex falls back to reset)
- `/reset`
- `/help`

For archive summaries, the intended continuation path is to reply to that summary or press its Continue Analysis button; bare `/continue` only resumes the latest waiting archive.

Recovery behavior on unreadable state:

- `telegram service status` and `telegram service doctor` degrade to `unknown (...)` warnings instead of crashing when `session.json` or `file-workflow.json` is unreadable.
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

---

## Access Control

Per-instance, two layers: **pairing** + **allowlist**.

```bash
npm run dev -- telegram access pair <code>
npm run dev -- telegram access policy allowlist
npm run dev -- telegram access allow <chat-id>
npm run dev -- telegram access revoke <chat-id>
npm run dev -- telegram status [--instance work]
```

---

## Audit Trail

Per-instance append-only JSONL log with filterable queries:

```bash
npm run dev -- telegram audit [--instance work]
npm run dev -- telegram audit 50                                    # Last 50 entries
npm run dev -- telegram audit --type update.handle --outcome error  # Filter by type/outcome
npm run dev -- telegram audit --chat 688567588                      # Filter by chat
```

---

## State Layout

```
# Windows: %USERPROFILE%\.cctb\<instance>\
# macOS/Linux: ~/.cctb/<instance>/

<instance>/
├── agent.md                # Bot personality & instructions
├── config.json             # Engine, YOLO mode, verbosity
├── usage.json              # Token usage and cost tracking
├── engine-home/            # Isolated engine config, memory, sessions
│   ├── memory/             # Claude: auto-memory (CLAUDE_CONFIG_DIR)
│   ├── sessions/           # Codex: thread history (CODEX_HOME)
│   └── ...                 # Each bot's engine state is fully isolated
├── workspace/              # Claude working directory (Claude engine only)
│   └── CLAUDE.md           # Claude Code project instructions
├── .env                    # Bot token
├── access.json             # Pairing + allowlist data
├── session.json            # Chat-to-thread bindings
├── runtime-state.json      # Watermarks, offsets
├── instance.lock.json      # Process lock
├── audit.log.jsonl         # Structured audit stream
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
docker run -v ~/.cctb:/root/.codex cc-telegram-bridge telegram configure <token>
docker run -v ~/.cctb:/root/.codex cc-telegram-bridge telegram service start
```

Mount `~/.cctb` to persist state across container restarts.

---

## Troubleshooting

<details>
<summary><strong>Bot does not reply</strong></summary>

1. Run `telegram service doctor --instance <name>` to diagnose
2. Check `telegram service logs` for errors
3. Verify the engine is installed: `codex --version` or `claude --version`

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

## License

[MIT](./LICENSE)

---

<p align="center">
  <sub>Your agents. Your engines. Your rules.</sub>
</p>
