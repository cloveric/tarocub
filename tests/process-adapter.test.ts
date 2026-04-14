import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ProcessCodexAdapter } from "../src/codex/process-adapter.js";

async function waitForSpawn(calls: Array<unknown>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (calls.length > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Codex process was not spawned in time");
}

describe("ProcessCodexAdapter", () => {
  it("creates a logical telegram session placeholder", async () => {
    const adapter = new ProcessCodexAdapter("codex");
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "telegram-12345",
    });
  });

  it("inherits CODEX_HOME from the parent env so bots track the main CLI", async () => {
    const original = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/codex-shared-test";
    try {
      const adapter = new ProcessCodexAdapter("codex") as unknown as { childEnv: NodeJS.ProcessEnv };
      expect(adapter.childEnv.CODEX_HOME).toBe("/tmp/codex-shared-test");
    } finally {
      if (original === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = original;
      }
    }
  });

  it("passes attachments into the generated prompt", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { stdio: ["pipe", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv; windowsHide?: boolean };
    }> = [];
    const child = new FakeChildProcess();
    const spawnCodex = (
      command: string,
      args: string[],
      options: { stdio: ["pipe", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv; windowsHide?: boolean },
    ) => {
      calls.push({ command, args, options });
      return child;
    };

    const adapter = new ProcessCodexAdapter("codex", spawnCodex);
    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: ["a.png", "b.pdf"],
    });

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
    child.close(0);

    await promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "codex",
      args: ["exec", "--json", "--skip-git-repo-check", "-"],
      options: { stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true },
    });
    expect(child.stdin.writes.join("")).toBe("Hello\nAttachment: a.png\nAttachment: b.pdf");
    expect(child.stdin.ended).toBe(true);
    expect(calls[0]?.options.env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it("normalizes quoted Windows codex.cmd paths before invoking cmd.exe", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      options: { stdio: ["pipe", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv; windowsHide?: boolean };
    }> = [];
    const child = new FakeChildProcess();
    const spawnCodex = (
      command: string,
      args: string[],
      options: { stdio: ["pipe", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv; windowsHide?: boolean },
    ) => {
      calls.push({ command, args, options });
      return child;
    };

    const adapter = new ProcessCodexAdapter('"C:\\Users\\hangw\\AppData\\Roaming\\npm\\codex.cmd"', spawnCodex);
    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
    child.close(0);
    await promise;

    expect(calls[0]?.command.toLowerCase()).toContain("cmd");
    expect(calls[0]?.args.slice(0, 5)).toEqual([
      "/d",
      "/s",
      "/c",
      "C:\\Users\\hangw\\AppData\\Roaming\\npm\\codex.cmd",
      "exec",
    ]);
    expect(calls[0]?.args.at(-1)).toBe("-");
    expect(child.stdin.writes.join("")).toBe("Hello");
    expect(calls[0]?.options.windowsHide).toBe(true);
  });

  it("pipes multiline prompts through stdin for PowerShell shim executables", async () => {
    const { spawnCodex, child, calls } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("C:\\Users\\hangw\\AppData\\Roaming\\npm\\codex.ps1", spawnCodex);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "生成一个文件并传给我",
      files: [],
      instructions: "[Codex Telegram-Out Contract]\nWrite output files to C:\\tmp\\out",
    });
    await waitForSpawn(calls);

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
    child.close(0);
    await promise;

    expect(calls[0]?.command.toLowerCase()).toContain("pwsh");
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      "-NoProfile",
      "-File",
      "C:\\Users\\hangw\\AppData\\Roaming\\npm\\codex.ps1",
      "exec",
    ]);
    expect(calls[0]?.args.at(-1)).toBe("-");
    expect(child.stdin.writes.join("")).toContain("[Codex Telegram-Out Contract]");
    expect(child.stdin.writes.join("")).toContain("生成一个文件并传给我");
    expect(child.stdin.ended).toBe(true);
  });

  it("returns trimmed stdout when codex exits successfully", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData(
      '{"type":"item.completed","item":{"type":"agent_message","text":"  answer from codex  "}}\n',
    );
    child.close(0);

    await expect(promise).resolves.toEqual({ text: "answer from codex" });
  });

  it("does not emit pseudo-streaming progress from completed agent messages", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);
    const progressUpdates: string[] = [];

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
      onProgress: (text) => progressUpdates.push(text),
    });

    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"partial-but-complete"}}\n');
    child.close(0);

    await expect(promise).resolves.toEqual({ text: "partial-but-complete" });
    expect(progressUpdates).toEqual([]);
  });

  it("falls back when codex returns empty stdout", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Session thread-123 completed.",
    });
  });

  it("returns a newly created thread id on the first real user message", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"Hello back"}}\n');
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Hello back",
      sessionId: "thread-123",
    });
  });

  it("rejects with stderr text on nonzero exit", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.stderr.emitData("codex failed\n");
    child.close(2);

    await expect(promise).rejects.toThrow("codex failed");
  });

  it("prefers structured turn failure messages over stderr noise", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"error","message":"Reconnecting... 5/5"}\n');
    child.stdout.emitData('{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}\n');
    child.stderr.emitData("codex internal logs\n");
    child.close(1);

    await expect(promise).rejects.toThrow("unexpected status 401 Unauthorized");
  });

  it("prepends instance instructions from agent.md when present", async () => {
    const { spawnCodex, child, calls } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "You are bot alpha.", "utf8");
      const adapter = new ProcessCodexAdapter("codex", undefined, spawnCodex, instructionsPath);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });
      await waitForSpawn(calls);

      child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
      child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
      child.close(0);
      await promise;

      expect(calls[0]?.args[3]).toBe("-");
      expect(child.stdin.writes.join("")).toContain("You are bot alpha.\n---\nHello");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges bridge instructions with instance agent instructions", async () => {
    const { spawnCodex, child, calls } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "You are bot alpha.", "utf8");
      const adapter = new ProcessCodexAdapter("codex", undefined, spawnCodex, instructionsPath);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        instructions: "[Telegram Bridge Capabilities]\nUse file blocks.",
      });
      await waitForSpawn(calls);

      child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
      child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
      child.close(0);
      await promise;

      expect(calls[0]?.args[3]).toBe("-");
      expect(child.stdin.writes.join("")).toContain("You are bot alpha.");
      expect(child.stdin.writes.join("")).toContain("[Telegram Bridge Capabilities]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("truncates oversized instructions and degrades safely on read failure", async () => {
    const { spawnCodex, child, calls } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-telegram-channel-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "x".repeat(20_000), "utf8");
      const adapter = new ProcessCodexAdapter("codex", undefined, spawnCodex, instructionsPath);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });
      await waitForSpawn(calls);

      child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
      child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
      child.close(0);
      await promise;

      expect(calls[0]?.args[3]).toBe("-");
      expect(child.stdin.writes.join("")).toContain("[Instructions truncated at 16000 characters]");
      expect(child.stdin.writes.join("").length).toBeLessThan(17_000);

      const { spawnCodex: secondSpawn, child: secondChild, calls: secondCalls } = createSpawnHarness();
      const brokenAdapter = new ProcessCodexAdapter("codex", undefined, secondSpawn, path.join(root, "missing.md"));
      const secondPromise = brokenAdapter.sendUserMessage("telegram-12345", {
        text: "Hello again",
        files: [],
      });
      await waitForSpawn(secondCalls);

      secondChild.stdout.emitData('{"type":"thread.started","thread_id":"thread-456"}\n');
      secondChild.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
      secondChild.close(0);
      await secondPromise;

      expect(secondCalls[0]?.args[3]).toBe("-");
      expect(secondChild.stdin.writes.join("")).toBe("Hello again");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

class FakeStream extends EventEmitter {
  emitData(chunk: string) {
    this.emit("data", chunk);
  }
}

class FakeChildProcess extends EventEmitter {
  stdin = {
    writes: [] as string[],
    ended: false,
    write: (chunk: string) => {
      this.stdin.writes.push(chunk);
      return true;
    },
    end: (chunk?: string) => {
      if (chunk) {
        this.stdin.writes.push(chunk);
      }
      this.stdin.ended = true;
    },
  };
  stdout = new FakeStream();
  stderr = new FakeStream();

  close(code: number | null) {
    this.emit("close", code);
  }
}

function createSpawnHarness() {
  const child = new FakeChildProcess();
  const calls: Array<{
    command: string;
    args: string[];
    options: { stdio: ["pipe", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv; windowsHide?: boolean };
  }> = [];
  const spawnCodex = (
    command: string,
    args: string[],
    options: { stdio: ["pipe", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv; windowsHide?: boolean },
  ) => {
    calls.push({ command, args, options });
    return child;
  };

  return { spawnCodex, child, calls };
}
