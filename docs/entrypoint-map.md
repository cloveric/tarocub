# Entrypoint Map

This file is the source of truth for codebase navigation when modifying this repository.

Use it before changing:
- Telegram message flow
- bus / delegation flow
- state or config handling
- usage / budget / audit behavior
- file delivery behavior

## Read Order

Start here for most changes:
1. `src/telegram/delivery.ts`
2. `src/telegram/authorized-dispatch.ts`
3. The specific Telegram submodule for the behavior you want to change
4. The matching focused test file in `tests/`

For deeper system context, then read:
- `docs/architecture-notes.md`
- `docs/state-model.md`
- `docs/security-boundaries.md`
- `docs/bus-protocol.md`
- `docs/event-model.md`
- `docs/change-rules.md`
- `docs/release-checklist.md`

## Main Entrypoints

- `src/index.ts`
  Process bootstrap, Telegram polling/webhook wiring, bus HTTP wiring.
- `src/service.ts`
  Service lifecycle, polling loop, update scheduling, process-level orchestration.
- `src/telegram/delivery.ts`
  Telegram entrypoint only. Handles callback ack, access check, dispatch, retry handoff, final error handoff.

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
- `src/telegram/message-input.ts`
  Attachment download and voice transcription.
- `src/telegram/message-turn.ts`
  Ordinary workflow-aware turn execution.
- `src/telegram/turn-error.ts`
  Auth retry, stale-session retry, workflow cleanup, final error reply/audit.
- `src/telegram/response-delivery.ts`
  Text chunking, `[send-file:]` / Markdown file extraction, local file send, rejection notices.
- `src/telegram/turn-bookkeeping.ts`
  Telegram-side audit / budget reply / usage bookkeeping helpers.

## Shared Runtime Helpers

- `src/runtime/bridge-turn.ts`
  Shared usage recording and budget threshold logic.
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
  Usage accumulation.
- `src/state/audit-log.ts`
  Audit event persistence.
- `src/state/timeline-log.ts`
  Structured turn/event persistence.

See `docs/state-model.md` before changing on-disk semantics.

## Engine / Provider Layer

- `src/runtime/bridge.ts`
  High-level bridge behavior and access control.
- `src/codex/process-adapter.ts`
  Codex process adapter.
- `src/codex/claude-adapter.ts`
  Claude CLI adapter.
- `src/codex/claude-stream-adapter.ts`
  Claude streaming adapter.

If a bug smells like auth, stale session, engine CLI output shape, or provider-specific formatting, inspect these modules before patching Telegram code.

## Modification Rules

- Prefer changing the narrowest module that owns the behavior.
- Do not add new command logic back into `delivery.ts`.
- Do not duplicate usage, budget, or audit logic across Telegram command modules and bus handlers.
- When changing file delivery, keep both Claude and Codex output formats working.
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
- Normal message turn:
  `tests/telegram-message-input.test.ts`
  `tests/telegram-message-turn.test.ts`
  `tests/telegram-turn-error.test.ts`
  `tests/telegram-response-delivery.test.ts`
  `tests/telegram-turn-bookkeeping.test.ts`
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
