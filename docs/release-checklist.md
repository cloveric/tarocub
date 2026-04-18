# Release Checklist

This is the lightweight release and verification checklist for `cc-telegram-bridge`.

Use it before tagging a release, merging a large refactor, or claiming a milestone is done.

## 1. Baseline Validation

Run:

```bash
npm test
npm run build
```

If the change is narrow, still prefer full validation before release.

## 2. Area-Specific Regression

Pick the relevant focused set in addition to the full suite.

### Telegram Flow

```bash
npm test -- tests/telegram-instance-config.test.ts tests/telegram-response-delivery.test.ts tests/telegram-turn-error.test.ts tests/telegram-authorized-dispatch.test.ts tests/telegram-message-input.test.ts tests/telegram-message-turn.test.ts tests/telegram-delegation-commands.test.ts tests/telegram-engine-commands.test.ts tests/telegram-simple-commands.test.ts tests/telegram-session-commands.test.ts tests/telegram-turn-bookkeeping.test.ts tests/service.test.ts
```

### Bus / Delegation

```bash
npm test -- tests/bus.test.ts tests/bus-handler.test.ts tests/service.test.ts
```

### State / Schema

```bash
npm test -- tests/access-store.test.ts tests/session-store.test.ts tests/usage-store.test.ts tests/runtime-state.test.ts tests/file-workflow-store.test.ts tests/audit-log.test.ts tests/instance-lock.test.ts
```

## 3. Manual Smoke Checks

Prefer at least one real smoke check when behavior changed materially.

Recommended:

- send one normal Telegram message
- run one local command such as `/status` or `/usage`
- if bus is enabled, run one delegation flow like `/ask`
- if file delivery changed, send one response that delivers a real workspace file

## 4. Security/Boundary Sanity

If the change touched any of these, do an explicit sanity check:

- access policy
- bus auth / bus registry
- `/resume`
- file delivery
- archive restore / backup
- shared Claude/Codex config homes

Questions:

- did the change widen trust?
- did it weaken path validation?
- did it weaken state-file permissions?
- did it disable a guardrail through fallback behavior?

## 5. Compatibility Check

If persisted state or protocol changed:

- confirm runtime schema accepts older valid data where intended
- confirm malformed-but-valid-JSON inputs fail safely
- update the matching docs:
  - `docs/state-model.md`
  - `docs/bus-protocol.md`
  - `docs/event-model.md`

## 6. Operator Experience Check

For meaningful user-facing changes:

- errors should be actionable
- unauthorized or rejected actions should not fail silently
- logs should be loud when fallback behavior disables protection

## 7. Final Pre-Push Checks

- no secrets in diff
- no accidental real chat IDs / pairing codes in tests or docs
- no unrelated state snapshots committed
- docs updated if contracts changed
