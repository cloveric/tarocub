# Delivery Protocol v2 Design

Date: 2026-04-27

## Goal

Make Telegram file delivery a structured turn protocol instead of a prompt convention.

The immediate user-facing problem is: when a user asks for files, images, PDFs, decks, or other deliverables, the engine must not be able to end the Telegram turn by only saying the files were generated. The turn should complete only after the bridge has real delivery evidence or after the engine reports that delivery failed.

## Scope

This is the medium-scope delivery upgrade. It includes:

- A turn-level delivery ledger.
- Structured accepted/rejected delivery receipts.
- Unified evidence from side-channel, stream events, final `[send-file:]` output, and `.telegram-out`.
- A completion gate that checks the ledger before allowing deliverable-producing turns to finish.
- Explicit support for adapters that cannot receive per-turn environment variables by using the generated helper path with embedded endpoint credentials.

This does not include:

- Live Preview.
- Worker pools or long-lived runtime refactors.
- Full Claude/Codex stream event unification.
- Automatic scanning of arbitrary workspace folders.
- Removing `[send-file:]` fallback.

## Current State

The bridge already creates a per-turn side-channel helper and, when possible, injects `CCTB_SEND_URL`, `CCTB_SEND_TOKEN`, and `CCTB_SEND_COMMAND` into the engine process. The helper posts requested file paths to a local turn endpoint. The endpoint calls `deliverTelegramResponse`, which validates paths, sends Telegram files, and records `file.accepted` / `file.rejected` timeline events.

The v4.3.9 completion guard blocks obvious incomplete replies, including background batch replies and claims that files were generated without delivery evidence. This works, but the evidence is still spread across side-channel state, stream-delivered sets, `[send-file:]` tags, and `.telegram-out` checks.

## Proposed Design

Add a small in-memory `TurnDeliveryLedger` owned by `executeWorkflowAwareTelegramTurn`.

The ledger records delivery attempts and outcomes:

- `accepted`: source path, resolved path when available, filename, source, bytes when available.
- `rejected`: source path, source, reason, detail when available.
- `sources`: `side-channel`, `stream-event`, `post-turn`, `telegram-out`.

The ledger provides:

- `recordAccepted(receipt)`.
- `recordRejected(receipt)`.
- `acceptedPaths()`.
- `hasAcceptedDelivery()`.
- `isSatisfiedForDeliverableRequest()`.

Delivery functions should feed the ledger through callbacks instead of only returning a count. The existing timeline events remain; the ledger is the turn-local decision source, while timeline logs are diagnostics.

## Data Flow

1. A Telegram turn starts.
2. The bridge creates a request-scoped `.telegram-out` directory for Codex and starts the side-channel endpoint.
3. The side-channel endpoint receives helper calls and delivers files immediately.
4. Each accepted/rejected file updates the ledger.
5. Stream event deliveries and final `[send-file:]` deliveries also update the ledger.
6. The final `.telegram-out` flush updates the ledger and skips files already accepted by real path.
7. Before normal completion, deliverable-producing requests must satisfy the ledger.

The completion gate should prefer structured evidence over text. Existing incomplete-reply regex repair remains a safety net for ambiguous cases, not the primary mechanism.

## Adapter Handling

Adapters that support turn-scoped env keep receiving `extraEnv` with `CCTB_SEND_COMMAND`.

Adapters that do not support turn-scoped env still receive the literal `sideChannelCommand` in instructions. The generated helper embeds `CCTB_SEND_URL` and `CCTB_SEND_TOKEN`, so the helper remains callable even without env injection.

The medium-scope requirement is to test and preserve both paths.

## Error Handling

If a side-channel request asks to send N files and fewer than N are accepted, it returns HTTP 400 with structured rejection details when available.

If the engine later fails after files were accepted, `deliveredFilesBeforeError` should continue to use ledger accepted paths so the user sees that file delivery already happened.

If no delivery path is available and the user requested files, the turn should fail with a delivery-incomplete error rather than sending a misleading completion reply.

## Tests

Add tests before implementation for:

- Side-channel server exposes structured accepted and rejected receipts.
- A deliverable-producing turn is blocked when the engine claims completion but the ledger has no accepted delivery.
- A deliverable-producing turn succeeds when side-channel delivery records an accepted receipt, even if the final text only says done.
- `.telegram-out` delivery records ledger receipts and de-duplicates against side-channel accepted paths.
- A `supportsTurnScopedEnv=false` bridge receives the embedded helper path and can satisfy delivery without `extraEnv`.

Run targeted tests first, then the full test suite.
