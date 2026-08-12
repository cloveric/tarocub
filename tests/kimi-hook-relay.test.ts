import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureKimiHookRelayPlugin,
  isKimiHookRelayVersionSupported,
  KIMI_HOOK_RELAY_TOKEN_ENV,
  KIMI_HOOK_RELAY_URL_ENV,
  parseKimiHookEvent,
  startKimiHookRelay,
} from "../src/codex/kimi-hook-relay.js";

describe("Kimi hook relay", () => {
  it("enables hooks only for Kimi Code 0.32 or newer", () => {
    expect(isKimiHookRelayVersionSupported("0.32.0\n")).toBe(true);
    expect(isKimiHookRelayVersionSupported("Kimi Code CLI 1.0.0\n")).toBe(true);
    expect(isKimiHookRelayVersionSupported("0.31.9\n")).toBe(false);
    expect(isKimiHookRelayVersionSupported("unknown\n")).toBe(false);
  });

  it("accepts turn and task lifecycle hooks and deliberately rejects SessionHeartbeat", () => {
    expect(parseKimiHookEvent({
      hook_event_name: "TurnStarted",
      session_id: "session-1",
      turn_id: 52,
      origin_kind: "task",
      prompt: "<notification source_id=\"bash-1\">done</notification>",
    })).toEqual({
      hookEventName: "TurnStarted",
      sessionId: "session-1",
      turnId: "52",
      originKind: "task",
      prompt: "<notification source_id=\"bash-1\">done</notification>",
    });
    expect(parseKimiHookEvent({
      hook_event_name: "TurnStarted",
      session_id: "session-1",
      turn_id: 53,
      origin_kind: "task",
      prompt: [{
        type: "text",
        text: "<notification source_id=\"bash-2\">retry</notification>",
      }],
    })).toEqual({
      hookEventName: "TurnStarted",
      sessionId: "session-1",
      turnId: "53",
      originKind: "task",
      prompt: "<notification source_id=\"bash-2\">retry</notification>",
    });
    expect(parseKimiHookEvent({
      hook_event_name: "TurnStarted",
      session_id: "session-1",
      turn_id: 54,
      origin: {
        kind: "task",
        taskId: "bash-3",
      },
      input: [{
        type: "text",
        text: "<notification source_id=\"bash-3\">done</notification>",
      }],
    })).toEqual({
      hookEventName: "TurnStarted",
      sessionId: "session-1",
      turnId: "54",
      originKind: "task",
      originTaskId: "bash-3",
      prompt: "<notification source_id=\"bash-3\">done</notification>",
    });
    expect(parseKimiHookEvent({
      hook_event_name: "Stop",
      session_id: "session-1",
      stop_hook_active: false,
    })).toEqual({
      hookEventName: "Stop",
      sessionId: "session-1",
      stopHookActive: false,
    });
    expect(parseKimiHookEvent({
      hook_event_name: "StopFailure",
      session_id: "session-1",
      error_type: "ToolError",
      error_message: "background repair failed",
    })).toEqual({
      hookEventName: "StopFailure",
      sessionId: "session-1",
      errorType: "ToolError",
      errorMessage: "background repair failed",
    });
    expect(parseKimiHookEvent({
      hook_event_name: "Interrupt",
      session_id: "session-1",
      turn_id: "53",
      reason: "cancelled",
    })).toEqual({
      hookEventName: "Interrupt",
      sessionId: "session-1",
      turnId: "53",
      reason: "cancelled",
    });
    expect(parseKimiHookEvent({
      hook_event_name: "TaskStarted",
      session_id: "session-1",
      task_id: "bash-1",
      kind: "process",
      description: "Build release",
      status: "running",
      detached: true,
      started_at: 123,
    })).toEqual({
      hookEventName: "TaskStarted",
      sessionId: "session-1",
      taskId: "bash-1",
      kind: "process",
      description: "Build release",
      status: "running",
      detached: true,
      startedAt: 123,
    });
    expect(parseKimiHookEvent({
      hook_event_name: "SessionHeartbeat",
      session_id: "session-1",
      uptime_ms: 60_000,
    })).toBeNull();
    expect(parseKimiHookEvent({
      hook_event_name: "Notification",
      session_id: "session-1",
      notification_type: "task.completed",
      source_kind: "background_task",
      source_id: "task-7",
      body: "Finished.",
    })).toEqual(expect.objectContaining({
      hookEventName: "Notification",
      sessionId: "session-1",
      notificationType: "task.completed",
      sourceId: "task-7",
    }));
    expect(parseKimiHookEvent({
      hook_event_name: "SubagentStop",
      session_id: "session-1",
      agent_name: "reviewer",
      response: "No findings.",
    })).toEqual({
      hookEventName: "SubagentStop",
      sessionId: "session-1",
      agentName: "reviewer",
      response: "No findings.",
    });
    expect(parseKimiHookEvent({
      hook_event_name: "Notification",
      session_id: "session-1",
      notification_type: "task.completed",
    })).toBeNull();
  });

  it("registers an inert plugin without replacing existing Kimi plugins", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "tarocub-kimi-hook-home-"));
    const installedPath = path.join(home, "plugins", "installed.json");
    await mkdir(path.dirname(installedPath), { recursive: true });
    await writeFile(installedPath, `${JSON.stringify({
      version: 1,
      plugins: [{
        id: "existing-plugin",
        root: "/tmp/existing-plugin",
        source: "local-path",
        enabled: true,
        installedAt: "2026-01-01T00:00:00.000Z",
      }],
    }, null, 2)}\n`, "utf8");

    try {
      const pluginRoot = await ensureKimiHookRelayPlugin(home);
      const firstRegistry = await readFile(installedPath, "utf8");
      await ensureKimiHookRelayPlugin(home);
      const secondRegistry = await readFile(installedPath, "utf8");
      expect(secondRegistry).toBe(firstRegistry);

      const installed = JSON.parse(firstRegistry) as {
        plugins: Array<{ id: string; root: string; enabled: boolean }>;
      };
      expect(installed.plugins).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "existing-plugin", root: "/tmp/existing-plugin" }),
        expect.objectContaining({ id: "tarocub-hook-relay", root: pluginRoot, enabled: true }),
      ]));

      const manifest = JSON.parse(await readFile(path.join(pluginRoot, "kimi.plugin.json"), "utf8")) as {
        hooks: Array<{ event: string; command: string }>;
      };
      expect(manifest.hooks.map((hook) => hook.event)).toEqual([
        "TurnStarted",
        "Stop",
        "StopFailure",
        "Interrupt",
        "TaskStarted",
        "Notification",
        "SubagentStop",
      ]);
      expect(manifest.hooks.some((hook) => hook.event === "SessionHeartbeat")).toBe(false);
      expect(manifest.hooks[0]?.command).toContain("forward.mjs");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("authenticates loopback posts and serializes accepted hook events", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "tarocub-kimi-hook-server-"));
    const received: string[] = [];
    const runtime = await startKimiHookRelay({
      engineHomePath: home,
      onEvent: async (event) => {
        if (event.hookEventName === "TaskStarted") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          received.push(`start:${event.taskId}`);
        } else if (event.hookEventName === "Notification") {
          received.push(`done:${event.sourceId}`);
        }
      },
    });
    const url = runtime.env[KIMI_HOOK_RELAY_URL_ENV];
    const token = runtime.env[KIMI_HOOK_RELAY_TOKEN_ENV];

    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const forbidden = await fetch(url!, {
        method: "POST",
        body: JSON.stringify({
          hook_event_name: "TaskStarted",
          session_id: "session-1",
          task_id: "bash-1",
        }),
      });
      expect(forbidden.status).toBe(403);

      const headers = {
        "content-type": "application/json",
        "x-tarocub-kimi-hook-token": token!,
      };
      const start = await fetch(url!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "TaskStarted",
          session_id: "session-1",
          task_id: "bash-1",
          detached: true,
        }),
      });
      const done = await fetch(url!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "Notification",
          session_id: "session-1",
          notification_type: "task.completed",
          source_kind: "background_task",
          source_id: "bash-1",
        }),
      });
      expect([start.status, done.status]).toEqual([202, 202]);
      await runtime.drainAcceptedEvents();
      expect(received).toEqual(["start:bash-1", "done:bash-1"]);
    } finally {
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("waits for accepted hook handlers when explicitly drained", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "tarocub-kimi-hook-explicit-drain-"));
    let releaseHandler: (() => void) | undefined;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const runtime = await startKimiHookRelay({
      engineHomePath: home,
      onEvent: async () => await handlerReleased,
    });

    try {
      const response = await fetch(runtime.env[KIMI_HOOK_RELAY_URL_ENV]!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tarocub-kimi-hook-token": runtime.env[KIMI_HOOK_RELAY_TOKEN_ENV]!,
        },
        body: JSON.stringify({
          hook_event_name: "TaskStarted",
          session_id: "session-1",
          task_id: "bash-explicit-drain",
          detached: true,
        }),
      });
      expect(response.status).toBe(202);

      let drainResolved = false;
      const drainPromise = runtime.drainAcceptedEvents().then(() => {
        drainResolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(drainResolved).toBe(false);
      releaseHandler?.();
      await drainPromise;
      expect(drainResolved).toBe(true);
    } finally {
      releaseHandler?.();
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("waits for accepted hook handlers before close resolves", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "tarocub-kimi-hook-drain-"));
    let releaseHandler: (() => void) | undefined;
    let markHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const runtime = await startKimiHookRelay({
      engineHomePath: home,
      onEvent: async () => {
        markHandlerStarted?.();
        await handlerReleased;
      },
    });

    try {
      const response = await fetch(runtime.env[KIMI_HOOK_RELAY_URL_ENV]!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tarocub-kimi-hook-token": runtime.env[KIMI_HOOK_RELAY_TOKEN_ENV]!,
        },
        body: JSON.stringify({
          hook_event_name: "TaskStarted",
          session_id: "session-1",
          task_id: "bash-drain",
          detached: true,
        }),
      });
      expect(response.status).toBe(202);
      await handlerStarted;

      let closeResolved = false;
      const closePromise = runtime.close().then(() => {
        closeResolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closeResolved).toBe(false);

      releaseHandler?.();
      await closePromise;
      expect(closeResolved).toBe(true);
    } finally {
      releaseHandler?.();
      await runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
