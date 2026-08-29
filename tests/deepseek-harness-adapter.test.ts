import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  EngineApprovalRequest,
  EngineStreamEvent,
} from "../src/codex/adapter.js";
import {
  DeepSeekHarnessAdapter,
  type DeepSeekHarnessGateway,
} from "../src/codex/deepseek-harness-adapter.js";
import type {
  DeepSeekHarnessProtocolHandlers,
  DeepSeekHarnessServerRequest,
} from "../src/codex/deepseek-harness-protocol.js";

type GatewayCall = { method: string; payload: unknown };
type GatewayResponse = unknown | ((payload: unknown) => unknown | Promise<unknown>);

class FakeGateway extends EventEmitter implements DeepSeekHarnessGateway {
  readonly calls: GatewayCall[] = [];
  readonly responses = new Map<string, GatewayResponse>();
  readonly clientResponses: Array<{ rpcId: string; value: unknown }> = [];
  readonly clientErrors: Array<{
    rpcId: string;
    error: { code: string; message: string; details?: unknown };
  }> = [];
  respondReceipt: { accepted: boolean; reason?: string } = { accepted: true };
  handlers: DeepSeekHarnessProtocolHandlers | undefined;
  closed = false;

  constructor() {
    super();
    this.responses.set("session.create", (payload: unknown) => ({
      sessionId: (payload as { sessionId: string }).sessionId,
      agentPreset: "standard",
    }));
    this.responses.set("session.prompt", { accepted: true });
    this.responses.set("commands/execute", {
      commandId: "command-1",
      result: { kind: "success", text: "ok" },
    });
    this.responses.set("session.cancel", { accepted: true });
    this.responses.set("session.list", { items: [] });
    this.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: -1, values: {} },
    });
    this.responses.set("session.models", {
      current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      routable: true,
      groups: [],
      failures: [],
    });
    this.responses.set("session.selectModel", (payload: unknown) => ({ selected: payload }));
    this.responses.set("goal.create", { ref: { id: "goal-1", revision: 1 } });
    this.responses.set("goal.clear", { cleared: true });
  }

  async connect(handlers: DeepSeekHarnessProtocolHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    this.calls.push({ method, payload });
    const response = this.responses.get(method);
    if (typeof response === "function") {
      return await response(payload);
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  async respond(
    rpcId: string,
    value: unknown,
  ): Promise<{ accepted: boolean; reason?: string }> {
    this.clientResponses.push({ rpcId, value });
    return this.respondReceipt;
  }

  async respondError(
    rpcId: string,
    error: { code: string; message: string; details?: unknown },
  ): Promise<{ accepted: boolean; reason?: string }> {
    this.clientErrors.push({ rpcId, error });
    return this.respondReceipt;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emitMux(payload: Record<string, unknown>, rpcId = `rpc-${Math.random()}`): Promise<void> {
    const frame: DeepSeekHarnessServerRequest = {
      type: "server-request",
      rpcId,
      method: String(payload.type),
      payload: payload as DeepSeekHarnessServerRequest["payload"],
    };
    return Promise.resolve(this.handlers?.onMuxFrame(frame));
  }

  emitSessionEvent(
    sessionId: string,
    type: string,
    data: Record<string, unknown>,
    seq: number,
  ): Promise<void> {
    return this.emitMux({
      type: "session/event",
      sessionId,
      event: { type, seq, time: Date.now(), data },
    });
  }

  emitProjection(sessionId: string, key: string, value: unknown, seq: number): Promise<void> {
    return this.emitMux({
      type: "session/projection",
      sessionId,
      key,
      value,
      seq,
    });
  }

  emitHost(payload: Record<string, unknown>, rpcId = `host-${Math.random()}`): Promise<void> {
    const frame: DeepSeekHarnessServerRequest = {
      type: "server-request",
      rpcId,
      method: String(payload.type),
      payload: payload as DeepSeekHarnessServerRequest["payload"],
    };
    return Promise.resolve(this.handlers?.onHostFrame(frame));
  }
}

function createAdapter(gateway = new FakeGateway(), options: {
  permissionPreset?: "workspace-write" | "full-auto" | "danger-full-access";
  model?: { provider: string; model: string; reasoningEffort?: string };
  configPath?: string;
  goalStatePath?: string;
  turnTimeoutMs?: number | null;
  inactivityTimeoutMs?: number | null;
  backgroundReviewGraceMs?: number;
} = {}) {
  const adapter = new DeepSeekHarnessAdapter({
    gateway,
    workspacePath: "/workspace",
    permissionPreset: options.permissionPreset ?? "workspace-write",
    model: options.model,
    configPath: options.configPath,
    goalStatePath: options.goalStatePath,
    turnSettleDelayMs: 1,
    backgroundReviewGraceMs: options.backgroundReviewGraceMs ?? 50,
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    ...(options.inactivityTimeoutMs !== undefined ? { inactivityTimeoutMs: options.inactivityTimeoutMs } : {}),
  });
  return { adapter, gateway };
}

async function finishTurn(
  gateway: FakeGateway,
  sessionId: string,
  turn: number,
  firstSeq: number,
  text: string,
): Promise<void> {
  gateway.emitSessionEvent(sessionId, "turn/start", { turn }, firstSeq);
  gateway.emitSessionEvent(sessionId, "assistant/chunk", {
    turn,
    step: 1,
    chunk: { type: "text-delta", index: 0, text },
  }, firstSeq + 1);
  gateway.emitSessionEvent(sessionId, "turn/end", { turn, reason: completedReason() }, firstSeq + 2);
}

async function waitForCall(gateway: FakeGateway, method: string, count = 1): Promise<void> {
  await vi.waitFor(() => {
    expect(gateway.calls.filter((call) => call.method === method)).toHaveLength(count);
  });
}

function completedReason(): { kind: "completed" } {
  return { kind: "completed" };
}

describe("DeepSeekHarnessAdapter", () => {
  it("cancels and rejects a DeepSeek turn that exceeds the hard runtime timeout", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, gateway } = createAdapter(undefined, {
        turnTimeoutMs: 60_000,
        inactivityTimeoutMs: null,
      });
      const { sessionId } = await adapter.createSession(1);
      const turn = adapter.sendUserMessage(sessionId, { text: "keep working", files: [] });
      const rejected = expect(turn).rejects.toThrow("DeepSeek Harness turn timed out after 1 minute");
      await waitForCall(gateway, "session.prompt", 1);

      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(gateway.calls).toContainEqual({ method: "session.cancel", payload: { sessionId } });
      await adapter.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the inactivity watchdog on activity and honors /timeout off", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, gateway } = createAdapter(undefined, {
        turnTimeoutMs: null,
        inactivityTimeoutMs: 60_000,
      });
      const { sessionId } = await adapter.createSession(2);
      const turn = adapter.sendUserMessage(sessionId, { text: "stream slowly", files: [] });
      const rejected = expect(turn).rejects.toThrow("DeepSeek Harness turn became inactive after 1 minute");
      await waitForCall(gateway, "session.prompt", 1);

      await vi.advanceTimersByTimeAsync(45_000);
      gateway.emitSessionEvent(sessionId, "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", index: 0, text: "still active" },
      }, 1);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(gateway.calls.filter((call) => call.method === "session.cancel")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;

      const disabled = adapter.sendUserMessage(sessionId, {
        text: "intentionally long",
        files: [],
        disableRuntimeTimeout: true,
      });
    await waitForCall(gateway, "session.prompt", 1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(gateway.calls.filter((call) => call.method === "session.cancel")).toHaveLength(1);
      gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 2);
      gateway.emitSessionEvent(sessionId, "assistant/chunk", {
        turn: 2,
        step: 1,
        chunk: { type: "text-delta", index: 0, text: "finished" },
      }, 3);
      gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 4);
      await vi.advanceTimersByTimeAsync(1);
      await expect(disabled).resolves.toMatchObject({ text: "finished" });
      await adapter.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not declare inactivity while a DeepSeek tool call is outstanding", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, gateway } = createAdapter(undefined, {
        turnTimeoutMs: null,
        inactivityTimeoutMs: 60_000,
      });
      const { sessionId } = await adapter.createSession(3);
      const turn = adapter.sendUserMessage(sessionId, { text: "run a long tool", files: [] });
      await waitForCall(gateway, "session.prompt", 1);
      gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
      gateway.emitSessionEvent(sessionId, "tool/call", {
        turn: 1,
        step: 1,
        callId: "tool-1",
        name: "long_tool",
        arguments: "{}",
      }, 2);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(gateway.calls.filter((call) => call.method === "session.cancel")).toHaveLength(0);
      gateway.emitSessionEvent(sessionId, "tool/result", {
        turn: 1,
        step: 1,
        message: {
          source: { callId: "tool-1" },
          content: [{ type: "text", text: "done" }],
        },
      }, 3);
      gateway.emitSessionEvent(sessionId, "assistant/chunk", {
        turn: 1,
        step: 2,
        chunk: { type: "text-delta", index: 0, text: "complete" },
      }, 4);
      gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 5);
      await vi.advanceTimersByTimeAsync(1);
      await expect(turn).resolves.toMatchObject({ text: "complete" });
      await adapter.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects on timeout even when the event delivery callback never settles", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, gateway } = createAdapter(undefined, {
        turnTimeoutMs: null,
        inactivityTimeoutMs: 60_000,
      });
      const { sessionId } = await adapter.createSession(4);
      let outcome: string | undefined;
      const eventStarted = vi.fn();
      const turn = adapter.sendUserMessage(sessionId, {
        text: "do not let a stuck card update hold the turn open",
        files: [],
        onEngineEvent: () => {
          eventStarted();
          return new Promise<void>(() => {});
        },
      });
      void turn.then(
        () => { outcome = "resolved"; },
        (error: unknown) => { outcome = error instanceof Error ? error.message : String(error); },
      );
      await vi.waitFor(() => expect(eventStarted).toHaveBeenCalledTimes(1));
      expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();

      expect(outcome).toBe("DeepSeek Harness turn became inactive after 1 minute");
      expect(gateway.calls).toContainEqual({ method: "session.cancel", payload: { sessionId } });
      await adapter.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates a durable standard session and applies the configured permission preset", async () => {
    const { adapter, gateway } = createAdapter(undefined, { permissionPreset: "full-auto" });

    const session = await adapter.createSession(12345);
    expect(session.sessionId).toMatch(/^session-/);
    expect(gateway.calls[0]).toEqual({
      method: "session.create",
      payload: {
        sessionId: session.sessionId,
        cwd: "/workspace",
        agentPreset: "standard",
      },
    });

    const turn = adapter.sendUserMessage(session.sessionId, { text: "Hello", files: [] });
    await waitForCall(gateway, "session.prompt", 1);
    expect(gateway.calls).toContainEqual({
      method: "commands/execute",
      payload: {
        args: {
          agentId: session.sessionId,
          line: "/permission full-auto",
          images: [],
        },
      },
    });
    const prompts = gateway.calls.filter((call) => call.method === "session.prompt");
    expect(prompts[0]?.payload).toMatchObject({
      sessionId: session.sessionId,
      mode: "queue",
      content: [{ type: "text", text: expect.stringContaining("Hello") }],
    });

    gateway.emitSessionEvent(session.sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(session.sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Hi" },
    }, 2);
    gateway.emitSessionEvent(session.sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 3);

    await expect(turn).resolves.toMatchObject({ text: "Hi", sessionId: session.sessionId });
    await adapter.destroy();
    expect(gateway.closed).toBe(true);
  });

  it("encodes image attachments as Harness image content and keeps non-images as paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-images-"));
    const imagePath = path.join(root, "sample.png");
    const textPath = path.join(root, "notes.txt");
    const imageBytes = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(imagePath, imageBytes);
    await writeFile(textPath, "notes", "utf8");

    try {
      const { adapter, gateway } = createAdapter();
      const { sessionId } = await adapter.createSession(12346);
      const turn = adapter.sendUserMessage(sessionId, {
        text: "Inspect both attachments",
        files: [imagePath, textPath],
      });
      await waitForCall(gateway, "session.prompt", 1);

      expect(gateway.calls.find((call) => call.method === "session.prompt")?.payload).toEqual({
        sessionId,
        mode: "queue",
        content: [
          {
            type: "text",
            text: expect.stringContaining(`Attachment: ${textPath}`),
          },
          {
            type: "image",
            mediaType: "image/png",
            data: imageBytes.toString("base64"),
            name: "sample.png",
          },
        ],
        clientTimeZone: "Asia/Shanghai",
      });

      await finishTurn(gateway, sessionId, 1, 1, "Inspected");
      await expect(turn).resolves.toMatchObject({ text: "Inspected" });
      await adapter.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases the single-writer claim after Harness rejects a prompt", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(12347);
    gateway.responses.set("session.prompt", new Error("MODEL_DOES_NOT_SUPPORT_IMAGES"));

    await expect(adapter.sendUserMessage(sessionId, {
      text: "Inspect this image",
      files: [],
    })).rejects.toThrow("MODEL_DOES_NOT_SUPPORT_IMAGES");

    gateway.responses.set("session.prompt", { accepted: true });
    const retry = adapter.sendUserMessage(sessionId, { text: "Continue without it", files: [] });
    await waitForCall(gateway, "session.prompt", 2);
    await finishTurn(gateway, sessionId, 1, 1, "Recovered");
    await expect(retry).resolves.toMatchObject({ text: "Recovered" });
    await adapter.destroy();
  });

  it("rejects a known session when a later turn claims a different workspace", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(12348);
    gateway.responses.set("session.prompt", new Error("prompt must not be sent"));

    await expect(adapter.sendUserMessage(sessionId, {
      text: "Use another project",
      files: [],
      workspaceOverride: "/other-workspace",
    })).rejects.toThrow(
      `DeepSeek Harness session ${sessionId} belongs to /workspace, not /other-workspace`,
    );
    expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(0);
    await adapter.destroy();
  });

  it("executes /compact as a Harness command instead of exposing it to the model", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(1);
    gateway.responses.set("commands/execute", (payload: unknown) => {
      const line = ((payload as { args?: { line?: string } }).args?.line ?? "");
      return {
        commandId: `command-${line}`,
        result: { kind: "success", text: line === "/compact" ? "Compacted" : "Configured" },
      };
    });

    await expect(adapter.sendUserMessage(sessionId, { text: "/compact", files: [] }))
      .resolves.toMatchObject({ sessionId, text: "Compacted" });
    expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(0);
    expect(gateway.calls.filter((call) => call.method === "commands/execute")).toEqual([
      {
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/permission workspace-write", images: [] } },
      },
      {
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/compact", images: [] } },
      },
    ]);
  });

  it("fails closed when Harness does not recognize a required command", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(1);
    gateway.responses.set("commands/execute", undefined);

    await expect(adapter.sendUserMessage(sessionId, { text: "Hello", files: [] }))
      .rejects.toThrow("did not recognize /permission workspace-write");
    expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(0);
  });

  it("reloads permission, model, and effort between turns and restores the Harness default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-runtime-config-"));
    const configPath = path.join(root, "config.json");
    const gateway = new FakeGateway();
    const baseline = {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    };
    let current = { ...baseline };
    const groups = [{
      id: "deepseek-official",
      name: "DeepSeek",
      models: [
        { id: "deepseek-v4-flash", name: "Flash", reasoning: { efforts: [], defaultEffort: "high" } },
        { id: "deepseek-v4-pro", name: "Pro", reasoning: { efforts: [], defaultEffort: "high" } },
      ],
    }, {
      id: "openai",
      name: "OpenAI",
      models: [{ id: "gpt-5", name: "GPT-5", reasoning: { efforts: [], defaultEffort: "medium" } }],
    }];
    gateway.responses.set("settings.describe", {
      writable: true,
      hasDocument: true,
      namespaces: [{
        ns: "agent-default-model",
        value: baseline,
        schema: {},
        applies: "live",
        secrets: [],
        revision: 0,
      }],
    });
    gateway.responses.set("session.models", () => ({ current: { ...current }, routable: true, groups, failures: [] }));
    gateway.responses.set("session.selectModel", (payload: unknown) => {
      const selection = payload as typeof current & { sessionId: string };
      current = {
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      };
      return { selected: { ...current } };
    });

    try {
      await writeFile(configPath, JSON.stringify({
        engine: "deepseek",
        approvalMode: "normal",
        model: "deepseek-official/deepseek-v4-pro",
        effort: "max",
      }), "utf8");
      const { adapter } = createAdapter(gateway, { configPath });
      const { sessionId } = await adapter.createSession(123);

      const first = adapter.sendUserMessage(sessionId, { text: "first", files: [] });
      await waitForCall(gateway, "session.selectModel", 1);
      expect(gateway.calls).toContainEqual({
        method: "session.selectModel",
        payload: { sessionId, provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" },
      });
      expect(gateway.calls).toContainEqual({
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/permission workspace-write", images: [] } },
      });
      await finishTurn(gateway, sessionId, 1, 1, "one");
      await expect(first).resolves.toMatchObject({ text: "one" });

      await writeFile(configPath, JSON.stringify({
        engine: "deepseek",
        approvalMode: "full-auto",
        model: "openai/gpt-5",
        effort: "medium",
      }), "utf8");
      const second = adapter.sendUserMessage(sessionId, { text: "second", files: [] });
      await waitForCall(gateway, "session.selectModel", 2);
      expect(gateway.calls).toContainEqual({
        method: "session.selectModel",
        payload: { sessionId, provider: "openai", model: "gpt-5", reasoningEffort: "medium" },
      });
      expect(gateway.calls).toContainEqual({
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/permission full-auto", images: [] } },
      });
      await finishTurn(gateway, sessionId, 2, 4, "two");
      await expect(second).resolves.toMatchObject({ text: "two" });

      await writeFile(configPath, JSON.stringify({ engine: "deepseek", approvalMode: "bypass" }), "utf8");
      const third = adapter.sendUserMessage(sessionId, { text: "third", files: [] });
      await waitForCall(gateway, "session.selectModel", 3);
      expect(gateway.calls).toContainEqual({
        method: "session.selectModel",
        payload: { sessionId, ...baseline },
      });
      expect(gateway.calls).toContainEqual({
        method: "commands/execute",
        payload: { args: { agentId: sessionId, line: "/permission danger-full-access", images: [] } },
      });
      await finishTurn(gateway, sessionId, 3, 7, "three");
      await expect(third).resolves.toMatchObject({ text: "three" });

      await adapter.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams reasoning, text, correlated tool calls/results, and disjoint usage once", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(1);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Inspect",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "reasoning-delta", index: 0, text: "checking" },
    }, 2);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 1, text: "Found " },
    }, 3);
    gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "bash",
      arguments: "{\"command\":\"pwd\"}",
    }, 4);
    gateway.emitSessionEvent(sessionId, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        id: "tool-message-1",
        role: "user",
        source: { kind: "tool", callId: "call-1" },
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          content: [{ type: "text", text: "/workspace" }],
        }],
      },
    }, 5);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "text-delta", index: 0, text: "it." },
    }, 6);
    gateway.emitSessionEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 2,
      message: {
        id: "assistant-1",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
        content: [{ type: "text", text: "it." }],
      },
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 4,
        reasoningTokens: 7,
      },
    }, 7);
    gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 8);

    await expect(turn).resolves.toEqual({
      text: "it.",
      sessionId,
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 34 },
    });
    expect(events).toEqual(expect.arrayContaining([
      { type: "session", sessionId },
      { type: "thinking", text: "checking", sessionId },
      { type: "assistant_text", text: "Found ", delta: true, sessionId },
      {
        type: "tool_use",
        toolName: "bash",
        toolInput: { command: "pwd" },
        toolUseId: "call-1",
        sessionId,
      },
      {
        type: "tool_result",
        toolName: "bash",
        toolUseId: "call-1",
        output: "/workspace",
        isError: false,
        sessionId,
      },
      { type: "result", text: "it.", sessionId },
    ]));
    expect(events.filter((event) => event.type === "assistant_text").map((event) => event.text)).toEqual([
      "Found ",
      "it.",
    ]);
  });

  it("keeps finalized reasoning out of the reply without replaying streamed thinking", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(2);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Verify a rumor",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "reasoning-delta", index: 0, text: "private analysis" },
    }, 2);
    await gateway.emitSessionEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "assistant-mixed-content",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
        content: [
          { type: "reasoning", text: "private analysis" },
          { type: "text", text: "Verified public answer" },
        ],
      },
    }, 3);
    await gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 4);

    await expect(turn).resolves.toMatchObject({ text: "Verified public answer", sessionId });
    expect(events.filter((event) => event.type === "thinking")).toEqual([
      { type: "thinking", text: "private analysis", sessionId },
    ]);
    expect(events.filter((event) => event.type === "assistant_text")).toEqual([
      { type: "assistant_text", text: "Verified public answer", sessionId },
    ]);
    expect(events.filter((event) => event.type === "result")).toEqual([
      { type: "result", text: "Verified public answer", sessionId },
    ]);
  });

  it("keeps tool-step narration in progress events but out of the final reply", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(2);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Generate and deliver images",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    const progressText = "I will validate the generated images first.";
    const finalText = [
      "The images are ready.",
      "```tool-call",
      '{"name":"send.batch","payload":{"images":[{"path":"/workspace/p1.png","caption":"P1 cover"}]}}',
      "```",
    ].join("\n");

    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: progressText },
    }, 2);
    await gateway.emitSessionEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "assistant-tool-step",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
        content: [
          { type: "text", text: progressText },
          { type: "tool-call", toolCallId: "call-1", name: "read_image", arguments: "{}" },
        ],
      },
    }, 3);
    await gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-1",
      name: "read_image",
      arguments: "{}",
    }, 4);
    await gateway.emitSessionEvent(sessionId, "tool/result", {
      turn: 1,
      step: 1,
      message: {
        id: "tool-message-1",
        role: "user",
        source: { kind: "tool", callId: "call-1" },
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          content: [{ type: "text", text: "valid" }],
        }],
      },
    }, 5);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "text-delta", index: 0, text: finalText },
    }, 6);
    await gateway.emitSessionEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 2,
      message: {
        id: "assistant-final",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
        content: [{ type: "text", text: finalText }],
      },
    }, 7);
    await gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 8);

    await expect(turn).resolves.toMatchObject({ text: finalText, sessionId });
    expect(events.filter((event) => event.type === "assistant_text")).toEqual([
      { type: "assistant_text", text: progressText, delta: true, sessionId },
      { type: "assistant_text", text: finalText, delta: true, sessionId },
    ]);
    expect(events.filter((event) => event.type === "result")).toEqual([
      { type: "result", text: finalText, sessionId },
    ]);
  });

  it("keeps the user turn open through background completion and the automatic review turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(2);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Run in background",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "bash-1",
        kind: "bash",
        label: "sleep 1; echo done",
        status: "running",
        startedAt: Date.now(),
      }],
    });
    gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 2);

    let settled = false;
    void turn.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "bash-1",
        kind: "bash",
        label: "sleep 1; echo done",
        status: "completed",
        detail: "exit code: 0",
        startedAt: Date.now() - 1_000,
        finishedAt: Date.now(),
      }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 3);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Background result: done" },
    }, 4);
    gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 2,
      reason: completedReason(),
    }, 5);

    await expect(turn).resolves.toMatchObject({ text: "Background result: done", sessionId });
    expect(events).toEqual(expect.arrayContaining([
      {
        type: "background_task_started",
        taskId: "bash-1",
        description: "sleep 1; echo done",
        sessionId,
      },
      {
        type: "background_task_finished",
        taskId: "bash-1",
        status: "completed",
        summary: "exit code: 0",
        sessionId,
      },
    ]));
  });

  it("emits one final result when a completed job snapshot arrives during card delivery", async () => {
    const { adapter, gateway } = createAdapter(undefined, { backgroundReviewGraceMs: 5 });
    const { sessionId } = await adapter.createSession(18);
    let releaseResult!: () => void;
    const blockedResult = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const resultEvents = vi.fn();
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Wait for the background job",
      files: [],
      onEngineEvent: (event) => {
        if (event.type === "result") {
          resultEvents();
          return blockedResult;
        }
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      source: { kind: "user" },
    }, 2);
    await gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "job-1",
        kind: "process",
        label: "Worker",
        status: "running",
        startedAt: Date.now(),
      }],
    });
    await gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: completedReason(),
    }, 3);
    const completedJobs = {
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "job-1",
        kind: "process",
        label: "Worker",
        status: "completed",
        startedAt: Date.now() - 100,
        finishedAt: Date.now(),
      }],
    };
    await gateway.emitMux(completedJobs);
    await vi.waitFor(() => expect(resultEvents).toHaveBeenCalledTimes(1));

    await gateway.emitMux(completedJobs);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resultEvents).toHaveBeenCalledTimes(1);

    releaseResult();
    await expect(turn).resolves.toMatchObject({ sessionId });
    await adapter.destroy();
  });

  it("maps one-shot and session approvals and reuses a session grant", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(3);
    const approvals: EngineApprovalRequest[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Write",
      files: [],
      onApprovalRequest: async (request) => {
        approvals.push(request);
        return { behavior: "allow", scope: "session" };
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "call-edit-1",
      name: "edit",
      arguments: "{\"path\":\"a.ts\"}",
    }, 2);
    gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "approval-1",
      callId: "call-edit-1",
      toolName: "edit",
      reason: "write outside current patch",
    }, "approval-rpc-1");
    await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(1));
    expect(approvals).toEqual([{
      engine: "deepseek",
      toolName: "edit",
      toolInput: { path: "a.ts" },
      cwd: "/workspace",
      sessionId,
      abortSignal: expect.any(AbortSignal),
    }]);
    expect(gateway.clientResponses[0]).toEqual({
      rpcId: "approval-rpc-1",
      value: { sessionId, approvalId: "approval-1", outcome: "allowed-once" },
    });

    gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 2,
      callId: "call-edit-2",
      name: "edit",
      arguments: "{\"path\":\"b.ts\"}",
    }, 3);
    gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "approval-2",
      callId: "call-edit-2",
      toolName: "edit",
    }, "approval-rpc-2");
    await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(2));
    expect(approvals).toHaveLength(1);
    expect(gateway.clientResponses[1]).toMatchObject({
      rpcId: "approval-rpc-2",
      value: { outcome: "allowed-once" },
    });

    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 3,
      chunk: { type: "text-delta", index: 0, text: "Edited" },
    }, 4);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 5);
    await expect(turn).resolves.toMatchObject({ text: "Edited" });
  });

  it("fails a broken approval UI closed without leaving Harness waiting", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(30);
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Write safely",
      files: [],
      onApprovalRequest: async () => {
        throw new Error("approval card failed");
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "approval-ui-failure",
      toolName: "write",
    }, "approval-ui-failure-rpc");

    expect(gateway.clientResponses).toContainEqual({
      rpcId: "approval-ui-failure-rpc",
      value: {
        sessionId,
        approvalId: "approval-ui-failure",
        outcome: "rejected",
      },
    });
    await finishTurn(gateway, sessionId, 1, 2, "Denied safely");
    await expect(turn).resolves.toMatchObject({ text: "Denied safely" });
  });

  it("rejects malformed approval and question requests instead of leaving Harness waiting", async () => {
    const { adapter, gateway } = createAdapter();
    await adapter.createSession(33);

    await gateway.emitMux({
      type: "approval/requested",
      sessionId: "missing-approval-fields",
    }, "malformed-approval-rpc");
    await gateway.emitMux({
      type: "question/requested",
      sessionId: "partial-question-list",
      questions: [
        { id: "valid", question: "Valid?" },
        { id: "missing-question-text" },
      ],
    }, "malformed-question-rpc");

    expect(gateway.clientErrors).toEqual([
      {
        rpcId: "malformed-approval-rpc",
        error: {
          code: "invalid-request",
          message: "Malformed DeepSeek Harness approval request",
        },
      },
      {
        rpcId: "malformed-question-rpc",
        error: {
          code: "invalid-request",
          message: "Malformed DeepSeek Harness question request",
        },
      },
    ]);
  });

  it("rejects a pending Harness approval even when the foreground turn is aborted", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(31);
    const controller = new AbortController();
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Wait for approval",
      files: [],
      abortSignal: controller.signal,
      onApprovalRequest: async () => await new Promise(() => {}),
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    const approval = gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "approval-aborted",
      toolName: "write",
    }, "approval-aborted-rpc");
    controller.abort();

    await approval;
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(gateway.clientResponses).toContainEqual({
      rpcId: "approval-aborted-rpc",
      value: {
        sessionId,
        approvalId: "approval-aborted",
        outcome: "rejected",
      },
    });
  });

  it("does not cache a session grant unless Harness accepts the approval response", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(32);
    let approvalCount = 0;
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Write twice",
      files: [],
      onApprovalRequest: async () => {
        approvalCount += 1;
        return { behavior: "allow", scope: "session" };
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.respondReceipt = { accepted: false, reason: "not-pending" };
    await gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "stale-approval",
      toolName: "write",
    }, "stale-approval-rpc");

    gateway.respondReceipt = { accepted: true };
    await gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "live-approval",
      toolName: "write",
    }, "live-approval-rpc");

    expect(approvalCount).toBe(2);
    await finishTurn(gateway, sessionId, 1, 2, "Done");
    await expect(turn).resolves.toMatchObject({ text: "Done" });
  });

  it("converts Feishu-style question answers back to Harness question ids", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(4);
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Ask me",
      files: [],
      onApprovalRequest: async (request) => {
        expect(request.engine).toBe("deepseek");
        expect(request.toolName).toBe("AskUserQuestion");
        return {
          behavior: "allow",
          updatedInput: {
            answers: {
              "Choose a mode": "Safe",
              "Pick tags": "One, Two",
            },
          },
        };
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitMux({
      type: "question/requested",
      sessionId,
      questions: [
        {
          id: "mode",
          question: "Choose a mode",
          options: [{ label: "Safe" }, { label: "Fast" }],
        },
        {
          id: "tags",
          question: "Pick tags",
          options: [{ label: "One" }, { label: "Two" }, { label: "Three" }],
          multiSelect: true,
        },
      ],
    }, "question-rpc");

    await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(1));
    expect(gateway.clientResponses[0]).toEqual({
      rpcId: "question-rpc",
      value: {
        sessionId,
        answer: {
          answers: [
            { id: "mode", selected: ["Safe"] },
            { id: "tags", selected: ["One", "Two"] },
          ],
        },
      },
    });
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "text-delta", index: 0, text: "Thanks" },
    }, 2);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 3);
    await expect(turn).resolves.toMatchObject({ text: "Thanks" });
  });

  it("answers a broken question UI with an explicit empty Harness answer", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(33);
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Ask safely",
      files: [],
      onApprovalRequest: async () => {
        throw new Error("question card failed");
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitMux({
      type: "question/requested",
      sessionId,
      questions: [{
        id: "choice",
        question: "Choose",
        options: [{ label: "A" }, { label: "B" }],
      }],
    }, "question-ui-failure-rpc");

    expect(gateway.clientResponses).toContainEqual({
      rpcId: "question-ui-failure-rpc",
      value: {
        sessionId,
        answer: { answers: [{ id: "choice", selected: [] }] },
      },
    });
    await finishTurn(gateway, sessionId, 1, 2, "Continued");
    await expect(turn).resolves.toMatchObject({ text: "Continued" });
  });

  it("cancels an active turn on abort and never leaves its writer slot occupied", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(5);
    const controller = new AbortController();
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Long task",
      files: [],
      abortSignal: controller.signal,
    });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    controller.abort();

    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(gateway.calls).toContainEqual({
      method: "session.cancel",
      payload: { sessionId },
    });

    const second = adapter.sendUserMessage(sessionId, { text: "Next", files: [] });
    await waitForCall(gateway, "session.prompt", 2);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 2);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Recovered" },
    }, 3);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 4);
    await expect(second).resolves.toMatchObject({ text: "Recovered" });
  });

  it("honors an abort that arrives while the Harness session is being created", async () => {
    const { adapter, gateway } = createAdapter();
    let resolveCreate!: (value: { sessionId: string; agentPreset: string }) => void;
    gateway.responses.set("session.create", () => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    gateway.responses.set("session.prompt", {
      command: { kind: "success", text: "should not run" },
    });
    const controller = new AbortController();
    const sessionId = "session-aborted-during-create";

    const turn = adapter.sendUserMessage(sessionId, {
      text: "Do not start this turn",
      files: [],
      abortSignal: controller.signal,
    });
    await waitForCall(gateway, "session.create", 1);
    controller.abort();
    resolveCreate({ sessionId, agentPreset: "standard" });

    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(gateway.calls.filter((call) => call.method === "session.prompt")).toHaveLength(0);
  });

  it("does not let a late aborted turn end cancel the replacement foreground turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(5);
    const controller = new AbortController();
    const first = adapter.sendUserMessage(sessionId, {
      text: "Long task",
      files: [],
      abortSignal: controller.signal,
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "old-call",
      name: "bash",
      arguments: JSON.stringify({ command: "sleep 30" }),
    }, 2);
    await gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "old-job",
        kind: "bash",
        label: "sleep 30",
        status: "running",
        startedAt: Date.now(),
      }],
    });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const replacementApprovals: EngineApprovalRequest[] = [];
    const replacementEvents: EngineStreamEvent[] = [];
    const replacement = adapter.sendUserMessage(sessionId, {
      text: "Replacement",
      files: [],
      onApprovalRequest: async (request) => {
        replacementApprovals.push(request);
        return { behavior: "allow" };
      },
      onEngineEvent: (event) => {
        replacementEvents.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 2);

    await gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "old-approval",
      callId: "old-call",
      toolName: "bash",
    }, "old-approval-rpc");
    await gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "old-job",
        kind: "bash",
        label: "sleep 30",
        status: "killed",
        startedAt: Date.now() - 100,
        finishedAt: Date.now(),
      }],
    });
    expect(replacementApprovals).toHaveLength(0);
    expect(replacementEvents.some((event) => event.type === "background_task_finished")).toBe(false);
    expect(gateway.clientResponses).toContainEqual({
      rpcId: "old-approval-rpc",
      value: {
        sessionId,
        approvalId: "old-approval",
        outcome: "rejected",
      },
    });

    // Harness cancellation is asynchronous. The old terminal frame can arrive
    // after the bridge has released the writer and admitted the next turn.
    await gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 1,
      reason: { kind: "aborted" },
    }, 3);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 4);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Replacement survived" },
    }, 5);
    await gateway.emitSessionEvent(sessionId, "turn/end", {
      turn: 2,
      reason: completedReason(),
    }, 6);

    await expect(replacement).resolves.toMatchObject({ text: "Replacement survived" });
  });

  it("steers an active turn, configures model effort, and lists resumable sessions", async () => {
    const { adapter, gateway } = createAdapter(undefined, {
      model: {
        provider: "deepseek-official",
        model: "deepseek-v4",
        reasoningEffort: "high",
      },
    });
    gateway.responses.set("session.list", {
      items: [{
        sessionId: "session-existing",
        cwd: "/workspace",
        updatedAt: 1_787_000_000_000,
        running: false,
        blank: false,
        projections: {
          asOfSeq: 5,
          values: { title: { title: "Existing work" } },
        },
      }],
    });
    const { sessionId } = await adapter.createSession(6);
    const turn = adapter.sendUserMessage(sessionId, { text: "Start", files: [] });
    await waitForCall(gateway, "session.prompt", 1);
    expect(gateway.calls).toContainEqual({
      method: "session.selectModel",
      payload: {
        sessionId,
        provider: "deepseek-official",
        model: "deepseek-v4",
        reasoningEffort: "high",
      },
    });
    await expect(adapter.steerActiveTurn(sessionId, { text: "Use the other file" })).resolves.toBe(true);
    expect(gateway.calls.at(-1)).toEqual({
      method: "session.prompt",
      payload: {
        sessionId,
        mode: "steer",
        content: [{ type: "text", text: "Use the other file" }],
        clientTimeZone: "Asia/Shanghai",
      },
    });
    await expect(adapter.listExternalSessions({ cwd: "/workspace", limit: 10 })).resolves.toEqual([{
      sessionId: "session-existing",
      cwd: "/workspace",
      title: "Existing work",
      updatedAt: new Date(1_787_000_000_000).toISOString(),
    }]);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Done" },
    }, 2);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 3);
    await expect(turn).resolves.toMatchObject({ text: "Done" });
  });

  it("fails closed when a resumed session is absent from the authoritative session list", async () => {
    const { adapter, gateway } = createAdapter();
    gateway.responses.set("session.list", { items: [] });
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
    });

    await expect(adapter.validateExternalSession("unlisted-session", {
      workspaceOverride: "/workspace",
    })).rejects.toThrow("not present in session.list");
    expect(gateway.calls.some((call) => call.method === "session.history")).toBe(false);
  });

  it("rejects a listed resumed session whose workspace cannot be verified", async () => {
    const { adapter, gateway } = createAdapter();
    gateway.responses.set("session.list", {
      items: [{
        sessionId: "cwd-less-session",
        updatedAt: 1_787_000_000_000,
        running: false,
        blank: false,
      }],
    });

    await expect(adapter.validateExternalSession("cwd-less-session", {
      workspaceOverride: "/workspace",
    })).rejects.toThrow("has no verifiable workspace");
  });

  it("maps native goal projections and clears with the current CAS reference", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(7);
    const projection = {
      goal: {
        id: "goal-1",
        revision: 1,
        objective: "Finish parity",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 2,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_010_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: {
        asOfSeq: 10,
        values: {
          goal: projection,
          tokenUsage: {
            uncachedInputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 5,
          },
        },
      },
    });

    await expect(adapter.setThreadGoal(sessionId, {
      objective: "Finish parity",
      tokenBudget: 1_000,
    })).resolves.toMatchObject({
      sessionId,
      goal: {
        threadId: sessionId,
        objective: "Finish parity",
        status: "active",
        tokenBudget: 1_000,
        tokensUsed: 0,
      },
    });
    expect(gateway.calls).toContainEqual({
      method: "goal.create",
      payload: { sessionId, objective: "Finish parity" },
    });

    await expect(adapter.clearThreadGoal(sessionId)).resolves.toEqual({ cleared: true, sessionId });
    expect(gateway.calls.at(-1)).toEqual({
      method: "goal.clear",
      payload: { sessionId, ref: { id: "goal-1", revision: 1 } },
    });
  });

  it("pauses an active goal when goal-local usage reaches its token budget", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(19);
    const oldGoal = {
      goal: {
        id: "goal-old-budget",
        revision: 2,
        objective: "Old work",
        phase: "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 2,
      createdAt: 1_786_000_000_000,
      updatedAt: 1_786_000_100_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: {
        asOfSeq: 10,
        values: {
          goal: oldGoal,
          tokenUsage: {
            uncachedInputTokens: 800,
            outputTokens: 100,
            cacheReadTokens: 75,
            cacheWriteTokens: 25,
          },
        },
      },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-budget", revision: 1 } });
    gateway.responses.set("goal.pause", { ref: { id: "goal-budget", revision: 2 } });
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Budgeted work",
      tokenBudget: 100,
    });
    await waitForCall(gateway, "goal.create");
    await gateway.emitProjection(sessionId, "goal", {
      goal: {
        id: "goal-budget",
        revision: 1,
        objective: "Budgeted work",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    }, 11);
    await gateway.emitProjection(sessionId, "tokenUsage", {
      uncachedInputTokens: 880,
      outputTokens: 120,
      cacheReadTokens: 80,
      cacheWriteTokens: 40,
    }, 12);

    await waitForCall(gateway, "goal.pause");
    expect(gateway.calls.find((call) => call.method === "goal.pause")).toEqual({
      method: "goal.pause",
      payload: {
        sessionId,
        ref: { id: "goal-budget", revision: 1 },
      },
    });
    await expect(watch).resolves.toMatchObject({
      goal: {
        objective: "Budgeted work",
        status: "budgetLimited",
        tokenBudget: 100,
        tokensUsed: 120,
      },
    });
  });

  it("restores a goal budget baseline after the adapter process restarts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deepseek-goal-state-"));
    try {
      const goalStatePath = path.join(dir, "goals.json");
      const first = createAdapter(undefined, { goalStatePath });
      const { sessionId } = await first.adapter.createSession(20);
      let firstHistoryCall = true;
      first.gateway.responses.set("session.history", () => {
        if (firstHistoryCall) {
          firstHistoryCall = false;
          return {
            events: [],
            hasMore: false,
            projections: {
              asOfSeq: 5,
              values: {
                tokenUsage: {
                  uncachedInputTokens: 400,
                  outputTokens: 50,
                  cacheReadTokens: 25,
                  cacheWriteTokens: 25,
                },
              },
            },
          };
        }
        return {
          events: [],
          hasMore: false,
          projections: {
            asOfSeq: 6,
            values: {
              goal: {
                goal: {
                  id: "goal-persisted",
                  revision: 1,
                  objective: "Persistent work",
                  phase: "active",
                  maxGoalRounds: 50,
                },
                roundsStarted: 0,
                createdAt: 1_787_000_000_000,
                updatedAt: 1_787_000_000_000,
              },
              tokenUsage: {
                uncachedInputTokens: 400,
                outputTokens: 50,
                cacheReadTokens: 25,
                cacheWriteTokens: 25,
              },
            },
          },
        };
      });
      first.gateway.responses.set("goal.create", { ref: { id: "goal-persisted", revision: 1 } });
      await first.adapter.setThreadGoal(sessionId, {
        objective: "Persistent work",
        tokenBudget: 500,
      });
      await first.adapter.destroy();

      const second = createAdapter(undefined, { goalStatePath });
      second.gateway.responses.set("session.history", {
        events: [],
        hasMore: false,
        projections: {
          asOfSeq: 7,
          values: {
            goal: {
              goal: {
                id: "goal-persisted",
                revision: 1,
                objective: "Persistent work",
                phase: "active",
                maxGoalRounds: 50,
              },
              roundsStarted: 1,
              createdAt: 1_787_000_000_000,
              updatedAt: 1_787_000_001_000,
            },
            tokenUsage: {
              uncachedInputTokens: 420,
              outputTokens: 55,
              cacheReadTokens: 30,
              cacheWriteTokens: 25,
            },
          },
        },
      });

      await expect(second.adapter.getThreadGoal(sessionId)).resolves.toMatchObject({
        goal: {
          tokenBudget: 500,
          tokensUsed: 30,
          status: "active",
        },
      });
      await second.adapter.destroy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps watching a natively paused goal until it reaches a terminal status", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(21);
    const watch = adapter.watchThreadGoal(sessionId, { objective: "Wait through pause" });
    let settled = false;
    void watch.finally(() => { settled = true; });
    await waitForCall(gateway, "goal.create");

    const projection = {
      goal: {
        id: "goal-1",
        revision: 2,
        objective: "Wait through pause",
        phase: "paused" as "paused" | "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    };
    await gateway.emitProjection(sessionId, "goal", projection, 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    projection.goal.phase = "complete";
    projection.goal.revision = 3;
    projection.updatedAt += 1_000;
    await gateway.emitProjection(sessionId, "goal", projection, 2);
    await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
    await adapter.destroy();
  });

  it("reports a completed goal as complete even when its local budget is exhausted", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(22);
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Finish at the boundary",
      tokenBudget: 10,
    });
    await waitForCall(gateway, "goal.create");
    await gateway.emitProjection(sessionId, "tokenUsage", {
      uncachedInputTokens: 20,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }, 1);
    await gateway.emitProjection(sessionId, "goal", {
      goal: {
        id: "goal-1",
        revision: 2,
        objective: "Finish at the boundary",
        phase: "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    }, 2);

    await expect(watch).resolves.toMatchObject({
      goal: { status: "complete", tokenBudget: 10, tokensUsed: 20 },
    });
    expect(gateway.calls.filter((call) => call.method === "goal.pause")).toHaveLength(0);
    await adapter.destroy();
  });

  it("removes persisted goal budget state when Harness removes the session", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "deepseek-removed-session-"));
    try {
      const goalStatePath = path.join(dir, "goals.json");
      const { adapter, gateway } = createAdapter(undefined, { goalStatePath });
      const { sessionId } = await adapter.createSession(23);
      gateway.responses.set("goal.create", { ref: { id: "goal-removed", revision: 1 } });
      await adapter.setThreadGoal(sessionId, {
        objective: "Will be removed",
        tokenBudget: 250,
      });
      await gateway.emitHost({ type: "host/session-removed", sessionId });

      const persisted = JSON.parse(await readFile(goalStatePath, "utf8")) as {
        sessions: Record<string, unknown>;
      };
      expect(persisted.sessions).not.toHaveProperty(sessionId);
      await adapter.destroy();

      const second = createAdapter(undefined, { goalStatePath });
      second.gateway.responses.set("session.history", {
        events: [],
        hasMore: false,
        projections: {
          asOfSeq: 1,
          values: {
            goal: {
              goal: {
                id: "goal-removed",
                revision: 1,
                objective: "External replacement",
                phase: "active",
                maxGoalRounds: 50,
              },
              roundsStarted: 1,
              createdAt: 1_787_000_000_000,
              updatedAt: 1_787_000_001_000,
            },
            tokenUsage: {
              uncachedInputTokens: 500,
              outputTokens: 25,
              cacheReadTokens: 5,
              cacheWriteTokens: 0,
            },
          },
        },
      });
      await expect(second.adapter.getThreadGoal(sessionId)).resolves.toMatchObject({
        goal: { tokenBudget: null, tokensUsed: 0, status: "active" },
      });
      await second.adapter.destroy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("streams autonomous goal turns without consuming or settling a concurrent user turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(8);
    let goalProjection = {
      goal: {
        id: "goal-live",
        revision: 1,
        objective: "Finish parity",
        phase: "active" as "active" | "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    gateway.responses.set("session.history", () => ({
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: { goal: goalProjection } },
    }));
    gateway.responses.set("goal.create", { ref: { id: "goal-live", revision: 1 } });

    const goalEvents: EngineStreamEvent[] = [];
    const goalWatch = adapter.watchThreadGoal(sessionId, {
      objective: "Finish parity",
      onEngineEvent: (event) => {
        goalEvents.push(event);
      },
    });
    await waitForCall(gateway, "goal.create");

    const userEvents: EngineStreamEvent[] = [];
    const userTurn = adapter.sendUserMessage(sessionId, {
      text: "Give me a status update",
      files: [],
      onEngineEvent: (event) => {
        userEvents.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-live", revision: 1, round: 1 },
    }, 2);
    gateway.emitSessionEvent(sessionId, "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "goal-assistant-message",
        role: "assistant",
        content: [
          { type: "reasoning", text: "goal-private-thinking" },
          { type: "text", text: "goal-only output" },
        ],
      },
    }, 3);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 4);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 5);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "user-message",
      role: "user",
      content: [{ type: "text", text: "Give me a status update" }],
      source: { kind: "user", rpcId: "user-rpc" },
    }, 6);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "user-only output" },
    }, 7);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 8);

    await expect(userTurn).resolves.toMatchObject({ text: "user-only output" });
    expect(userEvents.filter((event) => event.type === "assistant_text").map((event) => event.text)).toEqual([
      "user-only output",
    ]);
    expect(goalEvents.filter((event) => event.type === "assistant_text").map((event) => event.text)).toEqual([
      "goal-only output",
    ]);
    expect(goalEvents.filter((event) => event.type === "thinking").map((event) => event.text)).toEqual([
      "goal-private-thinking",
    ]);

    goalProjection = {
      ...goalProjection,
      goal: { ...goalProjection.goal, phase: "complete" },
      roundsStarted: 1,
      updatedAt: 1_787_000_001_000,
    };
    gateway.emitProjection(sessionId, "goal", goalProjection, 9);
    await expect(goalWatch).resolves.toMatchObject({
      goal: { status: "complete", objective: "Finish parity" },
    });
  });

  it("resolves an aborted goal watcher with its latest state instead of reporting a failure", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(9);
    const activeGoal = {
      goal: {
        id: "goal-abort",
        revision: 1,
        objective: "Long-running audit",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 2,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_002_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 2, values: { goal: activeGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-abort-new", revision: 1 } });
    const controller = new AbortController();
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Long-running audit",
      abortSignal: controller.signal,
    });
    await waitForCall(gateway, "goal.create");

    controller.abort();

    await expect(watch).resolves.toMatchObject({
      sessionId,
      goal: { status: "active", objective: "Long-running audit" },
    });
  });

  it("clears a prior durable goal before creating a fresh watched goal", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(10);
    const oldGoal = {
      goal: {
        id: "goal-old",
        revision: 4,
        objective: "Old objective",
        phase: "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 17,
      createdAt: 1_786_000_000_000,
      updatedAt: 1_786_000_100_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 20, values: { goal: oldGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-new", revision: 1 } });

    const watch = adapter.watchThreadGoal(sessionId, { objective: "Fresh objective" });
    await waitForCall(gateway, "goal.create");

    const clearIndex = gateway.calls.findIndex((call) => call.method === "goal.clear");
    const createIndex = gateway.calls.findIndex((call) => call.method === "goal.create");
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(clearIndex);

    gateway.emitProjection(sessionId, "goal", {
      ...oldGoal,
      goal: {
        ...oldGoal.goal,
        id: "goal-new",
        revision: 1,
        objective: "Fresh objective",
        phase: "complete",
      },
      roundsStarted: 1,
      updatedAt: 1_787_000_001_000,
    }, 21);
    await expect(watch).resolves.toMatchObject({ goal: { objective: "Fresh objective" } });
  });

  it("creates a fresh active goal instead of editing a terminal goal in place", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(11);
    let projection: unknown = {
      goal: {
        id: "goal-terminal",
        revision: 3,
        objective: "Finished work",
        phase: "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 9,
      createdAt: 1_786_000_000_000,
      updatedAt: 1_786_000_100_000,
    };
    let projectionSeq = 30;
    gateway.responses.set("session.history", () => ({
      events: [],
      hasMore: false,
      projections: { asOfSeq: projectionSeq, values: { goal: projection } },
    }));
    gateway.responses.set("goal.clear", () => {
      projection = null;
      projectionSeq += 1;
      return { cleared: true };
    });
    gateway.responses.set("goal.create", () => {
      projection = {
        goal: {
          id: "goal-fresh",
          revision: 1,
          objective: "New work",
          phase: "active",
          maxGoalRounds: 50,
        },
        roundsStarted: 0,
        createdAt: 1_787_000_000_000,
        updatedAt: 1_787_000_000_000,
      };
      projectionSeq += 1;
      return { ref: { id: "goal-fresh", revision: 1 } };
    });

    await expect(adapter.setThreadGoal(sessionId, { objective: "New work" })).resolves.toMatchObject({
      goal: { objective: "New work", status: "active", tokensUsed: 0 },
    });
    const methods = gateway.calls.map((call) => call.method);
    const clearIndex = methods.indexOf("goal.clear");
    const createIndex = methods.indexOf("goal.create");
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(clearIndex);
    expect(methods).not.toContain("goal.edit");
  });

  it("routes a goal approval request to the goal watcher instead of a concurrent user turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(12);
    const activeGoal = {
      goal: {
        id: "goal-approval",
        revision: 1,
        objective: "Use tools",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: { goal: activeGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-approval", revision: 1 } });
    const controller = new AbortController();
    const goalEvents: EngineStreamEvent[] = [];
    const goalApprovals: EngineApprovalRequest[] = [];
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Use tools",
      abortSignal: controller.signal,
      onEngineEvent: (event) => {
        goalEvents.push(event);
      },
      onApprovalRequest: async (request) => {
        goalApprovals.push(request);
        return { behavior: "allow", scope: "session" };
      },
    });
    await waitForCall(gateway, "goal.create");

    const userApprovals: EngineApprovalRequest[] = [];
    const userTurn = adapter.sendUserMessage(sessionId, {
      text: "Status",
      files: [],
      onApprovalRequest: async (request) => {
        userApprovals.push(request);
        return { behavior: "allow" };
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-approval", revision: 1, round: 1 },
    }, 2);
    gateway.emitSessionEvent(sessionId, "tool/call", {
      turn: 1,
      step: 1,
      callId: "goal-tool",
      name: "outside_write",
      arguments: "{\"path\":\"/tmp/out\"}",
    }, 3);
    gateway.emitMux({
      type: "approval/requested",
      sessionId,
      approvalId: "goal-approval-request",
      callId: "goal-tool",
      toolName: "outside_write",
    }, "goal-approval-rpc");

    await vi.waitFor(() => expect(gateway.clientResponses).toHaveLength(1));
    expect(userApprovals).toHaveLength(0);
    expect(goalApprovals).toEqual([expect.objectContaining({
      engine: "deepseek",
      toolName: "outside_write",
      toolInput: { path: "/tmp/out" },
      sessionId,
    })]);
    expect(gateway.clientResponses[0]).toMatchObject({
      rpcId: "goal-approval-rpc",
      value: { outcome: "allowed-once" },
    });
    expect(goalEvents).toContainEqual({
      type: "permission_request",
      toolName: "outside_write",
      toolInput: { path: "/tmp/out" },
      sessionId,
    });

    controller.abort();
    await expect(watch).resolves.toBeDefined();
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 4);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "user-status-message",
      role: "user",
      content: [{ type: "text", text: "Status" }],
      source: { kind: "user", rpcId: "status-rpc" },
    }, 5);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "user result" },
    }, 6);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 7);
    await expect(userTurn).resolves.toMatchObject({ text: "user result" });
  });

  it("keeps goal-owned background jobs out of a concurrent user turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(13);
    const activeGoal = {
      goal: {
        id: "goal-job",
        revision: 1,
        objective: "Run in background",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: { goal: activeGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-job", revision: 1 } });
    const controller = new AbortController();
    const goalEvents: EngineStreamEvent[] = [];
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Run in background",
      abortSignal: controller.signal,
      onEngineEvent: (event) => {
        goalEvents.push(event);
      },
    });
    await waitForCall(gateway, "goal.create");
    const userEvents: EngineStreamEvent[] = [];
    const userTurn = adapter.sendUserMessage(sessionId, {
      text: "Status",
      files: [],
      onEngineEvent: (event) => {
        userEvents.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-job-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-job", revision: 1, round: 1 },
    }, 2);
    gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "goal-job-1",
        kind: "bash",
        label: "long goal job",
        status: "running",
        startedAt: Date.now(),
      }],
    });
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 3);
    gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "goal-job-1",
        kind: "bash",
        label: "long goal job",
        status: "completed",
        detail: "exit code: 0",
        startedAt: Date.now() - 1_000,
        finishedAt: Date.now(),
      }],
    });

    await vi.waitFor(() => {
      expect(goalEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "background_task_started", taskId: "goal-job-1" }),
        expect.objectContaining({ type: "background_task_finished", taskId: "goal-job-1" }),
      ]));
    });
    expect(userEvents.some((event) => event.type.startsWith("background_task_"))).toBe(false);

    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 2 }, 4);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "user-status-message",
      role: "user",
      content: [{ type: "text", text: "Status" }],
      source: { kind: "user", rpcId: "status-rpc" },
    }, 5);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 2,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "user result" },
    }, 6);
    gateway.emitSessionEvent(sessionId, "turn/end", { turn: 2, reason: completedReason() }, 7);
    await expect(userTurn).resolves.toMatchObject({ text: "user result" });
    controller.abort();
    await expect(watch).resolves.toBeDefined();
  });

  it("routes a goal question request to the goal watcher instead of a concurrent user turn", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(14);
    const activeGoal = {
      goal: {
        id: "goal-question",
        revision: 1,
        objective: "Ask safely",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: { goal: activeGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-question", revision: 1 } });
    const controller = new AbortController();
    const goalEvents: EngineStreamEvent[] = [];
    const goalQuestions: EngineApprovalRequest[] = [];
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Ask safely",
      abortSignal: controller.signal,
      onEngineEvent: (event) => {
        goalEvents.push(event);
      },
      onApprovalRequest: async (request) => {
        goalQuestions.push(request);
        return {
          behavior: "allow",
          updatedInput: { answers: { Choose: "B" } },
        };
      },
    });
    await waitForCall(gateway, "goal.create");

    const userApprovals: EngineApprovalRequest[] = [];
    const userTurn = adapter.sendUserMessage(sessionId, {
      text: "Status",
      files: [],
      onApprovalRequest: async (request) => {
        userApprovals.push(request);
        return { behavior: "allow" };
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-question-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-question", revision: 1, round: 1 },
    }, 2);
    await gateway.emitMux({
      type: "question/requested",
      sessionId,
      questions: [{
        id: "choice",
        question: "Choose",
        options: [{ label: "A" }, { label: "B" }],
      }],
    }, "goal-question-rpc");

    expect(userApprovals).toHaveLength(0);
    expect(goalQuestions).toEqual([expect.objectContaining({
      engine: "deepseek",
      toolName: "AskUserQuestion",
      sessionId,
    })]);
    expect(gateway.clientResponses.at(-1)).toEqual({
      rpcId: "goal-question-rpc",
      value: {
        sessionId,
        answer: { answers: [{ id: "choice", selected: ["B"] }] },
      },
    });
    expect(goalEvents).toContainEqual({
      type: "permission_request",
      toolName: "AskUserQuestion",
      toolInput: {
        questions: [{
          id: "choice",
          question: "Choose",
          options: [{ label: "A" }, { label: "B" }],
        }],
      },
      sessionId,
    });

    controller.abort();
    await expect(watch).resolves.toBeDefined();
    await finishTurn(gateway, sessionId, 2, 3, "user result");
    await expect(userTurn).resolves.toMatchObject({ text: "user result" });
  });

  it("keeps a newer live projection when an equal-seq history snapshot arrives later", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(15);
    await gateway.emitProjection(sessionId, "contextPressure", {
      pressureTokens: 20_000,
      projectedTokens: 21_000,
      contextWindow: 131_072,
    }, 10);
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: {
        asOfSeq: 10,
        values: {
          contextPressure: {
            pressureTokens: 1,
            projectedTokens: 2,
            contextWindow: 3,
          },
        },
      },
    });

    await expect(adapter.getContextUsage(sessionId)).resolves.toEqual({
      pressureTokens: 20_000,
      projectedTokens: 21_000,
      contextWindow: 131_072,
    });
  });

  it("releases a goal event callback that never settles when the watcher is aborted", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(16);
    const activeGoal = {
      goal: {
        id: "goal-hung-callback",
        revision: 1,
        objective: "Stream safely",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: { goal: activeGoal } },
    });
    gateway.responses.set("goal.create", { ref: { id: "goal-hung-callback", revision: 1 } });
    const controller = new AbortController();
    let callbackStarted = false;
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Stream safely",
      abortSignal: controller.signal,
      onEngineEvent: (event) => {
        if (event.type === "assistant_text") {
          callbackStarted = true;
          return new Promise<void>(() => {});
        }
      },
    });
    await waitForCall(gateway, "goal.create");
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-hung-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-hung-callback", revision: 1, round: 1 },
    }, 2);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "partial" },
    }, 3);
    await vi.waitFor(() => expect(callbackStarted).toBe(true));

    controller.abort();
    await expect(watch).resolves.toBeDefined();
    const next = adapter.sendUserMessage(sessionId, { text: "After abort", files: [] });
    await waitForCall(gateway, "session.prompt", 1);
    await finishTurn(gateway, sessionId, 2, 4, "released");
    await expect(next).resolves.toMatchObject({ text: "released" });
  });

  it("finishes a goal watcher from unseen terminal events recovered after reconnect", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(17);
    const activeGoal = {
      goal: {
        id: "goal-reconnect",
        revision: 1,
        objective: "Survive reconnect",
        phase: "active" as "active" | "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 0,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_000_000,
    };
    let reconnected = false;
    const historyEvent = (type: string, data: Record<string, unknown>, seq: number) => ({
      event: { type, data, seq, time: Date.now() },
    });
    gateway.responses.set("session.history", () => reconnected
      ? {
          events: [
            historyEvent("turn/start", { turn: 1 }, 1),
            historyEvent("user/message", {
              id: "goal-reconnect-message",
              role: "user",
              content: [{ type: "text", text: "goal round" }],
              source: { kind: "goal", goalId: "goal-reconnect", revision: 1, round: 1 },
            }, 2),
            historyEvent("assistant/chunk", {
              turn: 1,
              step: 1,
              chunk: { type: "text-delta", index: 0, text: "before disconnect" },
            }, 3),
            historyEvent("turn/end", { turn: 1, reason: completedReason() }, 4),
          ],
          hasMore: false,
          projections: {
            asOfSeq: 4,
            values: {
              goal: {
                ...activeGoal,
                goal: { ...activeGoal.goal, phase: "complete" },
                roundsStarted: 1,
                updatedAt: 1_787_000_001_000,
              },
            },
          },
        }
      : {
          events: [],
          hasMore: false,
          projections: { asOfSeq: 0, values: { goal: activeGoal } },
        });
    gateway.responses.set("goal.create", { ref: { id: "goal-reconnect", revision: 1 } });
    const events: EngineStreamEvent[] = [];
    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Survive reconnect",
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "goal.create");
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "goal-reconnect-message",
      role: "user",
      content: [{ type: "text", text: "goal round" }],
      source: { kind: "goal", goalId: "goal-reconnect", revision: 1, round: 1 },
    }, 2);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "before disconnect" },
    }, 3);

    reconnected = true;
    await gateway.handlers?.onReconnect?.({ reason: "transport" });

    await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
    expect(events.filter((event) => event.type === "assistant_text")).toHaveLength(1);
  });

  it("fails an active turn immediately when the host reports an unpositioned agent error", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(18);
    const turn = adapter.sendUserMessage(sessionId, { text: "Fail fast", files: [] });
    await waitForCall(gateway, "session.prompt", 1);

    await gateway.emitHost({
      type: "host/agent-error",
      sessionId,
      message: "provider connection failed",
    });

    await expect(turn).rejects.toThrow("provider connection failed");
    const next = adapter.sendUserMessage(sessionId, { text: "Retry", files: [] });
    await waitForCall(gateway, "session.prompt", 2);
    await finishTurn(gateway, sessionId, 1, 1, "recovered");
    await expect(next).resolves.toMatchObject({ text: "recovered" });
  });

  it("reads the durable context pressure projection for /context", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(1);
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: {
        asOfSeq: 4,
        values: {
          contextPressure: {
            pressureTokens: 12_000,
            projectedTokens: 13_107,
            contextWindow: 131_072,
          },
        },
      },
    });

    await expect(adapter.getContextUsage(sessionId)).resolves.toEqual({
      pressureTokens: 12_000,
      projectedTokens: 13_107,
      contextWindow: 131_072,
    });
    expect(gateway.calls).toContainEqual({
      method: "session.history",
      payload: { sessionId, maxMessages: 1 },
    });
  });

  it("rejects a projection snapshot without an as-of sequence", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(2);
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: {
        values: {
          contextPressure: {
            pressureTokens: 1,
            projectedTokens: 2,
            contextWindow: 3,
          },
        },
      },
    });

    await expect(adapter.getContextUsage(sessionId)).rejects.toThrow("missing asOfSeq");
  });

  it("recovers only unseen session events after a transport reconnect", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(8);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Continue after reconnect",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "Once" },
    }, 2);
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "assistant_text",
        text: "Once",
        delta: true,
        sessionId,
      });
    });

    const historyEvent = (type: string, data: Record<string, unknown>, seq: number) => ({
      event: { type, data, seq, time: Date.now() },
    });
    gateway.responses.set("session.history", {
      events: [
        historyEvent("turn/start", { turn: 1 }, 1),
        historyEvent("assistant/chunk", {
          turn: 1,
          step: 1,
          chunk: { type: "text-delta", index: 0, text: "Once" },
        }, 2),
        historyEvent("assistant/chunk", {
          turn: 1,
          step: 2,
          chunk: { type: "text-delta", index: 0, text: " after reconnect" },
        }, 3),
        historyEvent("turn/end", { turn: 1, reason: completedReason() }, 4),
      ],
      hasMore: false,
      projections: { asOfSeq: 4, values: {} },
    });

    await gateway.handlers?.onReconnect?.({ reason: "transport" });
    await expect(turn).resolves.toMatchObject({ text: "Once after reconnect", sessionId });
    expect(events.filter((event) => event.type === "assistant_text").map((event) => event.text)).toEqual([
      "Once",
      " after reconnect",
    ]);
  });

  it("drains reconnect frames before admitting live frames that arrive during recovery", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(8);
    const textEvents: string[] = [];
    let injectedLiveFrame = false;
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Preserve reconnect ordering",
      files: [],
      onEngineEvent: (event) => {
        if (event.type !== "assistant_text") {
          return;
        }
        textEvents.push(event.text);
        if (event.text === "buffered-1" && !injectedLiveFrame) {
          injectedLiveFrame = true;
          void gateway.emitSessionEvent(sessionId, "assistant/chunk", {
            turn: 1,
            step: 3,
            chunk: { type: "text-delta", index: 0, text: "live" },
          }, 5);
        }
      },
    });
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "reconnect-order-user",
      role: "user",
      content: [{ type: "text", text: "Preserve reconnect ordering" }],
      source: { kind: "user" },
    }, 2);

    await gateway.handlers?.onDisconnect?.(new Error("socket closed"));
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "buffered-1" },
    }, 3);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "text-delta", index: 0, text: "buffered-2" },
    }, 4);

    await gateway.handlers?.onReconnect?.({ reason: "transport" });
    await vi.waitFor(() => expect(textEvents).toEqual(["buffered-1", "buffered-2", "live"]));
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 6);

    await expect(turn).resolves.toMatchObject({ text: "buffered-1buffered-2live" });
  });

  it("re-arms a watched active goal after the Harness process restarts", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(19);
    const activeGoal = {
      goal: {
        id: "goal-host-restart",
        revision: 1,
        objective: "Survive the host restart",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    };
    gateway.responses.set("goal.create", { ref: { id: "goal-host-restart", revision: 1 } });
    gateway.responses.set("goal.resume", { ref: { id: "goal-host-restart", revision: 2 } });
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 1, values: { goal: activeGoal } },
    });

    const watch = adapter.watchThreadGoal(sessionId, {
      objective: "Survive the host restart",
    });
    await waitForCall(gateway, "goal.create");
    expect(gateway.calls.filter((call) => call.method === "goal.resume")).toHaveLength(0);

    await gateway.handlers?.onDisconnect?.(new Error("dsh exited"));
    await gateway.handlers?.onReconnect?.({ reason: "host-restart" });

    expect(gateway.calls.filter((call) => call.method === "goal.resume")).toEqual([{
      method: "goal.resume",
      payload: {
        sessionId,
        ref: { id: "goal-host-restart", revision: 1 },
      },
    }]);

    await gateway.emitProjection(sessionId, "goal", {
      ...activeGoal,
      goal: { ...activeGoal.goal, phase: "complete", revision: 2 },
      updatedAt: 1_787_000_002_000,
    }, 2);
    await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
  });

  it("does not redundantly resume an armed goal after a transport-only reconnect", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(20);
    const activeGoal = {
      goal: {
        id: "goal-transport-reconnect",
        revision: 1,
        objective: "Stay armed",
        phase: "active",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    };
    gateway.responses.set("goal.create", { ref: { id: "goal-transport-reconnect", revision: 1 } });
    gateway.responses.set("session.history", {
      events: [],
      hasMore: false,
      projections: { asOfSeq: 1, values: { goal: activeGoal } },
    });

    const watch = adapter.watchThreadGoal(sessionId, { objective: "Stay armed" });
    await waitForCall(gateway, "goal.create");
    await gateway.handlers?.onDisconnect?.(new Error("socket closed"));
    await gateway.handlers?.onReconnect?.({ reason: "transport" });

    expect(gateway.calls.filter((call) => call.method === "goal.resume")).toHaveLength(0);
    await gateway.emitProjection(sessionId, "goal", {
      ...activeGoal,
      goal: { ...activeGoal.goal, phase: "complete", revision: 2 },
      updatedAt: 1_787_000_002_000,
    }, 2);
    await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
  });

  it("does not start a new turn until reconnect history recovery has finished", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(21);
    const activeGoal = {
      goal: {
        id: "goal-recovery-barrier",
        revision: 1,
        objective: "Keep pursuing",
        phase: "active" as "active" | "complete",
        maxGoalRounds: 50,
      },
      roundsStarted: 1,
      createdAt: 1_787_000_000_000,
      updatedAt: 1_787_000_001_000,
    };
    gateway.responses.set("goal.create", { ref: { id: "goal-recovery-barrier", revision: 1 } });
    const watch = adapter.watchThreadGoal(sessionId, { objective: "Keep pursuing" });
    await waitForCall(gateway, "goal.create");
    const historyCallsBeforeDisconnect = gateway.calls.filter((call) => call.method === "session.history").length;
    const promptCallsBeforeDisconnect = gateway.calls.filter((call) => call.method === "session.prompt").length;
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    gateway.responses.set("session.history", async () => {
      await historyGate;
      return {
        events: [],
        hasMore: false,
        projections: { asOfSeq: 1, values: { goal: activeGoal } },
      };
    });

    await gateway.handlers?.onDisconnect?.(new Error("socket closed"));
    const recovery = Promise.resolve(gateway.handlers?.onReconnect?.({ reason: "transport" }));
    await vi.waitFor(() => {
      expect(gateway.calls.filter((call) => call.method === "session.history").length)
        .toBeGreaterThan(historyCallsBeforeDisconnect);
    });

    const turn = adapter.sendUserMessage(sessionId, { text: "after reconnect", files: [] });
    void turn.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gateway.calls.filter((call) => call.method === "session.prompt"))
      .toHaveLength(promptCallsBeforeDisconnect);

    releaseHistory();
    await recovery;
    await vi.waitFor(() => {
      expect(gateway.calls.filter((call) => call.method === "session.prompt").length)
        .toBeGreaterThan(promptCallsBeforeDisconnect);
    });
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 2);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "foreground-after-reconnect",
      role: "user",
      content: [{ type: "text", text: "after reconnect" }],
      source: { kind: "user" },
    }, 3);
    await gateway.emitSessionEvent(sessionId, "assistant/chunk", {
      turn: 1,
      step: 1,
      chunk: { type: "text-delta", index: 0, text: "recovered" },
    }, 4);
    await gateway.emitSessionEvent(sessionId, "turn/end", { turn: 1, reason: completedReason() }, 5);
    await expect(turn).resolves.toMatchObject({ text: "recovered" });

    await gateway.emitProjection(sessionId, "goal", {
      ...activeGoal,
      goal: { ...activeGoal.goal, phase: "complete", revision: 2 },
      updatedAt: 1_787_000_002_000,
    }, 6);
    await expect(watch).resolves.toMatchObject({ goal: { status: "complete" } });
  });

  it("fails closed when reconnect history exceeds the pagination safety limit", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(22);
    const turn = adapter.sendUserMessage(sessionId, { text: "recover all history", files: [] });
    void turn.catch(() => {});
    await waitForCall(gateway, "session.prompt");
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "history-limit-owner",
      role: "user",
      content: [{ type: "text", text: "recover all history" }],
      source: { kind: "user" },
    }, 2);

    gateway.responses.set("session.history", (payload: unknown) => {
      const beforeSeq = (payload as { beforeSeq?: number }).beforeSeq;
      const seq = beforeSeq === undefined ? 1_002 : beforeSeq - 1;
      return {
        events: [{ event: { type: "audit/noop", seq, time: Date.now(), data: {} } }],
        hasMore: true,
      };
    });

    await gateway.handlers?.onDisconnect?.(new Error("socket closed"));
    await gateway.handlers?.onReconnect?.({ reason: "transport" });

    const outcome = await Promise.race([
      turn.then(() => "resolved", (error: unknown) => String(error)),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(outcome).toContain("history pagination limit");
    expect(gateway.calls.filter((call) => call.method === "session.history")).toHaveLength(100);

    await adapter.destroy();
  });

  it("closes process-local background jobs as failed when the Harness host restarts", async () => {
    const { adapter, gateway } = createAdapter();
    const { sessionId } = await adapter.createSession(22);
    const events: EngineStreamEvent[] = [];
    const turn = adapter.sendUserMessage(sessionId, {
      text: "Run a background task",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });
    void turn.catch(() => {});
    await waitForCall(gateway, "session.prompt", 1);
    await gateway.emitSessionEvent(sessionId, "turn/start", { turn: 1 }, 1);
    await gateway.emitSessionEvent(sessionId, "user/message", {
      id: "foreground-message",
      role: "user",
      content: [{ type: "text", text: "Run a background task" }],
      source: { kind: "user" },
    }, 2);
    await gateway.emitMux({
      type: "session/jobs",
      sessionId,
      jobs: [{
        id: "job-before-crash",
        kind: "shell",
        label: "long command",
        status: "running",
        startedAt: Date.now(),
      }],
    });
    expect(events).toContainEqual({
      type: "background_task_started",
      taskId: "job-before-crash",
      description: "long command",
      sessionId,
    });

    gateway.responses.set("session.history", {
      events: [{
        event: {
          type: "turn/end",
          seq: 3,
          time: Date.now(),
          data: { turn: 1, reason: { kind: "interrupted" } },
        },
      }],
      hasMore: false,
      projections: { asOfSeq: 3, values: {} },
    });
    await gateway.handlers?.onDisconnect?.(new Error("dsh exited"));
    await gateway.handlers?.onReconnect?.({ reason: "host-restart" });

    expect(events).toContainEqual({
      type: "background_task_finished",
      taskId: "job-before-crash",
      status: "failed",
      summary: "DeepSeek Harness restarted before the background job reported completion",
      sessionId,
    });
    await expect(turn).rejects.toThrow("DeepSeek Harness turn ended with interrupted");
  });
});
