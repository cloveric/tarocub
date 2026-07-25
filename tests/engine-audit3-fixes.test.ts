import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { removeTempRoot } from "./helpers/temp-files.js";
import { createBusTalkHandler } from "../src/bus/bus-handler.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";
import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";
import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";
import { ProcessAntigravityAdapter } from "../src/codex/antigravity-adapter.js";
import { classifyFailure } from "../src/runtime/error-classification.js";

async function waitFor(condition: () => boolean, label = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) {
      return;
    }

    if ((vi as unknown as { isFakeTimers?: () => boolean }).isFakeTimers?.()) {
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  throw new Error(`${label} was not met in time`);
}

class FakeStream extends EventEmitter {
  emitData(chunk: string) {
    this.emit("data", chunk);
  }
}

class FakeWritable {
  lines: string[] = [];

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) {
      this.lines.push(text);
    }
    callback?.(null);
    return true;
  }

  end(): void {
    // no-op
  }
}

class FakeChildProcess extends EventEmitter {
  pid: number | undefined;
  stdin = new FakeWritable();
  stdout = new FakeStream();
  stderr = new FakeStream();
  killCalls = 0;

  kill() {
    this.killCalls += 1;
    return true;
  }

  close(code: number | null) {
    this.emit("close", code);
  }
}

type SpawnCall = {
  command: string;
  args: string[];
  options: Record<string, unknown>;
};

function createSpawnHarness() {
  const children: FakeChildProcess[] = [];
  const calls: SpawnCall[] = [];
  const spawnFn = (command: string, args: string[], options: Record<string, unknown>) => {
    const child = new FakeChildProcess();
    children.push(child);
    calls.push({ command, args, options });
    return child;
  };

  return { children, calls, spawnFn: spawnFn as never };
}

function parsedLines(child: FakeChildProcess): Array<Record<string, unknown>> {
  return child.stdin.lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

function findRequest(child: FakeChildProcess, method: string): Record<string, unknown> | undefined {
  return parsedLines(child).find((line) => line.method === method);
}

/** Waits for the app-server request `method`, then answers it with `result`. */
async function answerRequest(child: FakeChildProcess, method: string, result: unknown): Promise<void> {
  await waitFor(() => findRequest(child, method) !== undefined, `${method} request`);
  const request = findRequest(child, method)!;
  child.stdout.emitData(`${JSON.stringify({ id: request.id, result })}\n`);
}

/** Drives an app-server adapter up to (and including) the turn/start request. */
async function driveToTurnStart(
  children: FakeChildProcess[],
  index: number,
  threadId: string,
  options?: { resume?: boolean },
): Promise<FakeChildProcess> {
  await waitFor(() => children.length > index, "app-server spawn");
  const child = children[index]!;
  await answerRequest(child, "initialize", { platformOs: "macos" });
  await answerRequest(child, options?.resume ? "thread/resume" : "thread/start", { thread: { id: threadId } });
  await waitFor(() => findRequest(child, "turn/start") !== undefined, "turn/start request");
  return child;
}

describe("audit3 fix 1: bus turns start a FRESH engine session on every adapter", () => {
  async function mintBusSessionId(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "audit3-bus-"));
    try {
      const handleAuthorizedMessage = vi.fn().mockResolvedValue({ text: "done" });
      const handler = createBusTalkHandler({
        bridge: { handleAuthorizedMessage } as never,
        stateDir: root,
        instanceName: "worker",
      });
      await handler({ fromInstance: "caller", prompt: "ping", depth: 0 });
      const override = handleAuthorizedMessage.mock.calls[0]?.[0]?.sessionIdOverride as string | undefined;
      expect(override).toBeTruthy();
      return override!;
    } finally {
      await removeTempRoot(root);
    }
  }

  it("mints the ephemeral id in the logical form every adapter reads as 'fresh'", async () => {
    const sessionId = await mintBusSessionId();
    // Every adapter's isLogicalTelegramSessionId() is `startsWith("telegram-")`.
    expect(sessionId.startsWith("telegram-")).toBe(true);
  });

  it("does not pass a resume flag to the Claude CLI", async () => {
    const { calls, children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const sessionId = await mintBusSessionId();

    const promise = adapter.sendUserMessage(sessionId, { text: "ping", files: [] });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1, "claude spawn");
    // `-r <id>` on a non-UUID killed the turn instantly ("not a UUID"), so bus
    // turns produced zero output on Claude bots.
    expect(calls[0]?.args).not.toContain("-r");
    expect(calls[0]?.args).not.toContain("--resume");

    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"claude-session"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"pong","session_id":"claude-session"}\n');
    await expect(promise).resolves.toMatchObject({ text: "pong" });
    adapter.destroy();
  });

  it("does not run `exec resume` on the process Codex adapter", async () => {
    const { calls, children, spawnFn } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnFn);
    const sessionId = await mintBusSessionId();

    const promise = adapter.sendUserMessage(sessionId, { text: "ping", files: [] });
    await waitFor(() => calls.length === 1, "codex spawn");
    expect(calls[0]?.args).not.toContain("resume");
    expect(calls[0]?.args.slice(0, 2)).toEqual(["exec", "--json"]);

    children[0].stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}\n');
    children[0].close(0);
    await expect(promise).resolves.toMatchObject({ text: "pong" });
  });

  it("does not pass --conversation to Antigravity", async () => {
    const { calls, children, spawnFn } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", {}, spawnFn);
    const sessionId = await mintBusSessionId();

    const promise = adapter.sendUserMessage(sessionId, { text: "ping", files: [] });
    await waitFor(() => calls.length === 1, "agy spawn");
    expect(calls[0]?.args).not.toContain("--conversation");

    children[0].stdout.emitData("pong\n");
    children[0].close(0);
    await expect(promise).resolves.toMatchObject({ text: "pong" });
  });

  it("starts a new app-server thread instead of resuming one", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const sessionId = await mintBusSessionId();

    const promise = adapter.sendUserMessage(sessionId, { text: "ping", files: [] });
    await driveToTurnStart(children, 0, "thread-bus");
    expect(findRequest(children[0], "thread/resume")).toBeUndefined();

    children[0].stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-bus","turnId":"turn-1","delta":"pong"}}\n');
    children[0].stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-bus","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await expect(promise).resolves.toMatchObject({ text: "pong", sessionId: "thread-bus" });
    adapter.destroy();
  });
});

describe("audit3 fix 2: app-server turns are matched by turn id, not just thread id", () => {
  it("keeps a concurrent /goal pursuit from settling (and mis-billing) the user's turn", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const child = children[0] ?? undefined;
    const userEvents: unknown[] = [];
    const goalEvents: unknown[] = [];

    const userTurn = adapter.sendUserMessage("thread-A", {
      text: "what is 2+2?",
      files: [],
      onEngineEvent: (event) => {
        userEvents.push(event);
      },
    });
    void child;
    await waitFor(() => children.length === 1, "spawn");
    await driveToTurnStart(children, 0, "thread-A", { resume: true });
    const turnStart = findRequest(children[0], "turn/start")!;
    children[0].stdout.emitData(`${JSON.stringify({ id: turnStart.id, result: { turn: { id: "turn-user", status: "inProgress" } } })}\n`);
    await waitFor(
      () => Boolean((adapter as unknown as { pendingTurns: Map<string, { turnId?: string }> }).pendingTurns.get("thread-A")?.turnId),
      "user turn id",
    );

    // A /goal pursuit attaches to the SAME thread and runs outside the chat queue.
    const controller = new AbortController();
    const goalWatch = adapter.watchThreadGoal("thread-A", {
      objective: "keep working",
      onEngineEvent: (event) => {
        goalEvents.push(event);
      },
      abortSignal: controller.signal,
    });
    await answerRequest(children[0], "thread/goal/clear", { cleared: true });
    await answerRequest(children[0], "thread/goal/set", {
      goal: {
        threadId: "thread-A",
        objective: "keep working",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    // The goal's own turn streams text and completes with its own usage.
    children[0].stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-A","turnId":"turn-goal","delta":"GOAL PROGRESS"}}\n');
    children[0].stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-A","turn":{"id":"turn-goal","items":[],"status":"completed","error":null,"usage":{"inputTokens":9999,"outputTokens":9999,"cachedTokens":0}}}}\n');
    await waitFor(() => goalEvents.length > 0, "goal event");

    // The goal's stream must not leak into the user's turn, and must not settle it.
    expect(goalEvents).toEqual([
      expect.objectContaining({ type: "assistant_text", text: "GOAL PROGRESS" }),
    ]);
    expect(userEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "GOAL PROGRESS" }),
    ]));

    // The user's own turn still settles later, with its own text AND usage.
    children[0].stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-A","turnId":"turn-user","delta":"4"}}\n');
    children[0].stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-A","turn":{"id":"turn-user","items":[],"status":"completed","error":null,"usage":{"inputTokens":11,"outputTokens":2,"cachedTokens":1}}}}\n');

    await expect(userTurn).resolves.toEqual({
      text: "4",
      sessionId: undefined,
      usage: { inputTokens: 11, outputTokens: 2, cachedTokens: 1 },
    });

    controller.abort();
    await goalWatch;
    adapter.destroy();
  });

  it("settles two overlapping turns on one thread independently with their own text and usage", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const first = adapter.sendUserMessage("thread-B", { text: "first", files: [] });
    await waitFor(() => children.length === 1, "spawn");
    await driveToTurnStart(children, 0, "thread-B", { resume: true });
    const firstStart = findRequest(children[0], "turn/start")!;
    children[0].stdout.emitData(`${JSON.stringify({ id: firstStart.id, result: { turn: { id: "turn-1" } } })}\n`);
    await waitFor(
      () => (adapter as unknown as { pendingTurnsByTurnId: Map<string, unknown> }).pendingTurnsByTurnId.has("turn-1"),
      "first turn id",
    );

    const second = adapter.sendUserMessage("thread-B", { text: "second", files: [] });
    await waitFor(() => parsedLines(children[0]).filter((line) => line.method === "turn/start").length === 2, "second turn/start");
    const secondStart = parsedLines(children[0]).filter((line) => line.method === "turn/start")[1]!;
    children[0].stdout.emitData(`${JSON.stringify({ id: secondStart.id, result: { turn: { id: "turn-2" } } })}\n`);
    await waitFor(
      () => (adapter as unknown as { pendingTurnsByTurnId: Map<string, unknown> }).pendingTurnsByTurnId.has("turn-2"),
      "second turn id",
    );

    children[0].stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-B","turnId":"turn-2","delta":"SECOND"}}\n');
    children[0].stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-B","turnId":"turn-1","delta":"FIRST"}}\n');
    children[0].stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-B","turn":{"id":"turn-2","items":[],"status":"completed","error":null,"usage":{"inputTokens":2,"outputTokens":2,"cachedTokens":0}}}}\n');
    children[0].stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-B","turn":{"id":"turn-1","items":[],"status":"completed","error":null,"usage":{"inputTokens":1,"outputTokens":1,"cachedTokens":0}}}}\n');

    await expect(second).resolves.toMatchObject({
      text: "SECOND",
      usage: { inputTokens: 2, outputTokens: 2, cachedTokens: 0 },
    });
    await expect(first).resolves.toMatchObject({
      text: "FIRST",
      usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
    });
    adapter.destroy();
  });

  it("still settles a turn whose turn id never arrived (legacy thread-only matching)", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-77", { text: "hi", files: [] });
    await driveToTurnStart(children, 0, "thread-C");
    // No turn/start response and no turn/started notification: the turn id is
    // unknown, so the thread's pending turn keeps owning its notifications.
    children[0].stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-C","turnId":"turn-x","delta":"hello"}}\n');
    children[0].stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-C","turn":{"id":"turn-x","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toMatchObject({ text: "hello", sessionId: "thread-C" });
    adapter.destroy();
  });
});

describe("audit3 fix 3: the app-server adapter announces its thread before the turn can fail", () => {
  it("binds the thread of an aborted first turn on a brand-new chat", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const controller = new AbortController();
    let boundSessionId: string | undefined;

    const promise = adapter.sendUserMessage("telegram-4242", {
      text: "long task",
      files: [],
      abortSignal: controller.signal,
      onEngineEvent: async (event) => {
        if (event.type === "session" && event.sessionId) {
          boundSessionId = event.sessionId;
        }
      },
    });

    await driveToTurnStart(children, 0, "thread-new");
    // The bridge has already persisted the binding by the time the turn runs.
    expect(boundSessionId).toBe("thread-new");

    controller.abort();
    await expect(promise).rejects.toThrow("Codex app-server turn aborted");
    // ...and the thread id survives the failed turn, so the next message resumes it.
    expect(boundSessionId).toBe("thread-new");
    adapter.destroy();
  });
});

describe("audit3 fix 4: Claude turns have an inactivity watchdog honoring /timeout off", () => {
  it("rejects a silent worker with an engine-timeout-classified error", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn, turnInactivityTimeoutMs: 120_000 });

    try {
      const promise = adapter.sendUserMessage("telegram-1", { text: "hello", files: [] });
      // Attach the rejection handler up front: the watchdog fires inside the
      // timer advance below, and an unhandled rejection would fail the run.
      const settled = promise.then(() => undefined, (reason: unknown) => reason);
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1, "claude spawn");

      await vi.advanceTimersByTimeAsync(120_010);

      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/turn became inactive after 2 minutes/);
      // Not "engine crashed, restart the instance" — the user is told it stalled.
      expect(classifyFailure(error)).toBe("engine-timeout");
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("restarts the watchdog on every event, so a busy turn is never cut", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn, turnInactivityTimeoutMs: 120_000 });

    try {
      let settled = false;
      const promise = adapter.sendUserMessage("telegram-1", { text: "hello", files: [] });
      void promise.then(() => { settled = true; }, () => { settled = true; });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1, "claude spawn");

      await vi.advanceTimersByTimeAsync(90_000);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-1"}\n');
      await vi.advanceTimersByTimeAsync(90_000);
      expect(settled).toBe(false);

      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"session-1"}\n');
      await expect(promise).resolves.toMatchObject({ text: "done" });
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("disables the watchdog for the turn when disableRuntimeTimeout is set", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn, turnInactivityTimeoutMs: 120_000 });

    try {
      let settled = false;
      const promise = adapter.sendUserMessage("telegram-1", {
        text: "hello",
        files: [],
        disableRuntimeTimeout: true,
      });
      void promise.then(() => { settled = true; }, () => { settled = true; });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1, "claude spawn");

      await vi.advanceTimersByTimeAsync(600_000);
      expect(settled).toBe(false);

      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"slow but done","session_id":"session-1"}\n');
      await expect(promise).resolves.toMatchObject({ text: "slow but done" });
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });
});

describe("audit3 fix 5: a rejected app-server initialize is not sticky", () => {
  it("retries with a fresh child after an initialize error response", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const first = adapter.sendUserMessage("telegram-1", { text: "hi", files: [] });
    await waitFor(() => children.length === 1, "first spawn");
    await waitFor(() => findRequest(children[0], "initialize") !== undefined, "initialize");
    const initialize = findRequest(children[0], "initialize")!;
    // A JSON-RPC ERROR response (not a timeout): the child stays alive, so no
    // close/error handler resets the cached promise.
    children[0].stdout.emitData(`${JSON.stringify({ id: initialize.id, error: { message: "initialize rejected" } })}\n`);
    await expect(first).rejects.toThrow("initialize rejected");

    const second = adapter.sendUserMessage("telegram-1", { text: "hi again", files: [] });
    await waitFor(() => children.length === 2, "second spawn");
    await driveToTurnStart(children, 1, "thread-retry");
    children[1].stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-retry","turnId":"turn-1","delta":"recovered"}}\n');
    children[1].stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-retry","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(second).resolves.toMatchObject({ text: "recovered", sessionId: "thread-retry" });
    adapter.destroy();
  });
});

describe("audit3 fix 6: the background-task settle timer never drops a running turn", () => {
  it("waits for the outstanding tool call instead of settling with the task summary", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      let settled = false;
      const promise = adapter.sendUserMessage("telegram-1", { text: "audit the repo", files: [] });
      void promise.then(() => { settled = true; }, () => { settled = true; });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1, "claude spawn");

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-1"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        session_id: "session-1",
        message: {
          content: [
            { type: "text", text: "Working on it." },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "./slow.sh" } },
          ],
        },
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-1"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-1","status":"completed","session_id":"session-1"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Background helper finished.",
        session_id: "session-1",
        origin: { kind: "task-notification" },
      }) + "\n");

      // The tool call is still running: the 1.5s grace must not settle the turn.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);

      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        session_id: "session-1",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "The real answer.",
        session_id: "session-1",
        usage: { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: 2 },
        total_cost_usd: 0.5,
      }) + "\n");

      await expect(promise).resolves.toMatchObject({
        text: "The real answer.",
        usage: { inputTokens: 30, outputTokens: 5, cachedTokens: 2, costUsd: 0.5 },
      });
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("still settles a genuinely finished background turn", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const promise = adapter.sendUserMessage("telegram-1", { text: "audit the repo", files: [] });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1, "claude spawn");

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-1"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        session_id: "session-1",
        message: {
          content: [
            { type: "text", text: "Working on it." },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "./quick.sh" } },
          ],
        },
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        session_id: "session-1",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-1"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-1","status":"completed","session_id":"session-1"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Background helper finished.",
        session_id: "session-1",
        origin: { kind: "task-notification" },
      }) + "\n");

      await vi.advanceTimersByTimeAsync(1_600);
      await expect(promise).resolves.toMatchObject({ text: "Background helper finished." });
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });
});

describe("audit3 fix 7: stale background tasks no longer block Claude reconfiguration", () => {
  it("prunes expired background tasks so a settings change goes through", async () => {
    vi.useFakeTimers();
    const { children, calls, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      backgroundTaskMaxAgeMs: 1_000,
    });

    try {
      const first = adapter.sendUserMessage("telegram-1", {
        text: "start background work",
        files: [],
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1, "claude spawn");
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-1"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-1"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-1"}\n');
      await first;

      // The task notification never came back; after the max age it is stale.
      await vi.advanceTimersByTimeAsync(5_000);

      // A workspace change forces the worker to be rebuilt (same code path as a
      // /model, /effort or /approval change) — it used to be hard-blocked here.
      const second = adapter.sendUserMessage("session-1", {
        text: "new settings",
        files: [],
        workspaceOverride: "/tmp/new-workspace",
      });
      await waitFor(() => children.length === 2, "reconfigured spawn");
      expect(calls[1]?.args).toContain("-r");
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"reconfigured","session_id":"session-1"}\n');
      await expect(second).resolves.toMatchObject({ text: "reconfigured" });
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("reports a live background task as engine-busy, not an engine crash", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const first = adapter.sendUserMessage("telegram-1", {
        text: "start background work",
        files: [],
        instructions: "original instructions",
      });
      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1, "claude spawn");
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-1"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-1"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-1"}\n');
      await first;

      const error = await adapter.sendUserMessage("session-1", {
        text: "new settings",
        files: [],
        instructions: "changed instructions",
      }).then(() => undefined, (reason: unknown) => reason);

      expect((error as Error).message).toMatch(/1 background task still running/);
      expect((error as Error).message).toMatch(/\/reset/);
      // engine-cli would have told the user to restart the instance.
      expect(classifyFailure(error)).toBe("engine-busy");
      expect(children).toHaveLength(1);
    } finally {
      adapter.destroy();
    }
  });
});
