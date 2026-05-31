# Release Checklist

This is the lightweight release and verification checklist for TaroCub.

Use it before tagging a release, merging a large refactor, or claiming a milestone is done.

## Release Definition

For this repository, "commit and release" means all of the following have completed:

1. The intended changes are committed, with no unrelated runtime state or secrets staged.
2. The version/tag and GitHub Release are created or updated with accurate release notes.
3. The package is published with `npm publish`.
4. The local fleet is restarted and verified across Telegram and Lark.

Do not call a release complete until GitHub Release, `npm publish`, and Telegram and Lark restart verification have all succeeded. If `package.json` is still marked private, the registry rejects the package, or credentials are missing, report the npm publish step as blocked instead of silently skipping it.

`package.json` is intentionally publishable by default: it must not be marked `private`, and its npm metadata must keep the `tarocub` bin pointing at the built `dist/src/index.js` entrypoint. Run `npm run build` before publishing so the package contains fresh `dist/src` output without test artifacts.

For Lark service restarts, use the single fleet command:

```bash
node dist/src/index.js lark service restart --all
```

Do not hand-roll shell loops for Lark service restarts. The CLI knows how to defer the current active Lark instance so it does not kill the turn that is running the release.

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
npm test -- tests/access-store.test.ts tests/session-store.test.ts tests/usage-store.test.ts tests/runtime-state.test.ts tests/file-workflow-store.test.ts tests/cron-store.test.ts tests/audit-log.test.ts tests/instance-lock.test.ts
```

### Scheduled Tasks / Cron

```bash
npm test -- tests/cron-store.test.ts tests/cron-scheduler.test.ts tests/cron-executor.test.ts tests/cron-tags.test.ts tests/cron-helper-server.test.ts tests/cron-cli.test.ts tests/telegram-cron-commands.test.ts tests/cli.test.ts
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
- scheduled tasks / cron tag parsing and deprecated helper permissions
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
