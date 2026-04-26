import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ClaudeStreamAdapter } from "../src/codex/claude-stream-adapter.js";

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
      expect(calls[1]?.args).toContain("--system-prompt");
      expect(calls[1]?.args).toContain("You are v2.");
      expect(calls[1]?.args).toContain("--permission-mode");
      expect(calls[1]?.args).toContain("bypassPermissions");
      expect(calls[1]?.args).toContain("-r");
      expect(calls[1]?.args).toContain("session-123");

      children[1].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[1].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"TWO","session_id":"session-123"}\n');
      await expect(second).resolves.toEqual({ text: "TWO" });
    } finally {
      await rm(root, { recursive: true, force: true });
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
      const systemPromptIndex = calls[0]?.args.indexOf("--system-prompt") ?? -1;
      expect(systemPromptIndex).toBeGreaterThan(-1);
      expect(calls[0]?.args[systemPromptIndex + 1]).toContain("You are v1.");
      const appendIndex = calls[0]?.args.indexOf("--append-system-prompt") ?? -1;
      expect(appendIndex).toBeGreaterThan(-1);
      expect(calls[0]?.args[appendIndex + 1]).toContain("[Telegram Bridge Capabilities]");

      children[0].stdout.emitData('{"type":"system","subtype":"init","session_id":"session-123"}\n');
      children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"session-123"}\n');
      await promise;
    } finally {
      await rm(root, { recursive: true, force: true });
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

  it("does not time out — engine runs until completion", async () => {
    const { children, spawnFn } = createSpawnHarness();
    const adapter = new ClaudeStreamAdapter("claude", {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Long task",
      files: [],
    });

    expect(children).toHaveLength(1);
    children[0].stdout.emitData('{"type":"result","subtype":"success","is_error":false,"result":"done after a long time","session_id":"session-long"}\n');

    await expect(promise).resolves.toEqual({
      text: "done after a long time",
      sessionId: "session-long",
    });
  });
});
