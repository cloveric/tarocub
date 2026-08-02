import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EngineApprovalRequest,
  EngineStreamEvent,
} from "../src/codex/adapter.js";
import {
  KimiAcpAdapter,
  type KimiChildProcess,
  type SpawnKimi,
} from "../src/codex/kimi-acp-adapter.js";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) {
      return;
    }
    if ((vi as unknown as { isFakeTimers?: () => boolean }).isFakeTimers?.()) {
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw new Error("Condition was not met in time");
}

class FakeReadable extends EventEmitter {
  emitData(chunk: string | Uint8Array): void {
    this.emit("data", chunk);
  }

  end(): void {
    this.emit("end");
  }
}

class FakeWritable {
  constructor(private readonly onWrite: (chunk: string) => void) {}

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.onWrite(chunk.toString());
    callback?.(null);
    return true;
  }

  end(callback?: () => void): void {
    callback?.();
  }

  destroy(): void {}
}

class FakeAcpServer {
  readonly clientMessages: JsonRpcMessage[] = [];
  readonly clientResponses = new Map<number | string, JsonRpcMessage>();
  readonly cancels: JsonRpcMessage[] = [];
  readonly prompts: JsonRpcMessage[] = [];
  loadReplayText = "old replay that must be ignored";
  autoCompleteCancel = true;

  private inputBuffer = "";
  private nextServerRequestId = 10_000;
  private readonly pendingPrompts = new Map<number | string, JsonRpcMessage>();

  constructor(
    private readonly stdout: FakeReadable,
    readonly sessionId: string,
  ) {}

  receive(chunk: string): void {
    this.inputBuffer += chunk;
    const lines = this.inputBuffer.split("\n");
    this.inputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      this.handleClientMessage(JSON.parse(line) as JsonRpcMessage);
    }
  }

  requests(method: string): JsonRpcMessage[] {
    return this.clientMessages.filter((message) => message.method === method);
  }

  sendUpdate(update: Record<string, unknown>, sessionId = this.sessionId): void {
    this.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  sendUtf8SplitUpdate(update: Record<string, unknown>, marker: string): void {
    const line = Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: this.sessionId, update },
    })}\n`, "utf8");
    const markerBytes = Buffer.from(marker, "utf8");
    const markerIndex = line.indexOf(markerBytes);
    if (markerIndex < 0) {
      throw new Error(`Marker ${marker} was not present in ACP update`);
    }
    queueMicrotask(() => {
      this.stdout.emitData(line.subarray(0, markerIndex + 1));
      this.stdout.emitData(line.subarray(markerIndex + 1));
    });
  }

  requestPermission(params: Record<string, unknown>): number {
    const id = this.nextServerRequestId++;
    this.send({ jsonrpc: "2.0", id, method: "session/request_permission", params });
    return id;
  }

  respondPrompt(result: Record<string, unknown> = { stopReason: "end_turn" }): void {
    const entry = this.pendingPrompts.entries().next().value as
      | [number | string, JsonRpcMessage]
      | undefined;
    if (!entry) {
      throw new Error("No pending Kimi prompt to resolve");
    }
    const [id] = entry;
    this.pendingPrompts.delete(id);
    this.send({ jsonrpc: "2.0", id, result });
  }

  private handleClientMessage(message: JsonRpcMessage): void {
    this.clientMessages.push(message);
    if (!message.method) {
      if (message.id !== undefined) {
        this.clientResponses.set(message.id, message);
      }
      return;
    }

    if (message.method === "initialize") {
      this.respond(message, {
        protocolVersion: 1,
        agentInfo: { name: "Fake Kimi", version: "test" },
        agentCapabilities: { loadSession: true },
        authMethods: [],
      });
      return;
    }
    if (message.method === "session/new") {
      this.respond(message, { sessionId: this.sessionId });
      return;
    }
    if (message.method === "session/load") {
      this.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: this.loadReplayText },
      }, String(message.params?.sessionId));
      this.respond(message, {});
      return;
    }
    if (message.method === "session/prompt") {
      if (message.id === undefined) {
        throw new Error("session/prompt must have a JSON-RPC id");
      }
      this.prompts.push(message);
      this.pendingPrompts.set(message.id, message);
      return;
    }
    if (message.method === "session/cancel") {
      this.cancels.push(message);
      if (this.autoCompleteCancel) {
        const requestedSessionId = String(message.params?.sessionId);
        const pending = [...this.pendingPrompts.entries()].find(([, prompt]) => (
          String(prompt.params?.sessionId) === requestedSessionId
        ));
        if (pending) {
          this.pendingPrompts.delete(pending[0]);
          this.send({ jsonrpc: "2.0", id: pending[0], result: { stopReason: "cancelled" } });
        }
      }
      return;
    }

    if (message.id !== undefined) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported fake method ${message.method}` },
      });
    }
  }

  private respond(request: JsonRpcMessage, result: unknown): void {
    if (request.id === undefined) {
      throw new Error(`Request ${request.method} had no id`);
    }
    this.send({ jsonrpc: "2.0", id: request.id, result });
  }

  private send(message: JsonRpcMessage): void {
    queueMicrotask(() => this.stdout.emitData(`${JSON.stringify(message)}\n`));
  }
}

class FakeKimiChild extends EventEmitter {
  readonly pid: number;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin: FakeWritable;
  readonly server: FakeAcpServer;

  constructor(pid: number, sessionId: string) {
    super();
    this.pid = pid;
    this.server = new FakeAcpServer(this.stdout, sessionId);
    this.stdin = new FakeWritable((chunk) => this.server.receive(chunk));
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  close(code: number | null, signal?: NodeJS.Signals | null): void {
    this.emit("close", code, signal);
    this.stdout.end();
  }
}

function createHarness() {
  const children: FakeKimiChild[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const killedPids: Array<number | undefined> = [];
  const spawnFn: SpawnKimi = (command, args, options) => {
    const index = children.length + 1;
    const child = new FakeKimiChild(700 + index, `kimi-session-${index}`);
    children.push(child);
    spawnCalls.push({ command, args, cwd: options.cwd });
    return child as unknown as KimiChildProcess;
  };
  return {
    children,
    spawnCalls,
    killedPids,
    spawnFn,
    killProcessTreeFn: (pid: number | undefined) => killedPids.push(pid),
  };
}

function adapterOptions(harness: ReturnType<typeof createHarness>) {
  return {
    spawnFn: harness.spawnFn,
    killProcessTreeFn: harness.killProcessTreeFn,
    workspacePath: "/tmp/kimi-workspace",
    idleWorkerTtlMs: 0,
    idleSweepIntervalMs: 0,
    turnTimeoutMs: null,
    inactivityTimeoutMs: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("KimiAcpAdapter", () => {
  it("creates placeholders and maps a real ACP turn stream, UTF-8 chunks, tools, usage, and session ids", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("/opt/kimi", adapterOptions(harness));
    const events: EngineStreamEvent[] = [];
    const progress: string[] = [];

    await expect(adapter.createSession(42)).resolves.toEqual({ sessionId: "telegram-42" });
    const turn = adapter.sendUserMessage("telegram-42", {
      text: "hello",
      files: ["/tmp/input.txt"],
      onProgress: (text) => progress.push(text),
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const child = harness.children[0];
    expect(harness.spawnCalls).toEqual([{
      command: "/opt/kimi",
      args: ["acp"],
      cwd: "/tmp/kimi-workspace",
    }]);
    expect(child.server.prompts[0]?.params?.prompt).toEqual([{
      type: "text",
      text: "hello\nAttachment: /tmp/input.txt",
    }]);

    child.server.sendUpdate({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking" },
    });
    child.server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Read",
      kind: "read",
      status: "pending",
      rawInput: { path: "/tmp/input.txt" },
    });
    child.server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { ok: true },
    });
    child.server.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "你" },
    });
    child.server.sendUtf8SplitUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "好" },
    }, "好");
    child.server.respondPrompt({
      stopReason: "end_turn",
      usage: { inputTokens: 11, outputTokens: 7, cachedReadTokens: 3, totalTokens: 21 },
    });

    await expect(turn).resolves.toEqual({
      text: "你好",
      sessionId: "kimi-session-1",
      usage: { inputTokens: 11, outputTokens: 7, cachedTokens: 3 },
    });
    expect(progress).toEqual(["你", "你好"]);
    expect(events).toEqual(expect.arrayContaining([
      { type: "session", sessionId: "kimi-session-1" },
      { type: "thinking", text: "thinking", sessionId: "kimi-session-1" },
      {
        type: "tool_use",
        toolName: "Read",
        toolInput: { path: "/tmp/input.txt" },
        toolUseId: "tool-1",
        sessionId: "kimi-session-1",
      },
      {
        type: "tool_result",
        toolName: "Read",
        output: "{\"ok\":true}",
        isError: false,
        toolUseId: "tool-1",
        sessionId: "kimi-session-1",
      },
      { type: "assistant_text", text: "你", delta: true, sessionId: "kimi-session-1" },
      { type: "assistant_text", text: "好", delta: true, sessionId: "kimi-session-1" },
      { type: "result", text: "你好", sessionId: "kimi-session-1" },
    ]));
    adapter.destroy();
  });

  it("loads an external session and excludes replayed history from the new answer", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", adapterOptions(harness));

    const turn = adapter.sendUserMessage("durable-session", { text: "continue", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0].server;
    expect(server.requests("session/new")).toHaveLength(0);
    expect(server.requests("session/load")[0]?.params?.sessionId).toBe("durable-session");
    server.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "fresh answer" },
    }, "durable-session");
    server.respondPrompt();

    await expect(turn).resolves.toEqual({ text: "fresh answer" });
    adapter.destroy();
  });

  it("returns the exact advertised session approval option id", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", adapterOptions(harness));
    let approval: EngineApprovalRequest | undefined;
    const turn = adapter.sendUserMessage("telegram-1", {
      text: "run",
      files: [],
      onApprovalRequest: async (request) => {
        approval = request;
        return { behavior: "allow", scope: "session" };
      },
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0].server;
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "bash-1",
      title: "Bash",
      kind: "execute",
      status: "pending",
      rawInput: { command: "pwd" },
    });
    const requestId = server.requestPermission({
      sessionId: server.sessionId,
      toolCall: { toolCallId: "bash-1", title: "Bash" },
      options: [
        { kind: "allow_once", name: "Approve once", optionId: "real-once" },
        { kind: "allow_always", name: "Approve for this session", optionId: "real-always" },
        { kind: "reject_once", name: "Reject", optionId: "real-reject" },
      ],
    });
    await waitFor(() => server.clientResponses.has(requestId));

    expect(approval).toMatchObject({
      engine: "kimi",
      toolName: "Bash",
      toolInput: { command: "pwd" },
      cwd: "/tmp/kimi-workspace",
      sessionId: "kimi-session-1",
    });
    expect(server.clientResponses.get(requestId)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "real-always" },
    });
    server.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "approved" },
    });
    server.respondPrompt();
    await expect(turn).resolves.toMatchObject({ text: "approved" });
    adapter.destroy();
  });

  it("maps AskUserQuestion card answers back to Kimi's advertised option id", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", adapterOptions(harness));
    const turn = adapter.sendUserMessage("telegram-2", {
      text: "ask",
      files: [],
      onApprovalRequest: async (request) => {
        expect(request.engine).toBe("kimi");
        expect(request.toolName).toBe("AskUserQuestion");
        return {
          behavior: "allow",
          updatedInput: { answers: { Choice: "blue" } },
        };
      },
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0].server;
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "question-1",
      title: "AskUserQuestion",
      kind: "other",
      status: "pending",
      rawInput: {
        questions: [{
          question: "Red or blue?",
          header: "Choice",
          multi_select: false,
          options: [{ label: "red" }, { label: "blue" }],
        }],
      },
    });
    const requestId = server.requestPermission({
      sessionId: server.sessionId,
      toolCall: { toolCallId: "question-1", title: "AskUserQuestion" },
      options: [
        { kind: "allow_once", name: "red", optionId: "q0_opt_0" },
        { kind: "allow_once", name: "blue", optionId: "q0_opt_1" },
        { kind: "reject_once", name: "Skip", optionId: "q0_skip" },
      ],
    });
    await waitFor(() => server.clientResponses.has(requestId));
    expect(server.clientResponses.get(requestId)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "q0_opt_1" },
    });
    server.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "blue selected" },
    });
    server.respondPrompt();
    await expect(turn).resolves.toMatchObject({ text: "blue selected" });
    adapter.destroy();
  });

  it("soft-cancels through ACP and reuses the same worker for the next turn", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", adapterOptions(harness));
    const controller = new AbortController();
    const first = adapter.sendUserMessage("telegram-3", {
      text: "wait",
      files: [],
      abortSignal: controller.signal,
    });
    const firstRejected = expect(first).rejects.toThrow("Task was stopped by user");
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    controller.abort();
    await firstRejected;
    expect(harness.children[0].server.cancels).toHaveLength(1);
    expect(harness.killedPids).toHaveLength(0);

    const second = adapter.sendUserMessage("kimi-session-1", { text: "again", files: [] });
    await waitFor(() => harness.children[0].server.prompts.length === 2);
    harness.children[0].server.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "still alive" },
    });
    harness.children[0].server.respondPrompt();
    await expect(second).resolves.toEqual({ text: "still alive" });
    expect(harness.children).toHaveLength(1);
    adapter.destroy();
  });

  it("enforces total and inactivity watchdogs while honoring per-turn timeout disablement", async () => {
    vi.useFakeTimers();

    const totalHarness = createHarness();
    const totalAdapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(totalHarness),
      turnTimeoutMs: 60_000,
    });
    const total = totalAdapter.sendUserMessage("telegram-4", { text: "long", files: [] });
    const totalRejected = expect(total).rejects.toThrow("timed out after 1 minutes");
    await waitFor(() => totalHarness.children[0]?.server.prompts.length === 1);
    await vi.advanceTimersByTimeAsync(60_000);
    await totalRejected;
    expect(totalHarness.children[0].server.cancels).toHaveLength(1);
    totalAdapter.destroy();

    const inactiveHarness = createHarness();
    const inactiveAdapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(inactiveHarness),
      inactivityTimeoutMs: 60_000,
    });
    const inactive = inactiveAdapter.sendUserMessage("telegram-5", { text: "silent", files: [] });
    const inactiveRejected = expect(inactive).rejects.toThrow("became inactive after 1 minutes");
    await waitFor(() => inactiveHarness.children[0]?.server.prompts.length === 1);
    await vi.advanceTimersByTimeAsync(60_000);
    await inactiveRejected;
    expect(inactiveHarness.children[0].server.cancels).toHaveLength(1);

    const disabled = inactiveAdapter.sendUserMessage("kimi-session-1", {
      text: "intentionally silent",
      files: [],
      disableRuntimeTimeout: true,
    });
    await waitFor(() => inactiveHarness.children[0].server.prompts.length === 2);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(inactiveHarness.children[0].server.cancels).toHaveLength(1);
    inactiveHarness.children[0].server.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "done" },
    });
    inactiveHarness.children[0].server.respondPrompt();
    await expect(disabled).resolves.toEqual({ text: "done" });
    inactiveAdapter.destroy();
  });

  it("kills a wedged worker after the ACP cancel grace period and rejects promptly", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      cancelGraceMs: 5_000,
    });
    const controller = new AbortController();
    const turn = adapter.sendUserMessage("telegram-6", {
      text: "wedge",
      files: [],
      abortSignal: controller.signal,
    });
    const rejected = expect(turn).rejects.toThrow("Task was stopped by user");
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0].server.autoCompleteCancel = false;
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(harness.children[0].server.cancels).toHaveLength(1);
    expect(harness.killedPids).toContain(701);
    adapter.destroy();
  });

  it("rejects child failures with bounded stderr diagnostics and removes the failed worker", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", adapterOptions(harness));
    const first = adapter.sendUserMessage("telegram-7", { text: "fail", files: [] });
    const rejected = expect(first).rejects.toThrow(/spawn failed[\s\S]*Kimi stderr:[\s\S]*diagnostic tail/);
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0].stderr.emitData("diagnostic tail\n");
    harness.children[0].fail(new Error("spawn failed"));
    await rejected;
    expect(harness.killedPids).toContain(701);

    const retry = adapter.sendUserMessage("telegram-7", { text: "retry", files: [] });
    await waitFor(() => harness.children[1]?.server.prompts.length === 1);
    harness.children[1].server.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "recovered" },
    });
    harness.children[1].server.respondPrompt();
    await expect(retry).resolves.toEqual({ text: "recovered", sessionId: "kimi-session-2" });
    adapter.destroy();
  });

  it("rejects a process failure during ACP initialization without waiting for the startup timeout", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      initializeTimeoutMs: 30_000,
    });
    const first = adapter.sendUserMessage("telegram-9", { text: "start", files: [] });
    const rejected = expect(first).rejects.toThrow("cannot spawn kimi");
    expect(harness.children).toHaveLength(1);
    harness.children[0].fail(new Error("cannot spawn kimi"));
    await rejected;
    expect(harness.killedPids).toContain(701);
    adapter.destroy();
  });

  it("evicts an idle worker when its ACP stream closes and restores on a fresh process", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", adapterOptions(harness));
    const first = adapter.sendUserMessage("telegram-8", { text: "first", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0].server.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "one" },
    });
    harness.children[0].server.respondPrompt();
    await expect(first).resolves.toEqual({ text: "one", sessionId: "kimi-session-1" });

    harness.children[0].stdout.end();
    await waitFor(() => harness.killedPids.includes(701));
    const second = adapter.sendUserMessage("kimi-session-1", { text: "second", files: [] });
    await waitFor(() => harness.children[1]?.server.prompts.length === 1);
    expect(harness.children[1].server.requests("session/load")[0]?.params?.sessionId).toBe("kimi-session-1");
    harness.children[1].server.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "two" },
    }, "kimi-session-1");
    harness.children[1].server.respondPrompt();
    await expect(second).resolves.toEqual({ text: "two" });
    adapter.destroy();
  });
});
