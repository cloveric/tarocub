import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/codex/process-tree.js", () => ({
  killProcessTree: vi.fn(),
}));

import { killProcessTree } from "../src/codex/process-tree.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";

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
  pid: number | undefined;
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

function parsedStdinLines(child: FakeChildProcess): Array<Record<string, unknown>> {
  return child.stdin.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function driveTurnStart(child: FakeChildProcess): Promise<void> {
  await waitFor(() => child.stdin.lines.length >= 1);
  child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
  await waitFor(() => child.stdin.lines.length >= 2);
  child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
  await waitFor(() => child.stdin.lines.length >= 3);
}

describe("app-server abort interrupts the engine (turn/interrupt)", () => {
  it("sends turn/interrupt for the aborted turn using the id from the turn/start response", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const controller = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      abortSignal: controller.signal,
    });

    await driveTurnStart(child);
    // turn/start responds immediately with the turn object; the turn keeps running.
    child.stdout.emitData('{"id":3,"result":{"turn":{"id":"turn-1","items":[],"status":"inProgress","error":null}}}\n');
    await waitFor(() =>
      parsedStdinLines(child).some((line) => line.method === "turn/interrupt") ||
      // wait until the response microtask captured the turn id
      Boolean((adapter as unknown as { pendingTurns: Map<string, { turnId?: string }> }).pendingTurns.get("thread-123")?.turnId),
    );

    controller.abort();

    await expect(promise).rejects.toThrow("Codex app-server turn aborted");
    const interrupt = parsedStdinLines(child).find((line) => line.method === "turn/interrupt");
    expect(interrupt?.params).toEqual({ threadId: "thread-123", turnId: "turn-1" });
    // Thread-scoped: the shared child must not be killed for one turn's abort.
    expect(child.killCalls).toBe(0);
  });

  it("sends turn/interrupt using the id from the turn/started notification when the response is late", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const controller = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      abortSignal: controller.signal,
    });

    await driveTurnStart(child);
    child.stdout.emitData('{"method":"turn/started","params":{"threadId":"thread-123","turn":{"id":"turn-9","status":"inProgress"}}}\n');

    controller.abort();

    await expect(promise).rejects.toThrow("Codex app-server turn aborted");
    const interrupt = parsedStdinLines(child).find((line) => line.method === "turn/interrupt");
    expect(interrupt?.params).toEqual({ threadId: "thread-123", turnId: "turn-9" });
  });

  it("skips the interrupt when no turn id is known yet", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const controller = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      abortSignal: controller.signal,
    });

    await driveTurnStart(child);
    controller.abort();

    await expect(promise).rejects.toThrow("Codex app-server turn aborted");
    expect(parsedStdinLines(child).some((line) => line.method === "turn/interrupt")).toBe(false);
  });

  it("sends turn/interrupt when the inactivity watchdog rejects the turn", async () => {
    const { child, spawnFn } = createSpawnHarness();
    // Inactivity window must comfortably outlast the event-loop ticks needed to
    // deliver the turn/start response (which carries the turn id) — but stay fast.
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      10_000,
      50,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await driveTurnStart(child);
    child.stdout.emitData('{"id":3,"result":{"turn":{"id":"turn-1","items":[],"status":"inProgress","error":null}}}\n');

    await expect(promise).rejects.toThrow("Codex app-server turn became inactive");
    const interrupt = parsedStdinLines(child).find((line) => line.method === "turn/interrupt");
    expect(interrupt?.params).toEqual({ threadId: "thread-123", turnId: "turn-1" });
    expect(child.killCalls).toBe(0);
  });
});

describe("app-server workspaceOverride", () => {
  it("starts new logical-session threads in the workspaceOverride directory", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/srv/default-cwd", spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
      workspaceOverride: "/srv/override-ws",
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    const threadStart = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(threadStart.method).toBe("thread/start");
    expect(threadStart.params.cwd).toBe("/srv/override-ws");

    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await expect(promise).resolves.toMatchObject({ text: "ok" });
  });

  it("uses the workspaceOverride for the thread-not-found fallback thread", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", "/srv/default-cwd", spawnFn);

    const promise = adapter.sendUserMessage("thread-stale", {
      text: "Hello",
      files: [],
      workspaceOverride: "/srv/override-ws",
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    await waitFor(() => child.stdin.lines.length >= 2);
    const resume = JSON.parse(child.stdin.lines[1] ?? "{}");
    expect(resume.method).toBe("thread/resume");
    child.stdout.emitData(`{"id":${resume.id},"error":{"message":"thread not found: thread-stale"}}\n`);

    await waitFor(() => child.stdin.lines.length >= 3);
    const threadStart = JSON.parse(child.stdin.lines[2] ?? "{}");
    expect(threadStart.method).toBe("thread/start");
    expect(threadStart.params.cwd).toBe("/srv/override-ws");

    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-fresh"}}}\n`);
    await waitFor(() => child.stdin.lines.length >= 4);
    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-fresh","item":{"type":"agentMessage","text":"ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-fresh","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await expect(promise).resolves.toMatchObject({ text: "ok", sessionId: "thread-fresh" });
  });
});

describe("app-server config change while busy", () => {
  it("keeps serving on the old config instead of hard-failing when the child cannot go idle", async () => {
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
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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
      // Simulate the 30s waitForIdle timeout without waiting 30s of real time.
      const internal = adapter as unknown as { waitForIdle(): Promise<void> };
      const originalWaitForIdle = internal.waitForIdle.bind(adapter);
      let failNextWaitForIdle = true;
      internal.waitForIdle = () => {
        if (failNextWaitForIdle) {
          failNextWaitForIdle = false;
          return Promise.reject(new Error("Codex app-server did not become idle within 30000ms"));
        }
        return originalWaitForIdle();
      };

      const firstPromise = adapter.sendUserMessage("telegram-100", {
        text: "First (long-running)",
        files: [],
      });

      await waitFor(() => childA.stdin.lines.length >= 1);
      const initA = JSON.parse(childA.stdin.lines[0] ?? "{}");
      childA.stdout.emitData(`{"id":${initA.id},"result":{"platformOs":"windows"}}\n`);
      await waitFor(() => childA.stdin.lines.length >= 2);
      const startThreadA = JSON.parse(childA.stdin.lines[1] ?? "{}");
      childA.stdout.emitData(`{"id":${startThreadA.id},"result":{"thread":{"id":"thread-a"}}}\n`);
      await waitFor(() => childA.stdin.lines.length >= 3);

      // Operator flips config while the first turn is still running.
      await writeFile(configPath, JSON.stringify({ approvalMode: "bypass" }) + "\n", "utf8");
      const secondPromise = adapter.sendUserMessage("telegram-200", {
        text: "Second",
        files: [],
      });

      // The second turn proceeds on the EXISTING child with the old config.
      await waitFor(() => childA.stdin.lines.length >= 4);
      expect(calls).toHaveLength(1);
      expect(childA.killCalls).toBe(0);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("config change deferred while busy"),
      );
      const startThreadB = JSON.parse(childA.stdin.lines[3] ?? "{}");
      expect(startThreadB.method).toBe("thread/start");
      childA.stdout.emitData(`{"id":${startThreadB.id},"result":{"thread":{"id":"thread-b"}}}\n`);
      await waitFor(() => childA.stdin.lines.length >= 5);

      childA.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-b","item":{"type":"agentMessage","text":"second ok"}}}\n');
      childA.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-b","turn":{"id":"turn-b","items":[],"status":"completed","error":null}}}\n');
      await expect(secondPromise).resolves.toEqual({ text: "second ok", sessionId: "thread-b" });

      childA.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-a","item":{"type":"agentMessage","text":"first ok"}}}\n');
      childA.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-a","turn":{"id":"turn-a","items":[],"status":"completed","error":null}}}\n');
      await expect(firstPromise).resolves.toEqual({ text: "first ok", sessionId: "thread-a" });

      // initializeKey was left unchanged, so the next message re-attempts the
      // re-init now that the child is idle: old child destroyed, new config used.
      const thirdPromise = adapter.sendUserMessage("telegram-300", {
        text: "Third",
        files: [],
      });
      await waitFor(() => childB.stdin.lines.length >= 1);
      expect(childA.killCalls).toBe(1);
      expect(calls[1]?.args).toEqual(["app-server", "-c", 'sandbox_mode="danger-full-access"']);
      const initB = JSON.parse(childB.stdin.lines[0] ?? "{}");
      childB.stdout.emitData(`{"id":${initB.id},"result":{"platformOs":"windows"}}\n`);
      await waitFor(() => childB.stdin.lines.length >= 2);
      const startThreadC = JSON.parse(childB.stdin.lines[1] ?? "{}");
      childB.stdout.emitData(`{"id":${startThreadC.id},"result":{"thread":{"id":"thread-c"}}}\n`);
      await waitFor(() => childB.stdin.lines.length >= 3);
      childB.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-c","item":{"type":"agentMessage","text":"third ok"}}}\n');
      childB.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-c","turn":{"id":"turn-c","items":[],"status":"completed","error":null}}}\n');
      await expect(thirdPromise).resolves.toEqual({ text: "third ok", sessionId: "thread-c" });
    } finally {
      consoleErrorSpy.mockRestore();
      await removeTempRoot(root);
    }
  });

  it("warns once per distinct pending change and names a /goal pursuit holding the session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "normal" }) + "\n", "utf8");
      const adapter = new CodexAppServerAdapter(
        "codex", process.cwd(), undefined, (() => new FakeChildProcess()) as never,
        undefined, undefined, configPath,
      );
      // Drive ensureInitialized directly: pretend a child is already running on an
      // OLD config, and a goal watcher is keeping it non-idle so waitForIdle rejects.
      const internal = adapter as unknown as {
        initializeKey: string | null;
        initializePromise: Promise<void> | null;
        goalWatchers: Map<string, unknown>;
        ensureInitialized(opts: { initializeArgs: string[]; initializeKey: string }): Promise<void>;
        waitForIdle(): Promise<void>;
      };
      internal.initializeKey = "old-config";
      internal.initializePromise = Promise.resolve();
      internal.goalWatchers.set("thread-goal", {});
      internal.waitForIdle = () => Promise.reject(new Error("Codex app-server did not become idle within 30000ms"));

      // Two consecutive messages carrying the SAME pending change → ONE warning.
      await internal.ensureInitialized({ initializeArgs: [], initializeKey: "new-config" });
      await internal.ensureInitialized({ initializeArgs: [], initializeKey: "new-config" });

      const goalWarnings = consoleErrorSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("config change deferred while busy"));
      expect(goalWarnings).toHaveLength(1);
      // The /goal pursuit is named so the operator knows why the change is stuck.
      expect(goalWarnings[0]).toContain("/goal");

      // A DIFFERENT pending change warns again (the one-shot latch reset).
      await internal.ensureInitialized({ initializeArgs: [], initializeKey: "newer-config" });
      const allWarnings = consoleErrorSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("config change deferred while busy"));
      expect(allWarnings).toHaveLength(2);
    } finally {
      consoleErrorSpy.mockRestore();
      await removeTempRoot(root);
    }
  });
});

describe("app-server per-turn stderr diagnostics", () => {
  it("excludes stderr produced before the turn started from the turn's failure diagnostics", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await waitFor(() => child.stdin.lines.length >= 1);
    child.stdout.emitData('{"id":1,"result":{"platformOs":"windows"}}\n');
    // Stale stderr from before this turn (e.g. an old auth failure).
    child.stderr.emitData("stale unexpected status 401 Unauthorized\n");
    await waitFor(() => child.stdin.lines.length >= 2);
    child.stdout.emitData('{"id":2,"result":{"thread":{"id":"thread-123"}}}\n');
    await waitFor(() => child.stdin.lines.length >= 3);

    child.stderr.emitData("fresh stream disconnected\n");
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"failed","error":{"message":"boom"}}}}\n');

    const error = await promise.then(
      () => {
        throw new Error("expected the turn to fail");
      },
      (value: Error) => value,
    );
    expect(error.message).toContain("boom");
    expect(error.message).toContain("fresh stream disconnected");
    expect(error.message).not.toContain("stale unexpected status 401");
  });

  it("still includes stderr produced during the turn in inactivity failures", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter(
      "codex",
      process.cwd(),
      undefined,
      spawnFn,
      undefined,
      undefined,
      undefined,
      10_000,
      50,
    );

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await driveTurnStart(child);
    child.stderr.emitData("during-turn runtime context\n");

    await expect(promise).rejects.toThrow(/during-turn runtime context/);
  });
});

describe("app-server inactivity detector counts unlisted notifications", () => {
  it("treats any thread-scoped notification as turn activity", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });

    await driveTurnStart(child);

    // Not in any explicit handler list: must still count as activity.
    child.stdout.emitData('{"method":"item/commandExecution/outputDelta","params":{"threadId":"thread-123","delta":"…"}}\n');

    const pending = (adapter as unknown as {
      pendingTurns: Map<string, { lastActivityAt?: number; lastActivityMethod?: string }>;
    }).pendingTurns.get("thread-123");
    expect(pending?.lastActivityMethod).toBe("item/commandExecution/outputDelta");
    expect(pending?.lastActivityAt).toBeTypeOf("number");

    // Notifications without a threadId are ignored (no crash, no activity reset).
    child.stdout.emitData('{"method":"mcpServer/startupStatus/updated","params":{"status":"starting"}}\n');
    expect(pending?.lastActivityMethod).toBe("item/commandExecution/outputDelta");

    child.stdout.emitData('{"method":"item/completed","params":{"threadId":"thread-123","item":{"type":"agentMessage","text":"ok"}}}\n');
    child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"thread-123","turn":{"id":"turn-1","items":[],"status":"completed","error":null}}}\n');
    await expect(promise).resolves.toMatchObject({ text: "ok" });
  });
});

describe("app-server destroy kills the process tree", () => {
  it("routes destroy through killProcessTree when the child has a pid", async () => {
    vi.mocked(killProcessTree).mockClear();
    const { child, spawnFn } = createSpawnHarness();
    child.pid = 4242;
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });
    await driveTurnStart(child);

    adapter.destroy();
    await expect(promise).rejects.toThrow("Adapter destroyed");
    expect(killProcessTree).toHaveBeenCalledWith(4242);
    expect(child.killCalls).toBe(0);
  });

  it("falls back to kill() for children without a pid", async () => {
    vi.mocked(killProcessTree).mockClear();
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Hello",
      files: [],
    });
    await driveTurnStart(child);

    adapter.destroy();
    await expect(promise).rejects.toThrow("Adapter destroyed");
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(child.killCalls).toBe(1);
  });
});

describe("app-server mid-turn steering (turn/steer)", () => {
  it("steers the active turn with the expected turn id and resolves true", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const controller = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Rewrite the README",
      files: [],
      abortSignal: controller.signal,
    });

    await driveTurnStart(child);
    child.stdout.emitData('{"id":3,"result":{"turn":{"id":"turn-1","items":[],"status":"inProgress","error":null}}}\n');
    await waitFor(() =>
      Boolean((adapter as unknown as { pendingTurns: Map<string, { turnId?: string }> }).pendingTurns.get("thread-123")?.turnId),
    );

    const steerPromise = adapter.steerActiveTurn("thread-123", { text: "also write it in English" });
    await waitFor(() => parsedStdinLines(child).some((line) => line.method === "turn/steer"));
    const steer = parsedStdinLines(child).find((line) => line.method === "turn/steer") as {
      id: number;
      params: Record<string, unknown>;
    };
    expect(steer.params).toEqual({
      threadId: "thread-123",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "also write it in English" }],
    });

    child.stdout.emitData(`{"id":${steer.id},"result":{}}\n`);
    await expect(steerPromise).resolves.toBe(true);

    controller.abort();
    await expect(promise).rejects.toThrow("Codex app-server turn aborted");
  });

  it("resolves false without writing a steer when no turn is active", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);

    await expect(adapter.steerActiveTurn("thread-123", { text: "hello" })).resolves.toBe(false);
    expect(child.stdin.lines.length).toBe(0);
  });

  it("resolves false when the engine rejects the steer (turn already over)", async () => {
    const { child, spawnFn } = createSpawnHarness();
    const adapter = new CodexAppServerAdapter("codex", process.cwd(), spawnFn);
    const controller = new AbortController();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Rewrite the README",
      files: [],
      abortSignal: controller.signal,
    });

    await driveTurnStart(child);
    child.stdout.emitData('{"id":3,"result":{"turn":{"id":"turn-1","items":[],"status":"inProgress","error":null}}}\n');
    await waitFor(() =>
      Boolean((adapter as unknown as { pendingTurns: Map<string, { turnId?: string }> }).pendingTurns.get("thread-123")?.turnId),
    );

    const steerPromise = adapter.steerActiveTurn("thread-123", { text: "late follow-up" });
    await waitFor(() => parsedStdinLines(child).some((line) => line.method === "turn/steer"));
    const steer = parsedStdinLines(child).find((line) => line.method === "turn/steer") as { id: number };
    child.stdout.emitData(`{"id":${steer.id},"error":{"code":-32600,"message":"expected turn id does not match"}}\n`);
    await expect(steerPromise).resolves.toBe(false);

    controller.abort();
    await expect(promise).rejects.toThrow("Codex app-server turn aborted");
  });
});
