# Entrypoint Map

This file is the source of truth for codebase navigation when modifying this repository.

Use it before changing:
- Telegram message flow
- Lark / Feishu message and card flow
- bus / delegation flow
- state or config handling
- usage / budget / audit behavior
- file delivery behavior

## Read Order

Start here for most changes:
1. The platform entrypoint: `src/telegram/delivery.ts` or `src/lark/service.ts`
2. The platform dispatcher: `src/telegram/authorized-dispatch.ts` or `src/lark/message-handler.ts`
3. The narrow submodule that owns the behavior
4. The matching focused test file in `tests/`

For deeper system context, then read:
- `docs/architecture-notes.md`
- `docs/state-model.md`
- `docs/security-boundaries.md`
- `docs/bus-protocol.md`
- `docs/event-model.md`
- `docs/change-rules.md`
- `docs/release-checklist.md`
- `docs/lark-permissions.md` — granting a Feishu scope to a Lark bot. 个人版 apps: `申请开通` is INSTANT, there is NO version-publish step — don't hunt a `发布` button.
- `docs/kimi-engine-notes.md` — verified Kimi CLI/ACP behavior, implementation consequences, and known gaps.
- `docs/kimi-capability-matrix.md` — Kimi vs Codex vs Claude release contract, including explicit protocol gaps.

## Main Entrypoints

- `src/index.ts`
  Process bootstrap, Telegram polling/webhook wiring, bus HTTP wiring.
- `src/service.ts`
  Service lifecycle, polling loop, update scheduling, process-level orchestration.
- `src/telegram/delivery.ts`
  Telegram entrypoint only. Handles callback ack, access check, dispatch, retry handoff, final error handoff.
- `src/lark/service.ts`
  Lark WebSocket/event entrypoint, normalization, deduplication, and dispatch wiring.
- `src/lark/message-handler.ts`
  Lark turn queueing, live run cards, batching, steering, active-run registration, and terminal bookkeeping.

## Telegram Flow

The Telegram path is now intentionally layered.

- `src/telegram/delivery.ts`
  Entry orchestration only.
- `src/telegram/authorized-dispatch.ts`
  Runs after access is granted. Dispatches commands vs ordinary message turn.
- `src/telegram/simple-commands.ts`
  `/help`, `/usage`, `/status`, `/effort`, `/model`
- `src/telegram/session-commands.ts`
  `/reset`, `/resume`, `/detach`
- `src/telegram/engine-commands.ts`
  `/compact`, `/context`, `/ultrareview`
- `src/telegram/delegation-commands.ts`
  `/btw`, `/ask`, `/fan`, `/verify`
- `src/telegram/board-commands.ts`
  `/board`, `/kanban`
- `src/telegram/mini-bus-commands.ts`
  `/mini`
- `src/telegram/message-input.ts`
  Attachment download and voice transcription.
- `src/telegram/message-turn.ts`
  Ordinary workflow-aware turn execution.
- `src/telegram/turn-error.ts`
  Auth retry, stale-session retry, workflow cleanup, final error reply/audit.
- `src/telegram/response-delivery.ts`
  Text chunking, legacy `[send-file:]` / Markdown file extraction, local file send, rejection notices.
- `src/telegram/cron-tags.ts`
  Parses `[cron-add:...]` transport tags and forwards them into the Telegram tool layer.
- `src/telegram/tool-tags.ts`
  Parses generic `[tool:{...}]` transport tags and explicit fenced `tool-call` blocks, executes registered bridge tools, strips tags, and appends receipts.
- `src/telegram/legacy-delivery-tool-tags.ts`
  Normalizes legacy `[send-file:]` / `[send-image:]` response tags into the registered send tool layer before final turn delivery.
- `src/telegram/turn-bookkeeping.ts`
  Telegram-side audit / budget reply / usage bookkeeping helpers.

## Telegram Tool Layer

- `src/tools/telegram-tool-registry.ts`
  Registry for bridge-owned tools that can be invoked from Telegram response transports. Tool definitions include stable names, descriptions, input schemas, and executors.
- `src/tools/telegram-tool-executor.ts`
  Stable execution entrypoint for registered tools; records structured `tool.executed` timeline receipts.
- `src/tools/send-file-tool.ts`
  Implements `send.file`, `send.image`, and `send.batch` by delegating to Telegram response delivery with structured success/failure results.
- `src/tools/cron-add-tool.ts`
  Implements `cron.add` by validating payloads, injecting chat/user context, writing CronStore records, and refreshing the scheduler.
- `src/tools/cron-management-tools.ts`
  Implements `cron.list`, `cron.remove`, `cron.toggle`, and `cron.run` for current-chat task management.

## Lark Flow

- `src/lark/service.ts`
  Event/client wiring, startup recovery, and Lark service lifecycle.
- `src/lark/message-normalizer.ts`
  Converts Lark events into the bridge's normalized message shape.
- `src/lark/message-handler.ts`
  Ordinary turn execution, queues, dense-message batching, steering, cards, and stop behavior.
- `src/lark/commands.ts`
  Text command dispatch and group/access administration.
- `src/lark/card-actions.ts`
  Interactive-card callbacks, approvals, configuration actions, and stop actions.
- `src/lark/card-renderer.ts`
  Running/terminal card state and rendering.
- `src/lark/delivery.ts`
  Final text/file/image/video delivery and card overflow fallback.
- `src/lark/config-card.ts`
  `/config` card construction and group-message scope warnings.
- `src/lark/cron.ts`
  Lark cron execution, active-run registration, budget handling, and reminder delivery.
- `src/lark/runtime.ts`
  Lark-owned in-memory run, queue, batch, card, and callback state.
- `src/lark/service-lifecycle.ts`
  Lark service lock-path helpers. The actual lifecycle/fleet/deferred-restart logic
  (start/stop/restart, `--all`, the deferred-restart helper) lives in
  `src/commands/cli.ts` (`runLarkServiceCommand`) and `src/commands/service.ts`.
- `src/lark/comment-handler.ts`
  Feishu doc-comment @mention turns: comment-thread context, engine turn, threaded replies.
- `src/lark/bus.ts`
  Lark board (`/board`), mini-bus (`/mini`), and delegation (`/ask`, `/fan`, `/chain`, `/verify`) wiring.

## Shared Runtime Helpers

- `src/runtime/bridge.ts`
  Shared engine turn orchestration, session resolution, approvals, and provider result handling.
- `src/runtime/bridge-turn.ts`
  Shared usage recording and budget threshold logic.
- `src/runtime/turn-lock.ts`
  Per-session exclusion for user turns and cron turns.
- `src/runtime/turn-pool.ts`
  Active turn accounting used by shutdown/restart safety.
- `src/runtime/cron-scheduler.ts`
  Scheduler ownership, failure accounting, disable policy, and cron dispatch.
- `src/runtime/error-classification.ts`
  Stable operator-facing error categories and retry guidance.
- `src/runtime/audit-events.ts`
  Shared best-effort audit append helper.
- `src/runtime/timeline-events.ts`
  Shared best-effort timeline append helper.
- `src/bus/bus-handler.ts`
  Shared bus execution path; do not duplicate usage/budget/audit logic in `index.ts`.

## State And Config

- `src/telegram/instance-config.ts`
  Telegram-side `config.json` read/write and normalization.
- `src/state/session-store.ts`
  Bound chat-to-session records.
- `src/state/file-workflow-store.ts`
  Archive / attachment workflow state.
- `src/state/usage-store.ts`
  Usage accumulation, validation, corruption quarantine, and last-good recovery.
- `src/state/runtime-state.ts`
  Poll/update watermarks and runtime recovery state.
- `src/state/cron-store.ts`
  Durable cron task records and cross-process writes.
- `src/state/instance-lock.ts`
  Single-owner process lock and stale-lock recovery.
- `src/state/file-mutex.ts`
  Cross-process mutex used by durable state stores.
- `src/state/audit-log.ts`
  Audit event persistence.
- `src/state/timeline-log.ts`
  Structured turn/event persistence.

See `docs/state-model.md` before changing on-disk semantics.

## Engine / Provider Layer

- `src/runtime/bridge.ts`
  High-level bridge behavior and access control.
- `src/codex/process-adapter.ts`
  Codex one-shot process adapter.
- `src/codex/app-server-adapter.ts`
  Codex streaming/app-server adapter and the default Codex runtime.
- `src/codex/claude-adapter.ts`
  Claude CLI adapter.
- `src/codex/claude-stream-adapter.ts`
  Claude streaming adapter.
- `src/codex/kimi-acp-adapter.ts`
  Persistent Kimi ACP worker, session configuration/loading, streaming event mapping,
  approvals/questions, cancellation, and compact support.
- `src/codex/kimi-workspace.ts`
  Atomic managed-block synchronization for Kimi workspace instructions.

If a bug smells like auth, stale session, engine CLI output shape, or provider-specific formatting, inspect these modules before patching Telegram code.

## Modification Rules

- Prefer changing the narrowest module that owns the behavior.
- Do not add new command logic back into `delivery.ts`.
- Do not duplicate usage, budget, or audit logic across Telegram command modules and bus handlers.
- When changing file delivery, keep all engine response formats and shared channel delivery paths working.
- When changing state semantics, update `docs/state-model.md` if the authoritative behavior changes.
- When changing trust boundaries or file access behavior, update `docs/security-boundaries.md` if the effective boundary changes.

## Test Map

Run focused tests for the area you touched before wider validation.

- Telegram authorized routing:
  `tests/telegram-authorized-dispatch.test.ts`
- Command modules:
  `tests/telegram-simple-commands.test.ts`
  `tests/telegram-session-commands.test.ts`
  `tests/telegram-engine-commands.test.ts`
  `tests/telegram-delegation-commands.test.ts`
  `tests/telegram-board-commands.test.ts`
  `tests/telegram-mini-bus-commands.test.ts`
- Normal message turn:
  `tests/telegram-message-input.test.ts`
  `tests/telegram-message-turn.test.ts`
  `tests/telegram-turn-error.test.ts`
  `tests/telegram-response-delivery.test.ts`
  `tests/telegram-turn-bookkeeping.test.ts`
- Lark event and turn path:
  `tests/lark-service.test.ts`
  `tests/lark-card-renderer.test.ts`
  `tests/lark-card-fallback.test.ts`
  `tests/lark-audit-fixes.test.ts`
  `tests/lark-cron.test.ts`
  `tests/lark-element-stream.test.ts`
- Shared runtime/state:
  `tests/bridge.test.ts`
  `tests/kimi-acp-adapter.test.ts`
  `tests/kimi-workspace.test.ts`
  `tests/cron-scheduler.test.ts`
  `tests/instance-lock.test.ts`
  `tests/runtime-state.test.ts`
  `tests/usage-store.test.ts`
- bus path:
  `tests/bus-handler.test.ts`
  `tests/bus.test.ts`
- end-to-end Telegram/service regression:
  `tests/service.test.ts`

For meaningful Telegram-flow changes, the preferred regression command is:

```bash
npm test -- tests/telegram-instance-config.test.ts tests/telegram-response-delivery.test.ts tests/telegram-turn-error.test.ts tests/telegram-authorized-dispatch.test.ts tests/telegram-message-input.test.ts tests/telegram-message-turn.test.ts tests/telegram-delegation-commands.test.ts tests/telegram-engine-commands.test.ts tests/telegram-simple-commands.test.ts tests/telegram-session-commands.test.ts tests/telegram-turn-bookkeeping.test.ts tests/bus-handler.test.ts tests/bus.test.ts tests/service.test.ts
```

Then run:

```bash
npm run build
```

Before large refactors or release-like merges, also read:

- `docs/change-rules.md`
- `docs/release-checklist.md`
