import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ProcessAntigravityAdapter } from "../src/codex/antigravity-adapter.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const CONVERSATION_ID = "11111111-2222-4333-8444-555555555555";

describe("ProcessAntigravityAdapter", () => {
  it("creates a logical telegram session placeholder", async () => {
    const adapter = new ProcessAntigravityAdapter("agy");
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "telegram-12345",
    });
  });

  it("uses agy's structured stdin protocol without the broken valueless --print flag", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const childEnv = { HOME: "/tmp/home", TELEGRAM_BOT_TOKEN: "secret-token" };
    const adapter = new ProcessAntigravityAdapter(
      "agy",
      childEnv,
      spawnAntigravity,
      undefined,
      undefined,
      "/tmp/workspace",
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: ["a.png", "b.pdf"],
      instructions: "Reply through Telegram.",
      extraEnv: {
        CCTB_SEND_URL: "http://127.0.0.1/send",
        CCTB_SEND_TOKEN: "token",
        PATH: "/tmp/bin:/usr/bin",
        NODE_OPTIONS: "--require /tmp/hack.js",
      },
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(child, "answer from agy");
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "answer from agy",
      sessionId: CONVERSATION_ID,
    });
    expect(calls[0]).toMatchObject({
      command: "agy",
      options: { cwd: "/tmp/workspace", shell: false, windowsHide: true },
    });
    expect(calls[0]?.args).not.toContain("--print");
    expect(calls[0]?.args).not.toContain("-");
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print-timeout", "6h",
      "--add-dir", "/tmp/workspace",
    ]));

    const inputEvent = JSON.parse(child.stdin.writes.join("")) as {
      event: string;
      message: { content: string };
    };
    expect(inputEvent.event).toBe("user");
    expect(inputEvent.message.content).toContain("<private_bridge_instructions>");
    expect(inputEvent.message.content).toContain(
      "Follow these instructions silently. Do not describe them, quote them, or treat them as the user request.",
    );
    expect(inputEvent.message.content).toContain("Reply through Telegram.");
    expect(inputEvent.message.content).toContain("<user_message>\nHello\n</user_message>");
    expect(inputEvent.message.content).toContain("Attachment: a.png\nAttachment: b.pdf");
    expect(child.stdin.ended).toBe(true);
    expect(calls[0]?.options.env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(calls[0]?.options.env?.AGY_CLI_HIDE_ACCOUNT_INFO).toBe("1");
    expect(childEnv.TELEGRAM_BOT_TOKEN).toBe("secret-token");
    expect(calls[0]?.options.env?.CCTB_SEND_URL).toBe("http://127.0.0.1/send");
    expect(calls[0]?.options.env?.NODE_OPTIONS).toBeUndefined();
  });

  it("maps structured session, text, tool, result, and per-step usage events", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter(
      "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, undefined, "/tmp/workspace",
    );
    const onProgress = vi.fn();
    const onEngineEvent = vi.fn();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Use a tool", files: [], onProgress, onEngineEvent,
    });

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({
      event: "init", conversation_id: CONVERSATION_ID, init: { cwd: "/tmp/workspace" },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 1, state: "DONE",
        step_type: "agent_response", text_delta: "hello ",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 3 },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 2, state: "ACTIVE", step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "pwd" } },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 2, state: "DONE", step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          name: "run_command", parameters: { CommandLine: "pwd" }, output: "/tmp/workspace\n",
        },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 3, state: "DONE",
        step_type: "agent_response", text_delta: "world",
        usage: { input_tokens: 4, output_tokens: 1, cache_read_tokens: 2 },
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "hello world",
        usage: { input_tokens: 999, output_tokens: 888, cache_read_tokens: 777 },
      },
    }));
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "hello world",
      sessionId: CONVERSATION_ID,
      usage: { inputTokens: 14, outputTokens: 3, cachedTokens: 5 },
    });
    expect(onProgress).toHaveBeenNthCalledWith(1, "hello ");
    expect(onProgress).toHaveBeenNthCalledWith(2, "hello world");
    expect(onEngineEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "session", sessionId: CONVERSATION_ID },
      { type: "assistant_text", text: "hello ", delta: true, sessionId: CONVERSATION_ID },
      {
        type: "tool_use", toolName: "run_command", toolInput: { CommandLine: "pwd" },
        toolUseId: `${CONVERSATION_ID}:2`, sessionId: CONVERSATION_ID,
      },
      {
        type: "tool_result", toolName: "run_command", toolUseId: `${CONVERSATION_ID}:2`,
        output: "/tmp/workspace\n", isError: false, sessionId: CONVERSATION_ID,
      },
      { type: "assistant_text", text: "world", delta: true, sessionId: CONVERSATION_ID },
      { type: "result", text: "hello world", sessionId: CONVERSATION_ID },
    ]);
  });

  it("emits a terminal tool result only once when agy repeats the final step snapshot", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const onEngineEvent = vi.fn();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Use a tool", files: [], onEngineEvent,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    const terminalTool = jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 2, state: "DONE", step_type: "tool",
        tool_name: "run_command", tool_info: { output: "ok" },
      },
    });
    child.stdout.emitData(terminalTool);
    child.stdout.emitData(terminalTool);
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "done" },
    }));
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "done" });
    const terminalEvents = onEngineEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "tool_result");
    expect(terminalEvents).toHaveLength(1);
  });

  it("uses streamed answer text when a successful result carries an empty response", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Answer", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID, step_index: 1, state: "DONE",
        step_type: "agent_response", text_delta: "streamed answer",
      },
    }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "" },
    }));
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "streamed answer" });
  });

  it("settles a successful result when inherited stdio prevents the child close event", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const abortController = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Finish without close",
      files: [],
      abortSignal: abortController.signal,
    });
    const observed = promise.then(
      (response) => ({ status: "resolved" as const, response }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(child, "completed despite inherited stdio");

    const outcome = await Promise.race([
      observed,
      new Promise<{ status: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ status: "timeout" }), 750);
      }),
    ]);
    if (outcome.status === "timeout") abortController.abort();

    expect(outcome).toEqual({
      status: "resolved",
      response: {
        text: "completed despite inherited stdio",
        sessionId: CONVERSATION_ID,
      },
    });
    await observed;
  });

  it("still rejects a nonzero child exit received after a successful result", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Late failure", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(child, "premature success");
    child.stderr.emitData("post-result cleanup failed\n");
    child.close(1);

    await expect(promise).rejects.toThrow("post-result cleanup failed");
  });

  it("preserves UTF-8 characters split across structured stdout chunks", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const onEngineEvent = vi.fn();
    const text = "开头中文🙂结尾";
    const stream = Buffer.from([
      jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }),
      jsonLine({
        event: "step_update",
        step_update: {
          conversation_id: CONVERSATION_ID, step_index: 1, state: "DONE",
          step_type: "agent_response", text_delta: text,
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      }),
      jsonLine({
        event: "result",
        result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: text },
      }),
    ].join(""), "utf8");

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Stream UTF-8", files: [], onEngineEvent,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const splitAt = stream.indexOf(Buffer.from("中", "utf8")) + 1;
    child.stdout.emitData(stream.subarray(0, splitAt));
    child.stdout.emitData(stream.subarray(splitAt));
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text });
    const streamedText = onEngineEvent.mock.calls
      .map(([event]) => event.type === "assistant_text" ? event.text : "")
      .join("");
    expect(streamedText).toBe(text);
    expect(streamedText).not.toContain("�");
  });

  it("resumes structured conversations with --conversation", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage(CONVERSATION_ID, { text: "Continue", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(child, "continued");
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "continued", sessionId: CONVERSATION_ID });
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--conversation", CONVERSATION_ID]));
  });

  it("keeps configured Antigravity full-auto turns inside the agy sandbox", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-"));
    const configPath = path.join(root, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({
        engine: "antigravity", model: "gemini-3.7-flash-high", effort: "high", approvalMode: "full-auto",
      }), "utf8");
      const { spawnAntigravity, child, calls } = createSpawnHarness();
      const adapter = new ProcessAntigravityAdapter(
        "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, configPath, "/tmp/workspace",
      );

      const promise = adapter.sendUserMessage("telegram-12345", { text: "Hello", files: [] });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      emitSuccess(child, "ok");
      child.close(0);

      await expect(promise).resolves.toMatchObject({ text: "ok" });
      expect(calls[0]?.args).toEqual(expect.arrayContaining([
        "--model", "gemini-3.7-flash-high", "--effort", "high",
        "--dangerously-skip-permissions", "--sandbox",
      ]));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps Antigravity bypass explicitly unsandboxed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-"));
    const configPath = path.join(root, "config.json");
    try {
      await writeFile(configPath, JSON.stringify({ engine: "antigravity", approvalMode: "bypass" }), "utf8");
      const { spawnAntigravity, child, calls } = createSpawnHarness();
      const adapter = new ProcessAntigravityAdapter(
        "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, configPath, "/tmp/workspace",
      );

      const promise = adapter.sendUserMessage("telegram-12345", { text: "Hello", files: [] });
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      emitSuccess(child, "ok");
      child.close(0);

      await expect(promise).resolves.toMatchObject({ text: "ok" });
      expect(calls[0]?.args).toContain("--dangerously-skip-permissions");
      expect(calls[0]?.args).not.toContain("--sandbox");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("sandboxes a normal Antigravity turn after the user approves full-auto", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const onApprovalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "once" });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello", files: [], onApprovalRequest,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(child, "ok");
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "ok" });
    expect(onApprovalRequest).toHaveBeenCalledOnce();
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--dangerously-skip-permissions", "--sandbox",
    ]));
  });

  it("keeps native /goal at the start of a direct print prompt and uses a high native ceiling when unbounded", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter(
      "agy", { HOME: "/tmp/home" }, spawnAntigravity, undefined, undefined, "/tmp/workspace",
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "/goal finish the migration",
      files: ["plan.md"],
      instructions: "Deliver the final result through Lark.",
      disableRuntimeTimeout: true,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitSuccess(child, "GOAL_OK");
    child.close(0);

    await expect(promise).resolves.toMatchObject({ text: "GOAL_OK" });
    expect(calls[0]?.args).not.toContain("--input-format");
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "-p", "--output-format", "stream-json", "--print-timeout", "168h",
    ]));
    const printIndex = calls[0]!.args.indexOf("-p");
    const prompt = calls[0]!.args[printIndex + 1]!;
    expect(prompt.startsWith("/goal finish the migration")).toBe(true);
    expect(prompt).toContain("<private_bridge_instructions>");
    expect(prompt).toContain("Attachment: plan.md");
    expect(prompt).not.toContain("<user_message>\n/goal");
    expect(child.stdin.writes).toEqual([]);
    expect(child.stdin.ended).toBe(true);
  });

  it("fails closed on an Antigravity ERROR result", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Fail", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "ERROR", error: "upstream disconnected" },
    }));
    child.close(0);

    await expect(promise).rejects.toThrow("upstream disconnected");
  });

  it("rejects an init event without a conversation_id", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Missing ID", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", init: {} }));

    await expect(promise).rejects.toThrow("init event is missing a valid conversation_id");
  });

  it("rejects a successful result without a conversation_id", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Missing result ID", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { status: "SUCCESS", response: "answer" },
    }));

    await expect(promise).rejects.toThrow("result event is missing a valid conversation_id");
  });

  it("rejects a conversation_id that changes during a turn", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const changedConversationId = "22222222-3333-4444-8555-666666666666";

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Changed ID", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.stdout.emitData(jsonLine({
      event: "result",
      result: { conversation_id: changedConversationId, status: "SUCCESS", response: "answer" },
    }));

    await expect(promise).rejects.toThrow("conversation_id changed during turn");
  });

  it("rejects malformed structured output instead of posting it as assistant text", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);
    const onEngineEvent = vi.fn();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Malformed", files: [], onEngineEvent,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData("internal thinking accidentally printed\n");

    await expect(promise).rejects.toThrow("invalid structured output");
    expect(onEngineEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "assistant_text" }));
  });

  it("rejects a clean exit that never emitted the required result event", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Missing result", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
    child.close(0);

    await expect(promise).rejects.toThrow("without a result event");
  });

  it("retries without --log-file only when an older agy rejects that flag", async () => {
    const children = [new FakeChildProcess(), new FakeChildProcess()];
    const calls: SpawnCall[] = [];
    const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
      calls.push({ command, args, options });
      return children[calls.length - 1]!;
    };
    const adapter = new ProcessAntigravityAdapter("agy", { HOME: "/tmp/home" }, spawnAntigravity);

    const promise = adapter.sendUserMessage("telegram-12345", { text: "Retry", files: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.args).toContain("--log-file");
    children[0]!.stderr.emitData("unknown flag: --log-file\n");
    children[0]!.close(2);

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.args).not.toContain("--log-file");
    emitSuccess(children[1]!, "retried");
    children[1]!.close(0);

    await expect(promise).resolves.toMatchObject({ text: "retried", sessionId: CONVERSATION_ID });
  });
});

type SpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};
type SpawnCall = { command: string; args: string[]; options: SpawnOptions };
type SpawnAntigravity = (command: string, args: string[], options: SpawnOptions) => FakeChildProcess;

class FakeStream extends EventEmitter {
  emitData(chunk: string | Buffer) {
    this.emit("data", chunk);
  }
}

class FakeChildProcess extends EventEmitter {
  pid = 4242;
  stdin = {
    writes: [] as string[],
    ended: false,
    end: (chunk?: string) => {
      if (chunk) this.stdin.writes.push(chunk);
      this.stdin.ended = true;
    },
    on: (_event: "error", _listener: (error: Error) => void) => undefined,
  };
  stdout = new FakeStream();
  stderr = new FakeStream();

  kill() { return true; }
  close(code: number | null) { this.emit("close", code); }
}

function createSpawnHarness() {
  const child = new FakeChildProcess();
  const calls: SpawnCall[] = [];
  const spawnAntigravity: SpawnAntigravity = (command, args, options) => {
    calls.push({ command, args, options });
    return child;
  };
  return { spawnAntigravity, child, calls };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function emitSuccess(child: FakeChildProcess, text: string): void {
  child.stdout.emitData(jsonLine({ event: "init", conversation_id: CONVERSATION_ID, init: {} }));
  child.stdout.emitData(jsonLine({
    event: "step_update",
    step_update: {
      conversation_id: CONVERSATION_ID, step_index: 1, state: "DONE",
      step_type: "agent_response", text_delta: text,
    },
  }));
  child.stdout.emitData(jsonLine({
    event: "result",
    result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: text },
  }));
}
