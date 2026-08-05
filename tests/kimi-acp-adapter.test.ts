import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EngineApprovalRequest,
  EngineStreamEvent,
} from "../src/codex/adapter.js";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
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

async function settleWithin<T>(promise: Promise<T>, ms = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Kimi turn did not settle in time")), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
  respondToSessionList = true;
  listedSessions: Array<{
    sessionId: string;
    cwd: string;
    title?: string;
    updatedAt?: string;
  }> = [];
  configOptions: SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "kimi-default",
      options: [
        { value: "kimi-default", name: "Default" },
        { value: "kimi-k2.5", name: "K2.5" },
      ],
    },
    {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "max", name: "Max" },
      ],
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default" },
        { value: "yolo", name: "YOLO" },
        { value: "auto", name: "Auto" },
      ],
    },
  ];

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
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
        authMethods: [],
      });
      return;
    }
    if (message.method === "session/list") {
      if (!this.respondToSessionList) {
        return;
      }
      const cwd = typeof message.params?.cwd === "string" ? message.params.cwd : null;
      this.respond(message, {
        sessions: cwd ? this.listedSessions.filter((session) => session.cwd === cwd) : this.listedSessions,
        nextCursor: null,
      });
      return;
    }
    if (message.method === "session/new") {
      this.respond(message, { sessionId: this.sessionId, configOptions: this.configOptions });
      return;
    }
    if (message.method === "session/load") {
      this.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: this.loadReplayText },
      }, String(message.params?.sessionId));
      this.respond(message, { configOptions: this.configOptions });
      return;
    }
    if (message.method === "session/set_config_option") {
      const configId = String(message.params?.configId);
      const value = String(message.params?.value);
      this.configOptions = this.configOptions.map((option) => (
        option.id === configId && option.type === "select" ? { ...option, currentValue: value } : option
      ));
      this.respond(message, { configOptions: this.configOptions });
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

function createHarness(configureServer?: (server: FakeAcpServer) => void) {
  const children: FakeKimiChild[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const spawnEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
  const killedPids: Array<number | undefined> = [];
  const spawnFn: SpawnKimi = (command, args, options) => {
    const index = children.length + 1;
    const child = new FakeKimiChild(700 + index, `kimi-session-${index}`);
    configureServer?.(child.server);
    children.push(child);
    spawnCalls.push({ command, args, cwd: options.cwd });
    spawnEnvs.push(options.env);
    return child as unknown as KimiChildProcess;
  };
  return {
    children,
    spawnCalls,
    spawnEnvs,
    killedPids,
    spawnFn,
    killProcessTreeFn: (pid: number | undefined) => killedPids.push(pid),
  };
}

function promptText(server: FakeAcpServer, index = 0): string {
  const prompt = server.prompts[index]?.params?.prompt;
  if (!Array.isArray(prompt)) {
    throw new Error("Expected an ACP prompt array");
  }
  const first = prompt[0];
  if (!first || typeof first !== "object" || !("text" in first) || typeof first.text !== "string") {
    throw new Error("Expected the first ACP prompt block to contain text");
  }
  return first.text;
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
    syncWorkspaceInstructionsFn: vi.fn(async (_workspacePath: string, instructions: string | null) => instructions ?? ""),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("KimiAcpAdapter", () => {
  it("relays Kimi hook background tasks into start and out-of-band completion events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-hook-test-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ engine: "kimi", effort: "high" }), "utf8");
    const harness = createHarness();
    const events: EngineStreamEvent[] = [];
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      configPath,
      engineHomePath: root,
      hookRelayEnabled: true,
    });
    try {
      const turn = adapter.sendUserMessage("telegram-54", {
        text: "start a background build",
        files: [],
        onEngineEvent: async (event) => {
          events.push(event);
        },
      });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      const hookUrl = harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_URL;
      const hookToken = harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_TOKEN;
      expect(hookUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(hookToken).toMatch(/^[a-f0-9]{64}$/);
      const headers = {
        "content-type": "application/json",
        "x-tarocub-kimi-hook-token": hookToken!,
      };

      harness.children[0].server.sendUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-background-build",
        title: "Bash",
        kind: "execute",
        status: "pending",
        rawInput: { command: "npm run build", run_in_background: true },
      });
      harness.children[0].server.sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-background-build",
        status: "completed",
        rawOutput: [
          "task_id: bash-build1",
          "status: running",
          "description: Build release",
          "automatic_notification: true",
        ].join("\n"),
      });
      await waitFor(() => events.some((event) => event.type === "background_task_started"));

      const started = await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "TaskStarted",
          session_id: "kimi-session-1",
          task_id: "bash-build1",
          kind: "process",
          description: "Build release",
          status: "running",
          detached: true,
        }),
      });
      expect(started.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events.filter((event) => event.type === "background_task_started")).toHaveLength(1);

      harness.children[0].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "The build is running in the background." },
      });
      harness.children[0].server.respondPrompt();
      await expect(turn).resolves.toMatchObject({ text: "The build is running in the background." });

      await writeFile(configPath, JSON.stringify({ engine: "kimi", effort: "low" }), "utf8");
      await expect(adapter.sendUserMessage("kimi-session-1", {
        text: "apply the new effort",
        files: [],
      })).rejects.toThrow("Kimi session has 1 background task still running");

      const completed = await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "Notification",
          session_id: "kimi-session-1",
          notification_type: "task.completed",
          source_kind: "background_task",
          source_id: "bash-build1",
          title: "Background process completed",
          body: "Build release completed.",
        }),
      });
      expect(completed.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "background_task_started",
          taskId: "bash-build1",
          sessionId: "kimi-session-1",
          description: "Build release",
        }),
        expect.objectContaining({
          type: "task_notification",
          taskId: "bash-build1",
          sessionId: "kimi-session-1",
          status: "completed",
          text: "Build release completed.",
        }),
      ]));
      const notification = events.find((event) => event.type === "task_notification");
      expect(notification).not.toHaveProperty("settlesCurrentTurn");
    } finally {
      adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delivers real background Bash output instead of only the generic hook summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-hook-output-test-"));
    const harness = createHarness();
    const events: EngineStreamEvent[] = [];
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      engineHomePath: root,
      hookRelayEnabled: true,
    });
    try {
      const turn = adapter.sendUserMessage("telegram-58", {
        text: "run the build in the background",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      const hookUrl = harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_URL;
      const headers = {
        "content-type": "application/json",
        "x-tarocub-kimi-hook-token": harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_TOKEN ?? "",
      };

      await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "TaskStarted",
          session_id: "kimi-session-1",
          task_id: "bash-real-output",
          kind: "process",
          description: "Build release",
          detached: true,
        }),
      });
      await waitFor(() => events.some((event) => event.type === "background_task_started"));
      harness.children[0].server.respondPrompt();
      await expect(turn).resolves.toMatchObject({ text: "Kimi completed the request." });

      const outputDir = path.join(
        root,
        "sessions",
        "wd-test",
        "session_kimi-session-1",
        "agents",
        "main",
        "tasks",
        "bash-real-output",
      );
      await mkdir(outputDir, { recursive: true });
      await writeFile(path.join(outputDir, "output.log"), "build passed\n12 tests passed\n", "utf8");

      const completed = await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "Notification",
          session_id: "kimi-session-1",
          notification_type: "task.completed",
          source_kind: "background_task",
          source_id: "bash-real-output",
          title: "Background process completed",
          body: "Build release completed.",
        }),
      });
      expect(completed.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await waitFor(() => events.some((event) => event.type === "task_notification"));

      expect(events).toContainEqual(expect.objectContaining({
        type: "task_notification",
        taskId: "bash-real-output",
        status: "completed",
        text: "build passed\n12 tests passed",
      }));

      await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "TaskStarted",
          session_id: "kimi-session-1",
          task_id: "bash-escaped-output",
          kind: "process",
          description: "Unsafe output path",
          detached: true,
        }),
      });
      const escapedOutputDir = path.join(
        root,
        "sessions",
        "wd-test",
        "session_kimi-session-1",
        "agents",
        "main",
        "tasks",
        "bash-escaped-output",
      );
      const outsideSecret = path.join(root, "outside-secret.txt");
      await writeFile(outsideSecret, "DO_NOT_LEAK", "utf8");
      await mkdir(escapedOutputDir, { recursive: true });
      await symlink(outsideSecret, path.join(escapedOutputDir, "output.log"));
      await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "Notification",
          session_id: "kimi-session-1",
          notification_type: "task.completed",
          source_kind: "background_task",
          source_id: "bash-escaped-output",
          body: "Safe completion summary.",
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const escapedNotification = events.find((event) => (
        event.type === "task_notification" && event.taskId === "bash-escaped-output"
      ));
      expect(escapedNotification).toMatchObject({ text: "Safe completion summary." });
      expect(escapedNotification).not.toMatchObject({ text: expect.stringContaining("DO_NOT_LEAK") });
    } finally {
      await adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not resurrect a terminal background task from late or duplicate events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-hook-order-test-"));
    const harness = createHarness();
    const events: EngineStreamEvent[] = [];
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      engineHomePath: root,
      hookRelayEnabled: true,
    });
    try {
      const turn = adapter.sendUserMessage("telegram-59", {
        text: "observe an already completed task",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      const hookUrl = harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_URL;
      const headers = {
        "content-type": "application/json",
        "x-tarocub-kimi-hook-token": harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_TOKEN ?? "",
      };
      const terminalPayload = {
        hook_event_name: "Notification",
        session_id: "kimi-session-1",
        notification_type: "task.completed",
        source_kind: "background_task",
        source_id: "bash-finished-first",
        body: "Task already completed.",
      };

      await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify(terminalPayload),
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await waitFor(() => events.some((event) => event.type === "task_notification"));

      await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "TaskStarted",
          session_id: "kimi-session-1",
          task_id: "bash-finished-first",
          kind: "process",
          description: "Late start",
          detached: true,
        }),
      });
      harness.children[0].server.sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-late-background",
        status: "completed",
        rawOutput: [
          "task_id: bash-finished-first",
          "description: Late tool result",
          "automatic_notification: true",
        ].join("\n"),
      });
      await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify(terminalPayload),
      });
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(events.filter((event) => event.type === "background_task_started")).toHaveLength(0);
      expect(events.filter((event) => event.type === "task_notification")).toHaveLength(1);
      harness.children[0].server.respondPrompt();
      await expect(turn).resolves.toMatchObject({ text: "Kimi completed the request." });
    } finally {
      await adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not emit duplicate completion while background output is still being read", async () => {
    const harness = createHarness();
    const events: EngineStreamEvent[] = [];
    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead: ((value: string | undefined) => void) | undefined;
    const readResult = new Promise<string | undefined>((resolve) => {
      releaseRead = resolve;
    });
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      engineHomePath: "/tmp/kimi-output-race",
      hookRelayEnabled: true,
      readBackgroundTaskOutputFn: async () => {
        signalReadStarted?.();
        return await readResult;
      },
    });
    try {
      const turn = adapter.sendUserMessage("telegram-60", {
        text: "observe duplicate completion hooks",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      const hookUrl = harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_URL;
      const headers = {
        "content-type": "application/json",
        "x-tarocub-kimi-hook-token": harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_TOKEN ?? "",
      };
      const sendHook = async (body: Record<string, unknown>): Promise<void> => {
        const response = await fetch(hookUrl!, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(202);
      };

      await sendHook({
        hook_event_name: "TaskStarted",
        session_id: "kimi-session-1",
        task_id: "bash-output-race",
        kind: "process",
        description: "Race-safe build",
        detached: true,
      });
      await waitFor(() => events.some((event) => (
        event.type === "background_task_started" && event.taskId === "bash-output-race"
      )));
      harness.children[0].server.respondPrompt();
      await expect(turn).resolves.toMatchObject({ text: "Kimi completed the request." });

      const completion = {
        hook_event_name: "Notification",
        session_id: "kimi-session-1",
        notification_type: "task.completed",
        source_kind: "background_task",
        source_id: "bash-output-race",
        body: "Build completed.",
      };
      await sendHook(completion);
      await readStarted;

      await sendHook(completion);
      await sendHook({
        hook_event_name: "TaskStarted",
        session_id: "kimi-session-1",
        task_id: "bash-event-chain-marker",
        kind: "process",
        description: "Event-chain marker",
        detached: true,
      });
      await waitFor(() => events.some((event) => (
        event.type === "background_task_started" && event.taskId === "bash-event-chain-marker"
      )));
      releaseRead?.("build passed");

      await waitFor(() => events.some((event) => (
        event.type === "task_notification" && event.taskId === "bash-output-race"
      )));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(events.filter((event) => (
        event.type === "task_notification" && event.taskId === "bash-output-race"
      ))).toHaveLength(1);
    } finally {
      releaseRead?.(undefined);
      await adapter.destroy();
    }
  });

  it("does not retain tool-result task metadata when no completion relay is active", async () => {
    const harness = createHarness();
    const events: EngineStreamEvent[] = [];
    const adapter = new KimiAcpAdapter("kimi", adapterOptions(harness));
    const turn = adapter.sendUserMessage("telegram-56", {
      text: "start a background build",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0].server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-background-build",
      title: "Bash",
      kind: "execute",
      status: "pending",
      rawInput: { command: "npm run build", run_in_background: true },
    });
    harness.children[0].server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-background-build",
      status: "completed",
      rawOutput: [
        "task_id: bash-build1",
        "description: Build release",
        "automatic_notification: true",
      ].join("\n"),
    });
    harness.children[0].server.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Background build started." },
    });
    harness.children[0].server.respondPrompt();
    await expect(turn).resolves.toMatchObject({ text: "Background build started." });
    expect(events.some((event) => event.type === "background_task_started")).toBe(false);
    adapter.destroy();
  });

  it("terminalizes retained background tasks when their ACP worker is destroyed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-hook-destroy-test-"));
    const harness = createHarness();
    const events: EngineStreamEvent[] = [];
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      engineHomePath: root,
      hookRelayEnabled: true,
    });
    try {
      const turn = adapter.sendUserMessage("telegram-57", {
        text: "start a background build",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      const hookUrl = harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_URL;
      const hookToken = harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_TOKEN;
      const started = await fetch(hookUrl!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tarocub-kimi-hook-token": hookToken!,
        },
        body: JSON.stringify({
          hook_event_name: "TaskStarted",
          session_id: "kimi-session-1",
          task_id: "bash-build-destroyed",
          kind: "process",
          description: "Build release",
          detached: true,
        }),
      });
      expect(started.status).toBe(202);
      await waitFor(() => events.some((event) => event.type === "background_task_started"));

      harness.children[0].server.respondPrompt();
      await expect(turn).resolves.toMatchObject({ text: "Kimi completed the request." });
      adapter.destroy();
      await waitFor(() => events.some((event) => event.type === "task_notification"));

      expect(events).toContainEqual(expect.objectContaining({
        type: "task_notification",
        taskId: "bash-build-destroyed",
        sessionId: "kimi-session-1",
        status: "failed",
      }));
    } finally {
      adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for the hook relay to drain before destroying Kimi workers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-hook-destroy-drain-test-"));
    const harness = createHarness();
    let releaseRelay: (() => void) | undefined;
    let closeStarted = false;
    const relayReleased = new Promise<void>((resolve) => {
      releaseRelay = resolve;
    });
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      engineHomePath: root,
      hookRelayEnabled: true,
      startHookRelayFn: async () => ({
        env: {},
        close: async () => {
          closeStarted = true;
          await relayReleased;
        },
      }),
    });
    try {
      const turn = adapter.sendUserMessage("telegram-60", {
        text: "start and finish normally",
        files: [],
      });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      harness.children[0].server.respondPrompt();
      await expect(turn).resolves.toMatchObject({ text: "Kimi completed the request." });

      const destroyPromise = adapter.destroy();
      await waitFor(() => closeStarted);
      expect(harness.killedPids).toEqual([]);

      releaseRelay?.();
      await destroyPromise;
      expect(harness.killedPids).toEqual([701]);
    } finally {
      releaseRelay?.();
      await adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enriches an agent-task notification with the matching SubagentStop response", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-agent-hook-test-"));
    const harness = createHarness();
    const events: EngineStreamEvent[] = [];
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      engineHomePath: root,
      hookRelayEnabled: true,
    });
    try {
      const turn = adapter.sendUserMessage("telegram-55", {
        text: "start a background reviewer",
        files: [],
        onEngineEvent: async (event) => {
          events.push(event);
        },
      });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      const hookUrl = harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_URL;
      const headers = {
        "content-type": "application/json",
        "x-tarocub-kimi-hook-token": harness.spawnEnvs[0]?.TAROCUB_KIMI_HOOK_TOKEN ?? "",
      };

      await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "TaskStarted",
          session_id: "kimi-session-1",
          task_id: "agent-review1",
          kind: "agent",
          description: "Review the patch",
          detached: true,
        }),
      });
      await waitFor(() => events.some((event) => event.type === "background_task_started"));
      harness.children[0].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Reviewer dispatched." },
      });
      harness.children[0].server.respondPrompt();
      await expect(turn).resolves.toMatchObject({ text: "Reviewer dispatched." });

      const notification = await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "Notification",
          session_id: "kimi-session-1",
          notification_type: "task.completed",
          source_kind: "background_task",
          source_id: "agent-review1",
          body: "Reviewer finished.",
        }),
      });
      const subagentStop = await fetch(hookUrl!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          hook_event_name: "SubagentStop",
          session_id: "kimi-session-1",
          agent_name: "reviewer",
          response: "No blocking findings.",
        }),
      });
      expect(notification.status).toBe(202);
      expect(subagentStop.status).toBe(202);
      await waitFor(() => events.some((event) => event.type === "task_notification"));

      expect(events).toContainEqual(expect.objectContaining({
        type: "task_notification",
        taskId: "agent-review1",
        sessionId: "kimi-session-1",
        status: "completed",
        text: "No blocking findings.",
      }));
    } finally {
      adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies advertised model, effort, and approval settings and reloads the same session after reconfiguration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-config-test-"));
    const configPath = path.join(root, "config.json");
    const instructionsPath = path.join(root, "agent.md");
    await writeFile(instructionsPath, "Always follow the instance instruction.", "utf8");
    await writeFile(configPath, JSON.stringify({
      engine: "kimi",
      model: "kimi-k2.5",
      effort: "max",
      approvalMode: "full-auto",
    }), "utf8");

    const harness = createHarness();
    const syncWorkspaceInstructionsFn = vi.fn(async (_workspacePath: string, instructions: string | null) => instructions ?? "");
    const adapter = new KimiAcpAdapter("/opt/kimi", {
      ...adapterOptions(harness),
      configPath,
      engineHomePath: root,
      instructionsPath,
      syncWorkspaceInstructionsFn,
    });
    try {
      const first = adapter.sendUserMessage("telegram-55", {
        text: "first",
        files: [],
        instructions: "Use the Lark delivery contract.",
      });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      expect(harness.children[0].server.requests("session/set_config_option").map((request) => request.params)).toEqual([
        { sessionId: "kimi-session-1", configId: "model", value: "kimi-k2.5" },
        { sessionId: "kimi-session-1", configId: "thinking", value: "max" },
        { sessionId: "kimi-session-1", configId: "mode", value: "yolo" },
      ]);
      expect(harness.spawnCalls[0]?.args).toEqual(["acp"]);
      expect(promptText(harness.children[0].server)).toBe("first");
      expect(syncWorkspaceInstructionsFn).toHaveBeenCalledWith(
        "/tmp/kimi-workspace",
        "Always follow the instance instruction.\n\nUse the Lark delivery contract.",
      );
      expect(harness.children[0].server.requests("session/new")[0]?.params?.mcpServers).toEqual([
        expect.objectContaining({ name: "cctb_search" }),
      ]);
      harness.children[0].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "one" },
      });
      harness.children[0].server.respondPrompt();
      await expect(first).resolves.toEqual({ text: "one", sessionId: "kimi-session-1" });

      await writeFile(configPath, JSON.stringify({
        engine: "kimi",
        effort: "low",
        approvalMode: "bypass",
      }), "utf8");
      const second = adapter.sendUserMessage("kimi-session-1", {
        text: "second",
        files: [],
        instructions: "Use the Lark delivery contract.",
      });
      await waitFor(() => harness.children[1]?.server.prompts.length === 1);
      expect(harness.killedPids).toContain(701);
      expect(harness.children[1].server.requests("session/load")[0]?.params?.sessionId).toBe("kimi-session-1");
      expect(harness.children[1].server.requests("session/set_config_option").map((request) => request.params)).toEqual([
        { sessionId: "kimi-session-1", configId: "thinking", value: "low" },
        { sessionId: "kimi-session-1", configId: "mode", value: "auto" },
      ]);
      harness.children[1].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "two" },
      }, "kimi-session-1");
      harness.children[1].server.respondPrompt();
      await expect(second).resolves.toEqual({ text: "two" });
    } finally {
      adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("syncs instance instructions into Kimi's native workspace context and reloads when they change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-instructions-test-"));
    const instructionsPath = path.join(root, "agent.md");
    await writeFile(instructionsPath, "Use instruction version one.", "utf8");
    const harness = createHarness();
    const syncWorkspaceInstructionsFn = vi.fn(async (_workspacePath: string, instructions: string | null) => instructions ?? "");
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      instructionsPath,
      syncWorkspaceInstructionsFn,
    });
    try {
      const first = adapter.sendUserMessage("telegram-59", { text: "first", files: [] });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      expect(promptText(harness.children[0].server)).toBe("first");
      harness.children[0].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "one" },
      });
      harness.children[0].server.respondPrompt();
      await first;

      await writeFile(instructionsPath, "Use instruction version two.", "utf8");
      const second = adapter.sendUserMessage("kimi-session-1", { text: "second", files: [] });
      await waitFor(() => harness.children[1]?.server.prompts.length === 1);
      expect(promptText(harness.children[1].server)).toBe("second");
      expect(harness.children).toHaveLength(2);
      expect(harness.killedPids).toContain(701);
      expect(syncWorkspaceInstructionsFn).toHaveBeenNthCalledWith(
        2,
        "/tmp/kimi-workspace",
        "Use instruction version two.",
      );
      harness.children[1].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "two" },
      }, "kimi-session-1");
      harness.children[1].server.respondPrompt();
      await second;
    } finally {
      adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reloads when project-owned Kimi AGENTS guidance changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-project-instructions-test-"));
    const instructionsPath = path.join(root, "agent.md");
    await writeFile(instructionsPath, "Stable bridge guidance.", "utf8");
    await mkdir(path.join(root, ".kimi-code"), { recursive: true });
    const agentsPath = path.join(root, ".kimi-code", "AGENTS.md");
    await writeFile(agentsPath, "Project-owned guidance v1.\n", "utf8");
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      workspacePath: root,
      instructionsPath,
      syncWorkspaceInstructionsFn: undefined,
    });
    try {
      const first = adapter.sendUserMessage("telegram-62", { text: "first", files: [] });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      harness.children[0].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "one" },
      });
      harness.children[0].server.respondPrompt();
      await first;

      await writeFile(agentsPath, "Project-owned guidance v2.\n", "utf8");
      const second = adapter.sendUserMessage("kimi-session-1", { text: "second", files: [] });
      await waitFor(() => harness.children[1]?.server.prompts.length === 1);
      expect(harness.killedPids).toContain(701);
      harness.children[1].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "two" },
      }, "kimi-session-1");
      harness.children[1].server.respondPrompt();
      await second;
    } finally {
      adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps native slash commands raw when an override workspace requires prompt-level instructions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-command-test-"));
    const instructionsPath = path.join(root, "agent.md");
    await writeFile(instructionsPath, "Follow bridge guidance.", "utf8");
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", { ...adapterOptions(harness), instructionsPath });
    try {
      const turn = adapter.sendUserMessage("telegram-61", {
        text: "/compact",
        files: [],
        workspaceOverride: path.join(root, "external-workspace"),
      });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      expect(promptText(harness.children[0].server)).toBe("/compact");
      harness.children[0].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "compacted" },
      });
      harness.children[0].server.respondPrompt();
      await expect(turn).resolves.toMatchObject({ text: "compacted" });
    } finally {
      adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes provider model and bridge effort defaults back to a resumed session after overrides are removed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-default-reset-test-"));
    const configPath = path.join(root, "instance-config.json");
    await writeFile(path.join(root, "config.toml"), 'default_model = "kimi-default"\n', "utf8");
    await writeFile(configPath, JSON.stringify({
      engine: "kimi",
      model: "kimi-k2.5",
      effort: "max",
      approvalMode: "normal",
    }), "utf8");

    let workerCount = 0;
    const harness = createHarness((server) => {
      workerCount += 1;
      if (workerCount !== 2) {
        return;
      }
      server.configOptions = server.configOptions.map((option) => {
        if (option.id === "model" && option.type === "select") {
          return { ...option, currentValue: "kimi-k2.5" };
        }
        if (option.id === "thinking" && option.type === "select") {
          return { ...option, currentValue: "max" };
        }
        return option;
      });
    });
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      configPath,
      engineHomePath: root,
    });
    try {
      const first = adapter.sendUserMessage("telegram-60", { text: "first", files: [] });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      expect(harness.children[0].server.requests("session/set_config_option").map((request) => request.params)).toEqual([
        { sessionId: "kimi-session-1", configId: "model", value: "kimi-k2.5" },
        { sessionId: "kimi-session-1", configId: "thinking", value: "max" },
      ]);
      harness.children[0].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "one" },
      });
      harness.children[0].server.respondPrompt();
      await first;

      await writeFile(configPath, JSON.stringify({ engine: "kimi", approvalMode: "normal" }), "utf8");
      const second = adapter.sendUserMessage("kimi-session-1", { text: "second", files: [] });
      await waitFor(() => harness.children[1]?.server.prompts.length === 1);
      expect(harness.children[1].server.requests("session/load")[0]?.params?.sessionId).toBe("kimi-session-1");
      expect(harness.children[1].server.requests("session/set_config_option").map((request) => request.params)).toEqual([
        { sessionId: "kimi-session-1", configId: "model", value: "kimi-default" },
        { sessionId: "kimi-session-1", configId: "thinking", value: "high" },
      ]);
      harness.children[1].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "two" },
      }, "kimi-session-1");
      harness.children[1].server.respondPrompt();
      await second;
    } finally {
      adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a Kimi model that the live ACP session does not advertise", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-model-test-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      engine: "kimi",
      model: "not-installed",
      effort: "high",
      approvalMode: "normal",
    }), "utf8");
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", { ...adapterOptions(harness), configPath, engineHomePath: root });
    try {
      await expect(adapter.sendUserMessage("telegram-56", { text: "hello", files: [] }))
        .rejects.toThrow("Available values: kimi-default, kimi-k2.5");
      expect(harness.children[0].server.prompts).toHaveLength(0);
      expect(harness.killedPids).toContain(701);
    } finally {
      adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts model values advertised inside grouped ACP config options", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-grouped-model-test-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      engine: "kimi",
      model: "moonshot-v1",
      effort: "high",
      approvalMode: "normal",
    }), "utf8");
    const harness = createHarness((server) => {
      server.configOptions = server.configOptions.map((option) => option.category === "model"
        ? {
            ...option,
            options: [{
              group: "moonshot",
              name: "Moonshot",
              options: [{ value: "moonshot-v1", name: "Moonshot V1" }],
            }],
          }
        : option);
    });
    const adapter = new KimiAcpAdapter("kimi", { ...adapterOptions(harness), configPath, engineHomePath: root });
    try {
      const turn = adapter.sendUserMessage("telegram-57", { text: "hello", files: [] });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      expect(harness.children[0].server.requests("session/set_config_option")[0]?.params).toEqual({
        sessionId: "kimi-session-1",
        configId: "model",
        value: "moonshot-v1",
      });
      harness.children[0].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "ok" },
      });
      harness.children[0].server.respondPrompt();
      await expect(turn).resolves.toMatchObject({ text: "ok" });
    } finally {
      adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a settings change while the same Kimi session has an in-flight turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-inflight-config-test-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ engine: "kimi", effort: "high" }), "utf8");
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", { ...adapterOptions(harness), configPath, engineHomePath: root });
    try {
      const first = adapter.sendUserMessage("telegram-58", { text: "first", files: [] });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      await writeFile(configPath, JSON.stringify({ engine: "kimi", effort: "max" }), "utf8");
      await expect(adapter.sendUserMessage("kimi-session-1", { text: "second", files: [] }))
        .rejects.toThrow("Cannot reconfigure Kimi session while a turn is in flight");
      expect(harness.children).toHaveLength(1);

      harness.children[0].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "one" },
      });
      harness.children[0].server.respondPrompt();
      await expect(first).resolves.toMatchObject({ text: "one" });
    } finally {
      adapter.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it("delivers queued engine events before the final result", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", adapterOptions(harness));
    const eventOrder: string[] = [];
    const turn = adapter.sendUserMessage("telegram-43", {
      text: "hello",
      files: [],
      onEngineEvent: async (event) => {
        if (event.type === "assistant_text") {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        eventOrder.push(event.type);
      },
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    harness.children[0].server.sendUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "done" },
    });
    harness.children[0].server.respondPrompt();
    await expect(turn).resolves.toMatchObject({ text: "done" });
    expect(eventOrder).toEqual(["session", "assistant_text", "result"]);
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

  it("lists and validates Kimi sessions through a short-lived ACP control connection", async () => {
    const harness = createHarness((server) => {
      server.listedSessions = [
        {
          sessionId: "session-a",
          cwd: "/tmp/project-a",
          title: "Project A",
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
        { sessionId: "session-b", cwd: "/tmp/project-b" },
      ];
    });
    const adapter = new KimiAcpAdapter("kimi", adapterOptions(harness));
    await expect(adapter.listExternalSessions({ cwd: "/tmp/project-a", limit: 20 })).resolves.toEqual([{
      sessionId: "session-a",
      cwd: "/tmp/project-a",
      title: "Project A",
      updatedAt: "2026-08-03T00:00:00.000Z",
    }]);
    expect(harness.children[0].server.requests("session/list")[0]?.params).toEqual({
      cwd: "/tmp/project-a",
      cursor: null,
    });
    expect(harness.children[0].server.requests("session/new")).toHaveLength(0);
    expect(harness.killedPids).toContain(701);

    await expect(adapter.validateExternalSession("session-b")).resolves.toEqual({
      sessionId: "session-b",
      cwd: "/tmp/project-b",
    });
    expect(harness.children[1].server.requests("session/load")[0]?.params).toEqual({
      sessionId: "session-b",
      cwd: "/tmp/project-b",
      mcpServers: [expect.objectContaining({ name: "cctb_search" })],
    });
    await expect(adapter.validateExternalSession("session-b", {
      workspaceOverride: "/tmp/project-a",
    })).rejects.toThrow("Kimi session workspace mismatch");
    await expect(adapter.validateExternalSession("missing-session")).rejects.toThrow("Kimi session not found");
    expect(harness.children).toHaveLength(4);
    expect(harness.children.every((child) => child.server.requests("session/new").length === 0)).toBe(true);
    adapter.destroy();
  });

  it("times out and kills a stalled Kimi session/list control process", async () => {
    vi.useFakeTimers();
    const harness = createHarness((server) => {
      server.respondToSessionList = false;
    });
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      initializeTimeoutMs: 25,
    });
    const listing = adapter.listExternalSessions();
    const timedOut = expect(listing).rejects.toThrow("Kimi ACP control request timed out after 25ms");
    await waitFor(() => harness.children[0]?.server.requests("session/list").length === 1);
    await vi.advanceTimersByTimeAsync(25);

    await timedOut;
    expect(harness.killedPids).toContain(701);
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
        expect(request.toolInput).toEqual({
          questions: [{
            question: "Which do you choose: red or blue?",
            header: "Colour",
            multi_select: false,
            options: [
              { label: "red", description: "Warm" },
              { label: "blue", description: "Cool" },
            ],
          }],
        });
        return {
          behavior: "allow",
          updatedInput: { answers: { Colour: "blue" } },
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
        questions: [
          {
            question: "Which do you choose: red or blue?",
            header: "Colour",
            multi_select: true,
            options: [
              { label: "red", description: "Warm" },
              { label: "blue", description: "Cool" },
            ],
          },
          {
            question: "This second question cannot be represented by one ACP optionId.",
            header: "Unsupported",
            options: [{ label: "extra" }],
          },
        ],
      },
    });
    const requestId = server.requestPermission({
      sessionId: server.sessionId,
      toolCall: {
        toolCallId: "question-1",
        title: "AskUserQuestion",
        content: [{
          type: "content",
          content: { type: "text", text: "Which do you choose: red or blue?" },
        }],
      },
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

  it("builds the AskUserQuestion form from tool_call content when the request has no structured rawInput", async () => {
    // The docs-recorded LIVE shape: the real 0.31.1 permission request carried
    // no rawInput/questions — only content text on the tool_call. The fallback
    // (question from content, header "Choice") is the path production hits.
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", adapterOptions(harness));
    const turn = adapter.sendUserMessage("telegram-noraw", {
      text: "ask",
      files: [],
      onApprovalRequest: async (request) => {
        expect(request.toolName).toBe("AskUserQuestion");
        const input = request.toolInput as { questions: Array<{ question: string; header: string; options: Array<{ label: string }> }> };
        expect(input.questions[0]?.question).toContain("Proceed with the risky migration?");
        expect(input.questions[0]?.header).toBe("Choice");
        // Only allow-kind options become form choices; reject kinds map to deny.
        expect(input.questions[0]?.options.map((option) => option.label)).toEqual(["Yes", "No"]);
        return { behavior: "allow", updatedInput: { answers: { [input.questions[0]!.question]: "Yes" } } };
      },
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0].server;
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "ask-noraw",
      title: "AskUserQuestion",
      kind: "other",
      status: "pending",
      content: [{ type: "content", content: { type: "text", text: "Proceed with the risky migration?" } }],
    });
    const requestId = server.requestPermission({
      sessionId: server.sessionId,
      toolCall: {
        toolCallId: "ask-noraw",
        title: "AskUserQuestion",
        // The question text lives on the PERMISSION REQUEST's toolCall content
        // (the live 0.31.1 shape) — not on the earlier tool_call update.
        content: [{ type: "content", content: { type: "text", text: "Proceed with the risky migration?" } }],
      },
      options: [
        { kind: "allow_once", name: "Yes", optionId: "opt-yes" },
        { kind: "allow_once", name: "No", optionId: "opt-no" },
        { kind: "reject_once", name: "Skip", optionId: "opt-skip" },
      ],
    });
    await waitFor(() => server.clientResponses.has(requestId));
    expect(server.clientResponses.get(requestId)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "opt-yes" },
    });
    server.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "migrating" } });
    server.respondPrompt();
    await expect(turn).resolves.toMatchObject({ text: "migrating" });
    adapter.destroy();
  });

  it("still answers an outstanding permission request on the wire when the turn is stopped mid-approval", async () => {
    // The unanswered-server-request family: an ACP session/request_permission
    // that never gets a JSON-RPC response wedges the CLI forever. A /stop while
    // the operator approval is outstanding must still settle the wire request.
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", adapterOptions(harness));
    const controller = new AbortController();
    const approvalStarted = { seen: false };
    const turn = adapter.sendUserMessage("telegram-stopmid", {
      text: "run",
      files: [],
      abortSignal: controller.signal,
      onApprovalRequest: (request) => new Promise((resolve) => {
        approvalStarted.seen = true;
        // Mirror the channels' abort contract: resolve deny when aborted.
        request.abortSignal?.addEventListener("abort", () => resolve({ behavior: "deny" }), { once: true });
      }),
    });
    const turnRejected = expect(turn).rejects.toThrow("Task was stopped by user");
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0].server;
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "bash-stop",
      title: "Bash",
      kind: "execute",
      status: "pending",
      rawInput: { command: "sleep 999" },
    });
    const requestId = server.requestPermission({
      sessionId: server.sessionId,
      toolCall: { toolCallId: "bash-stop", title: "Bash" },
      options: [
        { kind: "allow_once", name: "Approve", optionId: "ok" },
        { kind: "reject_once", name: "Reject", optionId: "no" },
      ],
    });
    await waitFor(() => approvalStarted.seen);
    controller.abort();
    await turnRejected;
    // The wire request MUST have a response (reject/cancel outcome), and the
    // worker must remain usable for the next turn.
    await waitFor(() => server.clientResponses.has(requestId));
    const outcome = (server.clientResponses.get(requestId)?.result as { outcome?: { outcome?: string } })?.outcome?.outcome;
    expect(["selected", "cancelled"]).toContain(outcome);

    const second = adapter.sendUserMessage("kimi-session-1", { text: "again", files: [] });
    await waitFor(() => server.prompts.length === 2);
    server.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "recovered" } });
    server.respondPrompt();
    await expect(second).resolves.toMatchObject({ text: "recovered" });
    adapter.destroy();
  });

  it("unblocks a turn stuck on a hung engine-event handler when stopped, even with timeouts disabled", async () => {
    // eventChain delivery is best-effort. With runtime timeouts disabled, a
    // hung onEngineEvent used to pin pendingTurn forever (every later message
    // bounced off "already has an in-flight turn"); the awaits now race the
    // interruption promise so a soft ACP cancel can unblock them without
    // destroying the reusable worker.
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", { ...adapterOptions(harness), cancelGraceMs: 25 });
    const controller = new AbortController();
    const turn = adapter.sendUserMessage("telegram-hung", {
      text: "run",
      files: [],
      abortSignal: controller.signal,
      disableRuntimeTimeout: true,
      // The initial "session" event must pass (it is awaited before the prompt
      // is sent); only in-turn queued events hang, wedging the event chain.
      onEngineEvent: (event) => event.type === "session"
        ? undefined
        : new Promise<void>(() => {
          // never settles — a wedged downstream consumer (e.g. a dead Lark call)
        }),
    });
    const turnSettled = expect(turn).rejects.toThrow("Task was stopped by user");
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0].server;
    server.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
    server.respondPrompt();
    // The prompt has completed but the turn is now waiting on the hung event
    // chain. Stopping must settle it rather than leaving the session wedged.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await turnSettled;
    adapter.destroy();
  });

  it("stops while the initial session event handler is hung before the ACP prompt starts", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", { ...adapterOptions(harness), cancelGraceMs: 25 });
    const controller = new AbortController();
    let sessionEventStarted = false;
    const turn = adapter.sendUserMessage("telegram-hung-session", {
      text: "run",
      files: [],
      abortSignal: controller.signal,
      disableRuntimeTimeout: true,
      onEngineEvent: (event) => {
        if (event.type !== "session") {
          return undefined;
        }
        sessionEventStarted = true;
        return new Promise<void>(() => {
          // Simulate a wedged downstream session-card delivery.
        });
      },
    });
    await waitFor(() => sessionEventStarted);
    expect(harness.children[0]?.server.prompts).toHaveLength(0);

    controller.abort();
    await expect(settleWithin(turn)).rejects.toThrow("Task was stopped by user");
    expect(harness.killedPids).toHaveLength(0);
    adapter.destroy();
  });

  it("stops while the final result event handler is hung after the ACP prompt completes", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", { ...adapterOptions(harness), cancelGraceMs: 25 });
    const controller = new AbortController();
    let resultEventStarted = false;
    const turn = adapter.sendUserMessage("telegram-hung-result", {
      text: "run",
      files: [],
      abortSignal: controller.signal,
      disableRuntimeTimeout: true,
      onEngineEvent: (event) => {
        if (event.type !== "result") {
          return undefined;
        }
        resultEventStarted = true;
        return new Promise<void>(() => {
          // Simulate a final-card update that never returns.
        });
      },
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0].server;
    server.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
    server.respondPrompt();
    await waitFor(() => resultEventStarted);

    controller.abort();
    await expect(settleWithin(turn)).rejects.toThrow("Task was stopped by user");
    expect(harness.killedPids).toHaveLength(0);
    adapter.destroy();
  });

  it("answers ACP permission denial when both event delivery and the approval callback are hung", async () => {
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", { ...adapterOptions(harness), cancelGraceMs: 25 });
    const controller = new AbortController();
    const turn = adapter.sendUserMessage("telegram-hung-permission", {
      text: "run",
      files: [],
      abortSignal: controller.signal,
      disableRuntimeTimeout: true,
      onEngineEvent: (event) => event.type === "tool_use"
        ? new Promise<void>(() => {
            // Prevent the permission event chain from advancing.
          })
        : undefined,
      onApprovalRequest: () => new Promise(() => {
        // Deliberately ignore the abort signal; the adapter must still deny.
      }),
    });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0].server;
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "bash-hung",
      title: "Bash",
      kind: "execute",
      status: "pending",
      rawInput: { command: "sleep 999" },
    });
    const requestId = server.requestPermission({
      sessionId: server.sessionId,
      toolCall: { toolCallId: "bash-hung", title: "Bash" },
      options: [
        { kind: "allow_once", name: "Approve", optionId: "ok" },
        { kind: "reject_once", name: "Reject", optionId: "no" },
      ],
    });

    controller.abort();
    await expect(settleWithin(turn)).rejects.toThrow("Task was stopped by user");
    await waitFor(() => server.clientResponses.has(requestId));
    expect(server.clientResponses.get(requestId)?.result).toEqual({
      outcome: { outcome: "selected", optionId: "no" },
    });
    expect(harness.killedPids).toHaveLength(0);
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

  it("does not fire the inactivity watchdog while a tool call (e.g. AgentSwarm) is outstanding", async () => {
    // The field incident: a turn fanned out into Kimi's AgentSwarm, whose
    // subagent progress is NOT forwarded to the parent session in 0.31.1. The
    // parent stream was silent for exactly 30 minutes and the watchdog killed
    // the turn one second before the swarm's tool_result landed.
    vi.useFakeTimers();
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", {
      ...adapterOptions(harness),
      turnTimeoutMs: null,
      inactivityTimeoutMs: 60_000,
    });
    const turn = adapter.sendUserMessage("telegram-swarm", { text: "audit the repo", files: [] });
    await waitFor(() => harness.children[0]?.server.prompts.length === 1);
    const server = harness.children[0].server;
    server.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "swarm-1",
      title: "AgentSwarm",
      kind: "other",
      status: "in_progress",
    });

    // Way past the inactivity window with ZERO session updates: the outstanding
    // swarm call must keep the turn alive.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(harness.children[0].server.cancels).toHaveLength(0);

    // The swarm returns; the turn completes normally.
    server.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "swarm-1",
      status: "completed",
    });
    server.sendUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "swarm done" } });
    server.respondPrompt();
    await expect(turn).resolves.toMatchObject({ text: "swarm done" });

    // With NO outstanding tool, silence must still kill a stalled turn.
    const second = adapter.sendUserMessage("kimi-session-1", { text: "again", files: [] });
    const secondRejected = expect(second).rejects.toThrow(/inactive/);
    await waitFor(() => server.prompts.length === 2);
    await vi.advanceTimersByTimeAsync(61_000);
    await secondRejected;
    adapter.destroy();
    vi.useRealTimers();
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
    await waitFor(() => harness.children.length === 1);
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
