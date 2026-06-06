---
name: tarocub-service-ops
description: Operate the TaroCub Lark bot fleet — restart, status, stop, start, logs, doctor — via its service manager. Use when asked to restart the fleet/bots, check whether the service is running or healthy, stop or start the bots, view bot logs, or diagnose the Lark service. Triggers: 重启车队 / 重启bot / restart the fleet, 服务状态 / 健康 / service status, 看日志 / logs, doctor / 诊断 / 排查.
---

# TaroCub service ops (Lark fleet)

Manage the TaroCub Lark bot fleet through its own service manager. The commands take an absolute path (via `~`), so they run from any directory.

## Restart the fleet (most common)

```bash
node ~/projects/cc-telegram-bridge/dist/src/index.js lark service restart --all
```

- Restarts every configured Lark instance. **Idle** bots restart immediately; the **current** instance (the one whose bot is running this command) **auto-defers** its own restart until its turn queue is idle — it can't kill itself mid-turn; a **busy** instance is **skipped** (not interrupted).
- Add **`--force`** to also restart busy instances — this **interrupts their in-flight turn**. Use it only when you mean to (the current instance is still deferred, never force-killed).
- **Do NOT hand-roll a per-instance restart loop** (stopping/starting each bot by hand). Always use the manager command above.

## Other service commands

```bash
node ~/projects/cc-telegram-bridge/dist/src/index.js lark service status              # status of the current instance
node ~/projects/cc-telegram-bridge/dist/src/index.js lark service stop  [--all] [--force]
node ~/projects/cc-telegram-bridge/dist/src/index.js lark service start [--all]
node ~/projects/cc-telegram-bridge/dist/src/index.js lark service logs                # recent service logs
node ~/projects/cc-telegram-bridge/dist/src/index.js lark service doctor              # diagnose config / connectivity
```

## Notes

- A full TaroCub release ends with `restart --all` (step 3 of the release ritual: commit → GitHub Release → restart & verify). This is that command.
- The fleet is the configured Lark instances (e.g. ccfcc1/2/3, ccfgg1/2). One bot per instance, one instance per process; state lives under `~/.cctb/<instance>/`.
- If you only need to confirm a bot is alive, `lark service status` (current instance) or checking the process is enough — don't restart unless asked.
