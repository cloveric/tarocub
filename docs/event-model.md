# Event Model

This document defines the lightweight timeline model written to `timeline.log.jsonl`.

It complements `audit.log.jsonl`:
- `audit.log.jsonl` remains the operator-facing historical log
- `timeline.log.jsonl` is the more structured turn/event stream

The project currently dual-writes both.

## Goals

- Make turn lifecycle and budgeting visible without reverse-engineering audit lines.
- Give dashboard/debug tooling a stable event stream.
- Keep the first version lightweight; do not require epoch/cursor machinery yet.

## File

- Path: `<stateDir>/timeline.log.jsonl`
- Format: one JSON object per line
- Permissions: directory `700`, file `600`

## Event Shape

Every event may contain:

- `timestamp`
- `type`
- `instanceName`
- `channel`
- `chatId`
- `userId`
- `updateId`
- `outcome`
- `detail`
- `metadata`

`channel` is currently one of:
- `telegram`
- `bus`

## Event Types

Current event types:

- `input.received`
- `command.handled`
- `turn.started`
- `turn.completed`
- `turn.retried`
- `workflow.prepared`
- `workflow.failed`
- `workflow.completed`
- `file.accepted`
- `file.rejected`
- `budget.blocked`
- `budget.threshold_reached`

## Write Rules

### Telegram

- `input.received`
  Written at Telegram entry after callback ack / typing starts.
- `command.handled`
  Written for command paths that already go through shared command bookkeeping.
- `turn.started`
  Written before the ordinary bridge turn is sent to the engine.
- `turn.completed`
  Written when a Telegram update finishes with `success`, `error`, or other handled outcome.
- `turn.retried`
  Written when auth-refresh retry or stale-session retry is triggered.
- `workflow.prepared`
  Written when attachment/archive workflow state is materialized for the turn.
- `workflow.failed`
  Written when an unfinished workflow is marked failed in error cleanup.
- `workflow.completed`
  Written when workflow state is marked completed after a successful turn.
- `file.accepted`
  Written for each outbound local file actually delivered to Telegram.
- `file.rejected`
  Written for each local file reference rejected during delivery.
- `budget.blocked`
  Written when a turn is prevented from running because the instance is already over budget.
- `budget.threshold_reached`
  Written after usage is recorded and the configured budget is crossed.

### Bus

- `turn.started`
  Written when a bus handler accepts a validated request.
- `turn.completed`
  Written when the bus turn returns success or error.
- `budget.blocked`
  Written when a bus turn is rejected because the target instance is already over budget.
- `budget.threshold_reached`
  Written when a successful bus turn pushes the target instance over budget.

## Relation To Audit

Do not delete or replace `audit.log.jsonl` yet.

Current division of responsibility:
- `audit.log.jsonl`
  Best for operator history, human-readable troubleshooting, existing CLI commands
- `timeline.log.jsonl`
  Best for turn reconstruction, dashboards, future replay/debug tools

Practical rule of thumb:
- write to `audit` when the event answers "what action/result should an operator care about later?"
- write to `timeline` when the event answers "where is this turn in its lifecycle right now?"

Expected split:
- `audit`
  configuration changes, access decisions, command outcomes, bus/Telegram operator-visible success or failure records
- `timeline`
  input received, turn start/completion/retry, workflow lifecycle, file accepted/rejected, budget lifecycle events

Avoid dual-writing new concepts by default. Add both only when:
1. operators need a durable historical record, and
2. UI/debug tooling also needs structured lifecycle visibility

Current consumers of `timeline.log.jsonl`:
- dashboard summary cards
- `telegram timeline`
- `telegram service status`
- `telegram service doctor`

Current status/doctor summary fields include:
- total timeline events
- last turn completion / retry / budget block timestamps
- incident counts for retries, budget blocks, file rejections, and workflow failures

Read-side rule:
- missing timeline log is acceptable
- unreadable timeline log should degrade to an operator-visible warning, not crash status/doctor

When a new lifecycle concept is added:
1. decide whether it needs structured timeline visibility
2. if yes, add a new timeline event or extend metadata additively
3. only then decide whether audit should also change

## Change Rules

- Add new event types; do not repurpose an existing type for a different lifecycle moment.
- Keep metadata additive when possible.
- Prefer writing through shared helpers instead of ad-hoc per-command append logic.
- When changing timeline semantics, update:
  - this file
  - `docs/entrypoint-map.md` if module ownership changes
  - relevant tests such as:
    - `tests/telegram-turn-bookkeeping.test.ts`
    - `tests/telegram-message-turn.test.ts`
    - `tests/telegram-turn-error.test.ts`
    - `tests/telegram-response-delivery.test.ts`
    - `tests/bus-handler.test.ts`
