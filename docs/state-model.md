# State Model

This document describes the persistent on-disk state used by `cc-telegram-bridge`.

The goal is to answer five practical questions for each file:

1. Where does it live?
2. Which module owns it?
3. What data is authoritative?
4. What are the write and recovery rules?
5. How sensitive is it?

This document covers both:

- **authoritative state**: files the runtime depends on for behavior
- **operational artifacts**: logs, inbox files, backups, and registry files that are useful but not the source of truth for core behavior

## Root Layout

Per-instance state lives under:

```text
~/.cctb/<instance>/
```

Typical files and directories:

```text
.env
config.json
access.json
session.json
runtime-state.json
usage.json
file-workflow.json
audit.log.jsonl
instance.lock.json
workspace/
inbox/
service.stdout.log
service.stderr.log
```

Some related control-plane state lives one level above the instance:

```text
~/.cctb/.bus-registry.json
```

## Classification

The project should reason about state in four buckets.

### 1. Authoritative configuration

- `.env`
- `config.json`

These files define how the instance should run.

### 2. Authoritative runtime state

- `access.json`
- `session.json`
- `runtime-state.json`
- `usage.json`
- `file-workflow.json`

These files represent the durable control state of the instance.

### 3. Append-only or operational evidence

- `audit.log.jsonl`
- `service.stdout.log`
- `service.stderr.log`

These help with auditability and debugging, but the instance should not need them to compute its current truth.

### 4. Derived or transient artifacts

- `workspace/`
- `inbox/`
- backup archives
- migration leftovers
- `instance.lock.json`
- `.bus-registry.json`

These files are important, but they are not all the same. Some are transient coordination files, others are user data or deliverables.

## Shared Storage Rules

These rules apply across most state files.

### JSON storage primitive

[src/state/json-store.ts](/Users/cloveric/projects/cc-telegram-bridge/src/state/json-store.ts:1) is the shared primitive for most structured state.

It provides:

- `ENOENT -> default` reads
- atomic temp-file + rename writes
- owner-only permissions on write (`0700` dirs, `0600` files)
- schema-version stamping
- downgrade protection when loading newer state
- quarantine support for unreadable/corrupt files

Implication:

- if a new state file is structured JSON, it should usually be built on `JsonStore`
- if a file is not using `JsonStore`, the code should explain why

### Concurrency rule

Atomic rename prevents partial writes, but it does **not** prevent lost updates in read-modify-write flows.

Stores that mutate counters or collections must serialize writes inside the process.

Current examples:

- `SessionStore`
- `RuntimeStateStore`
- `UsageStore`
- `FileWorkflowStore`

### Security rule

Anything under the instance state directory should be treated as private unless there is a strong reason otherwise.

That includes:

- bot token
- pairing/access policy
- session mappings
- usage/cost history
- workflow records
- audit events

## Per-File Model

## `.env`

### Path

`<stateDir>/.env`

### Owner

- read path: [src/service.ts](/Users/cloveric/projects/cc-telegram-bridge/src/service.ts:84)
- CLI config commands also write and maintain it

### Purpose

Stores the Telegram bot token for the instance when it is not provided through the ambient process environment.

The key field is:

- `TELEGRAM_BOT_TOKEN`

### Authoritative data

The token is authoritative if the service was started without `TELEGRAM_BOT_TOKEN` already set in the process environment.

### Write rules

- should remain owner-readable only
- should be updated without clobbering unrelated env lines
- should not be regenerated from runtime state

### Recovery rules

- if missing, the instance can still start if `TELEGRAM_BOT_TOKEN` exists in the process environment
- if missing in both places, startup must fail

### Sensitivity

Highest sensitivity.

Compromise of this file is effectively bot compromise.

## `config.json`

### Path

`<stateDir>/config.json`

### Owner

This file has multiple readers and writers.

Primary readers:

- [src/telegram/delivery.ts](/Users/cloveric/projects/cc-telegram-bridge/src/telegram/delivery.ts:78)
- [src/service.ts](/Users/cloveric/projects/cc-telegram-bridge/src/service.ts:364)
- adapter modules in [src/codex](/Users/cloveric/projects/cc-telegram-bridge/src/codex)

Primary writers:

- CLI commands in [src/commands/cli.ts](/Users/cloveric/projects/cc-telegram-bridge/src/commands/cli.ts:721)
- runtime updates in [src/telegram/delivery.ts](/Users/cloveric/projects/cc-telegram-bridge/src/telegram/delivery.ts:132)

### Purpose

Stores persistent instance configuration and a small amount of durable control state.

Important fields currently include:

- `engine`
- `approvalMode`
- `locale`
- `verbosity`
- `budgetUsd`
- `effort`
- `model`
- `resume`
- `bus`

### Authoritative data

This file is authoritative for instance configuration.

It is also currently authoritative for the durable `/resume` binding, which means it is partly configuration and partly state.

That mixed role is acceptable for now, but should remain explicit.

### Write rules

- must be written atomically
- readers tolerate missing file by falling back to defaults
- runtime should not silently overwrite unreadable/corrupt config

Current behavior is split:

- CLI reads treat parse failure as `{}` and continue
- delivery/runtime reads log malformed config and run on defaults
- runtime writes refuse to overwrite unreadable non-`ENOENT` config

This asymmetry is worth remembering.

### Recovery rules

- missing file means "fresh instance defaults"
- malformed file currently causes runtime fallback with loud logging, not automatic repair

### Sensitivity

Moderate sensitivity.

Usually not credential-bearing, but it can reveal instance topology, bus peers, resume state, model selection, and operator intent.

## `access.json`

### Path

`<stateDir>/access.json`

### Owner

[src/state/access-store.ts](/Users/cloveric/projects/cc-telegram-bridge/src/state/access-store.ts:1)

### Purpose

Stores Telegram access policy and pairing state.

Schema:

- `policy: "pairing" | "allowlist"`
- `pairedUsers[]`
- `allowlist[]`
- `pendingPairs[]`

### Authoritative data

This file is authoritative for:

- who is allowed to talk to the bot
- whether pairing or allowlist mode is active
- outstanding pairing codes

### Write rules

Current writes are read-modify-write and are **not** internally queued.

That means this store is logically authoritative but still vulnerable to same-process lost-update races if heavily mutated concurrently.

In practice, writes are low-frequency enough today that this has not been a major issue, but the file should still be treated as mutable shared state.

### Recovery rules

- missing file -> default state:
  - `policy = pairing`
  - empty allowlist/pairs/pending codes
- invalid shape currently throws from the parser

There is no built-in quarantine-and-repair path here today.

### Sensitivity

High sensitivity.

Leaking this file exposes pairing codes, authorized chats, and chat/user linkage.

## `session.json`

### Path

`<stateDir>/session.json`

### Owner

[src/state/session-store.ts](/Users/cloveric/projects/cc-telegram-bridge/src/state/session-store.ts:1)

### Purpose

Maps Telegram chats to provider session identifiers.

Schema:

- `chats[]`
  - `telegramChatId`
  - `codexSessionId`
  - `status`
  - `updatedAt`

### Authoritative data

This file is authoritative for durable chat -> engine session binding.

It is what lets a Telegram chat continue an engine conversation across process restarts.

### Write rules

- writes are serialized in-process
- updates are upsert-style by `telegramChatId`
- removal supports recovery behavior on corrupt state

### Recovery rules

This store has the best repair story in the project today.

It can:

- inspect unreadable state without throwing to the outer system
- distinguish repairable vs non-repairable failures
- quarantine corrupt files to `*.corrupt.*.bak`
- reset to an empty default state when safe to do so

### Sensitivity

Moderate to high sensitivity.

It exposes chat IDs and engine session identifiers, which are operationally sensitive even if not credential-equivalent.

## `runtime-state.json`

### Path

`<stateDir>/runtime-state.json`

### Owner

[src/state/runtime-state.ts](/Users/cloveric/projects/cc-telegram-bridge/src/state/runtime-state.ts:1)

### Purpose

Stores polling progress.

Current schema:

- `lastHandledUpdateId`

### Authoritative data

This file is authoritative for "how far Telegram polling has durably advanced".

### Write rules

- writes are serialized in-process
- updates are monotonic: lower update IDs do not replace higher ones

### Recovery rules

- missing file -> `lastHandledUpdateId = null`
- invalid file throws

This file matters because if its semantics drift from update acknowledgment semantics, the system can either replay or lose updates.

### Sensitivity

Low sensitivity, but high correctness importance.

## `usage.json`

### Path

`<stateDir>/usage.json`

### Owner

[src/state/usage-store.ts](/Users/cloveric/projects/cc-telegram-bridge/src/state/usage-store.ts:1)

### Purpose

Stores cumulative token and cost accounting for the instance.

Schema:

- `totalInputTokens`
- `totalOutputTokens`
- `totalCachedTokens`
- `totalCostUsd`
- `requestCount`
- `lastUpdatedAt`

### Authoritative data

This file is authoritative for user-visible cumulative usage and budget comparisons.

### Write rules

- read-modify-write
- writes are serialized per `UsageStore` instance

Important nuance:

the serialization is instance-local in memory. Callers should avoid creating many unrelated `UsageStore` instances for the same concurrent hot path if they expect strong same-process coordination.

### Recovery rules

- missing file -> zeroed counters
- invalid file throws

There is currently no dedicated auto-repair path.

### Sensitivity

Moderate sensitivity.

It reveals usage volume, cost, and activity timing.

## `file-workflow.json`

### Path

`<stateDir>/file-workflow.json`

### Owner

[src/state/file-workflow-store.ts](/Users/cloveric/projects/cc-telegram-bridge/src/state/file-workflow-store.ts:1)

### Purpose

Tracks attachment and archive processing workflows that span multiple Telegram messages.

Schema:

- `records[]`
  - `uploadId`
  - `chatId`
  - `userId`
  - `kind`
  - `status`
  - `sourceFiles`
  - `derivedFiles`
  - `summary`
  - `summaryMessageId?`
  - `extractedPath?`
  - `createdAt`
  - `updatedAt`

### Authoritative data

This file is authoritative for in-progress and resumable file-processing state, especially archive workflows that wait for a follow-up `/continue`.

### Write rules

- writes are serialized in-process
- records are append/update/remove by `uploadId`
- status is mutated over time; `updatedAt` is refreshed on mutation

### Recovery rules

Like `session.json`, this store supports:

- inspect-with-warning
- corruption detection
- quarantine to backup
- reset-based repair

This is important because users can still receive successful Telegram output even if bookkeeping later fails.

### Sensitivity

Moderate sensitivity.

It contains local file paths, chat IDs, and summaries of processed content.

## `audit.log.jsonl`

### Path

`<stateDir>/audit.log.jsonl`

### Owner

[src/state/audit-log.ts](/Users/cloveric/projects/cc-telegram-bridge/src/state/audit-log.ts:1)

### Purpose

Append-only operational and forensic event log.

Each line is an `AuditEvent` with fields such as:

- `timestamp`
- `type`
- `instanceName`
- `chatId`
- `userId`
- `updateId`
- `outcome`
- `detail`
- `metadata`

### Authoritative data

This file is **not** authoritative for current runtime truth.

It is authoritative only as a historical record of what the system attempted and reported.

### Write rules

- append-only JSONL
- best effort in some call sites
- no compaction semantics

Callers should never rely on this file for reconstructing canonical current state.

### Recovery rules

- malformed lines are ignored by parsers
- summaries are best-effort over whatever lines remain parseable

### Sensitivity

High sensitivity.

It may contain prompts, error details, chat IDs, workflow metadata, and operational clues.

## `instance.lock.json`

### Path

`<stateDir>/instance.lock.json`

### Owner

[src/state/instance-lock.ts](/Users/cloveric/projects/cc-telegram-bridge/src/state/instance-lock.ts:1)

### Purpose

Ensures only one service process owns an instance state directory at a time.

Schema:

- `pid`
- `token`
- `acquiredAt`

### Authoritative data

This file is authoritative only for process exclusivity at startup/runtime, not for user-visible behavior.

### Write rules

- created with exclusive write (`wx`)
- stale file is removed only after verifying the recorded process is dead
- release checks both `pid` and random `token`

### Recovery rules

- missing file is normal
- stale file is automatically pruned
- live holder means startup must fail

### Sensitivity

Low confidentiality sensitivity, high coordination importance.

## `service.stdout.log` and `service.stderr.log`

### Path

- `<stateDir>/service.stdout.log`
- `<stateDir>/service.stderr.log`

### Owner

Service management commands under [src/commands/service.ts](/Users/cloveric/projects/cc-telegram-bridge/src/commands/service.ts:365)

### Purpose

Operational logs for managed background service processes.

### Authoritative data

Not authoritative for runtime behavior.

Useful for diagnosis only.

### Write rules

- append as process output streams
- subject to rotation via [src/state/log-rotation.ts](/Users/cloveric/projects/cc-telegram-bridge/src/state/log-rotation.ts:1)

### Recovery rules

Safe to truncate or rotate.

### Sensitivity

Moderate sensitivity because logs may include prompts, errors, config paths, and stack traces.

## `workspace/`

### Path

`<stateDir>/workspace/`

### Owner

Created by service/adapters, then effectively co-owned by the engine and the user.

### Purpose

The instance working directory.

This is where:

- engine tasks operate
- `CLAUDE.md` may live
- generated files may be created before Telegram delivery
- resumed-session workspace alignment matters

### Authoritative data

Not canonical bridge control state, but authoritative as the working tree the engine sees.

### Write rules

- contents are not schema-managed
- should be treated as user/engine data, not config

### Recovery rules

Backed up and restored as part of instance archives.

### Sensitivity

Potentially very high, depending on project contents.

## `inbox/`

### Path

`<stateDir>/inbox/`

### Owner

Telegram delivery and workflow code.

### Purpose

Stores downloaded Telegram attachments and quoted files for local processing.

### Authoritative data

Not authoritative long-term control state, but important transient input material for workflows.

### Write rules

- created on demand
- contains downloaded user data

### Recovery rules

Safe to treat as ephemeral operational data, but note that in-progress workflows may still reference files under it.

### Sensitivity

High sensitivity because it contains raw user attachments.

## Backup archives (`*.cctb.gz`)

### Path

User-chosen output path, not a fixed in-place state file.

### Owner

[src/state/archive.ts](/Users/cloveric/projects/cc-telegram-bridge/src/state/archive.ts:1)

### Purpose

Portable backup/restore format for an instance state directory.

### Authoritative data

A backup is authoritative only as a snapshot artifact, not as live state.

### Write rules

- skips symlinks
- skips oversized files
- writes a gzipped custom archive format

### Recovery rules

- restore validates archive magic and version
- restore prevents path traversal
- restore reapplies restrictive permissions

### Sensitivity

Highest sensitivity.

A backup may contain nearly the entire private state of an instance.

## `.bus-registry.json`

### Path

`<channelRoot>/.bus-registry.json`

Where `channelRoot = dirname(stateDir)`, usually `~/.cctb/`.

### Owner

[src/bus/bus-registry.ts](/Users/cloveric/projects/cc-telegram-bridge/src/bus/bus-registry.ts:1)

### Purpose

Shared control-plane registry of locally running instances participating in the bus.

Schema:

- `instances[instanceName]`
  - `port`
  - `pid`
  - `secret`
  - `updatedAt`

### Authoritative data

This file is authoritative for local instance discovery on the bus.

It is not part of a single instance's isolated state; it is shared across sibling instances.

### Write rules

- currently plain read-modify-write, not `JsonStore`
- should be treated as coordination state
- liveness is verified via `/api/health`, not by trusting the file alone

### Recovery rules

- missing/corrupt registry -> empty registry
- stale entries are pruned by active probing

### Sensitivity

High sensitivity for local control-plane security because it contains bus secrets and routing info.

## Files That Are Not Canonical State

These files may exist under the state directory but should not be treated as authoritative business state:

- `runtime.log`
- rotated logs like `audit.log.jsonl.1`
- `engine-home.migrated-*`
- temporary `*.tmp` files
- transient Telegram-out directories

They matter operationally, but no feature should depend on them as the sole source of truth.

## Current Gaps

These are the most important state-model gaps in the current code.

### 1. `config.json` has multiple owners

That is manageable, but only if all writers keep using atomic write and we stay disciplined about which fields are runtime state vs operator config.

### 2. Not every JSON store has the same repair semantics

`session.json` and `file-workflow.json` are more mature here than `access.json`, `usage.json`, and `runtime-state.json`.

### 3. Some coordination files do not use `JsonStore`

That is not automatically wrong, but the difference should be intentional and documented.

### 4. Shared-state files and per-instance files are easy to conflate

`.bus-registry.json` is not just another instance file. It belongs to the local mesh, not one bot.

## Recommended Next Steps

1. Keep this file updated whenever a new persistent file is introduced.
2. Normalize repair behavior across state stores where it materially helps operators.
3. Decide whether `resume` should remain in `config.json` or eventually move into a dedicated runtime-state file.
4. Add a short `docs/security-boundaries.md` that explicitly maps these state files to trust/sensitivity levels.
