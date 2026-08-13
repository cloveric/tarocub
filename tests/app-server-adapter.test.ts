import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import {
  CODEX_APP_SERVER_AUTO_COMPACT_RATIO,
  CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS,
  CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS,
  CODEX_APP_SERVER_INACTIVITY_TIMEOUT_MS,
  CODEX_APP_SERVER_GOAL_RPC_TIMEOUT_MS,
  CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS,
  CODEX_APP_SERVER_TURN_TIMEOUT_MS,
  CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS,
  CodexAppServerAdapter,
  codexPlanTodos,
  extractCodexToolItem,
} from "../src/codex/app-server-adapter.js";

describe("extractCodexToolItem", () => {
  it("maps a command execution item to a Bash tool event", () => {
    expect(extractCodexToolItem({
      id: "c1",
      type: "commandExecution",
      command: "npm test",
      aggregatedOutput: "ok",
      exitCode: 0,
      status: "completed",
    })).toEqual({
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolUseId: "c1",
      output: "ok",
      isError: false,
    });
  });

  it("flags a non-zero command exit as a tool error", () => {
    expect(extractCodexToolItem({ type: "command_execution", command: "false", exit_code: 1 }))
      .toMatchObject({ toolName: "Bash", isError: true });
  });

  it("maps file change, mcp tool call, and web search items", () => {
    expect(extractCodexToolItem({ type: "fileChange", path: "/a/b.ts", status: "completed" }))
      .toMatchObject({ toolName: "Edit", toolInput: { file_path: "/a/b.ts" }, isError: false });
    expect(extractCodexToolItem({ type: "mcpToolCall", server: "web", tool: "search", arguments: { q: "x" } }))
      .toMatchObject({ toolName: "web.search", toolInput: { q: "x" } });
    expect(extractCodexToolItem({ type: "webSearch", query: "tarocub" }))
      .toMatchObject({ toolName: "WebSearch", toolInput: { query: "tarocub" } });
  });

  it("returns null for non-tool items", () => {
    expect(extractCodexToolItem({ type: "agentMessage", text: "hi" })).toBeNull();
    expect(extractCodexToolItem(null)).toBeNull();
    expect(extractCodexToolItem("nope")).toBeNull();
  });

  it("maps a Codex plan item to a TodoWrite event (so the plan panel renders)", () => {
    // Shape confirmed from the Codex app-server: turn/plan/updated → { plan: [{step, status}] }.
    expect(extractCodexToolItem({
      type: "plan",
      plan: [
        { step: "Read the code", status: "completed" },
        { step: "Write tests", status: "in_progress" },
        { step: "Ship", status: "pending" },
      ],
    })).toMatchObject({
      toolName: "TodoWrite",
      toolInput: { todos: [
        { content: "Read the code", status: "completed" },
        { content: "Write tests", status: "in_progress" },
        { content: "Ship", status: "pending" },
      ] },
    });
  });
});

describe("codexPlanTodos", () => {
  it("converts Codex plan steps to TodoWrite todos", () => {
    expect(codexPlanTodos([{ step: "A", status: "completed" }, { step: "B", status: "pending" }])).toEqual([
      { content: "A", status: "completed", activeForm: "A" },
      { content: "B", status: "pending", activeForm: "B" },
    ]);
  });
  it("accepts a { steps: [...] } wrapper and drops empty steps", () => {
    expect(codexPlanTodos({ steps: [{ step: "X", status: "in_progress" }, { step: "  ", status: "pending" }] }))
      .toEqual([{ content: "X", status: "in_progress", activeForm: "X" }]);
  });
  it("returns null for nothing usable", () => {
    expect(codexPlanTodos(undefined)).toBeNull();
    expect(codexPlanTodos([])).toBeNull();
    expect(codexPlanTodos("nope")).toBeNull();
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Condition was not met in time");
}

class FakeStream extends EventEmitter {
  emitData(chunk: string | Buffer) {
    this.emit("data", chunk);
  }
}

class FakeWritable {
  lines: string[] = [];
  nextError: Error | null = null;

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) {
      this.lines.push(text);
    }
    const error = this.nextError;
    this.nextError = null;
    callback?.(error);
    return true;
  }
}

class FakeChildProcess extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeStream();
  stderr = new FakeStream();
  killCalls = 0;

  kill() {
    this.killCalls += 1;
  }

  close(code: number | null) {
    this.emit("close", code);
  }
}

function createSpawnHarness() {
  const child = new FakeChildProcess();
  const calls: Array<{
    command: string;
    args: string[];
    options: {
      stdio: ["pipe", "pipe", "pipe"];
      shell?: boolean;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      windowsHide?: boolean;
    };
  }> = [];

  const spawnFn = (
    command: string,
    args: string[],
    options: {
      stdio: ["pipe", "pipe", "pipe"];
      shell?: boolean;
      env?: NodeJS.ProcessEnv;
      cwd?: string;
      windowsHide?: boolean;
    },
  ) => {
    calls.push({ command, args, options });
    return child;
  };

  return { child, calls, spawnFn };
}

describe("CodexAppServerAdapter", () => {
  it("defaults the hard turn timeout to one hour", () => {
    expect(CODEX_APP_SERVER_TURN_TIMEOUT_MS).toBe(60 * 60_000);
  });

  it("defaults the inactivity diagnostic interval to thirty minutes", () => {
    expect(CODEX_APP_SERVER_INACTIVITY_TIMEOUT_MS).toBe(30 * 60_000);
  });

  it("compacts a saturated thread before starting its next user turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    expect(CODEX_APP_SERVER_AUTO_COMPACT_RATIO).toBe(0.8);
    expect(CODEX_APP_SERVER_COMPACTION_TIMEOUT_MS).toBeGreaterThan(0);

    const first = adapter.sendUserMessage("telegram-compact", { text: "first", files: [] });
    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-compact"}}}\n`);
    await waitFor(() => child.stdin.lines.length >= 3);
    const firstTurnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    child.stdout.emitData(`{"id":${firstTurnStart.id},"result":{"turn":{"id":"turn-1"}}}\n`);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-compact","turnId":"turn-1","delta":"first answer"}}\n');
    child.stdout.emitData('{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-compact","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":999999,"inputTokens":999999,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},"last":{"totalTokens":212435,"inputTokens":211344,"cachedInputTokens":209280,"cacheWriteInputTokens":0,"outputTokens":1091,"reasoningOutputTokens":392},"modelContextWindow":258400}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-compact","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await expect(first).resolves.toMatchObject({ text: "first answer", sessionId: "thread-compact" });

    const second = adapter.sendUserMessage("thread-compact", { text: "second", files: [] });
    await waitFor(() => child.stdin.lines.length >= 4);
    const compactStart = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(compactStart.method).toBe("thread/compact/start");
    expect(compactStart.params).toEqual({ threadId: "thread-compact" });
    expect(child.stdin.lines.slice(3).map((line) => JSON.parse(line).method)).toEqual([
      "thread/compact/start",
    ]);
    child.stdout.emitData(`{"id":${compactStart.id},"result":{}}\n`);
    child.stdout.emitData('{"method":"turn/started","params":{"threadId":"thread-compact","turn":{"id":"turn-compact","items":[],"status":"inProgress","error":null}}}\n');
    child.stdout.emitData('{"method":"thread/compacted","params":{"threadId":"thread-compact","turnId":"turn-compact"}}\n');

    await waitFor(() => child.stdin.lines.length >= 5);
    const secondTurnStart = JSON.parse(child.stdin.lines[4] ?? "{}");
    expect(secondTurnStart.method).toBe("turn/start");
    expect(secondTurnStart.params.threadId).toBe("thread-compact");
    child.stdout.emitData(`{"id":${secondTurnStart.id},"result":{"turn":{"id":"turn-2"}}}\n`);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-compact","turnId":"turn-2","delta":"second answer"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-compact","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');

    await expect(second).resolves.toMatchObject({ text: "second answer" });
  });

  it("starts a fresh thread when preventive compaction is unavailable", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const first = adapter.sendUserMessage("telegram-compact-fallback", { text: "first", files: [] });
    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
    await waitFor(() => child.stdin.lines.length >= 2);
    const firstThreadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${firstThreadStart.id},"result":{"thread":{"id":"thread-saturated"}}}\n`);
    await waitFor(() => child.stdin.lines.length >= 3);
    const firstTurnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    child.stdout.emitData(`{"id":${firstTurnStart.id},"result":{"turn":{"id":"turn-1"}}}\n`);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-saturated","turnId":"turn-1","delta":"first answer"}}\n');
    child.stdout.emitData('{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-saturated","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":999999,"inputTokens":999999,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},"last":{"totalTokens":212435,"inputTokens":211344,"cachedInputTokens":209280,"cacheWriteInputTokens":0,"outputTokens":1091,"reasoningOutputTokens":392},"modelContextWindow":258400}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-saturated","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await expect(first).resolves.toMatchObject({ sessionId: "thread-saturated" });

    const second = adapter.sendUserMessage("thread-saturated", { text: "second", files: [] });
    await waitFor(() => child.stdin.lines.length >= 4);
    const compactStart = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(compactStart.method).toBe("thread/compact/start");
    child.stdout.emitData(`{"id":${compactStart.id},"error":{"message":"method not found"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 5);
    const replacementThreadStart = JSON.parse(child.stdin.lines[4] ?? "{}");
    expect(replacementThreadStart.method).toBe("thread/start");
    child.stdout.emitData(`{"id":${replacementThreadStart.id},"result":{"thread":{"id":"thread-fresh"}}}\n`);
    await waitFor(() => child.stdin.lines.length >= 6);
    const secondTurnStart = JSON.parse(child.stdin.lines[5] ?? "{}");
    expect(secondTurnStart.method).toBe("turn/start");
    expect(secondTurnStart.params.threadId).toBe("thread-fresh");
    child.stdout.emitData(`{"id":${secondTurnStart.id},"result":{"turn":{"id":"turn-2"}}}\n`);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-fresh","turnId":"turn-2","delta":"fresh answer"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-fresh","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');

    await expect(second).resolves.toMatchObject({ text: "fresh answer", sessionId: "thread-fresh" });
  });

  it("sets a Codex thread goal through the app-server protocol", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);

    const promise = adapter.setThreadGoal("telegram-12345", {
      objective: "ship the release",
      tokenBudget: null,
      workspaceOverride: "/tmp/project",
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(threadStart.method).toBe("thread/start");
    expect(threadStart.params.cwd).toBe("/tmp/project");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);

    await waitFor(() => child.stdin.lines.length >= 3);
    const goalSet = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(goalSet).toMatchObject({
      method: "thread/goal/set",
      params: {
        threadId: "thread-123",
        objective: "ship the release",
        tokenBudget: null,
      },
    });
    child.stdout.emitData(`{"id":${goalSet.id},"result":{"goal":{"threadId":"thread-123","objective":"ship the release","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1,"updatedAt":1}}}\n`);

    await expect(promise).resolves.toEqual({
      goal: {
        threadId: "thread-123",
        objective: "ship the release",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      sessionId: "thread-123",
    });
  });

  it("clears any existing goal before setting when watching, and resolves on the live status (not the stale set result)", async () => {
    // Regression: re-running /goal on a thread that already had a COMPLETE goal made
    // thread/goal/set return the stale "complete" status + old usage, so the watch
    // resolved instantly (e.g. a fresh "review the bugs" goal showing 432937 tokens as
    // done). watchThreadGoal must clear first so the new objective starts fresh.
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);

    const promise = adapter.watchThreadGoal("telegram-12345", {
      objective: "review the bugs",
      tokenBudget: null,
      workspaceOverride: "/tmp/project",
      onEngineEvent: () => {},
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(threadStart.method).toBe("thread/start");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);

    // The fix: clear BEFORE set.
    await waitFor(() => child.stdin.lines.length >= 3);
    const goalClear = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(goalClear.method).toBe("thread/goal/clear");
    expect(goalClear.params).toMatchObject({ threadId: "thread-123" });
    child.stdout.emitData(`{"id":${goalClear.id},"result":{"cleared":true}}\n`);

    await waitFor(() => child.stdin.lines.length >= 4);
    const goalSet = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(goalSet).toMatchObject({
      method: "thread/goal/set",
      params: { threadId: "thread-123", objective: "review the bugs", tokenBudget: null },
    });
    // Set returns a fresh "active" goal (0 usage); the watch must NOT resolve on this.
    child.stdout.emitData(`{"id":${goalSet.id},"result":{"goal":{"threadId":"thread-123","objective":"review the bugs","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1,"updatedAt":1}}}\n`);

    // It resolves only when Codex's autonomous pursuit actually reaches complete.
    child.stdout.emitData(`{"method":"thread/goal/updated","params":{"threadId":"thread-123","goal":{"threadId":"thread-123","objective":"review the bugs","status":"complete","tokenBudget":null,"tokensUsed":1234,"timeUsedSeconds":56,"createdAt":1,"updatedAt":2}}}\n`);

    const result = await promise;
    expect(result.goal?.status).toBe("complete");
    expect(result.goal?.tokensUsed).toBe(1234);
  });

  it("resolves goal watchers with the latest goal when the app-server child exits", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);

    const promise = adapter.watchThreadGoal("telegram-12345", {
      objective: "keep shipping",
      tokenBudget: null,
      workspaceOverride: "/tmp/project",
      onEngineEvent: () => {},
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);

    await waitFor(() => child.stdin.lines.length >= 3);
    const goalClear = JSON.parse(child.stdin.lines[2] ?? "{}");
    child.stdout.emitData(`{"id":${goalClear.id},"result":{"cleared":true}}\n`);

    await waitFor(() => child.stdin.lines.length >= 4);
    const goalSet = JSON.parse(child.stdin.lines[3] ?? "{}");
    child.stdout.emitData(`{"id":${goalSet.id},"result":{"goal":{"threadId":"thread-123","objective":"keep shipping","status":"active","tokenBudget":null,"tokensUsed":7,"timeUsedSeconds":2,"createdAt":1,"updatedAt":1}}}\n`);

    child.close(1);

    await expect(Promise.race([
      promise.then((result) => result.goal?.status ?? "missing-goal"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 20)),
    ])).resolves.toBe("active");
  });

  it("times out a wedged goal RPC instead of leaving the watcher permanently busy", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnFn } = createSpawnHarness();
      const adapter = new CodexAppServerAdapter("codex", "/tmp/default-workspace", spawnFn);
      const promise = adapter.watchThreadGoal("telegram-12345", {
        objective: "bounded goal rpc",
        workspaceOverride: "/tmp/project",
      });

      await vi.advanceTimersByTimeAsync(0);
      const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
      child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
      child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-goal-timeout"}}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(child.stdin.lines[2] ?? "{}").method).toBe("thread/goal/clear");

      const assertion = expect(promise).rejects.toThrow(/thread\/goal\/set|not running/);
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_GOAL_RPC_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      await assertion;
      expect(child.killCalls).toBe(1);
      expect((adapter as unknown as { isIdle(): boolean }).isIdle()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and destroys app-server when initialize never replies", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnFn } = createSpawnHarness();
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(child.stdin.lines).toHaveLength(1);
      expect(JSON.parse(child.stdin.lines[0] ?? "{}").method).toBe("initialize");

      const assertion = expect(promise).rejects.toThrow("Codex app-server initialize timed out");
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_INITIALIZE_TIMEOUT_MS);
      await assertion;
      expect(child.killCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and destroys app-server when thread/start never replies", async () => {
    vi.useFakeTimers();
    try {
      const childA = new FakeChildProcess();
      const childB = new FakeChildProcess();
      const children = [childA, childB];
      const spawnFn = () => {
        const child = children.shift();
        if (!child) {
          throw new Error("no more fake children");
        }
        return child;
      };
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn as never);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await vi.advanceTimersByTimeAsync(0);
      childA.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(childA.stdin.lines).toHaveLength(2);
      expect(JSON.parse(childA.stdin.lines[1] ?? "{}").method).toBe("thread/start");

      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(childA.killCalls).toBe(1);
      const retryInitialize = JSON.parse(childB.stdin.lines[0] ?? "{}");
      expect(retryInitialize.method).toBe("initialize");
      childB.stdout.emitData(`{"id":${retryInitialize.id},"result":{"platformOs":"windows"}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(childB.stdin.lines[1] ?? "{}").method).toBe("thread/start");

      const assertion = expect(promise).rejects.toMatchObject({
        name: "ThreadReadTimeoutError",
        message: expect.stringContaining("Codex app-server thread/start timed out"),
      });
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS);
      await assertion;
      expect(childB.killCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries thread/start once on a fresh app-server after a read timeout", async () => {
    vi.useFakeTimers();
    try {
      const childA = new FakeChildProcess();
      const childB = new FakeChildProcess();
      const children = [childA, childB];
      const spawnFn = () => {
        const child = children.shift();
        if (!child) {
          throw new Error("no more fake children");
        }
        return child;
      };
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn as never);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await vi.advanceTimersByTimeAsync(0);
      childA.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(childA.stdin.lines[1] ?? "{}").method).toBe("thread/start");

      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(childA.killCalls).toBe(1);
      const retryInitialize = JSON.parse(childB.stdin.lines[0] ?? "{}");
      expect(retryInitialize.method).toBe("initialize");

      childB.stdout.emitData(`{"id":${retryInitialize.id},"result":{"platformOs":"windows"}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      const retryThreadStart = JSON.parse(childB.stdin.lines[1] ?? "{}");
      childB.stdout.emitData(`{"id":${retryThreadStart.id},"result":{"thread":{"id":"thread-retry"}}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(childB.stdin.lines[2] ?? "{}").method).toBe("turn/start");
      childB.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-retry","item":{"type":"agentMessage","text":"ok after retry"}}}\n');
      childB.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-retry","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

      await expect(promise).resolves.toEqual({
        text: "ok after retry",
        sessionId: "thread-retry",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("overrides approval policy when resuming and starting a turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("thread-existing", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const resume = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(resume).toMatchObject({
      method: "thread/resume",
      params: {
        threadId: "thread-existing",
        approvalPolicy: "never",
      },
    });
    child.stdout.emitData(`{"id":${resume.id},"result":{"thread":{"id":"thread-existing"}}}\n`);

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-existing",
        approvalPolicy: "never",
      },
    });
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-existing","item":{"type":"agentMessage","text":"ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-existing","turn":{"id":"turn-1","status":"completed"}}}\n');

    await expect(promise).resolves.toMatchObject({
      text: "ok",
    });
  });

  it("responds to app-server command approval requests instead of leaving the turn hanging", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "session" });
    // Approvals are only forwarded in "normal" mode; this test exercises that flow,
    // so the instance is configured normal (the default is bypass → policy "never").
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, undefined, undefined, configPath);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      onApprovalRequest,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-123",
        approvalPolicy: "on-request",
      },
    });
    child.stdout.emitData('{"jsonrpc":"2.0","id":99,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-123","turnId":"turn-1","itemId":"item-1","startedAtMs":1,"command":"tmux new-session","cwd":"/tmp/project","reason":"requires unsandboxed command"}}\n');

    await waitFor(() => child.stdin.lines.length >= 4);
    const approvalResponse = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(approvalResponse).toEqual({
      jsonrpc: "2.0",
      id: 99,
      result: {
        decision: "acceptForSession",
      },
    });
    expect(onApprovalRequest).toHaveBeenCalledWith(expect.objectContaining({
      engine: "codex",
      toolName: "Codex command approval",
      cwd: "/tmp/project",
      sessionId: "thread-123",
    }));

    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"approved ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","status":"completed"}}}\n');

    await expect(promise).resolves.toMatchObject({
      text: "approved ok",
    });
    await removeTempRoot(root);
  });

  it("declines app-server approval denials while allowing the turn to continue", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "deny" });
    // Forwarding (and thus this user-driven deny) only happens in "normal" mode.
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, undefined, undefined, configPath);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      onApprovalRequest,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);

    await waitFor(() => child.stdin.lines.length >= 3);
    child.stdout.emitData('{"jsonrpc":"2.0","id":99,"method":"item/fileChange/requestApproval","params":{"threadId":"thread-123","turnId":"turn-1","itemId":"item-1","cwd":"/tmp/project","reason":"needs write access"}}\n');

    await waitFor(() => child.stdin.lines.length >= 4);
    expect(JSON.parse(child.stdin.lines[3] ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 99,
      result: {
        decision: "decline",
      },
    });

    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"declined ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","status":"completed"}}}\n');

    await expect(promise).resolves.toMatchObject({
      text: "declined ok",
    });
    expect(onApprovalRequest).toHaveBeenCalled();
    await removeTempRoot(root);
  });

  it("times out and destroys app-server when thread/resume never replies", async () => {
    vi.useFakeTimers();
    try {
      const childA = new FakeChildProcess();
      const childB = new FakeChildProcess();
      const children = [childA, childB];
      const spawnFn = () => {
        const child = children.shift();
        if (!child) {
          throw new Error("no more fake children");
        }
        return child;
      };
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn as never);

      const promise = adapter.sendUserMessage("thread-previous", {
        text: "Hello",
        files: [],
      });

      await vi.advanceTimersByTimeAsync(0);
      childA.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(childA.stdin.lines).toHaveLength(2);
      expect(JSON.parse(childA.stdin.lines[1] ?? "{}").method).toBe("thread/resume");

      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(childA.killCalls).toBe(1);
      const retryInitialize = JSON.parse(childB.stdin.lines[0] ?? "{}");
      expect(retryInitialize.method).toBe("initialize");
      childB.stdout.emitData(`{"id":${retryInitialize.id},"result":{"platformOs":"windows"}}\n`);
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.parse(childB.stdin.lines[1] ?? "{}").method).toBe("thread/resume");

      const assertion = expect(promise).rejects.toMatchObject({
        name: "ThreadReadTimeoutError",
        message: expect.stringContaining("Codex app-server thread/resume timed out"),
      });
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_THREAD_READ_TIMEOUT_MS);
      await assertion;
      expect(childB.killCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out waiting for idle app-server state", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new CodexAppServerAdapter("codex", process.cwd()) as unknown as {
        pendingTurns: Map<string, unknown>;
        waitForIdle: () => Promise<void>;
      };
      adapter.pendingTurns.set("turn-1", {});

      const waitPromise = adapter.waitForIdle();
      const assertion = expect(waitPromise).rejects.toThrow(
        `Codex app-server did not become idle within ${CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats live goal watchers as non-idle app-server work", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new CodexAppServerAdapter("codex", process.cwd()) as unknown as {
        goalWatchers: Map<string, unknown>;
        waitForIdle: () => Promise<void>;
      };
      adapter.goalWatchers.set("thread-goal", {});

      const waitPromise = adapter.waitForIdle();
      const assertion = expect(waitPromise).rejects.toThrow(
        `Codex app-server did not become idle within ${CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(CODEX_APP_SERVER_WAIT_FOR_IDLE_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not compact underneath a live goal pursuit", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn) as unknown as {
      goalWatchers: Map<string, unknown>;
      threadContextUsage: Map<string, { totalTokens: number; modelContextWindow: number }>;
      prepareThreadForTurn: (threadId: string, cwd: string) => Promise<string>;
    };
    adapter.goalWatchers.set("thread-goal", {});
    adapter.threadContextUsage.set("thread-goal", {
      totalTokens: 240_000,
      modelContextWindow: 258_400,
    });

    await expect(adapter.prepareThreadForTurn("thread-goal", process.cwd())).resolves.toBe("thread-goal");
    expect(child.stdin.lines).toHaveLength(0);
  });

  it("creates a logical telegram session placeholder", async () => {
    const adapter = new CodexAppServerAdapter("codex", process.cwd());
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "telegram-12345",
    });
  });

  it("inherits CODEX_HOME from the parent env so bots track the main CLI", async () => {
    const original = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/codex-shared-test";
    try {
      const adapter = new CodexAppServerAdapter("codex", process.cwd()) as unknown as { childEnv: NodeJS.ProcessEnv };
      expect(adapter.childEnv.CODEX_HOME).toBe("/tmp/codex-shared-test");
    } finally {
      if (original === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = original;
      }
    }
  });

  it("starts a persistent thread for a logical session and returns the real thread id", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const progressUpdates: string[] = [];

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: ["a.txt"],
      onProgress: (text) => progressUpdates.push(text),
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    expect(initialize.method).toBe("initialize");
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(threadStart.method).toBe("thread/start");
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart.method).toBe("turn/start");
    expect(turnStart.params.threadId).toBe("thread-123");
    expect(turnStart.params.input).toEqual([
      {
        type: "text",
        text: "Hello\nAttachment: a.txt",
        text_elements: [],
      },
    ]);

    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-123","delta":"READY"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null,"usage":{"input_tokens":12,"output_tokens":5,"cached_input_tokens":2,"cost_usd":0.001}}}}\n');

    await expect(promise).resolves.toEqual({
      text: "READY",
      sessionId: "thread-123",
      usage: {
        inputTokens: 12,
        outputTokens: 5,
        cachedTokens: 2,
        costUsd: 0.001,
      },
    });
    expect(progressUpdates).toEqual(["READY"]);
    expect(calls[0]?.command).toBe("codex");
    expect(calls[0]?.args).toEqual(["app-server"]);
    expect(calls[0]?.options.windowsHide).toBe(true);
  });

  it("decodes UTF-8 JSON correctly when a multibyte character crosses stdout chunks", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const promise = adapter.sendUserMessage("telegram-12345", { text: "Hello", files: [] });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-utf8"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    const delta = Buffer.from('{"method":"item/agentMessage/delta","params":{"threadId":"thread-utf8","delta":"你好🙂"}}\n');
    const marker = delta.indexOf(Buffer.from("好"));
    child.stdout.emitData(delta.subarray(0, marker + 1));
    child.stdout.emitData(delta.subarray(marker + 1));
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-utf8","turn":{"id":"turn-1","status":"completed"}}}\n');

    await expect(promise).resolves.toMatchObject({ text: "你好🙂", sessionId: "thread-utf8" });
  });

  it("processes the final JSON-RPC event when app-server exits without a newline", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const promise = adapter.sendUserMessage("telegram-12345", { text: "Hello", files: [] });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-final"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-final","delta":"FINAL"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-final","turn":{"id":"turn-1","status":"completed"}}}');
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "FINAL", sessionId: "thread-final" });
  });

  it("loads instructions from agent.md and isolates CODEX_HOME", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");
    const engineHomePath = path.join(root, "engine-home");

    try {
      await writeFile(instructionsPath, "You are isolated.", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        instructionsPath,
        engineHomePath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);

      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart.params.input[0].text).toBe("[System Instructions]\nYou are isolated.\n[End Instructions]\nHello");
      expect(calls[0]?.options.env?.CODEX_HOME).toBe(engineHomePath);

      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await waitFor(() => child.stdin.lines.length >= 4);
      const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
      expect(threadRead.method).toBe("thread/read");
      child.stdout.emitData('{"id":4,"result":{"thread":{"turns":[{"id":"turn-1","items":[{"type":"agentMessage","text":"READY isolated"}]}]}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("starts app-server in workspace-write mode for full-auto instances", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        onApprovalRequest: vi.fn().mockResolvedValue({ behavior: "allow", scope: "once" }),
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual(["app-server", "-c", 'sandbox_mode="workspace-write"']);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      // full-auto opts out of approvals: even though onApprovalRequest was passed,
      // the turn runs with policy "never" (Codex won't prompt) — only "normal" mode
      // forwards approvals. The workspace-write sandbox still bounds what can run.
      expect(turnStart).toMatchObject({
        method: "turn/start",
        params: {
          approvalPolicy: "never",
        },
      });
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("starts app-server in danger-full-access mode for bypass instances", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "bypass" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual(["app-server", "-c", 'sandbox_mode="danger-full-access"']);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("runs bypass instances with approvalPolicy never even when onApprovalRequest is provided", async () => {
    // Operator report: a yolo/bypass Codex instance still prompted to approve `rm -rf`.
    // bypass = danger-full-access + no approvals, so the turn must use policy "never"
    // and ignore any onApprovalRequest (matching the Claude/Antigravity/process adapters,
    // which gate approval forwarding on `approvalMode === "normal"`).
    const { child, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "bypass" }) + "\n", "utf8");
      const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "session" });
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, undefined, undefined, configPath);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        onApprovalRequest,
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
      child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
      await waitFor(() => child.stdin.lines.length >= 2);
      const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
      child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);
      await waitFor(() => child.stdin.lines.length >= 3);
      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart).toMatchObject({
        method: "turn/start",
        params: { approvalPolicy: "never" },
      });

      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","status":"completed"}}}\n');
      await promise;
      expect(onApprovalRequest).not.toHaveBeenCalled();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("uses the turn's captured approval mode when starting an app-server turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");
      const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "session" });
      const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn, undefined, undefined, configPath);
      const internal = adapter as unknown as {
        currentApprovalMode: string;
        loadRuntimeOptions: () => Promise<unknown>;
      };
      const loadRuntimeOptions = internal.loadRuntimeOptions.bind(adapter);
      internal.loadRuntimeOptions = async () => {
        const runtimeOptions = await loadRuntimeOptions();
        internal.currentApprovalMode = "bypass";
        return runtimeOptions;
      };

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        onApprovalRequest,
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
      child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);
      await waitFor(() => child.stdin.lines.length >= 2);
      const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
      child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);
      await waitFor(() => child.stdin.lines.length >= 3);
      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart).toMatchObject({
        method: "turn/start",
        params: { approvalPolicy: "on-request" },
      });

      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","status":"completed"}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("defaults configured app-server instances without approval mode to danger-full-access", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, "{}\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual(["app-server", "-c", 'sandbox_mode="danger-full-access"']);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("forwards model, effort, and Codex fast mode into app-server startup config", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ model: "gpt-5.6-luna", effort: "max", codexServiceTier: "fast" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual([
        "app-server",
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        'model_reasoning_effort="max"',
        "-c",
        'model="gpt-5.6-luna"',
        "--enable",
        "fast_mode",
        "-c",
        'service_tier="fast"',
      ]);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps serving while busy and applies config changes on the next idle turn", async () => {
    const childA = new FakeChildProcess();
    const childB = new FakeChildProcess();
    const children = [childA, childB];
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnFn = (command: string, args: string[]) => {
      calls.push({ command, args });
      const child = children.shift();
      if (!child) {
        throw new Error("no more fake children");
      }
      return child;
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn as never,
        undefined,
        undefined,
        configPath,
      );

      const firstPromise = adapter.sendUserMessage("telegram-100", {
        text: "First",
        files: [],
      });

      await waitFor(() => childA.stdin.lines.length >= 1);
      const initA = JSON.parse(childA.stdin.lines[0] ?? "{}");
      childA.stdout.emitData(`{"id":${initA.id},"result":{"platformOs":"windows"}}\n`);
      await waitFor(() => childA.stdin.lines.length >= 2);
      const startThreadA = JSON.parse(childA.stdin.lines[1] ?? "{}");
      childA.stdout.emitData(`{"id":${startThreadA.id},"result":{"thread":{"id":"thread-a"}}}\n`);
      await waitFor(() => childA.stdin.lines.length >= 3);

      await writeFile(configPath, JSON.stringify({ approvalMode: "bypass" }) + "\n", "utf8");
      const secondPromise = adapter.sendUserMessage("telegram-200", {
        text: "Second",
        files: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toHaveLength(1);
      expect(childA.killCalls).toBe(0);

      // Busy config changes are deferred immediately. The second chat keeps
      // running on the old child/config instead of waiting up to 30 seconds.
      await waitFor(() => childA.stdin.lines.length >= 4);
      const startThreadBOnOldConfig = JSON.parse(childA.stdin.lines[3] ?? "{}");
      childA.stdout.emitData(`{"id":${startThreadBOnOldConfig.id},"result":{"thread":{"id":"thread-b-old"}}}\n`);
      await waitFor(() => childA.stdin.lines.length >= 5);
      childA.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-b-old","item":{"type":"agentMessage","text":"second ok"}}}\n');
      childA.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-b-old","turn":{"id":"turn-b","items":[],"status":"completed","error":null}}}\n');
      await expect(secondPromise).resolves.toEqual({
        text: "second ok",
        sessionId: "thread-b-old",
      });

      childA.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-a","item":{"type":"agentMessage","text":"first ok"}}}\n');
      childA.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-a","turn":{"id":"turn-a","items":[],"status":"completed","error":null}}}\n');
      await expect(firstPromise).resolves.toEqual({
        text: "first ok",
        sessionId: "thread-a",
      });

      const thirdPromise = adapter.sendUserMessage("telegram-300", {
        text: "Third",
        files: [],
      });

      await waitFor(() => childB.stdin.lines.length >= 1);
      expect(childA.killCalls).toBe(1);
      expect(calls[1]?.args).toEqual(["app-server", "-c", 'sandbox_mode="danger-full-access"']);

      const initB = JSON.parse(childB.stdin.lines[0] ?? "{}");
      childB.stdout.emitData(`{"id":${initB.id},"result":{"platformOs":"windows"}}\n`);
      await waitFor(() => childB.stdin.lines.length >= 2);
      const startThreadC = JSON.parse(childB.stdin.lines[1] ?? "{}");
      childB.stdout.emitData(`{"id":${startThreadC.id},"result":{"thread":{"id":"thread-c"}}}\n`);
      await waitFor(() => childB.stdin.lines.length >= 3);
      childB.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-c","item":{"type":"agentMessage","text":"third ok"}}}\n');
      childB.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-c","turn":{"id":"turn-c","items":[],"status":"completed","error":null}}}\n');

      await expect(thirdPromise).resolves.toEqual({
        text: "third ok",
        sessionId: "thread-c",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("logs malformed config files instead of silently swallowing them", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFile(configPath, "{not-json\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual(["app-server", "-c", 'sandbox_mode="danger-full-access"']);
      expect(consoleErrorSpy).toHaveBeenCalled();
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      consoleErrorSpy.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("merges bridge instructions with instance agent instructions", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "You are isolated.", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        instructionsPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        instructions: "[Telegram Bridge Capabilities]\nUse file blocks.",
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);

      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart.params.input[0].text).toContain("You are isolated.");
      expect(turnStart.params.input[0].text).toContain("[Telegram Bridge Capabilities]");

      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("truncates oversized instructions and degrades safely on read failure", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "x".repeat(20_000), "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        instructionsPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);

      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart.params.input[0].text).toContain("[Instructions truncated at 16000 characters]");
      expect(turnStart.params.input[0].text.length).toBeLessThan(17_000);

      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;

      const secondHarness = createSpawnHarness();
      const second = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        secondHarness.spawnFn,
        path.join(root, "missing.md"),
      );
      const secondPromise = second.sendUserMessage("telegram-67890", {
        text: "Hello again",
        files: [],
      });
      await waitFor(() => secondHarness.child.stdin.lines.length >= 1);
      secondHarness.child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => secondHarness.child.stdin.lines.length >= 2);
      secondHarness.child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-456"}}}\n');
      await waitFor(() => secondHarness.child.stdin.lines.length >= 3);
      const secondTurnStart = JSON.parse(secondHarness.child.stdin.lines[2] ?? "{}");
      expect(secondTurnStart.params.input[0].text).toBe("Hello again");
      secondHarness.child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-456","item":{"type":"agentMessage","text":"ok"}}}\n');
      secondHarness.child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-456","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');
      await secondPromise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("reuses an existing thread without starting a new one", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("thread-abc", {
      text: "Next",
      files: [],
      instructions: "Be concise.",
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');

    await waitFor(() => child.stdin.lines.length >= 2);
    const resume = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(resume.method).toBe("thread/resume");
    expect(resume.params.threadId).toBe("thread-abc");
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-abc"}}}\n');

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart.method).toBe("turn/start");
    expect(turnStart.params.threadId).toBe("thread-abc");
    expect(turnStart.params.input[0].text).toBe("[System Instructions]\nBe concise.\n[End Instructions]\nNext");

    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "done",
    });
  });

  it("does not resume a thread twice once it is loaded", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const first = adapter.sendUserMessage("thread-abc", {
      text: "First",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-abc"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done-1"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await first;

    const second = adapter.sendUserMessage("thread-abc", {
      text: "Second",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 4);
    const nextRequest = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(nextRequest.method).toBe("turn/start");
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done-2"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');

    await expect(second).resolves.toEqual({
      text: "done-2",
    });
  });

  it("falls back to thread/read when turn completion arrives before agent text events", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(threadRead.method).toBe("thread/read");
    child.stdout.emitData('{"id":4,"result":{"thread":{"turns":[{"id":"turn-1","usage":{"inputTokens":9,"outputTokens":4,"cachedTokens":1},"items":[{"type":"agentMessage","text":"READY via thread read"}]}]}}}\n');

    await expect(promise).resolves.toEqual({
      text: "READY via thread read",
      sessionId: "thread-123",
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        cachedTokens: 1,
      },
    });
  });

  it("uses turn/completed summary items without issuing a redundant thread/read", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const imagePath = "/tmp/codex-generated/summary.png";

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData(JSON.stringify({
      method: "turn/completed",
      params: {
        threadId: "thread-123",
        turn: {
          id: "turn-1",
          status: "completed",
          error: null,
          usage: { inputTokens: 5, outputTokens: 2, cachedTokens: 1 },
          itemsView: "summary",
          items: [
            { type: "agentMessage", text: "READY from completion summary" },
            { type: "imageGenerationCall", result: { saved_path: imagePath } },
          ],
        },
      },
    }) + "\n");

    await expect(promise).resolves.toEqual({
      text: `READY from completion summary\n[send-image:${imagePath}]`,
      sessionId: "thread-123",
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cachedTokens: 1,
      },
    });
    expect(child.stdin.lines).toHaveLength(3);
  });

  it("emits generated image items as send-image stream output", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const engineEvents: unknown[] = [];
    const imagePath = "/tmp/codex-generated/photo.png";

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "make image fun",
      files: [],
      onEngineEvent: (event) => {
        engineEvents.push(event);
      },
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData(JSON.stringify({
      method: "item/completed",
      params: {
        threadId: "thread-123",
        item: {
          type: "imageGenerationCall",
          result: {
            saved_path: imagePath,
          },
        },
      },
    }) + "\n");
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: `[send-image:${imagePath}]`,
      sessionId: "thread-123",
    });
    expect(engineEvents).toEqual([
      // The thread is announced before the turn starts so the bridge binds it
      // even if the turn is aborted (see engine-audit3-fixes).
      {
        type: "session",
        sessionId: "thread-123",
      },
      {
        type: "assistant_text",
        text: `[send-image:${imagePath}]`,
        sessionId: "thread-123",
      },
    ]);
  });

  it("recovers generated image paths from thread/read without resending input attachments", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const sourcePath = "/tmp/telegram-input/original.jpg";
    const generatedPath = "/tmp/codex-generated/fun.png";

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "make image fun",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(threadRead.method).toBe("thread/read");
    child.stdout.emitData(JSON.stringify({
      id: 4,
      result: {
        thread: {
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "input_image", path: sourcePath }],
                },
                {
                  type: "imageGenerationCall",
                  result: { saved_path: generatedPath },
                },
              ],
            },
          ],
        },
      },
    }) + "\n");

    await expect(promise).resolves.toEqual({
      text: `[send-image:${generatedPath}]`,
      sessionId: "thread-123",
    });
  });

  it("does not duplicate generated image tags recovered from thread/read", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const generatedPath = "/tmp/codex-generated/fun.png";

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "make image fun",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    child.stdout.emitData(JSON.stringify({
      id: 4,
      result: {
        thread: {
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  type: "agentMessage",
                  text: `Done.\n[send-image:${generatedPath}]`,
                },
                {
                  type: "imageGenerationCall",
                  result: { saved_path: generatedPath },
                },
              ],
            },
          ],
        },
      },
    }) + "\n");

    await expect(promise).resolves.toEqual({
      text: `Done.\n[send-image:${generatedPath}]`,
      sessionId: "thread-123",
    });
  });

  it("rejects with the turn error instead of resolving a fake completion message", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"error","params":{"error":{"message":"unexpected status 401 Unauthorized","additionalDetails":null},"willRetry":false,"threadId":"thread-123","turnId":"turn-1"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"failed","error":{"message":"unexpected status 401 Unauthorized","additionalDetails":null}}}}\n');

    await expect(promise).rejects.toThrow("unexpected status 401 Unauthorized");
  });

  it("aborts an in-flight turn when the caller aborts the request", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const controller = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      abortSignal: controller.signal,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    controller.abort();

    await expect(promise).rejects.toThrow("Codex app-server turn aborted");
    expect(child.killCalls).toBe(0);
  });

  it("interrupts a turn aborted before its turn id arrived (writer-leak fix)", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const controller = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      abortSignal: controller.signal,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart.method).toBe("turn/start");

    // Abort BEFORE the turn/start response delivers the turn id: the interrupt
    // has no addressable turn yet.
    controller.abort();
    await expect(promise).rejects.toThrow("Codex app-server turn aborted");

    // The app-server started the turn anyway. Its late response must trigger
    // the deferred interrupt, or the server-side turn keeps the thread's
    // writer and every later turn fails with "already has an active writer".
    child.stdout.emitData(`{"id":${turnStart.id},"result":{"turn":{"id":"turn-late"}}}\n`);
    await waitFor(() => child.stdin.lines.some((line) => {
      const parsed = JSON.parse(line || "{}") as { method?: string; params?: { turnId?: string } };
      return parsed.method === "turn/interrupt" && parsed.params?.turnId === "turn-late";
    }));
    expect(child.killCalls).toBe(0);
  });

  it("recovers a thread whose writer leaked instead of failing every later turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");

    child.stdout.emitData(`{"id":${turnStart.id},"error":{"code":-32603,"message":"thread thread-123 already has an active writer"}}\n`);
    await expect(promise).rejects.toThrow("already has an active writer");

    // Self-heal: interrupt the thread so the NEXT turn is not dead on arrival.
    await waitFor(() => child.stdin.lines.some((line) => {
      const parsed = JSON.parse(line || "{}") as { method?: string; params?: { threadId?: string } };
      return parsed.method === "turn/interrupt" && parsed.params?.threadId === "thread-123";
    }));
  });

  it("rejects when thread/read shows the completed turn actually failed", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(threadRead.method).toBe("thread/read");
    child.stdout.emitData('{"id":4,"result":{"thread":{"turns":[{"id":"turn-1","items":[{"type":"userMessage","content":[{"type":"text","text":"Hello"}]}],"status":"failed","error":{"message":"unexpected status 401 Unauthorized","additionalDetails":null}}]}}}\n');

    await expect(promise).rejects.toThrow("unexpected status 401 Unauthorized");
  });

  it("times out an in-flight turn that never completes without killing the shared child", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      1,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    await expect(promise).rejects.toThrow("Codex app-server turn timed out");
    // Thread-scoped (H4): the timed-out turn rejects, but the SHARED child is not
    // killed so other concurrent conversations keep running. A genuinely wedged
    // child is still caught by the next thread/resume|read request timeout.
    expect(child.killCalls).toBe(0);
  });

  it("aborts an idle app-server turn at the inactivity interval so queues can continue", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      25,
      1,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    await expect(promise).rejects.toThrow("Codex app-server turn became inactive after 1 minutes");
    // Thread-scoped (H4): rejecting the inactive turn lets this conversation's
    // queue continue without killing the shared child / other live turns.
    expect(child.killCalls).toBe(0);
  });

  it("uses a dedicated thread/read timeout after turn/completed instead of the inactivity watchdog", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      60 * 60_000,
      1,
      5,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(threadRead.method).toBe("thread/read");

    await expect(promise).rejects.toThrow("Codex app-server thread/read timed out");
    expect(child.killCalls).toBe(1);
  });

  it("does not drive completingTurns negative when a completing turn is destroyed mid-read", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);

    (adapter as unknown as { destroy(): void }).destroy();
    await expect(promise).rejects.toThrow("Adapter destroyed");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const internal = adapter as unknown as {
      completingTurns: number;
      waitForIdle(): Promise<void>;
    };
    expect(internal.completingTurns).toBe(0);
    await expect(internal.waitForIdle()).resolves.toBeUndefined();
  });

  it("does not destroy the shared child when aborting one chat turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), undefined, spawnFn);
    const firstAbort = new AbortController();

    const firstPromise = adapter.sendUserMessage("telegram-100", {
      text: "First",
      files: [],
      abortSignal: firstAbort.signal,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-a"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    const secondPromise = adapter.sendUserMessage("telegram-200", {
      text: "Second",
      files: [],
    });
    await waitFor(() => child.stdin.lines.length >= 4);
    const secondThreadStart = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(secondThreadStart.method).toBe("thread/start");
    child.stdout.emitData(`{"id":${secondThreadStart.id},"result":{"thread":{"id":"thread-b"}}}\n`);
    await waitFor(() => child.stdin.lines.length >= 5);

    firstAbort.abort();
    await expect(firstPromise).rejects.toThrow("Codex app-server turn aborted");
    expect(child.killCalls).toBe(0);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-a","turn":{"id":"turn-a","items":[],"status":"completed","error":null}}}\n');
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-b","item":{"type":"agentMessage","text":"second ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-b","turn":{"id":"turn-b","items":[],"status":"completed","error":null}}}\n');

    await expect(secondPromise).resolves.toEqual({
      text: "second ok",
      sessionId: "thread-b",
    });
    expect(child.killCalls).toBe(0);
  });

  it("clears transport buffers and diagnostic tails on destroy", () => {
    const adapter = new CodexAppServerAdapter("codex", process.cwd()) as unknown as {
      lineBuffer: string;
      stderrTail: string;
      stdoutDiagnosticTail: string;
      destroy(): void;
    };
    adapter.lineBuffer = '{"partial":true';
    adapter.stderrTail = "trustd noise";
    adapter.stdoutDiagnosticTail = "non-json";

    adapter.destroy();

    expect(adapter.lineBuffer).toBe("");
    expect(adapter.stderrTail).toBe("");
    expect(adapter.stdoutDiagnosticTail).toBe("");
  });

  it("includes stderr and non-JSON stdout diagnostics in hard timeout failures after idle intervals", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      5,
      1,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stderr.emitData("trustd: ocsp responder failed\n");
    child.stdout.emitData("non-json diagnostic line\n");

    await expect(promise).rejects.toThrow(/trustd: ocsp responder failed/);
    await expect(promise).rejects.toThrow(/non-json diagnostic line/);
    // Thread-scoped (H4): the rejection still carries diagnostics, but the shared
    // child is not killed on a per-turn timeout.
    expect(child.killCalls).toBe(0);
  });

  it("includes app-server protocol state in hard timeout failures after idle intervals", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      5,
      1,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    await expect(promise).rejects.toThrow(/\[app-server state\]/);
    await expect(promise).rejects.toThrow(/pending turn: threadId=thread-123/);
    await expect(promise).rejects.toThrow(/last request: .* id=3 method=turn\/start threadId=thread-123/);
    await expect(promise).rejects.toThrow(/last response: .* id=2 method=thread\/start threadId=thread-123/);
    await expect(promise).rejects.toThrow(/last notification: none/);
    await expect(promise).rejects.toThrow(/last turn activity: none/);
    await expect(promise).rejects.toThrow(/pending requests: id=3 method=turn\/start threadId=thread-123/);
    // Thread-scoped (H4): per-turn timeout rejects with full protocol state but
    // does not kill the shared child.
    expect(child.killCalls).toBe(0);
  });

  it("drops oversized non-JSON stdout diagnostics without killing the app-server turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"timestamp":"2026-04-29T10:18:00Z","level":"WARN","fields":{"message":"<html>' + "x".repeat(1024 * 1024 + 1));
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "ok",
      sessionId: "thread-123",
    });
    expect(child.killCalls).toBe(0);
  });

  it("does not treat oversized log records with nested json-rpc words as protocol output", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"fields":{"error":"Cloudflare challenge","id":"ray","method":"challenge","message":"' + "x".repeat(1024 * 1024 + 1));
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "ok",
      sessionId: "thread-123",
    });
    expect(child.killCalls).toBe(0);
  });

  it("accepts oversized top-level json-rpc responses from large resumed threads", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("thread-large", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    expect(JSON.parse(child.stdin.lines[1] ?? "{}").method).toBe("thread/resume");

    child.stdout.emitData(
      JSON.stringify({
        id: 2,
        result: {
          thread: {
            id: "thread-large",
            turns: [
              {
                items: [
                  {
                    type: "agentMessage",
                    text: "x".repeat(1024 * 1024 + 1),
                  },
                ],
              },
            ],
          },
        },
      }) + "\n",
    );
    await waitFor(() => child.stdin.lines.length >= 3);
    expect(JSON.parse(child.stdin.lines[2] ?? "{}").method).toBe("turn/start");

    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-large","item":{"type":"agentMessage","text":"ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-large","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "ok",
      sessionId: undefined,
    });
    expect(child.killCalls).toBe(0);
  });

  it("rejects when app-server stdin write fails", async () => {
    const { child, spawnFn } = createSpawnHarness();
    child.stdin.nextError = new Error("pipe broken");
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    await expect(
      adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      }),
    ).rejects.toThrow("pipe broken");
  });
});
