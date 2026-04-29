import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { collectInstanceSnapshots, renderHtml, serveDashboard } from "../src/commands/dashboard.js";
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("renders cron status in the dashboard html", async () => {
    const html = renderHtml([
      {
        ...baseSnapshot(),
        cronJobs: [
          {
            id: "abcd1234",
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
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
