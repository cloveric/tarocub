import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
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

class FakeStream extends EventEmitter {
  emitData(chunk: string | Buffer) {
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
}

class FakeClaudeChildProcess extends EventEmitter {
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
  const children: FakeClaudeChildProcess[] = [];
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
    const child = new FakeClaudeChildProcess();
    children.push(child);
    calls.push({ command, args, options });
    return child;
  };

  return { children, calls, spawnFn };
}

describe("ClaudeStreamAdapter", () => {
  it("creates a logical telegram session placeholder", async () => {
    const adapter = new ClaudeStreamAdapter("claude");
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "telegram-12345",
    });
  });

  it("propagates the result's usage so /usage and budget enforcement see Claude spend", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    const turn = adapter.sendUserMessage("telegram-12345", { text: "count me", files: [] });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-usage"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-usage","usage":{"input_tokens":11,"output_tokens":7,"cache_read_input_tokens":3},"total_cost_usd":0.0012}\n');

    // The worker resolves with usage — sendUserMessage must not drop it (it
    // previously did, making every Claude turn invisible to usage/budget).
    await expect(turn).resolves.toMatchObject({
      text: "ONE",
      usage: { inputTokens: 11, outputTokens: 7, cachedTokens: 3, costUsd: 0.0012 },
    });
  });

  it("decodes UTF-8 JSON correctly when a multibyte character crosses stdout chunks", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const turn = adapter.sendUserMessage("telegram-12345", { text: "中文", files: [] });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);

    const line = Buffer.from('{"type":"result","subtype":"success","is_error":false,"result":"你好🙂","session_id":"session-utf8"}\n');
    const marker = line.indexOf(Buffer.from("好"));
    children[0].stdout.emitData(line.subarray(0, marker + 1));
    children[0].stdout.emitData(line.subarray(marker + 1));

    await expect(turn).resolves.toEqual({ text: "你好🙂", sessionId: "session-utf8" });
  });

  it("processes the final JSON event when the CLI exits without a newline", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const turn = adapter.sendUserMessage("telegram-12345", { text: "finish", files: [] });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);

    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"FINAL","session_id":"session-final"}');
    children[0].close(0);

    await expect(turn).resolves.toEqual({ text: "FINAL", sessionId: "session-final" });
  });

  it("keeps a persistent Claude session alive across multiple turns", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const first = adapter.sendUserMessage("telegram-12345", {
      text: "First",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    expect(calls[0]?.args).toEqual([
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
    ]);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"ONE"}]},"session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');

    await expect(first).resolves.toEqual({
      text: "ONE",
      sessionId: "session-123",
    });

    const second = adapter.sendUserMessage("session-123", {
      text: "Second",
      files: [],
    });

    await waitFor(() => children[0].stdin.lines.length === 2);
    expect(children).toHaveLength(1);
    const secondInput = JSON.parse(children[0].stdin.lines[1] ?? "{}");
    expect(secondInput.message.content[0].text).toBe("Second");
    children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"TWO"}]},"session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-123"}\n');

    await expect(second).resolves.toEqual({
      text: "TWO",
    });
  });

  it("defaults configured stream Claude instances without approval mode to unsafe bypass", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, "{}\n", "utf8");
      const adapter = new ClaudeStreamAdapter("claude", {
        spawnFn,
        configPath,
      });

      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "First",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      expect(calls[0]?.args).toContain("--dangerously-skip-permissions");
      expect(calls[0]?.args).not.toContain("bypassPermissions");

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');
      await expect(turn).resolves.toEqual({
        text: "ONE",
        sessionId: "session-123",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("sanitizes an incompatible config effort through the validated reader on the Claude path", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    // sanitizeConfigCompatibility logs the dropped effort; keep test output clean.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      // effort "ultra" is not a Claude effort: the raw reader used to forward it
      // as `--effort ultra`; the validated reader must drop it.
      await writeFile(
        configPath,
        JSON.stringify({ engine: "claude", approvalMode: "normal", effort: "ultra", model: "opus" }) + "\n",
        "utf8",
      );
      const adapter = new ClaudeStreamAdapter("claude", {
        spawnFn,
        configPath,
      });

      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "First",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      expect(calls[0]?.args).not.toContain("--effort");
      expect(calls[0]?.args).toContain("--model");
      expect(calls[0]?.args).toContain("opus");

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');
      await expect(turn).resolves.toEqual({
        text: "ONE",
        sessionId: "session-123",
      });

      // Control: a compatible effort still reaches the CLI unchanged.
      const compatibleHarness = createSpawnHarness();
      await writeFile(
        configPath,
        JSON.stringify({ engine: "claude", approvalMode: "normal", effort: "high", model: "opus" }) + "\n",
        "utf8",
      );
      const compatibleAdapter = new ClaudeStreamAdapter("claude", {
        spawnFn: compatibleHarness.spawnFn,
        configPath,
      });
      const compatibleTurn = compatibleAdapter.sendUserMessage("telegram-12345", {
        text: "First",
        files: [],
      });
      await waitFor(() => compatibleHarness.children.length === 1 && compatibleHarness.children[0].stdin.lines.length === 1);
      expect(compatibleHarness.calls[0]?.args).toContain("--effort");
      expect(compatibleHarness.calls[0]?.args).toContain("high");
      compatibleHarness.children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-456"}\n');
      compatibleHarness.children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-456"}\n');
      await expect(compatibleTurn).resolves.toEqual({
        text: "TWO",
        sessionId: "session-456",
      });
    } finally {
      consoleError.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("sweeps stale alias keys from the worker map when a turn re-keys the session", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const workers = (adapter as unknown as { workers: Map<string, unknown> }).workers;

    const first = adapter.sendUserMessage("telegram-12345", {
      text: "First",
      files: [],
    });
    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-1"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-1"}\n');
    await expect(first).resolves.toEqual({
      text: "ONE",
      sessionId: "session-1",
    });
    expect([...workers.keys()]).toEqual(["session-1"]);

    // Simulate a stale alias left behind by an earlier re-key (the reconfigure
    // path re-keys a resumed worker under its engine-reported session id, so the
    // caller's key and the map key can diverge and strand old entries).
    workers.set("session-0", workers.get("session-1")!);

    const second = adapter.sendUserMessage("session-1", {
      text: "Second",
      files: [],
    });
    await waitFor(() => children[0].stdin.lines.length === 2);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-2"}\n');
    await expect(second).resolves.toEqual({
      text: "TWO",
      sessionId: "session-2",
    });

    // The same live process re-keys to the new session id; every other key that
    // pointed at this worker (current AND stale aliases) must be gone.
    expect(children).toHaveLength(1);
    expect([...workers.keys()]).toEqual(["session-2"]);
  });

  it("reaps an idle Claude worker after the configured TTL and resumes on the next turn", async () => {
    vi.useFakeTimers();
    const { children, calls, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      idleWorkerTtlMs: 10,
      idleSweepIntervalMs: 5,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "First",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');
      await expect(first).resolves.toEqual({
        text: "ONE",
        sessionId: "session-123",
      });

      await vi.advanceTimersByTimeAsync(20);

      const second = adapter.sendUserMessage("session-123", {
        text: "Second",
        files: [],
      });

      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      expect(calls[1]?.args).toContain("-r");
      expect(calls[1]?.args).toContain("session-123");
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({
        text: "TWO",
      });
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("does not reap a Claude worker while a turn is in flight", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      idleWorkerTtlMs: 10,
      idleSweepIntervalMs: 5,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Long task",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      await vi.advanceTimersByTimeAsync(100);

      const second = adapter.sendUserMessage("telegram-67890", {
        text: "Another session",
        files: [],
      });
      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-456"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-456"}\n');

      await expect(first).resolves.toEqual({
        text: "ONE",
        sessionId: "session-123",
      });
      await expect(second).resolves.toEqual({
        text: "TWO",
        sessionId: "session-456",
      });
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("resumes an existing Claude session when there is no live worker", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const resultPromise = adapter.sendUserMessage("session-abc", {
      text: "Resume",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    expect(calls[0]?.args).toEqual([
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
      "-r",
      "session-abc",
    ]);
    expect(calls[0]?.options.windowsHide).toBe(true);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-abc"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"READY","session_id":"session-abc"}\n');

    await expect(resultPromise).resolves.toEqual({
      text: "READY",
    });
  });

  it("can opt out of Claude AskUserQuestion for plain transports", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      disallowedTools: ["AskUserQuestion"],
    });

    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Do not ask interactively",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    expect(calls[0]?.args).toContain("--disallowedTools");
    expect(calls[0]?.args).toContain("AskUserQuestion");
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"session-123"}\n');

    await expect(resultPromise).resolves.toEqual({
      text: "OK",
      sessionId: "session-123",
    });
  });

  it("runs resumed Claude sessions in the selected workspace override", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const botWorkspace = path.join(root, "bot-workspace");
    const resumedWorkspace = path.join(root, "resumed-project");

    try {
      const adapter = new ClaudeStreamAdapter("claude", {
        spawnFn,
        workspacePath: botWorkspace,
      });

      const resultPromise = adapter.sendUserMessage("session-abc", {
        text: "Resume",
        files: [],
        workspaceOverride: resumedWorkspace,
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      expect(calls[0]?.options.cwd).toBe(resumedWorkspace);
      expect(calls[0]?.args).toContain("--add-dir");
      expect(calls[0]?.args).toContain(resumedWorkspace);
      expect(calls[0]?.args).not.toContain(botWorkspace);

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-abc"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"READY","session_id":"session-abc"}\n');

      await expect(resultPromise).resolves.toEqual({
        text: "READY",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("restarts the worker when instructions or approval mode change", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");
    const configPath = path.join(root, "config.json");
    const workspacePath = path.join(root, "workspace");

    try {
      await writeFile(instructionsPath, "You are v1.", "utf8");
      await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");

      const adapter = new ClaudeStreamAdapter("claude", {
        spawnFn,
        instructionsPath,
        configPath,
        workspacePath,
      });

      const first = adapter.sendUserMessage("telegram-12345", {
        text: "First",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"ONE","session_id":"session-123"}\n');
      const firstResult = await first;
      expect(firstResult.sessionId).toBe("session-123");

      await writeFile(instructionsPath, "You are v2.", "utf8");
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }) + "\n", "utf8");

      const second = adapter.sendUserMessage("session-123", {
        text: "Second",
        files: [],
      });

      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      expect(calls[1]?.args).not.toContain("--system-prompt");
      expect(calls[1]?.args).not.toContain("--append-system-prompt");
      expect(calls[1]?.args).toContain("--append-system-prompt-file");
      const secondPromptFilePath = calls[1]?.args[calls[1].args.indexOf("--append-system-prompt-file") + 1];
      expect(secondPromptFilePath).toBeTruthy();
      await expect(readFile(secondPromptFilePath!, "utf8")).resolves.toContain("You are v2.");
      expect(calls[1]?.args.join(" ")).not.toContain("You are v2.");
      const secondTurn = JSON.parse(children[1].stdin.lines[0] ?? "{}");
      expect(secondTurn.message.content[0].text).toBe("Second");
      expect(calls[1]?.args).toContain("--permission-mode");
      expect(calls[1]?.args).toContain("bypassPermissions");
      expect(calls[1]?.args).toContain("-r");
      expect(calls[1]?.args).toContain("session-123");

      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({ text: "TWO" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("merges bridge instructions with instance agent instructions", async () => {
    const { children, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "You are v1.", "utf8");
      const adapter = new ClaudeStreamAdapter("claude", {
        spawnFn,
        instructionsPath,
      });

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        instructions: "[Telegram Bridge Capabilities]\nUse file blocks.",
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      expect(calls[0]?.args).not.toContain("--system-prompt");
      expect(calls[0]?.args).not.toContain("--append-system-prompt");
      expect(calls[0]?.args).toContain("--append-system-prompt-file");
      const promptFilePath = calls[0]?.args[calls[0].args.indexOf("--append-system-prompt-file") + 1];
      expect(promptFilePath).toBeTruthy();
      const promptFile = await readFile(promptFilePath!, "utf8");
      expect(promptFile).toContain("You are v1.");
      expect(promptFile).toContain("[Telegram Bridge Capabilities]");
      const turn = JSON.parse(children[0].stdin.lines[0] ?? "{}");
      expect(turn.message.content[0].text).toBe("Hello");

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"session-123"}\n');
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects structured error results", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Fail",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":true,"result":"Permission denied","session_id":"session-123"}\n');

    await expect(resultPromise).rejects.toThrow("Permission denied");
  });

  it("does not reject with an empty error for empty structured error results", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Fail",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"error","is_error":true,"result":"","session_id":"session-123"}\n');

    await expect(resultPromise).rejects.toThrow("Claude reported an error");
  });

  it("surfaces stderr when Claude stream exits before completing a turn", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Fail",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stderr.emitData("No deferred tool marker found in the resumed session.");
    children[0].close(1);

    await expect(resultPromise).rejects.toThrow(/No deferred tool marker/);
  });

  it("routes Claude stdio permission requests through the Telegram approval callback", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const approvalRequest = vi.fn().mockResolvedValue({ behavior: "allow", scope: "once" });
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Use a tool",
      files: [],
      onApprovalRequest: approvalRequest,
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData(JSON.stringify({
      type: "control_request",
      request_id: "approval-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Write",
        input: { file_path: "/tmp/a.txt", content: "hello" },
        cwd: "/tmp/workspace",
      },
    }) + "\n");

    await waitFor(() => children[0].stdin.lines.length === 2);
    expect(approvalRequest).toHaveBeenCalledWith(expect.objectContaining({
      engine: "claude",
      toolName: "Write",
      toolInput: { file_path: "/tmp/a.txt", content: "hello" },
      cwd: "/tmp/workspace",
      sessionId: "session-123",
    }));
    expect(JSON.parse(children[0].stdin.lines[1] ?? "{}")).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "approval-1",
        response: {
          behavior: "allow",
          updatedInput: { file_path: "/tmp/a.txt", content: "hello" },
        },
      },
    });

    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"session-123"}\n');
    await expect(resultPromise).resolves.toEqual({
      text: "DONE",
      sessionId: "session-123",
    });
  });

  it("coalesces overlapping identical stdio approval requests", async () => {
    const { children, spawnFn } = createSpawnHarness();
    let resolveDecision!: (decision: { behavior: "deny" }) => void;
    const decision = new Promise<{ behavior: "deny" }>((resolve) => {
      resolveDecision = resolve;
    });
    const approvalRequest = vi.fn(() => decision);
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });
    const resultPromise = adapter.sendUserMessage("telegram-12345", {
      text: "Use a tool",
      files: [],
      onApprovalRequest: approvalRequest,
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    const request = (requestId: string) => JSON.stringify({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /tmp/example" },
      },
    }) + "\n";
    children[0].stdout.emitData(request("approval-1"));
    children[0].stdout.emitData(request("approval-2"));
    await waitFor(() => approvalRequest.mock.calls.length === 1);
    resolveDecision({ behavior: "deny" });
    await waitFor(() => children[0].stdin.lines.length === 3);

    expect(approvalRequest).toHaveBeenCalledTimes(1);
    expect(children[0].stdin.lines.slice(1).map((line) => JSON.parse(line).response.request_id).sort()).toEqual([
      "approval-1",
      "approval-2",
    ]);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"session-123"}\n');
    await expect(resultPromise).resolves.toMatchObject({ text: "DONE" });
  });

  it("routes AskUserQuestion through the callback even in full-auto mode", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    const answeredInput = {
      questions: [
        {
          question: "Choose one?",
          header: "Choice",
          multiSelect: false,
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
        },
      ],
      answers: {
        "Choose one?": "A",
      },
    };
    const approvalRequest = vi.fn().mockResolvedValue({
      behavior: "allow",
      updatedInput: answeredInput,
    });
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      configPath,
    });

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }) + "\n", "utf8");
      const resultPromise = adapter.sendUserMessage("telegram-12345", {
        text: "Ask me",
        files: [],
        onApprovalRequest: approvalRequest,
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "control_request",
        request_id: "question-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Choose one?",
                header: "Choice",
                multiSelect: false,
                options: [
                  { label: "A", description: "First" },
                  { label: "B", description: "Second" },
                ],
              },
            ],
          },
        },
      }) + "\n");

      await waitFor(() => children[0].stdin.lines.length === 2);
      expect(approvalRequest).toHaveBeenCalledTimes(1);
      expect(JSON.parse(children[0].stdin.lines[1] ?? "{}")).toEqual({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "question-1",
          response: {
            behavior: "allow",
            updatedInput: answeredInput,
          },
        },
      });

      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"session-123"}\n');
      await expect(resultPromise).resolves.toEqual({
        text: "DONE",
        sessionId: "session-123",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("emits structured Claude stream events for tools, text, permission, and result", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Use tools",
      files: [],
      onApprovalRequest: vi.fn().mockResolvedValue({ behavior: "deny" }),
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "I should inspect files" },
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "Working..." },
        ],
      },
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "control_request",
      request_id: "approval-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /tmp/example" },
      },
    }) + "\n");

    await waitFor(() => children[0].stdin.lines.length === 2);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"session-123"}\n');
    await promise;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session", sessionId: "session-123" }),
      expect.objectContaining({ type: "thinking", text: "I should inspect files", sessionId: "session-123" }),
      expect.objectContaining({ type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, sessionId: "session-123" }),
      expect.objectContaining({ type: "assistant_text", text: "Working...", sessionId: "session-123" }),
      expect.objectContaining({ type: "permission_request", toolName: "Bash", toolInput: { command: "rm -rf /tmp/example" }, sessionId: "session-123" }),
      expect.objectContaining({ type: "result", text: "DONE", sessionId: "session-123" }),
    ]));
  });

  it("emits Claude background task notifications after the original turn has resolved", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Run in background",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
    await expect(promise).resolves.toEqual({
      text: "Started in the background.",
      sessionId: "session-123",
    });

    children[0].stdout.emitData(JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "The background command completed successfully.",
      session_id: "session-123",
      origin: { kind: "task-notification" },
    }) + "\n");

    await waitFor(() => events.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "task_notification"
    ));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task_notification",
        text: "The background command completed successfully.",
        sessionId: "session-123",
      }),
    ]));
    expect(events.filter((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "task_notification"
    )).toHaveLength(1);
  });

  it("does not retain foreground Bash calls that Claude temporarily promotes to tasks", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Run a foreground command",
        files: [],
        instructions: "original instructions",
        onEngineEvent: (event) => {
          events.push(event);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-foreground",
            name: "Bash",
            input: { command: "sleep 5; printf done" },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      // Claude 2.1.222 emits this lifecycle for foreground Bash calls that
      // exceed its short synchronous wait, even without run_in_background.
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-foreground","tool_use_id":"toolu-foreground","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-foreground","tool_use_id":"toolu-foreground","status":"completed","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "toolu-foreground",
            content: "done",
            is_error: false,
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Foreground answer.","session_id":"session-123"}\n');
      await first;

      expect(events.some((event) => event.type === "background_task_started")).toBe(false);
      expect(events.some((event) => event.type === "task_notification")).toBe(false);

      // A phantom background task used to reject this settings change for six
      // hours. With no detached work, the adapter can replace the idle worker.
      const second = adapter.sendUserMessage("session-123", {
        text: "Use the new instructions",
        files: [],
        instructions: "changed instructions",
      });
      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Reconfigured.","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({ text: "Reconfigured." });
    } finally {
      adapter.destroy();
    }
  });

  it("retains tasks whose tool call explicitly requests background execution", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: Array<{ type?: string; taskId?: string }> = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    try {
      const turn = adapter.sendUserMessage("telegram-12345", {
        text: "Run in background",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "toolu-background",
            name: "Bash",
            input: { command: "sleep 5", run_in_background: true },
          }],
        },
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-background","tool_use_id":"toolu-background","task_type":"local_bash","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started.","session_id":"session-123"}\n');
      await turn;

      expect(events).toContainEqual(expect.objectContaining({
        type: "background_task_started",
        taskId: "task-background",
      }));

      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-background","tool_use_id":"toolu-background","status":"completed","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Background done.","session_id":"session-123","origin":{"kind":"task-notification"}}\n');
      await waitFor(() => events.some((event) => event.type === "task_notification"));
      expect(events).toContainEqual(expect.objectContaining({
        type: "task_notification",
        taskId: "task-background",
      }));
    } finally {
      adapter.destroy();
    }
  });

  it("emits Claude background task notifications when the task result is empty but metadata has a summary", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Run in background",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
    await expect(promise).resolves.toEqual({
      text: "Started in the background.",
      sessionId: "session-123",
    });

    children[0].stdout.emitData(JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-empty",
      status: "completed",
      summary: "Background audit finished.",
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      task_id: "task-empty",
      session_id: "session-123",
      origin: { kind: "task-notification" },
    }) + "\n");

    await waitFor(() => events.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "task_notification"
    ));
    expect(events).toContainEqual(expect.objectContaining({
      type: "task_notification",
      text: "Background audit finished.",
      taskId: "task-empty",
      status: "completed",
    }));
  });

  it("does not describe a stopped Claude background task with an empty result as completed", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Run in background",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
    await expect(promise).resolves.toEqual({
      text: "Started in the background.",
      sessionId: "session-123",
    });

    children[0].stdout.emitData(JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-stopped",
      status: "stopped",
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      task_id: "task-stopped",
      session_id: "session-123",
      origin: { kind: "task-notification" },
    }) + "\n");

    await waitFor(() => events.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "task_notification"
    ));
    expect(events).toContainEqual(expect.objectContaining({
      type: "task_notification",
      text: "Background task stopped.",
      taskId: "task-stopped",
      status: "stopped",
    }));
  });

  it("does not resolve an active user turn with a Claude background task notification result", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const first = adapter.sendUserMessage("telegram-12345", {
      text: "Start background work",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
    await first;

    const second = adapter.sendUserMessage("session-123", {
      text: "Meanwhile, answer this",
      files: [],
      onEngineEvent: (event) => {
        events.push(event);
      },
    });

    await waitFor(() => children[0].stdin.lines.length === 2);
    children[0].stdout.emitData(JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "The background command completed successfully." },
        ],
      },
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "The background command completed successfully.",
      session_id: "session-123",
      origin: { kind: "task-notification" },
    }) + "\n");

    let secondResolved = false;
    void second.then(() => {
      secondResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondResolved).toBe(false);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task_notification",
        text: "The background command completed successfully.",
        taskId: "task-1",
        status: "completed",
        sessionId: "session-123",
      }),
    ]));

    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Current turn answer.","session_id":"session-123"}\n');
    await expect(second).resolves.toEqual({
      text: "Current turn answer.",
    });
  });

  it("settles the active turn when its own background task completion is the terminal output", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const events: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    try {
      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Run a long audit workflow",
        files: [],
        onEngineEvent: (event) => {
          events.push(event);
        },
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-123"}\n');
      children[0].stdout.emitData(JSON.stringify({
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        status: "completed",
        session_id: "session-123",
        summary: "Audit complete",
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "# Audit complete\n\nFull background report.",
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");

      await vi.advanceTimersByTimeAsync(1600);

      await expect(promise).resolves.toEqual({
        text: "# Audit complete\n\nFull background report.",
        sessionId: "session-123",
      });
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "task_notification",
          taskId: "task-1",
          status: "completed",
          text: "# Audit complete\n\nFull background report.",
          settlesCurrentTurn: true,
        }),
        expect.objectContaining({
          type: "result",
          text: "# Audit complete\n\nFull background report.",
          sessionId: "session-123",
        }),
      ]));
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("routes Claude background task notifications to the turn that started the task", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const first = adapter.sendUserMessage("telegram-12345", {
      text: "Start background work",
      files: [],
      onEngineEvent: (event) => {
        firstEvents.push(event);
      },
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
    await first;

    const second = adapter.sendUserMessage("session-123", {
      text: "New chat context on the same session",
      files: [],
      onEngineEvent: (event) => {
        secondEvents.push(event);
      },
    });

    await waitFor(() => children[0].stdin.lines.length === 2);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Current turn answer.","session_id":"session-123"}\n');
    await second;

    children[0].stdout.emitData(JSON.stringify({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      session_id: "session-123",
    }) + "\n");
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "The background command completed successfully.",
      session_id: "session-123",
      origin: { kind: "task-notification" },
    }) + "\n");

    await waitFor(() => firstEvents.some((event) =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "task_notification"
    ));
    expect(firstEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task_notification",
        text: "The background command completed successfully.",
        taskId: "task-1",
        sessionId: "session-123",
      }),
    ]));
    expect(secondEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task_notification",
      }),
    ]));
  });

  it("does not reap idle Claude workers while background tasks are active", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      idleWorkerTtlMs: 10,
      idleSweepIntervalMs: 5,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Start background work",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
      await first;

      await vi.advanceTimersByTimeAsync(20);

      const second = adapter.sendUserMessage("session-123", {
        text: "Still same worker",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 2);
      children[0].stdout.emitData(JSON.stringify({
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        status: "completed",
        session_id: "session-123",
      }) + "\n");
      children[0].stdout.emitData(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "The background command completed successfully.",
        session_id: "session-123",
        origin: { kind: "task-notification" },
      }) + "\n");
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Current turn answer.","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({
        text: "Current turn answer.",
      });
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("does not reconfigure a Claude worker while background tasks are active", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const first = adapter.sendUserMessage("telegram-12345", {
      text: "Start background work",
      files: [],
      instructions: "original instructions",
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
    await first;

    // Precise, non-alarming wording (classified engine-busy, not engine-cli):
    // a live background task blocks the reconfigure; restarting does not help.
    await expect(adapter.sendUserMessage("session-123", {
      text: "New instructions",
      files: [],
      instructions: "changed instructions",
    })).rejects.toThrow(/background task still running/);
    await waitFor(() => children.length === 1);
  });

  it("clears background tasks when a foreground result arrives between task notification events", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      idleWorkerTtlMs: 10,
      idleSweepIntervalMs: 5,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Start background work",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
      await first;

      const second = adapter.sendUserMessage("session-123", {
        text: "Foreground turn",
        files: [],
      });

      await waitFor(() => children[0].stdin.lines.length === 2);
      children[0].stdout.emitData('{"type":"system","subtype":"task_notification","task_id":"task-1","status":"completed","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Foreground answer.","session_id":"session-123"}\n');
      await second;
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Background done.","task_id":"task-1","session_id":"session-123","origin":{"kind":"task-notification"}}\n');

      await vi.advanceTimersByTimeAsync(20);

      const third = adapter.sendUserMessage("session-123", {
        text: "After cleanup",
        files: [],
      });

      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Fresh worker.","session_id":"session-123"}\n');
      await third;
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("prunes stale Claude background tasks so never-complete tasks do not pin workers forever", async () => {
    vi.useFakeTimers();
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
      idleWorkerTtlMs: 10,
      idleSweepIntervalMs: 5,
      backgroundTaskMaxAgeMs: 15,
    });

    try {
      const first = adapter.sendUserMessage("telegram-12345", {
        text: "Start background work",
        files: [],
      });

      await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"system","subtype":"task_started","task_id":"task-1","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Started in the background.","session_id":"session-123"}\n');
      await first;

      await vi.advanceTimersByTimeAsync(30);

      const second = adapter.sendUserMessage("session-123", {
        text: "After stale task cleanup",
        files: [],
      });

      await waitFor(() => children.length === 2 && children[1].stdin.lines.length === 1);
      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"Fresh worker.","session_id":"session-123"}\n');
      await second;
    } finally {
      adapter.destroy();
      vi.useRealTimers();
    }
  });

  it("keeps intermediate send-file tags when the final Claude result only summarizes delivery", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Generate files",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"Ready. [send-file:/tmp/a.png]"}]},"session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"I sent the image.","session_id":"session-123"}\n');

    await expect(promise).resolves.toEqual({
      text: "Ready. [send-file:/tmp/a.png]\nI sent the image.",
      sessionId: "session-123",
    });
  });

  it("keeps intermediate send-image tags when the final Claude result only summarizes delivery", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Generate a cover image",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"assistant","message":{"content":[{"type":"text","text":"Ready. [send-image:/tmp/cover.png]"}]},"session_id":"session-123"}\n');
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"I sent the image.","session_id":"session-123"}\n');

    await expect(promise).resolves.toEqual({
      text: "Ready. [send-image:/tmp/cover.png]\nI sent the image.",
      sessionId: "session-123",
    });
  });

  it("does not time out — engine runs until completion", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Long task",
      files: [],
    });

    await waitFor(() => children.length === 1 && children[0].stdin.lines.length === 1);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"done after a long time","session_id":"session-long"}\n');

    await expect(promise).resolves.toEqual({
      text: "done after a long time",
      sessionId: "session-long",
    });
  });
});
