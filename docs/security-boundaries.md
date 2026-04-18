# Security Boundaries

This document explains the trust boundaries in `cc-telegram-bridge`.

The goal is not to claim the system is "secure" in the abstract. The goal is to make the current security model explicit enough that future changes do not quietly widen trust, weaken isolation, or reintroduce file- or state-handling bugs.

This document should be read together with:

- [Architecture Notes](/Users/cloveric/projects/cc-telegram-bridge/docs/architecture-notes.md)
- [State Model](/Users/cloveric/projects/cc-telegram-bridge/docs/state-model.md)

## Threat Model

The project is a local-first bot bridge, not a public SaaS control plane.

The practical threat model is:

- untrusted Telegram messages reaching a local coding-agent CLI
- untrusted model output being turned into user-visible replies and file reads
- multiple local instances delegating work over loopback HTTP
- sensitive state and credentials living on disk
- engine subprocesses sharing some state with the user's real local CLI

The project is **not** designed as a hardened multi-tenant server.

Reasonable assumptions today:

- the operator controls the host machine
- the bus server listens only on loopback
- Telegram is the only remote entry point
- state directories are private to the local user

If those assumptions change, this document is no longer enough. The code will need a different security model.

## Boundary Map

The current system has six important boundaries:

1. Telegram input vs authorized chat
2. Local bus caller vs trusted peer instance
3. Model output vs filesystem egress
4. Per-instance state vs operational artifacts
5. Bot workspace vs shared engine-global config
6. User intent orchestration vs provider CLI side effects

Not all of these are equally strong.

The strongest boundaries today are:

- Telegram access control
- loopback-only bus exposure
- file delivery sandboxing to workspace-like roots
- owner-only permissions on structured state

The weakest or most intentionally-permeable boundaries today are:

- shared `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
- any engine behavior that can modify files inside the allowed workspace
- fallback behavior when optional config/state is missing or malformed

## 1. Telegram Boundary

Telegram is an untrusted remote input source until access control passes.

### Trusted

- chats that pass the configured access policy
- normalized message metadata after Telegram API parsing

### Untrusted

- message text
- attachments
- reply context
- callback payloads
- any attempt to smuggle file paths, shell intent, or prompt injection

### Current enforcement

- [src/runtime/bridge.ts](/Users/cloveric/projects/cc-telegram-bridge/src/runtime/bridge.ts:114) rejects or challenges normal chats according to `pairing` or `allowlist`
- non-private chats are rejected for normal Telegram use
- unauthorized inputs are answered at the delivery layer before engine execution
- Telegram messages are normalized before command handling

### Residual risk

- once a chat is authorized, the engine still receives raw user text
- prompt injection is a product-level risk, not something access control solves
- features that bypass the normal message path must preserve the same access semantics

### Design rule

Any new Telegram command or callback path must either:

- call the existing access check path, or
- very explicitly justify why it is safe without it

## 2. Local Bus Boundary

The Agent Bus is a privileged local control plane, not a public API.

### Trusted

- loopback-bound bus servers started by known bridge instances
- peers explicitly allowed by `bus.peers`
- requests that pass secret validation when a secret is configured

### Untrusted

- arbitrary local processes
- stale or forged registry entries
- wrong local listeners occupying an expected port
- peer instances not listed in the allowed peer set

### Current enforcement

- [src/bus/bus-server.ts](/Users/cloveric/projects/cc-telegram-bridge/src/bus/bus-server.ts:43) serves only on `127.0.0.1`
- `/api/talk` enforces JSON shape, body size, peer allowlist, and max delegation depth
- bus auth uses a bearer secret when configured
- [src/bus/bus-registry.ts](/Users/cloveric/projects/cc-telegram-bridge/src/bus/bus-registry.ts:67) probes `/api/health` and validates the bridge fingerprint before treating a registry entry as alive
- [src/runtime/bridge.ts](/Users/cloveric/projects/cc-telegram-bridge/src/runtime/bridge.ts:114) auto-allows `chatType === "bus"` only because bus auth is supposed to have already happened at the server boundary

### Residual risk

- local same-user compromise is still high impact
- a leaked bus secret is effectively local remote-control capability for that instance
- bus requests are privileged enough that logging and usage/budget semantics must stay aligned with Telegram

### Design rule

Treat bus changes as security-sensitive even when they are "only local". A loopback API with delegated model execution is still a real authority boundary.

## 3. File Delivery Boundary

File delivery is the highest-risk boundary in the product because it turns model output into filesystem reads and Telegram egress.

### Trusted

- canonical files under the instance workspace
- canonical files under an explicitly resumed project root
- inline ` ```file:... ` blocks for small text/code artifacts

### Untrusted

- arbitrary absolute paths emitted by the engine
- local Markdown links in model output
- symlink paths before canonical resolution
- any file outside the allowed workspace roots

### Current enforcement

- [src/runtime/bridge.ts](/Users/cloveric/projects/cc-telegram-bridge/src/runtime/bridge.ts:33) teaches the engine that `[send-file:/absolute/path]` is the only binary delivery mechanism
- [src/telegram/delivery.ts](/Users/cloveric/projects/cc-telegram-bridge/src/telegram/delivery.ts:539) extracts `[send-file:]`, Markdown image, and Markdown local-link references
- [src/telegram/delivery.ts](/Users/cloveric/projects/cc-telegram-bridge/src/telegram/delivery.ts:581) resolves `realpath()` before policy checks
- delivery only permits canonical paths under the bot workspace or the active `/resume` workspace override
- non-files, oversized files, missing files, and permission failures are rejected and surfaced back to the user

### Residual risk

- the engine can still read and exfiltrate any file that is already readable inside the allowed workspace tree
- `/resume` intentionally widens the file-delivery root to a real project directory
- users should assume that authorizing a bot on a project means the bot may send project files back over Telegram if prompted

### Design rule

Any change touching file extraction, `[send-file:]`, `/resume`, workspace roots, or canonical path checks requires explicit security review and regression tests.

## 4. Per-Instance State Boundary

Each instance has a private state root under `~/.cctb/<instance>/`.

### Trusted

- owner-only structured state files created by the bridge
- append-only operational logs written by the local service

### Untrusted

- malformed or manually edited state files
- partial operational artifacts
- restored archives from unknown provenance

### Current enforcement

- structured state uses atomic temp-file + rename writes
- private state is written with owner-only permissions
- corrupt JSON state can be quarantined rather than silently overwritten
- restore logic preserves private permissions on sensitive state
- lock files and runtime metadata are kept separate from authoritative config/state

### Residual risk

- some operational files remain best-effort rather than transactional
- malformed optional config may still trigger fallback behavior instead of hard failure
- state consistency bugs are more likely to be logic regressions than raw permission bugs now

### Design rule

When adding a new state file, define up front:

- whether it is authoritative or derived
- who owns writes
- whether writes must be serialized
- what recovery behavior is allowed
- whether the file is credential-bearing or privacy-sensitive

## 5. Shared Engine-Home Boundary

The bot no longer has a fully isolated engine-global home.

### Trusted

- the operator's own Claude/Codex CLI environment
- the real `CLAUDE_CONFIG_DIR` / `CODEX_HOME` selected by the parent process

### Untrusted

- any assumption that bot isolation fully contains engine-global side effects
- any feature that writes engine-global settings, caches, MCP config, plugin state, or auth artifacts

### Current enforcement

- [src/service.ts](/Users/cloveric/projects/cc-telegram-bridge/src/service.ts:563) intentionally inherits the real Claude/Codex config home instead of forcing a per-instance engine home
- workspace paths remain per-instance, so normal conversation history stays split by workspace in practice
- legacy Claude project files are migrated into the shared config home so upgrades do not silently drop prior history

### Residual risk

- blast radius is wider than the per-instance state directory
- a bot running in `full-auto` or `bypass` mode can affect engine-global state shared with the user's main CLI
- this is a deliberate trade-off to avoid auth-refresh token races, not a free isolation win

### Design rule

Any feature that touches provider config roots should document whether it is:

- per-instance state
- per-workspace state
- shared engine-global state

Do not describe the system as "fully isolated" without qualifying this boundary.

## 6. Engine Process Boundary

The provider CLI is not a pure function. It is a privileged local subprocess with filesystem and config side effects.

### Trusted

- adapter-level protocol handling
- explicit bridge instructions injected by the runtime

### Untrusted

- provider CLI output shape
- provider auth/session expiry behavior
- any tool or plugin execution performed by the engine

### Current enforcement

- adapter interfaces keep provider-specific parsing contained
- runtime normalizes auth errors, session handling, and usage accounting above the adapter layer
- Telegram-specific instructions explicitly forbid interactive prompt tools and define the file-delivery contract

### Residual risk

- provider behavior can change underneath the bridge
- array/object output formats, auth-expiry paths, and session-rebind semantics need regression coverage
- bugs at this layer usually become product-level reliability issues quickly

### Design rule

Provider integration changes are boundary changes. Treat them as such even when the patch looks like "just parsing".

## Operational Rules

These rules are the shortest useful version of the security model.

- Telegram is untrusted until access control passes.
- Bus is privileged local control-plane traffic, not a convenience API.
- `[send-file:]` is a filesystem egress mechanism and must stay sandboxed.
- `/resume` intentionally expands the workspace trust boundary to a real project root.
- `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are shared-engine boundaries, not per-instance boundaries.
- Sensitive state belongs under the instance state root with owner-only permissions.
- Cross-entry behavior must stay aligned across Telegram, bus, `/fan`, `/verify`, `/btw`, and future entry points.

## Review Checklist For Future Changes

Use this checklist when reviewing changes in security-sensitive areas.

### Access and entry points

- Does the new path enforce the same access semantics as the existing Telegram path?
- If it is bus-only, is the bus boundary still authenticated before `chatType === "bus"` is trusted?

### File handling

- Can model output cause the bridge to read or send a new class of local file?
- Are canonical path checks still in place after symlink resolution?
- Are rejection cases visible to the user and test-covered?

### State

- Is the new file authoritative or derived?
- Are writes atomic and, if needed, serialized?
- Are private files still private after backup/restore/migration?

### Engine integration

- Does the change widen shared engine-home side effects?
- Does it preserve auth-expiry, session-rebind, and malformed-output behavior?

### Cross-entry consistency

- Do Telegram, bus, `/fan`, `/verify`, and other entry points still share the same accounting, audit, and access rules?

## Next Hardening Work

The project does not need a giant security rewrite. It does need discipline around a few seams.

Most valuable next steps:

1. Keep shrinking cross-entry drift by centralizing usage, budget, audit, and post-turn bookkeeping.
2. Maintain regression tests around file delivery, `/resume`, bus auth, and provider output parsing.
3. Keep security assumptions documented when changing shared engine-home behavior.
4. Prefer adding narrow shared helpers over duplicating boundary logic in command-specific flows.
