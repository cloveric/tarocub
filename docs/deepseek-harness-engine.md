# DeepSeek Harness Engine

This document is the release contract for TaroCub's `deepseek` engine. It
describes behavior verified against **DeepSeek Harness 0.1.1-rc.2**, not a
prompt-level approximation of another engine.

## Runtime Architecture

Each TaroCub instance owns one private Harness host:

```text
TaroCub instance
  -> dsh web --no-open --host 127.0.0.1 --port 0
  -> official HTTP RPC (/api/*)
  -> mux + host WebSocket downlinks
  -> DeepSeek provider selected by the Harness profile
```

`DSH_EXECUTABLE` overrides the executable; otherwise TaroCub uses `dsh` from
`PATH`. `DSH_HOME` points at the user's authenticated Harness home (default
`~/.dsh`). TaroCub creates `<stateDir>/dsh-home` with mode `0700`, links the
shared credentials and profiles, copies mutable `settings.yaml`, installs the
bridge `AGENTS.md`, and appends only its permission presets to the private
patch. A bot can therefore reuse authentication and native profiles without
letting model selection or bridge instructions overwrite desktop settings.

The host binds only to loopback and uses an ephemeral port. TaroCub drains its
stdio, detects process/socket failure, reconnects with backoff, replays only
unseen ordered history, merges projections by `asOfSeq`, re-arms active Goals
after a process restart, and fails active work closed when recovery is
incomplete or malformed.

## Capability Matrix

| Capability | DeepSeek Harness behavior in TaroCub |
|---|---|
| Session create | Durable standard Harness session with a preallocated ID and verified workspace |
| Session resume | Native `session.list` scan and `/resume session <id>`; authoritative cwd is resolved and validated before binding |
| Streaming | Text deltas, reasoning, tool calls/results, usage, and terminal result events |
| Files | Non-image paths are attached as Harness file content |
| Images | Encoded as Harness image content; acceptance still depends on the selected provider/model |
| Tool approvals | Deny/allow-once plus bridge-managed session grants; broken UI and abort paths fail closed |
| Questions | Structured `AskUserQuestion`, including multiple questions, multi-select, and free-text Other answers on Lark |
| Stop | Native `session.cancel`, local abort propagation, and immediate writer-slot release |
| Mid-turn steering | Native `session.steer` from Lark during the configured `/steer` window |
| Compaction | `/compact` is executed through Harness `commands/execute`, never exposed as an ordinary model prompt |
| Context | `/context` reads the durable `contextPressure` projection |
| Model / effort | Harness session model APIs validate provider/model and reasoning effort on each turn |
| Goals | Native durable Goal create/read/watch/clear/resume; optional token budget is persisted across bridge restarts |
| Background jobs | Structured lifecycle, ownership routing, final review grace, and exactly-once terminal result delivery |
| Crash recovery | Host restart, ordered history replay, projection reconciliation, recovery admission barrier, and Goal re-arm |
| Usage | Structured input/output/cache token totals |
| Dollar cost | Not reported by Harness; USD budgets cannot constrain DeepSeek turns |
| Claude `/ultrareview` | Not available; this is a Claude-specific workflow |

## Verified Limits

- The bridge transports images correctly. In the current live probe, Harness's
  default `deepseek-v4-flash` model returned
  `MODEL_DOES_NOT_SUPPORT_IMAGES`; choose a vision-capable Harness model before
  expecting image understanding.
- Harness reports tokens but not per-turn USD cost. `/usage` states this
  explicitly even when no dollar budget is configured.
- TaroCub does not emulate Claude's `/ultrareview`. Ordinary review prompts,
  Agent Bus `/verify`, and native DeepSeek Goals remain available.
- Native Harness profiles, plugins, and MCP configuration remain Harness-owned.
  TaroCub isolates mutable bot settings but does not pretend that an unavailable
  native plugin is present.

## Safety Invariants

The adapter enforces these invariants with regression tests:

1. One foreground writer per Harness session; prompt rejection, abort, timeout,
   malformed recovery, and host error all release the claim.
2. A known session cannot later be attached to a different workspace.
3. Reconnect history must advance and reach the saved sequence within 100
   pages; otherwise the active operation fails instead of accepting a partial
   replay.
4. Projection snapshots require `asOfSeq`; a malformed snapshot cannot freeze
   all future live updates behind an artificial maximum watermark.
5. Malformed approval/question requests receive an explicit error response so
   Harness never waits forever for a bridge callback.
6. A final result is emitted once even if completed-job snapshots race with
   asynchronous Lark card delivery.
7. Goal and foreground turns retain separate ownership for approvals,
   questions, tool calls, background jobs, usage, and terminal events.
8. Turn, approval, question, and background-job routing is bound to a unique
   task claim. A cancelled turn's late terminal frame or job update cannot
   cancel, approve for, or settle a replacement turn in the same session.

The focused release gate is:

```bash
npm run build
npx vitest run \
  tests/deepseek-harness-protocol.test.ts \
  tests/deepseek-harness-host.test.ts \
  tests/deepseek-harness-adapter.test.ts
```

The full repository test suite and a real local Harness probe are still
required before release.
