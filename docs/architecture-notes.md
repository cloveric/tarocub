# Architecture Notes

This document describes the current architecture of `cc-telegram-bridge` as it exists in the codebase today.

The goal is not to sell an idealized design. The goal is to make the actual system legible enough that future changes land in the right place, cross-cutting behavior stays consistent, and new features do not regress security or state integrity.

## Purpose

`cc-telegram-bridge` is a local-first bridge that connects Telegram chats to real coding-agent CLIs.

Each running instance is a small service process with:

- one Telegram bot token
- one instance state directory
- one configured engine (`codex` or `claude`)
- one access policy
- one local session map
- optional participation in a local Agent Bus mesh

The bridge does not reimplement the model API. It delegates execution to native CLIs and adapts their behavior into Telegram-friendly request, session, and file-delivery flows.

## System Model

At a high level, one instance looks like this:

```text
Telegram Update
  -> src/index.ts
  -> src/service.ts polling + lifecycle
  -> src/telegram/update-normalizer.ts
  -> src/telegram/delivery.ts
  -> src/runtime/bridge.ts
  -> src/runtime/session-manager.ts
  -> src/codex/* adapter
  -> Codex / Claude CLI
  -> result + files
  -> Telegram reply + state updates
```

If bus is enabled, another local path exists:

```text
Instance A
  -> src/bus/bus-client.ts
  -> HTTP POST 127.0.0.1:<port>/api/talk
  -> src/bus/bus-server.ts on Instance B
  -> src/runtime/bridge.ts on Instance B
  -> local engine on Instance B
  -> response back to Instance A
```

The important architectural fact is that the system has multiple request entry points but only one real execution core: `Bridge.handleAuthorizedMessage()`.

That is the main seam we should preserve and strengthen.

## Main Runtime Layers

### 1. Boot and Process Lifecycle

The runtime entrypoint is [src/index.ts](/Users/cloveric/projects/cc-telegram-bridge/src/index.ts).

It is responsible for:

- CLI handoff vs service startup
- resolving the target instance name
- resolving environment for that instance
- acquiring the per-instance lock
- creating the Telegram API client, bridge, and adapter
- starting the optional bus server
- starting the polling loop

`src/service.ts` owns the long-lived service behavior:

- per-instance environment resolution
- adapter construction
- Telegram polling
- bot command registration
- update deduplication and runtime-state persistence
- per-chat queueing and stop semantics

### 2. Delivery Layer

[src/telegram/delivery.ts](/Users/cloveric/projects/cc-telegram-bridge/src/telegram/delivery.ts) is the orchestration layer for user-visible behavior.

It handles:

- Telegram commands
- attachments and workflow preparation
- locale-sensitive replies
- usage and budget checks
- session reset / compact / resume flows
- bus-powered commands like `/ask`, `/fan`, `/verify`
- file extraction and Telegram delivery
- audit logging around update handling

This file is the product layer of the system. It knows the most about user intent and currently carries many cross-cutting concerns.

### 3. Bridge Layer

[src/runtime/bridge.ts](/Users/cloveric/projects/cc-telegram-bridge/src/runtime/bridge.ts) is the narrow execution core.

It is responsible for:

- access checks
- session lookup / creation
- bridge-specific system instructions
- adapter invocation
- rebinding session IDs when the engine returns a new persisted session

This layer should stay small. When behavior must be shared across Telegram, bus, and future entry points, it should usually live here or just below here.

### 4. Adapter Layer

Engine-specific behavior lives under [src/codex](/Users/cloveric/projects/cc-telegram-bridge/src/codex).

Current adapters:

- `ProcessCodexAdapter`
- `CodexAppServerAdapter`
- `ProcessClaudeAdapter`
- `ClaudeStreamAdapter` for streaming-oriented Claude behavior

The adapter interface is intentionally narrow:

- send a message
- return text, session identity, and optional usage
- expose bridge instruction mode differences

This is a good boundary. It keeps Telegram and state logic from directly depending on provider-specific CLI quirks.

### 5. State Layer

Persistent state lives under [src/state](/Users/cloveric/projects/cc-telegram-bridge/src/state).

Important stores:

- `access-store.ts`
- `session-store.ts`
- `runtime-state.ts`
- `usage-store.ts`
- `file-workflow-store.ts`
- `audit-log.ts`
- `archive.ts`
- `instance-lock.ts`
- `json-store.ts`

The project is intentionally file-backed, not database-backed.

That is a valid choice for this product, as long as we continue treating file state as a first-class system design problem rather than a convenience hack.

## Instance State Model

An instance is rooted at:

```text
~/.cctb/<instance>/
```

Typical contents include:

- `.env`
- `config.json`
- `access.json`
- `session.json`
- `runtime-state.json`
- `usage.json`
- `audit.log.jsonl`
- `workspace/`
- `inbox/`
- workflow and archive artifacts

This directory is the real unit of isolation.

Today, instance isolation means:

- separate Telegram bot token
- separate config and access state
- separate bridge/session state
- separate workspace and inbox

It does **not** fully mean separate engine-global state anymore. Claude and Codex auth/config homes may be shared with the user's main CLI, by design, to avoid auth-refresh races.

That trade-off should remain explicit whenever we discuss "isolation".

## Current Trust Boundaries

The project has three main trust boundaries.

### Telegram Boundary

Telegram is an untrusted input source until access control passes.

For normal chats, authorization is enforced through the access store:

- `pairing`
- `allowlist`

For `chatType === "bus"`, bridge access is intentionally auto-allowed. This is correct only because bus requests are supposed to already be authenticated at the bus server layer.

### Local Bus Boundary

The Agent Bus is local HTTP on loopback.

Security currently depends on:

- per-instance registry entries
- shared secret authentication
- allowed-peer checks
- loopback binding
- health/fingerprint probing to avoid talking to the wrong local listener

This is a local trust boundary, not a public API boundary. We should keep treating it as privileged local control-plane traffic.

### File Delivery Boundary

File delivery is one of the highest-risk parts of the product because it crosses from model output into real filesystem reads and then into Telegram egress.

The intended model is:

- inline fenced file blocks for small text/code files
- explicit `[send-file:/absolute/path]` tags for existing files
- path restrictions to the workspace and controlled output areas

This boundary has already been a source of security bugs. Any new work here should default to conservative path validation and regression tests.

## Important Data Flows

### Telegram Message Flow

1. Service polls Telegram updates.
2. Update is normalized.
3. Delivery layer handles commands, attachments, and workflow preparation.
4. Bridge checks access and resolves the chat session.
5. Adapter invokes the engine.
6. Delivery layer records usage, updates audit state, and sends Telegram responses.

### Delegated Bus Flow

1. A command in `delivery.ts` decides to delegate.
2. `bus-client.ts` resolves the peer through the registry.
3. The target instance receives `/api/talk`.
4. The target bus handler calls `bridge.handleAuthorizedMessage()` with `chatType: "bus"`.
5. The target instance returns plain text plus metadata.
6. The caller formats that response into the user-facing Telegram reply.

### Resume Flow

Resume is a specialized bridge between local provider session persistence and Telegram chat state.

The key pieces are:

- scanning provider session history
- mapping a Telegram chat onto an existing provider session
- storing that mapping in instance config + session state
- making sure file access and workspace assumptions follow the resumed workspace

This is one of the product's most useful features and one of its most state-sensitive ones.

## Design Strengths Worth Preserving

### Narrow bridge core

The project already has a good center of gravity in `Bridge.handleAuthorizedMessage()`.

That is worth preserving because it gives us one place to unify behavior that otherwise drifts between Telegram, bus, and future entry points.

### File-backed state with atomic primitives

`JsonStore` already gives us:

- atomic temp-file + rename writes
- file permissions
- schema version stamping
- downgrade protection

This is the right foundation for a small local tool.

### Explicit per-instance model

The system thinks in instances, not just chats. That is the right abstraction because configuration, token, access policy, workspace, and bus role all hang off the instance.

### Strong regression-testing habit

The repository already has a healthy test suite and recent fixes have repeatedly been locked in with regression tests. That habit is a real asset and should continue.

## Current Design Tensions

These are the places where the architecture is most likely to drift or regress.

### 1. Cross-entry consistency

The same engine invocation can currently be reached through:

- normal Telegram updates
- command subflows like `/fan`, `/verify`, `/btw`
- bus HTTP delegation

The biggest historical class of bugs has been "fixed in one path, missed in another".

### 2. Delivery layer breadth

`delivery.ts` is doing real product work, but it also concentrates:

- command parsing
- workflow control
- usage/budget handling
- file delivery
- delegation
- locale text
- retry logic

It is still manageable, but it is now clearly the broadest file in the system and the most likely place for new features to bypass existing invariants.

### 3. State policy is implicit

The code knows a lot about which files are authoritative and how they interact, but the repository did not previously have one place that explains:

- what each state file means
- which writes must be serialized
- which failures are recoverable
- which data is authoritative vs derived

That implicit knowledge slows down safe iteration.

### 4. Shared engine home vs instance isolation

The recent auth-race fix improved reliability by sharing real CLI config homes, but widened the blast radius of engine-global writes.

That is an acceptable trade-off for now, but it needs to stay explicit in docs and code comments.

## Improvement Priorities

These are the highest-value architectural improvements for the next phase of the project.

### 1. Create canonical cross-cutting helpers

Anything that should apply to every engine turn should not live only in one caller.

The likely candidates are:

- usage recording
- budget enforcement
- audit event emission
- retry / stale-session recovery policy
- progress / delivery lifecycle markers

Recommendation:

- keep Telegram-specific rendering in `delivery.ts`
- move shared "post-engine turn accounting" into a small common helper or a lower layer near `Bridge`

### 2. Document the state model formally

This document is the start, but the next useful step is a short per-file state model:

- file path
- owner module
- canonical schema
- recovery behavior
- security sensitivity

Recommendation:

- add a dedicated `docs/state-model.md`

### 3. Introduce a lightweight event/timeline model

The project already has audit logs, workflow state, runtime state, and message replies, but not one canonical event vocabulary.

Recommendation:

- define a compact internal event model for engine turns and delegated work
- use it first for observability and debugging, not for UI ambition

This should stay much smaller than Paseo's timeline system, but the direction is still right.

### 4. Split product orchestration from transport plumbing

`delivery.ts` would be healthier if command parsing and user-facing orchestration were gradually separated from lower-level helpers such as:

- usage/budget accounting
- file delivery policy
- delegation accounting
- resumed-session safety checks

Recommendation:

- extract a few narrow helpers instead of attempting a large refactor
- preserve current behavior while shrinking the surface area of the main delivery file

### 5. Make trust boundaries explicit in future features

Any feature touching:

- bus
- resumed sessions
- file delivery
- shared engine home

should be reviewed first as a trust-boundary change, not just as a UX feature.

That framing has already paid off in past fixes and should become standard practice.

## Working Rules For Future Changes

When adding or changing behavior, prefer these rules:

1. If the behavior should apply to all engine turns, do not implement it only in one Telegram command path.
2. If a change touches state files, specify which file is authoritative and whether writes must be serialized.
3. If a feature crosses from model output into filesystem reads or outbound delivery, treat it as a security-sensitive change.
4. If a new command internally triggers another engine turn, verify usage, budget, audit, and stop semantics explicitly.
5. If a design increases shared global state, document the blast radius in code comments and docs.

## Near-Term Next Docs

The next documentation steps that would materially help the project are:

- `docs/state-model.md`
- `docs/command-flow-notes.md`
- `docs/security-boundaries.md`

Those three would cover most of the architectural ambiguity that still slows safe iteration.
