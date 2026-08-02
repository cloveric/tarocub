import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
        agentCapabilities: { loadSession: true },
        authMethods: [],
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
  const killedPids: Array<number | undefined> = [];
  const spawnFn: SpawnKimi = (command, args, options) => {
    const index = children.length + 1;
    const child = new FakeKimiChild(700 + index, `kimi-session-${index}`);
    configureServer?.(child.server);
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
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("KimiAcpAdapter", () => {
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
    const adapter = new KimiAcpAdapter("/opt/kimi", {
      ...adapterOptions(harness),
      configPath,
      engineHomePath: root,
      instructionsPath,
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
      expect(promptText(harness.children[0].server)).toBe([
        "[Bridge Instructions]",
        "Always follow the instance instruction.",
        "",
        "Use the Lark delivery contract.",
        "[/Bridge Instructions]",
        "",
        "[User Message]",
        "first",
      ].join("\n"));
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

  it("reloads instance instructions on every turn without restarting the ACP worker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kimi-acp-instructions-test-"));
    const instructionsPath = path.join(root, "agent.md");
    await writeFile(instructionsPath, "Use instruction version one.", "utf8");
    const harness = createHarness();
    const adapter = new KimiAcpAdapter("kimi", { ...adapterOptions(harness), instructionsPath });
    try {
      const first = adapter.sendUserMessage("telegram-59", { text: "first", files: [] });
      await waitFor(() => harness.children[0]?.server.prompts.length === 1);
      expect(promptText(harness.children[0].server)).toContain("Use instruction version one.");
      harness.children[0].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "one" },
      });
      harness.children[0].server.respondPrompt();
      await first;

      await writeFile(instructionsPath, "Use instruction version two.", "utf8");
      const second = adapter.sendUserMessage("kimi-session-1", { text: "second", files: [] });
      await waitFor(() => harness.children[0]?.server.prompts.length === 2);
      expect(promptText(harness.children[0].server, 1)).toContain("Use instruction version two.");
      expect(promptText(harness.children[0].server, 1)).not.toContain("Use instruction version one.");
      expect(harness.children).toHaveLength(1);
      expect(harness.killedPids).toEqual([]);
      harness.children[0].server.sendUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "two" },
      });
      harness.children[0].server.respondPrompt();
      await second;
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
