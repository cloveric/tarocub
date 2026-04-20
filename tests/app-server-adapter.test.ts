import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CODEX_APP_SERVER_TURN_TIMEOUT_MS,
  CodexAppServerAdapter,
} from "../src/codex/app-server-adapter.js";

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
  nextError: Error | null = null;

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    const text = chunk.toString().trim();
    if (text) {
      this.lines.push(text);
    }
    const error = this.nextError;
    this.nextError = null;
    callback?.(error);
    return true;
  }
}

class FakeChildProcess extends EventEmitter {
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
  const child = new FakeChildProcess();
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

describe("CodexAppServerAdapter", () => {
  it("defaults the hard turn timeout to one hour", () => {
    expect(CODEX_APP_SERVER_TURN_TIMEOUT_MS).toBe(60 * 60_000);
  });

  it("creates a logical telegram session placeholder", async () => {
    const adapter = new CodexAppServerAdapter("codex", process.cwd());
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "telegram-12345",
    });
  });

  it("inherits CODEX_HOME from the parent env so bots track the main CLI", async () => {
    const original = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/codex-shared-test";
    try {
      const adapter = new CodexAppServerAdapter("codex", process.cwd()) as unknown as { childEnv: NodeJS.ProcessEnv };
      expect(adapter.childEnv.CODEX_HOME).toBe("/tmp/codex-shared-test");
    } finally {
      if (original === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = original;
      }
    }
  });

  it("starts a persistent thread for a logical session and returns the real thread id", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const progressUpdates: string[] = [];

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: ["a.txt"],
      onProgress: (text) => progressUpdates.push(text),
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    const initialize = JSON.parse(child.stdin.lines[0] ?? "{}");
    expect(initialize.method).toBe("initialize");
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');

    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(threadStart.method).toBe("thread/start");
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart.method).toBe("turn/start");
    expect(turnStart.params.threadId).toBe("thread-123");
    expect(turnStart.params.input).toEqual([
      {
        type: "text",
        text: "Hello\nAttachment: a.txt",
        text_elements: [],
      },
    ]);

    child.stdout.emitData('{"method":"item/agentMessage/delta","params":{"threadId":"thread-123","delta":"READY"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "READY",
      sessionId: "thread-123",
    });
    expect(progressUpdates).toEqual(["READY"]);
    expect(calls[0]?.command).toBe("codex");
    expect(calls[0]?.args).toEqual(["app-server"]);
    expect(calls[0]?.options.windowsHide).toBe(true);
  });

  it("loads instructions from agent.md and isolates CODEX_HOME", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");
    const engineHomePath = path.join(root, "engine-home");

    try {
      await writeFile(instructionsPath, "You are isolated.", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        instructionsPath,
        engineHomePath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);

      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart.params.input[0].text).toBe("[System Instructions]\nYou are isolated.\n[End Instructions]\nHello");
      expect(calls[0]?.options.env?.CODEX_HOME).toBe(engineHomePath);

      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await waitFor(() => child.stdin.lines.length >= 4);
      const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
      expect(threadRead.method).toBe("thread/read");
      child.stdout.emitData('{"id":4,"result":{"thread":{"turns":[{"id":"turn-1","items":[{"type":"agentMessage","text":"READY isolated"}]}]}}}\n');
      await promise;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts app-server in workspace-write mode for full-auto instances", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual(["app-server", "-c", 'sandbox_mode="workspace-write"']);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts app-server in danger-full-access mode for bypass instances", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "bypass" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual(["app-server", "-c", 'sandbox_mode="danger-full-access"']);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards model and effort overrides into app-server startup config", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ model: "gpt-5.3-codex", effort: "max" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual([
        "app-server",
        "-c",
        'model_reasoning_effort="xhigh"',
        "-c",
        'model="gpt-5.3-codex"',
      ]);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for in-flight turns to finish before restarting for config changes", async () => {
    const childA = new FakeChildProcess();
    const childB = new FakeChildProcess();
    const children = [childA, childB];
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnFn = (command: string, args: string[]) => {
      calls.push({ command, args });
      const child = children.shift();
      if (!child) {
        throw new Error("no more fake children");
      }
      return child;
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn as never,
        undefined,
        undefined,
        configPath,
      );

      const firstPromise = adapter.sendUserMessage("telegram-100", {
        text: "First",
        files: [],
      });

      await waitFor(() => childA.stdin.lines.length >= 1);
      const initA = JSON.parse(childA.stdin.lines[0] ?? "{}");
      childA.stdout.emitData(`{"id":${initA.id},"result":{"platformOs":"windows"}}\n`);
      await waitFor(() => childA.stdin.lines.length >= 2);
      const startThreadA = JSON.parse(childA.stdin.lines[1] ?? "{}");
      childA.stdout.emitData(`{"id":${startThreadA.id},"result":{"thread":{"id":"thread-a"}}}\n`);
      await waitFor(() => childA.stdin.lines.length >= 3);

      await writeFile(configPath, JSON.stringify({ approvalMode: "bypass" }) + "\n", "utf8");
      const secondPromise = adapter.sendUserMessage("telegram-200", {
        text: "Second",
        files: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toHaveLength(1);
      expect(childA.killCalls).toBe(0);

      childA.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-a","item":{"type":"agentMessage","text":"first ok"}}}\n');
      childA.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-a","turn":{"id":"turn-a","items":[],"status":"completed","error":null}}}\n');
      await expect(firstPromise).resolves.toEqual({
        text: "first ok",
        sessionId: "thread-a",
      });

      await waitFor(() => childB.stdin.lines.length >= 1);
      expect(childA.killCalls).toBe(1);
      expect(calls[1]?.args).toEqual(["app-server", "-c", 'sandbox_mode="danger-full-access"']);

      const initB = JSON.parse(childB.stdin.lines[0] ?? "{}");
      childB.stdout.emitData(`{"id":${initB.id},"result":{"platformOs":"windows"}}\n`);
      await waitFor(() => childB.stdin.lines.length >= 2);
      const startThreadB = JSON.parse(childB.stdin.lines[1] ?? "{}");
      childB.stdout.emitData(`{"id":${startThreadB.id},"result":{"thread":{"id":"thread-b"}}}\n`);
      await waitFor(() => childB.stdin.lines.length >= 3);
      childB.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-b","item":{"type":"agentMessage","text":"second ok"}}}\n');
      childB.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-b","turn":{"id":"turn-b","items":[],"status":"completed","error":null}}}\n');

      await expect(secondPromise).resolves.toEqual({
        text: "second ok",
        sessionId: "thread-b",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs malformed config files instead of silently swallowing them", async () => {
    const { child, calls, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await writeFile(configPath, "{not-json\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        undefined,
        undefined,
        configPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      expect(calls[0]?.args).toEqual(["app-server"]);
      expect(consoleErrorSpy).toHaveBeenCalled();
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      consoleErrorSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges bridge instructions with instance agent instructions", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "You are isolated.", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        instructionsPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        instructions: "[Telegram Bridge Capabilities]\nUse file blocks.",
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);

      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart.params.input[0].text).toContain("You are isolated.");
      expect(turnStart.params.input[0].text).toContain("[Telegram Bridge Capabilities]");

      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("truncates oversized instructions and degrades safely on read failure", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const instructionsPath = path.join(root, "agent.md");

    try {
      await writeFile(instructionsPath, "x".repeat(20_000), "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        spawnFn,
        instructionsPath,
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitFor(() => child.stdin.lines.length >= 1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => child.stdin.lines.length >= 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
      await waitFor(() => child.stdin.lines.length >= 3);

      const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
      expect(turnStart.params.input[0].text).toContain("[Instructions truncated at 16000 characters]");
      expect(turnStart.params.input[0].text.length).toBeLessThan(17_000);

      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
      await promise;

      const secondHarness = createSpawnHarness();
      const second = new CodexAppServerAdapter(
        "codex",
        process.cwd(),
        undefined,
        secondHarness.spawnFn,
        path.join(root, "missing.md"),
      );
      const secondPromise = second.sendUserMessage("telegram-67890", {
        text: "Hello again",
        files: [],
      });
      await waitFor(() => secondHarness.child.stdin.lines.length >= 1);
      secondHarness.child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
      await waitFor(() => secondHarness.child.stdin.lines.length >= 2);
      secondHarness.child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-456"}}}\n');
      await waitFor(() => secondHarness.child.stdin.lines.length >= 3);
      const secondTurnStart = JSON.parse(secondHarness.child.stdin.lines[2] ?? "{}");
      expect(secondTurnStart.params.input[0].text).toBe("Hello again");
      secondHarness.child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-456","item":{"type":"agentMessage","text":"ok"}}}\n');
      secondHarness.child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-456","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');
      await secondPromise;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses an existing thread without starting a new one", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("thread-abc", {
      text: "Next",
      files: [],
      instructions: "Be concise.",
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');

    await waitFor(() => child.stdin.lines.length >= 2);
    const resume = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(resume.method).toBe("thread/resume");
    expect(resume.params.threadId).toBe("thread-abc");
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-abc"}}}\n');

    await waitFor(() => child.stdin.lines.length >= 3);
    const turnStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(turnStart.method).toBe("turn/start");
    expect(turnStart.params.threadId).toBe("thread-abc");
    expect(turnStart.params.input[0].text).toBe("[System Instructions]\nBe concise.\n[End Instructions]\nNext");

    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');

    await expect(promise).resolves.toEqual({
      text: "done",
    });
  });

  it("does not resume a thread twice once it is loaded", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const first = adapter.sendUserMessage("thread-abc", {
      text: "First",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-abc"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done-1"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await first;

    const second = adapter.sendUserMessage("thread-abc", {
      text: "Second",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 4);
    const nextRequest = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(nextRequest.method).toBe("turn/start");
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-abc","item":{"type":"agentMessage","text":"done-2"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-abc","turn":{"id":"turn-2","items":[],"status":"completed","error":null}}}\n');

    await expect(second).resolves.toEqual({
      text: "done-2",
    });
  });

  it("falls back to thread/read when turn completion arrives before agent text events", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(threadRead.method).toBe("thread/read");
    child.stdout.emitData('{"id":4,"result":{"thread":{"turns":[{"id":"turn-1","items":[{"type":"agentMessage","text":"READY via thread read"}]}]}}}\n');

    await expect(promise).resolves.toEqual({
      text: "READY via thread read",
      sessionId: "thread-123",
    });
  });

  it("rejects with the turn error instead of resolving a fake completion message", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"error","params":{"error":{"message":"unexpected status 401 Unauthorized","additionalDetails":null},"willRetry":false,"threadId":"thread-123","turnId":"turn-1"}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"failed","error":{"message":"unexpected status 401 Unauthorized","additionalDetails":null}}}}\n');

    await expect(promise).rejects.toThrow("unexpected status 401 Unauthorized");
  });

  it("aborts an in-flight turn when the caller aborts the request", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const controller = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      abortSignal: controller.signal,
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    controller.abort();

    await expect(promise).rejects.toThrow("Codex app-server turn aborted");
    expect(child.killCalls).toBe(1);
  });

  it("rejects when thread/read shows the completed turn actually failed", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await waitFor(() => child.stdin.lines.length >= 4);
    const threadRead = JSON.parse(child.stdin.lines[3] ?? "{}");
    expect(threadRead.method).toBe("thread/read");
    child.stdout.emitData('{"id":4,"result":{"thread":{"turns":[{"id":"turn-1","items":[{"type":"userMessage","content":[{"type":"text","text":"Hello"}]}],"status":"failed","error":{"message":"unexpected status 401 Unauthorized","additionalDetails":null}}]}}}\n');

    await expect(promise).rejects.toThrow("unexpected status 401 Unauthorized");
  });

  it("times out an in-flight turn that never completes and restarts cleanly", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      1,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    await expect(promise).rejects.toThrow("Codex app-server turn timed out");
    expect(child.killCalls).toBe(1);
  });

  it("aborts a turn that goes completely idle even when the hard timeout is long", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      60 * 60_000,
      1,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    await expect(promise).rejects.toThrow("Codex app-server turn became inactive");
    expect(child.killCalls).toBe(1);
  });

  it("rejects when app-server stdin write fails", async () => {
    const { child, spawnFn } = createSpawnHarness();
    child.stdin.nextError = new Error("pipe broken");
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    await expect(
      adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      }),
    ).rejects.toThrow("pipe broken");
  });
});
