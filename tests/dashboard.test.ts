import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it } from "vitest";

import { collectInstanceSnapshots, renderHtml, resolveOpenBrowserCommand, serveDashboard } from "../src/commands/dashboard.js";
import { CronStore } from "../src/state/cron-store.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function baseSnapshot() {
  return {
    name: "alpha",
    stateDir: "/tmp/alpha",
    engine: "codex",
    approvalMode: "normal",
    verbosity: 1,
    effort: "default",
    model: "default",
    locale: "en",
    budgetUsd: null,
    bus: "off",
    running: true,
    pid: 123,
    policy: "allowlist",
    pairedUsers: 1,
    allowlistCount: 1,
    sessionBindings: 1,
    knownChatCount: 0,
    knownChats: [],
    currentTaskChatLabel: null,
    lastHandledUpdateId: 10,
    botTokenConfigured: true,
    agentMdPreview: "",
    claudeMdExists: false,
    usage: { requestCount: 1, totalInputTokens: 2, totalOutputTokens: 3, totalCachedTokens: 0, totalCostUsd: 0, lastUpdatedAt: "" },
    auditTotal: 0,
    lastSuccess: "",
    lastFailure: "",
    lastError: "",
    recentAudit: [],
    timelineTotal: 0,
    recentTimeline: [],
    retryCount: 0,
    budgetBlockedCount: 0,
    serviceErrorCount: 0,
    serviceHealthCount: 0,
    fileRejectedCount: 0,
    workflowFailedCount: 0,
    turnPoolWaitCount: 0,
    liveLogs: [],
    currentTask: {
      status: "idle" as const,
      activeTurnCount: 0,
      source: "unknown" as const,
      chatId: null,
      userId: null,
      updateId: null,
      startedAt: null,
      lastActivityAt: null,
      lastEventType: null,
      outcome: null,
      detail: null,
      filesAccepted: 0,
      filesRejected: 0,
      cronJobId: null,
    },
    crewLatestRunId: null,
    crewLatestRunWorkflow: null,
    crewLatestRunStatus: null,
    crewLatestRunStage: null,
    crewLatestRunUpdatedAt: null,
    cronJobs: [],
  };
}

describe("collectInstanceSnapshots", () => {
  it("opens dashboard targets without interpolating paths into shell commands", () => {
    const target = '/tmp/cctb-dashboard-"quoted".html';

    expect(resolveOpenBrowserCommand(target, "darwin")).toEqual({
      command: "open",
      args: [target],
    });
    expect(resolveOpenBrowserCommand(target, "linux")).toEqual({
      command: "xdg-open",
      args: [target],
    });
    expect(resolveOpenBrowserCommand(target, "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", target],
    });
  });

  it("uses channel-neutral dashboard branding and empty-state guidance", () => {
    const html = renderHtml([]);

    expect(html).toContain("<title>CC Bridge Dashboard</title>");
    expect(html).toContain("<h1>CC Bridge Dashboard</h1>");
    expect(html).toContain("Configure Telegram with");
    expect(html).toContain("or Lark with");
    expect(html).toContain("telegram dashboard --live");
    expect(html).toContain("lark dashboard --live");
    expect(html).not.toContain("CC Telegram Bridge");
    expect(html).not.toContain("telegram configure &lt;token&gt;");
  });

  it("escapes model and other config labels before rendering dashboard html", () => {
    const payload = "<svg/onload=globalThis.__dashboardXss=1>";
    const html = renderHtml([{
      ...baseSnapshot(),
      model: payload,
      policy: payload,
      locale: payload,
    }]);

    expect(html).not.toContain(payload);
    expect(html).toContain("&lt;svg/onload=globalThis.__dashboardXss=1&gt;");
  });

  it("uses CODEX_TELEGRAM_STATE_DIR as the dashboard source and does not treat a bare .env as a configured token", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const customStateDir = path.join(tempDir, "custom-alpha");

    try {
      await mkdir(customStateDir, { recursive: true });
      await writeFile(path.join(customStateDir, "config.json"), JSON.stringify({ engine: "claude" }), "utf8");
      await writeFile(path.join(customStateDir, ".env"), "EXTRA=1\n", "utf8");
      await mkdir(path.join(customStateDir, "crew-runs"), { recursive: true });
      await writeFile(
        path.join(customStateDir, "crew-runs", "run-1.json"),
        JSON.stringify({
          runId: "run-1",
          workflow: "research-report",
          status: "completed",
          currentStage: "completed",
          coordinator: "custom-alpha",
          chatId: 100,
          userId: 200,
          locale: "en",
          originalPrompt: "Analyze AI adoption",
          createdAt: "2026-04-08T10:01:10.000Z",
          updatedAt: "2026-04-08T10:02:10.000Z",
          finalOutput: "Final report",
          stages: {},
        }),
        "utf8",
      );

      const snapshots = await collectInstanceSnapshots({
        USERPROFILE: tempDir,
        CODEX_TELEGRAM_STATE_DIR: customStateDir,
      });

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        name: "custom-alpha",
        stateDir: customStateDir,
        engine: "claude",
        botTokenConfigured: false,
        crewLatestRunId: "run-1",
        crewLatestRunStatus: "completed",
        crewLatestRunStage: "completed",
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("does not mark a custom-state instance as running when the pid is alive but not this service", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const customStateDir = path.join(tempDir, "custom-alpha");

    try {
      await mkdir(customStateDir, { recursive: true });
      await writeFile(path.join(customStateDir, "config.json"), JSON.stringify({ engine: "codex" }), "utf8");
      await writeFile(
        path.join(customStateDir, "instance.lock.json"),
        JSON.stringify({ pid: 12345, token: "token", acquiredAt: new Date().toISOString() }),
        "utf8",
      );

      const snapshots = await collectInstanceSnapshots(
        {
          USERPROFILE: tempDir,
          CODEX_TELEGRAM_STATE_DIR: customStateDir,
        },
        {
          cwd: REPO_ROOT,
          isProcessAlive: (pid) => pid === 12345,
          isExpectedServiceProcess: () => false,
        },
      );

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        name: "custom-alpha",
        running: false,
        pid: null,
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("includes read-only cron job status in instance snapshots", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const customStateDir = path.join(tempDir, "custom-alpha");

    try {
      await mkdir(customStateDir, { recursive: true });
      await writeFile(path.join(customStateDir, "config.json"), JSON.stringify({ engine: "codex" }), "utf8");
      const store = new CronStore(customStateDir);
      const targetAt = new Date(Date.now() + 5 * 60_000).toISOString();
      await store.add({
        chatId: 100,
        userId: 200,
        cronExpr: "5 10 29 4 *",
        prompt: "drink water",
        runOnce: true,
        targetAt,
      });
      const recurring = await store.add({
        chatId: 100,
        userId: 200,
        cronExpr: "0 * * * *",
        prompt: "check stock price",
      });
      await store.recordRun(recurring.id, {
        success: false,
        error: "queued Telegram turn was skipped before execution",
        ranAt: new Date().toISOString(),
      });

      const snapshots = await collectInstanceSnapshots({
        USERPROFILE: tempDir,
        CODEX_TELEGRAM_STATE_DIR: customStateDir,
      });

      expect(snapshots[0]!.cronJobs).toHaveLength(2);
      expect(snapshots[0]!.cronJobs[0]).toMatchObject({
        kind: "once",
        prompt: "drink water",
        targetAt,
        nextRunAt: targetAt,
      });
      expect(snapshots[0]!.cronJobs[1]).toMatchObject({
        kind: "recurring",
        prompt: "check stock price",
        lastError: "queued Telegram turn was skipped before execution",
        failureCount: 1,
        maxFailures: 3,
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("surfaces Lark cron routing metadata in snapshots and dashboard html", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const customStateDir = path.join(tempDir, "custom-lark");

    try {
      await mkdir(customStateDir, { recursive: true });
      await writeFile(path.join(customStateDir, "config.json"), JSON.stringify({ engine: "codex" }), "utf8");
      const store = new CronStore(customStateDir);
      await store.add({
        channel: "lark",
        chatId: 100,
        userId: 200,
        chatType: "group",
        conversationKey: "lark:oc_lark_chat:thread_1",
        larkChatId: "oc_lark_chat",
        larkThreadId: "thread_1",
        larkMessageId: "om_message_1",
        cronExpr: "0 9 * * *",
        prompt: "daily Lark briefing",
      });

      const snapshots = await collectInstanceSnapshots({
        USERPROFILE: tempDir,
        CODEX_TELEGRAM_STATE_DIR: customStateDir,
      });

      expect(snapshots[0]!.cronJobs[0]).toMatchObject({
        channel: "lark",
        larkChatId: "oc_lark_chat",
        larkThreadId: "thread_1",
        larkMessageId: "om_message_1",
      });

      const html = renderHtml(snapshots);
      expect(html).toContain("daily Lark briefing");
      expect(html).toContain("lark");
      expect(html).toContain("oc_lark_chat");
      expect(html).toContain("thread thread_1");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("includes a current task snapshot derived from runtime state and timeline events", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const customStateDir = path.join(tempDir, "custom-alpha");
    const startedAt = new Date(Date.now() - 6_000).toISOString();
    const engineAt = new Date(Date.now() - 1_000).toISOString();
    const fileAt = new Date().toISOString();

    try {
      await mkdir(customStateDir, { recursive: true });
      await writeFile(path.join(customStateDir, "config.json"), JSON.stringify({ engine: "codex" }), "utf8");
      await writeFile(
        path.join(customStateDir, "runtime-state.json"),
        JSON.stringify({
          lastHandledUpdateId: 98,
          activeTurnCount: 1,
          activeTurnStartedAt: startedAt,
          activeTurnUpdatedAt: startedAt,
        }),
        "utf8",
      );
      await writeFile(
        path.join(customStateDir, "timeline.log.jsonl"),
        [
          JSON.stringify({ timestamp: startedAt, type: "turn.started", channel: "telegram", chatId: 100, userId: 200, updateId: 99 }),
          JSON.stringify({ timestamp: engineAt, type: "engine.event", channel: "telegram", chatId: 100, userId: 200, updateId: 99, detail: "tool_call", metadata: { toolName: "bash" } }),
          JSON.stringify({ timestamp: fileAt, type: "file.accepted", channel: "telegram", chatId: 100, outcome: "accepted", metadata: { fileName: "out.png" } }),
        ].join("\n") + "\n",
        "utf8",
      );
      const snapshots = await collectInstanceSnapshots({
        USERPROFILE: tempDir,
        CODEX_TELEGRAM_STATE_DIR: customStateDir,
      });

      expect(snapshots[0]!.currentTask).toMatchObject({
        status: "running",
        activeTurnCount: 1,
        source: "telegram",
        chatId: 100,
        userId: 200,
        updateId: 99,
        startedAt,
        lastActivityAt: fileAt,
        lastEventType: "file.accepted",
        filesAccepted: 1,
        filesRejected: 0,
      });
      expect(snapshots[0]!.liveLogs.at(-1)).toMatchObject({
        type: "file.accepted",
        channel: "telegram",
        chatId: 100,
        detail: "fileName=out.png",
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("marks Lark turns as Lark current tasks in dashboard snapshots", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const customStateDir = path.join(tempDir, "custom-lark");
    const startedAt = new Date(Date.now() - 6_000).toISOString();
    const engineAt = new Date(Date.now() - 1_000).toISOString();

    try {
      await mkdir(customStateDir, { recursive: true });
      await writeFile(path.join(customStateDir, "config.json"), JSON.stringify({ engine: "codex" }), "utf8");
      await writeFile(
        path.join(customStateDir, "runtime-state.json"),
        JSON.stringify({
          activeTurnCount: 1,
          activeTurnStartedAt: startedAt,
          activeTurnUpdatedAt: startedAt,
        }),
        "utf8",
      );
      await writeFile(
        path.join(customStateDir, "timeline.log.jsonl"),
        [
          JSON.stringify({ timestamp: startedAt, type: "turn.started", channel: "lark", chatId: 100, userId: 200, conversationKey: "lark:oc_lark_chat" }),
          JSON.stringify({ timestamp: engineAt, type: "engine.event", channel: "lark", chatId: 100, userId: 200, conversationKey: "lark:oc_lark_chat", detail: "tool_call" }),
        ].join("\n") + "\n",
        "utf8",
      );
      await writeFile(
        path.join(customStateDir, "known-chats.json"),
        JSON.stringify({
          chats: [{
            chatId: "oc_lark_chat",
            conversationKey: "lark:oc_lark_chat",
            bridgeChatId: 100,
            bridgeAccessChatId: 100,
            chatType: "group",
            label: "研发群",
            lastSeenAt: engineAt,
          }],
        }),
        "utf8",
      );

      const snapshots = await collectInstanceSnapshots({
        USERPROFILE: tempDir,
        CODEX_TELEGRAM_STATE_DIR: customStateDir,
      });

      expect(snapshots[0]!.currentTask).toMatchObject({
        status: "running",
        source: "lark",
        chatId: 100,
        userId: 200,
        lastEventType: "engine.event",
      });
      expect(snapshots[0]!.knownChatCount).toBe(1);
      expect(snapshots[0]!.currentTaskChatLabel).toBe("研发群");

      const html = renderHtml(snapshots);
      expect(html).toContain("lark · 研发群");
      expect(html).toContain("Known Chats");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("does not count historical file events as current-turn activity without a start marker", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const customStateDir = path.join(tempDir, "custom-alpha");

    try {
      await mkdir(customStateDir, { recursive: true });
      await writeFile(path.join(customStateDir, "config.json"), JSON.stringify({ engine: "codex" }), "utf8");
      await writeFile(
        path.join(customStateDir, "runtime-state.json"),
        JSON.stringify({
          lastHandledUpdateId: 98,
          activeTurnCount: 0,
        }),
        "utf8",
      );
      await writeFile(
        path.join(customStateDir, "timeline.log.jsonl"),
        [
          JSON.stringify({ timestamp: "2026-04-29T04:00:00.000Z", type: "file.accepted", channel: "telegram", chatId: 100, outcome: "accepted", metadata: { fileName: "old.png" } }),
          JSON.stringify({ timestamp: "2026-04-29T04:01:00.000Z", type: "file.rejected", channel: "telegram", chatId: 100, outcome: "error", metadata: { fileName: "old-missing.png" } }),
        ].join("\n") + "\n",
        "utf8",
      );

      const snapshots = await collectInstanceSnapshots({
        USERPROFILE: tempDir,
        CODEX_TELEGRAM_STATE_DIR: customStateDir,
      });

      expect(snapshots[0]!.currentTask).toMatchObject({
        status: "idle",
        filesAccepted: 0,
        filesRejected: 0,
      });
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("summarizes incident counts from timeline events for dashboard triage", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const customStateDir = path.join(tempDir, "custom-alpha");

    try {
      await mkdir(customStateDir, { recursive: true });
      await writeFile(path.join(customStateDir, "config.json"), JSON.stringify({ engine: "codex" }), "utf8");
      await writeFile(
        path.join(customStateDir, "timeline.log.jsonl"),
        [
          JSON.stringify({ timestamp: "2026-04-29T10:00:00.000Z", type: "turn.retried", channel: "telegram", outcome: "retry" }),
          JSON.stringify({ timestamp: "2026-04-29T10:01:00.000Z", type: "service.error", channel: "lark", detail: "websocket dropped", outcome: "error" }),
          JSON.stringify({ timestamp: "2026-04-29T10:02:00.000Z", type: "file.rejected", channel: "lark", outcome: "rejected" }),
          JSON.stringify({ timestamp: "2026-04-29T10:03:00.000Z", type: "budget.blocked", channel: "telegram", outcome: "blocked" }),
          JSON.stringify({ timestamp: "2026-04-29T10:04:00.000Z", type: "workflow.failed", channel: "lark", outcome: "error" }),
        ].join("\n") + "\n",
        "utf8",
      );

      const snapshots = await collectInstanceSnapshots({
        USERPROFILE: tempDir,
        CODEX_TELEGRAM_STATE_DIR: customStateDir,
      });

      expect(snapshots[0]).toMatchObject({
        retryCount: 1,
        serviceErrorCount: 1,
        fileRejectedCount: 1,
        budgetBlockedCount: 1,
        workflowFailedCount: 1,
      });

      const html = renderHtml(snapshots);
      expect(html).toContain("Incidents");
      expect(html).toContain("Service errors");
      expect(html).toContain("File rejects");
      expect(html).toContain("Budget blocks");
      expect(html).toContain("Workflow fails");
    } finally {
      await removeTempRoot(tempDir);
    }
  });

  it("renders cron status in the dashboard html", async () => {
    const html = renderHtml([
      {
        ...baseSnapshot(),
        cronJobs: [
          {
            id: "abcd1234",
            channel: "telegram",
            kind: "once",
            enabled: false,
            schedule: "once 2026-04-29T10:05:00.000Z",
            nextRunAt: null,
            targetAt: "2026-04-29T10:05:00.000Z",
            lastRunAt: "2026-04-29T10:05:00.000Z",
            lastSuccessAt: null,
            lastError: "engine failed",
            failureCount: 2,
            maxFailures: 3,
            timezone: "Asia/Shanghai",
            prompt: "drink water",
            chatId: 100,
            userId: 200,
            larkChatId: null,
            larkThreadId: null,
            larkMessageId: null,
          },
        ],
      },
    ]);

    expect(html).toContain("Scheduled Tasks");
    expect(html).toContain("abcd1234");
    expect(html).toContain("drink water");
    expect(html).toContain("engine failed");
    expect(html).toContain("failures 2/3");
  });

  it("renders current task and live logs in the dashboard html", async () => {
    const html = renderHtml([
      {
        ...baseSnapshot(),
        auditTotal: 1,
        recentAudit: [
          {
            timestamp: "2026-04-29T10:00:07.000Z",
            type: "update.handle",
            outcome: "success",
          },
        ],
        currentTask: {
          status: "running",
          activeTurnCount: 1,
          source: "telegram",
          chatId: 100,
          userId: 200,
          updateId: 99,
          startedAt: "2026-04-29T10:00:00.000Z",
          lastActivityAt: "2026-04-29T10:00:06.000Z",
          lastEventType: "engine.event",
          outcome: null,
          detail: "tool_call",
          filesAccepted: 1,
          filesRejected: 0,
          cronJobId: null,
        },
        liveLogs: [
          {
            timestamp: "2026-04-29T10:00:06.000Z",
            type: "engine.event",
            outcome: "",
            channel: "telegram",
            chatId: 100,
            updateId: 99,
            detail: "tool_call",
          },
        ],
      },
    ]);

    expect(html).toContain("Current Task");
    expect(html).toContain("running");
    expect(html).toContain("update 99");
    expect(html).toContain("Live Logs");
    expect(html).toContain("tool_call");
    expect(html).toContain('data-panel="alpha:logs"');
    expect(html).toContain('<details class="logs" data-panel="alpha:logs">');
    expect(html).toContain('data-panel="alpha:activity"');
    const cardBodyIndex = html.indexOf('<div class="card-body">');
    expect(html.indexOf('<section class="task">', cardBodyIndex)).toBeLessThan(
      html.indexOf('<div class="metrics">', cardBodyIndex),
    );
  });

  it("renders usage analytics across daily and monthly buckets", async () => {
    const html = renderHtml([
      {
        ...baseSnapshot(),
        usage: {
          requestCount: 3,
          totalInputTokens: 900,
          totalOutputTokens: 300,
          totalCachedTokens: 300,
          totalCostUsd: 0.09,
          lastUpdatedAt: "2026-04-29T10:00:00.000Z",
          daily: {
            "2026-04-28": {
              requestCount: 1,
              totalInputTokens: 100,
              totalOutputTokens: 50,
              totalCachedTokens: 25,
              totalCostUsd: 0.01,
              lastUpdatedAt: "2026-04-28T10:00:00.000Z",
            },
            "2026-04-29": {
              requestCount: 2,
              totalInputTokens: 800,
              totalOutputTokens: 250,
              totalCachedTokens: 275,
              totalCostUsd: 0.08,
              lastUpdatedAt: "2026-04-29T10:00:00.000Z",
            },
          },
          monthly: {
            "2026-04": {
              requestCount: 3,
              totalInputTokens: 900,
              totalOutputTokens: 300,
              totalCachedTokens: 300,
              totalCostUsd: 0.09,
              lastUpdatedAt: "2026-04-29T10:00:00.000Z",
            },
          },
        },
      },
    ], { now: new Date("2026-04-29T12:00:00.000Z") });

    expect(html).toContain("Usage Intelligence");
    expect(html).toContain("Today");
    expect(html).toContain("This Month");
    expect(html).toContain("Avg / req");
    expect(html).toContain("Cache Ratio");
    expect(html).toContain("2026-04");
    expect(html).toContain("1.1K");
  });

  it("serves a live dashboard that refreshes data on each request", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const customStateDir = path.join(tempDir, "custom-alpha");
    let server: Awaited<ReturnType<typeof serveDashboard>> | undefined;

    try {
      await mkdir(customStateDir, { recursive: true });
      await writeFile(path.join(customStateDir, "config.json"), JSON.stringify({ engine: "codex" }), "utf8");
      await writeFile(
        path.join(customStateDir, "timeline.log.jsonl"),
        '{"timestamp":"2026-04-29T10:00:00.000Z","type":"engine.event","channel":"telegram","detail":"first"}\n',
        "utf8",
      );

      server = await serveDashboard(
        { USERPROFILE: tempDir, CODEX_TELEGRAM_STATE_DIR: customStateDir },
        { open: false, refreshSeconds: 1 },
      );
      const first = await fetch(server.url).then((response) => response.text());
      expect(first).toContain("first");
      expect(first).not.toContain('http-equiv="refresh"');
      expect(first).toContain("dashboard-refresh");
      expect(first).toContain("restoreDetailsState");
      expect(first).toContain("rememberDetailsState");

      await writeFile(
        path.join(customStateDir, "timeline.log.jsonl"),
        '{"timestamp":"2026-04-29T10:00:01.000Z","type":"engine.event","channel":"telegram","detail":"second"}\n',
        "utf8",
      );
      const second = await fetch(new URL("/fragment", server.url)).then((response) => response.text());
      expect(second).not.toContain("<!DOCTYPE html>");
      expect(second).toContain("second");
      expect(second).not.toContain('log-detail">first');
    } finally {
      await server?.close();
      await removeTempRoot(tempDir);
    }
  });
});
