# Change Rules

This document defines the engineering rules for changing `cc-telegram-bridge`.

It exists to prevent a repeat of the same failure pattern:

- one path gets fixed
- another entrypoint keeps the old behavior
- tests stay green because only one path was covered

Read this together with:

- [Entrypoint Map](./entrypoint-map.md)
- [State Model](./state-model.md)
- [Security Boundaries](./security-boundaries.md)
- [Bus Protocol](./bus-protocol.md)
- [Event Model](./event-model.md)

## 1. Shared Semantics First

If a behavior exists in more than one path, do not patch only the local caller unless the divergence is intentional and documented.

Common examples:

- usage accounting
- budget enforcement
- audit writes
- timeline writes
- auth retry
- stale-session retry
- file delivery policy
- bus failure semantics

Preferred order:

1. update the shared helper or protocol layer
2. wire callers into that shared layer
3. add focused tests for at least two entrypoints when relevant

Do not add new duplicated bookkeeping back into:

- `src/telegram/delivery.ts`
- `src/index.ts`
- individual command modules

when a shared helper already exists.

## 2. Compatibility Discipline

This repo is local-first, but it still has compatibility surfaces.

Treat these as versioned surfaces even if they are not public SaaS APIs:

- `config.json`
- `access.json`
- `session.json`
- `runtime-state.json`
- `usage.json`
- `file-workflow.json`
- `.bus-registry.json`
- `audit.log.jsonl`
- `timeline.log.jsonl`
- bus request/response payloads

Rules:

- prefer additive fields over renames
- do not silently repurpose an existing field to mean something else
- do not make an optional field required without a migration story
- do not narrow accepted values unless you also handle existing persisted data
- if a format changes, document it in the matching doc file

For bus protocol changes specifically:

- preserve legacy parsing unless there is a deliberate breaking version bump
- keep machine-readable `errorCode` stable
- treat `retryable` semantics as contract, not copy text

## 3. Runtime Schema Required For Durable State

New durable state or protocol payloads must have runtime validation.

TypeScript types alone are not sufficient.

Minimum requirement:

- a schema file or a schema colocated with the owner module
- parsing through that schema at the read boundary
- tests for malformed but syntactically-valid input

If a file intentionally does not use runtime schema validation, the code should explain why.

## 4. Delivery Layer Discipline

`src/telegram/delivery.ts` is an entrypoint, not a dumping ground.

Do:

- keep it focused on access check, dispatch, retry handoff, and final cleanup
- add new command behavior in the owning command module
- add ordinary turn logic in `message-*` or bookkeeping helpers

Do not:

- re-inline command logic there
- re-inline file delivery there
- re-inline budget or audit writes there

## 5. State Write Discipline

For structured state:

- write atomically
- preserve private permissions
- serialize read-modify-write flows when updates can race
- refuse to silently overwrite unreadable authoritative state

If fallback-to-default is used for a malformed state/config file, it must be an explicit choice and should log loudly unless the file is truly optional.

## 6. Security-Sensitive Areas

Any change touching one of these areas needs explicit regression thought:

- `/resume`
- `[send-file:]` or local Markdown file extraction
- bus auth / registry / liveness
- access policy
- shared `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
- archive restore / backup

For shared engine env:

- do not inject default `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
- only propagate them when the caller explicitly set them
- when debugging auth or engine startup issues, inspect the real runtime first and only then build a reduced reproduction

The default assumption should be:

- input is untrusted
- model output is untrusted
- local loopback services are not automatically trusted

## 7. Event/Audit Rules

When adding a new lifecycle concept:

1. decide whether it belongs in audit, timeline, or both
2. prefer shared append helpers
3. keep event names stable and metadata additive

Use audit for:

- operator-readable incident history
- existing CLI/status/debug surfaces

Use timeline for:

- turn lifecycle
- workflow lifecycle
- file delivery lifecycle
- budget lifecycle
- retry lifecycle

Do not introduce a one-off ad-hoc event shape in a local module when the same concept already exists elsewhere.

## 8. Test Rules

Behavior changes should usually include:

- a focused unit/module test for the owning module
- a cross-entry or integration test if the behavior is shared

Examples:

- budget changes:
  `tests/telegram-turn-bookkeeping.test.ts`
  `tests/bus-handler.test.ts`
  `tests/service.test.ts`
- file delivery changes:
  `tests/telegram-response-delivery.test.ts`
  and Telegram service regression if parsing behavior changed
- bus protocol changes:
  `tests/bus.test.ts`
  `tests/bus-handler.test.ts`
- ordinary Telegram turn changes:
  `tests/telegram-message-turn.test.ts`
  `tests/telegram-turn-error.test.ts`
  `tests/service.test.ts`

If a fix applies to both Telegram and bus, do not stop after testing one side.

## 9. Docs Update Rule

Update docs when the effective contract changes.

Typical mapping:

- architecture/module ownership change:
  `docs/entrypoint-map.md`
- state semantics change:
  `docs/state-model.md`
- trust boundary change:
  `docs/security-boundaries.md`
- bus payload or semantics change:
  `docs/bus-protocol.md`
- event/timeline change:
  `docs/event-model.md`
- engineering process/change discipline:
  this file

## 10. Default Review Questions

Before calling a change done, ask:

1. Did I change a shared behavior in only one entrypoint?
2. Did I widen a trust boundary?
3. Did I introduce a new persisted shape without runtime schema?
4. Did I preserve backward-compatible parsing where needed?
5. Did I add the smallest tests that would catch this exact regression next time?
