# Runtime Env Troubleshooting

When Claude, Codex, or DeepSeek Harness works in your shell but a bot instance fails, treat it as a runtime environment mismatch first.

## Shared Engine Env Rules

- Do not inject default `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `DSH_HOME` values.
- Only forward `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `DSH_HOME` when the user explicitly exported them.
- If you change one of those variables in your shell, restart the affected instance from that same shell.
- DeepSeek gets a private writable home under the instance state directory, but its authenticated credentials/profiles are sourced from the selected `DSH_HOME`.

## Debugging Order

1. Check the real shell behavior first.
   - `claude auth status`
   - `claude -p "reply with exactly OK and nothing else"`
   - `codex --version`
   - `dsh --version`
2. Run `telegram service doctor --instance <name>`.
   - The `environment` check compares the current shell's explicit shared-engine env (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `DSH_HOME`, depending on the engine) against the running service process.
   - The `legacy-launchd` check warns if an old `LaunchAgent` plist can still relaunch the bot behind your back.
3. Run `npm run smoke:claude-auth` from the same shell.
   - This checks both the current shell and a minimal bot-style environment.
4. Only after the real runtime checks pass should you start building smaller reproductions.

## Legacy launchd Cleanup

If you previously used the removed `telegram autostart ...` feature, old `~/Library/LaunchAgents/com.cloveric.cc-telegram-bridge.*.plist` files can still fight manual `service start/stop`.

Use:

```bash
bash scripts/cleanup-legacy-launchd.sh --all
```

Or remove one instance only:

```bash
bash scripts/cleanup-legacy-launchd.sh <instance>
```
