import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ProcessClaudeAdapter } from "../src/codex/claude-adapter.js";

async function waitForSpawn(calls: Array<unknown>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (calls.length > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Claude process was not spawned in time");
}

class FakeStream extends EventEmitter {
  emitData(chunk: string) {
    this.emit("data", chunk);
  }
}

class FakeWritable {
  written = "";

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.written += chunk;
    callback?.(null);
    return true;
  }

  end(callback?: () => void): void {
    callback?.();
  }
}

class FakeClaudeChildProcess extends EventEmitter {
  stdin = new FakeWritable();
  stdout = new FakeStream();
  stderr = new FakeStream();

  close(code: number | null) {
    this.emit("close", code);
  }
}

function createSpawnHarness() {
  const child = new FakeClaudeChildProcess();
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

describe("ProcessClaudeAdapter", () => {
  it("creates a logical telegram session placeholder", async () => {
    const adapter = new ProcessClaudeAdapter("claude");
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "telegram-12345",
    });
  });

  it("builds a Claude invocation with instructions, workspace, and resume", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");
    const configPath = path.join(root, "config.json");
    const workspacePath = path.join(root, "workspace");

    try {
      await writeFile(instructionsPath, "You are a reviewer.", "utf8");
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }), "utf8");
      const adapter = new ProcessClaudeAdapter("claude", {
        spawnFn,
        instructionsPath,
        configPath,
        workspacePath,
      });

      const promise = adapter.sendUserMessage("session-123", {
        text: "Review this",
        files: ["a.ts"],
      });
      await waitForSpawn(calls);

      child.stdout.emitData('{"type":"result","result":"Looks good","session_id":"session-123"}');
      child.close(0);

      await expect(promise).resolves.toEqual({
        text: "Looks good",
        sessionId: "session-123",
      });
      expect(calls[0]?.command).toBe("claude");
      expect(calls[0]?.args).toEqual([
        "-p",
        "--output-format",
        "json",
        "--system-prompt",
        "You are a reviewer.",
        "-r",
        "session-123",
        "--permission-mode",
        "bypassPermissions",
        "--add-dir",
        workspacePath,
      ]);
      expect(calls[0]?.options.cwd).toBe(workspacePath);
      expect(calls[0]?.options.windowsHide).toBe(true);
      expect(child.stdin.written).toBe("Review this\nAttachment: a.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges bridge instructions with instance agent instructions", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "You are a reviewer.", "utf8");
      const adapter = new ProcessClaudeAdapter("claude", {
        spawnFn,
        instructionsPath,
      });

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        instructions: "[Telegram Bridge Capabilities]\nUse file blocks.",
      });
      await waitForSpawn(calls);

      child.stdout.emitData('{"type":"result","result":"ok","session_id":"session-abc"}');
      child.close(0);
      await promise;

      expect(calls[0]?.args).toContain("--system-prompt");
      const systemPrompt = calls[0]?.args[calls[0].args.indexOf("--system-prompt") + 1];
      expect(systemPrompt).toContain("You are a reviewer.");
      expect(calls[0]?.args).toContain("--append-system-prompt");
      const appendPrompt = calls[0]?.args[calls[0].args.indexOf("--append-system-prompt") + 1];
      expect(appendPrompt).toContain("[Telegram Bridge Capabilities]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes quoted Windows claude.cmd paths", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter('"C:\\Users\\hangw\\AppData\\Roaming\\npm\\claude.cmd"', {
      spawnFn,
    });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"result","result":"ok","session_id":"session-abc"}');
    child.close(0);
    await promise;

    expect(calls[0]?.command.toLowerCase()).toContain("cmd");
    expect(calls[0]?.args.slice(0, 5)).toEqual([
      "/d",
      "/s",
      "/c",
      "C:\\Users\\hangw\\AppData\\Roaming\\npm\\claude.cmd",
      "-p",
    ]);
    expect(calls[0]?.options.windowsHide).toBe(true);
  });

  it("rejects when Claude returns is_error instead of resolving as text", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"result","is_error":true,"result":"auth expired"}');
    child.close(0);

    await expect(promise).rejects.toThrow("auth expired");
  });

  it("parses Claude JSON array output and returns the result event text", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData(JSON.stringify([
      { type: "system", subtype: "init", session_id: "session-123" },
      { type: "assistant", message: { content: [{ type: "text", text: "intermediate" }] } },
      { type: "result", result: "Looks good", session_id: "session-123" },
    ]));
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Looks good",
      sessionId: "session-123",
    });
  });

  it("falls back to visible assistant text when the result event is empty", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData(JSON.stringify([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello from assistant" }] },
        session_id: "session-abc",
      },
      { type: "result", result: "", session_id: "session-abc" },
    ]));
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Hello from assistant",
      sessionId: "session-abc",
    });
  });

  it("returns an empty-response message for an empty Claude event array", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData("[]");
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Claude returned an empty response.",
      sessionId: undefined,
    });
  });

  it("surfaces the is_error message even when the process exits with non-zero code", async () => {
    // Claude CLI exits with code 1 on 401 auth errors but still writes the
    // error JSON to stdout. We must resolve with stdout so parseResult() can
    // throw the real message, not "claude exited with code 1".
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", { spawnFn });

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"result","is_error":true,"result":"Failed to authenticate. API Error: 401"}');
    child.close(1);

    await expect(promise).rejects.toThrow(/Failed to authenticate/);
  });

  it("inherits CLAUDE_CONFIG_DIR from the parent env so bots track the main CLI", async () => {
    const original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-shared-test";
    try {
      const adapter = new ProcessClaudeAdapter("claude") as unknown as { childEnv: NodeJS.ProcessEnv };
      expect(adapter.childEnv.CLAUDE_CONFIG_DIR).toBe("/tmp/claude-shared-test");
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = original;
      }
    }
  });

  it("does not trigger multiple promise settlements when error is followed by close", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new ProcessClaudeAdapter("claude", {
      spawnFn,
    });
    let multipleResolve: { type: string } | null = null;
    const handler = (type: string) => {
      multipleResolve = { type };
    };

    process.once("multipleResolves", handler);

    try {
      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      child.emit("error", new Error("boom"));
      child.close(1);

      await expect(promise).rejects.toThrow("boom");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(multipleResolve).toBeNull();
    } finally {
      process.removeListener("multipleResolves", handler);
    }
  });
});
