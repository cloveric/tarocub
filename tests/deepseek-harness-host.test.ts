import { lstat, mkdtemp, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDeepSeekHarnessProtocolOptions,
  DeepSeekHarnessHost,
  prepareDeepSeekHarnessHome,
  type DeepSeekHarnessChildProcess,
  type SpawnDeepSeekHarness,
} from "../src/codex/deepseek-harness-host.js";
import type {
  DeepSeekHarnessProtocolHandlers,
  DeepSeekHarnessServerRequest,
} from "../src/codex/deepseek-harness-protocol.js";
import { removeTempRoot } from "./helpers/temp-files.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

describe("prepareDeepSeekHarnessHome", () => {
  it("isolates mutable settings while linking shared profiles and credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-home-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    const instructionsPath = path.join(root, "agent.md");
    await mkdir(path.join(sharedHome, "profiles", "web"), { recursive: true });
    await writeFile(path.join(sharedHome, "profiles", "web", "package.json"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, "settings.yaml"), "theme: dark\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "secret: never-copy-me\n", "utf8");
    await writeFile(instructionsPath, "Persistent bot instructions\n", "utf8");

    const prepared = await prepareDeepSeekHarnessHome({
      sharedHome,
      stateDir,
      instructionsPath,
    });

    expect(prepared.home).toBe(path.join(stateDir, "dsh-home"));
    for (const name of ["profiles", ".credentials.yaml", "AGENTS.md"]) {
      expect((await lstat(path.join(prepared.home, name))).isSymbolicLink()).toBe(true);
    }
    expect((await lstat(path.join(prepared.home, "settings.yaml"))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(prepared.home, "settings.yaml"), "utf8")).toBe("theme: dark\n");
    expect(await readlink(path.join(prepared.home, "profiles"))).toBe(path.join(sharedHome, "profiles"));
    expect(await readlink(path.join(prepared.home, ".credentials.yaml"))).toBe(
      path.join(sharedHome, ".credentials.yaml"),
    );
    expect(await readlink(path.join(prepared.home, "AGENTS.md"))).toBe(instructionsPath);
    expect(await readFile(path.join(prepared.home, ".credentials.yaml"), "utf8")).toBe(
      "secret: never-copy-me\n",
    );

    await writeFile(path.join(prepared.home, "settings.yaml"), "model: bot-only\n", "utf8");
    await writeFile(path.join(sharedHome, "settings.yaml"), "theme: light\n", "utf8");
    await prepareDeepSeekHarnessHome({ sharedHome, stateDir, instructionsPath });

    expect(await readFile(path.join(prepared.home, "settings.yaml"), "utf8")).toBe("theme: light\n");
    expect(await readFile(path.join(sharedHome, "settings.yaml"), "utf8")).toBe("theme: light\n");
  });

  it("migrates the old shared settings symlink without writing through it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-settings-migration-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    const privateHome = path.join(stateDir, "dsh-home");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await mkdir(privateHome, { recursive: true });
    await writeFile(path.join(sharedHome, "settings.yaml"), "theme: shared\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "{}\n", "utf8");
    await symlink(path.join(sharedHome, "settings.yaml"), path.join(privateHome, "settings.yaml"));

    await prepareDeepSeekHarnessHome({ sharedHome, stateDir });

    expect((await lstat(path.join(privateHome, "settings.yaml"))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(privateHome, "settings.yaml"), "utf8")).toBe("theme: shared\n");
    expect(await readFile(path.join(sharedHome, "settings.yaml"), "utf8")).toBe("theme: shared\n");
  });

  it("adds a sandboxed full-auto permission preset without weakening bypass mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-permissions-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, "settings.yaml"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "{}\n", "utf8");
    await writeFile(
      path.join(sharedHome, "cordis.patch.yml"),
      "- id: session-title\n  config:\n    fallbackMaxWords: 7\n",
      "utf8",
    );

    const prepared = await prepareDeepSeekHarnessHome({ sharedHome, stateDir });
    const patch = await readFile(prepared.patchPath, "utf8");

    expect(patch).toContain("fallbackMaxWords: 7");
    expect(patch).toMatch(/full-auto:\s+?sandbox: workspace-write\s+?approval: never/s);
    expect(patch).toMatch(/danger-full-access:\s+?sandbox: danger-full-access\s+?approval: never/s);
    expect(patch).toMatch(/workspace-write:\s+?sandbox: workspace-write\s+?approval: ask/s);
    expect(patch).not.toContain("never-copy-me");
  });

  it("replaces an empty-array shared patch with a valid permission patch sequence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-empty-patch-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, "settings.yaml"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, "cordis.patch.yml"), "# no shared patches\n[]\n", "utf8");

    const prepared = await prepareDeepSeekHarnessHome({ sharedHome, stateDir });
    const patch = await readFile(prepared.patchPath, "utf8");

    expect(patch).not.toMatch(/^\s*\[\]\s*$/m);
    expect(patch).toMatch(/^- id: permission/m);
    expect(patch).toMatch(/full-auto:\s+?sandbox: workspace-write\s+?approval: never/s);
  });
});

class FakeReadable extends EventEmitter {
  emitData(value: string): void {
    this.emit("data", Buffer.from(value, "utf8"));
  }
}

class FakeChild extends EventEmitter implements DeepSeekHarnessChildProcess {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly killCalls: Array<NodeJS.Signals | undefined> = [];
  pid = 12345;

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    queueMicrotask(() => this.emit("close", 0, signal ?? null));
    return true;
  }
}

class FakeProtocol {
  readonly requests: Array<{ method: string; payload: unknown }> = [];
  readonly responses: Array<{ rpcId: string; value: unknown }> = [];
  handlers: DeepSeekHarnessProtocolHandlers | undefined;
  closed = false;

  async connect(handlers: DeepSeekHarnessProtocolHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    this.requests.push({ method, payload });
    return { accepted: true };
  }

  async respond(rpcId: string, value: unknown): Promise<{ accepted: true }> {
    this.responses.push({ rpcId, value });
    return { accepted: true };
  }

  async respondError(): Promise<{ accepted: true }> {
    return { accepted: true };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emitMux(frame: DeepSeekHarnessServerRequest): void {
    void this.handlers?.onMuxFrame(frame);
  }
}

class BlockingProtocol extends FakeProtocol {
  connectStarted = false;
  private releaseConnect!: () => void;
  private readonly connectBarrier = new Promise<void>((resolve) => {
    this.releaseConnect = resolve;
  });

  override async connect(handlers: DeepSeekHarnessProtocolHandlers): Promise<void> {
    this.handlers = handlers;
    this.connectStarted = true;
    await this.connectBarrier;
  }

  release(): void {
    this.releaseConnect();
  }
}

describe("DeepSeekHarnessHost", () => {
  it("surfaces contained protocol failures without logging the raw downlink frame", () => {
    const diagnostics: string[] = [];
    const options = createDeepSeekHarnessProtocolOptions((message) => diagnostics.push(message));

    options.onMalformedFrame?.(new Error("invalid server request"), '{"token":"do-not-log"}');
    options.onHandlerError?.(new Error("projection consumer failed"));

    expect(diagnostics).toEqual([
      "DeepSeek Harness ignored a malformed downlink frame: invalid server request",
      "DeepSeek Harness downlink handler failed: projection consumer failed",
    ]);
    expect(diagnostics.join("\n")).not.toContain("do-not-log");
  });

  it("owns a private random-port dsh web process and delegates protocol traffic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-process-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, "settings.yaml"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "{}\n", "utf8");
    const child = new FakeChild();
    const spawnCalls: Parameters<SpawnDeepSeekHarness>[] = [];
    const spawnDsh: SpawnDeepSeekHarness = (...args) => {
      spawnCalls.push(args);
      return child;
    };
    const protocol = new FakeProtocol();
    const protocolFactory = vi.fn(() => protocol);
    const host = new DeepSeekHarnessHost({
      executable: "/opt/homebrew/bin/dsh",
      sharedHome,
      stateDir,
      workspacePath: "/workspace",
      childEnv: { HOME: "/Users/test" },
      spawnDsh,
      protocolFactory,
      startupTimeoutMs: 1_000,
    });
    const received: DeepSeekHarnessServerRequest[] = [];

    const connecting = host.connect({
      onMuxFrame: (frame) => {
        received.push(frame);
      },
      onHostFrame: () => {},
    });
    await vi.waitFor(() => expect(spawnCalls).toHaveLength(1));
    child.stdout.emitData("booting\ndsh web: http://127.0.0.1:");
    child.stdout.emitData("43123\n");
    await connecting;

    expect(spawnCalls[0]?.[0]).toBe("/opt/homebrew/bin/dsh");
    expect(spawnCalls[0]?.[1]).toEqual([
      "web",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
    ]);
    expect(spawnCalls[0]?.[2]).toMatchObject({
      cwd: "/workspace",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: "/Users/test",
        DSH_HOME: path.join(stateDir, "dsh-home"),
        DSH_PERMISSION_MODE: "workspace-write",
      },
    });
    expect(protocolFactory).toHaveBeenCalledWith("http://127.0.0.1:43123");
    expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
    expect(child.stderr.listenerCount("data")).toBeGreaterThan(0);

    await expect(host.request("session.cancel", { sessionId: "session-1" })).resolves.toEqual({
      accepted: true,
    });
    expect(protocol.requests).toEqual([{
      method: "session.cancel",
      payload: { sessionId: "session-1" },
    }]);

    await host.close();
    expect(protocol.closed).toBe(true);
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });

  it("rejects startup immediately when dsh exits before publishing its URL", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-start-fail-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, "settings.yaml"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "{}\n", "utf8");
    const child = new FakeChild();
    let spawned = false;
    const host = new DeepSeekHarnessHost({
      executable: "dsh",
      sharedHome,
      stateDir,
      workspacePath: "/workspace",
      spawnDsh: () => {
        spawned = true;
        return child;
      },
      protocolFactory: () => new FakeProtocol(),
      startupTimeoutMs: 5_000,
    });

    const connecting = host.connect({ onMuxFrame: () => {}, onHostFrame: () => {} });
    await vi.waitFor(() => expect(spawned).toBe(true));
    child.stderr.emitData("configuration failed\n");
    child.emit("close", 2, null);

    await expect(connecting).rejects.toThrow(/exited before startup.*configuration failed/i);
    await host.close();
  });

  it("rejects startup when the host closes during protocol connection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-close-during-connect-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, "settings.yaml"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "{}\n", "utf8");
    const child = new FakeChild();
    const protocol = new BlockingProtocol();
    let spawned = false;
    const host = new DeepSeekHarnessHost({
      executable: "dsh",
      sharedHome,
      stateDir,
      workspacePath: "/workspace",
      spawnDsh: () => {
        spawned = true;
        return child;
      },
      protocolFactory: () => protocol,
      startupTimeoutMs: 1_000,
    });

    const connecting = host.connect({ onMuxFrame: () => {}, onHostFrame: () => {} });
    void connecting.catch(() => {});
    await vi.waitFor(() => expect(spawned).toBe(true));
    child.stdout.emitData("dsh web: http://127.0.0.1:43124\n");
    await vi.waitFor(() => expect(protocol.connectStarted).toBe(true));
    await host.close();
    protocol.release();

    await expect(connecting).rejects.toThrow("closed during startup");
  });

  it("restarts after a running dsh process crashes and only then reports reconnect", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-restart-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, "settings.yaml"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "{}\n", "utf8");
    const children = [new FakeChild(), new FakeChild()];
    const protocols = [new FakeProtocol(), new FakeProtocol()];
    let spawnIndex = 0;
    let protocolIndex = 0;
    const onDisconnect = vi.fn();
    const onReconnect = vi.fn();
    const host = new DeepSeekHarnessHost({
      executable: "dsh",
      sharedHome,
      stateDir,
      workspacePath: "/workspace",
      spawnDsh: () => children[spawnIndex++]!,
      protocolFactory: () => protocols[protocolIndex++]!,
      startupTimeoutMs: 1_000,
      restartDelayMs: 1,
    });

    const connecting = host.connect({
      onMuxFrame: () => {},
      onHostFrame: () => {},
      onDisconnect,
      onReconnect,
    });
    await vi.waitFor(() => expect(spawnIndex).toBe(1));
    children[0]!.stdout.emitData("dsh web: http://127.0.0.1:43123\n");
    await connecting;

    children[0]!.emit("close", 1, null);
    await vi.waitFor(() => expect(spawnIndex).toBe(2));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onReconnect).not.toHaveBeenCalled();
    children[1]!.stdout.emitData("dsh web: http://127.0.0.1:43124\n");
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    expect(onReconnect).toHaveBeenCalledWith({ reason: "host-restart" });

    await host.request("session.list", {});
    expect(protocols[0]!.closed).toBe(true);
    expect(protocols[1]!.requests).toEqual([{ method: "session.list", payload: {} }]);
    await host.close();
  });

  it("treats a runtime child-process error as a restartable host failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-runtime-error-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, "settings.yaml"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "{}\n", "utf8");
    const children = [new FakeChild(), new FakeChild()];
    const protocols = [new FakeProtocol(), new FakeProtocol()];
    let spawnIndex = 0;
    let protocolIndex = 0;
    const onDisconnect = vi.fn();
    const onReconnect = vi.fn();
    const diagnostics: string[] = [];
    const host = new DeepSeekHarnessHost({
      executable: "dsh",
      sharedHome,
      stateDir,
      workspacePath: "/workspace",
      spawnDsh: () => children[spawnIndex++]!,
      protocolFactory: () => protocols[protocolIndex++]!,
      startupTimeoutMs: 1_000,
      restartDelayMs: 1,
      onDiagnostic: (message) => diagnostics.push(message),
    });

    const connecting = host.connect({
      onMuxFrame: () => {},
      onHostFrame: () => {},
      onDisconnect,
      onReconnect,
    });
    await vi.waitFor(() => expect(spawnIndex).toBe(1));
    children[0]!.stdout.emitData("dsh web: http://127.0.0.1:43123\n");
    await connecting;

    children[0]!.emit("error", new Error("runtime pipe failed"));
    await vi.waitFor(() => expect(spawnIndex).toBe(2));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(diagnostics).toContainEqual(expect.stringContaining("runtime pipe failed"));
    children[1]!.stdout.emitData("dsh web: http://127.0.0.1:43124\n");
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledWith({ reason: "host-restart" }));

    await host.close();
  });

  it("still reports a host restart when an RPC request starts the replacement before the timer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-request-restart-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, "settings.yaml"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "{}\n", "utf8");
    const children = [new FakeChild(), new FakeChild()];
    const protocols = [new FakeProtocol(), new FakeProtocol()];
    let spawnIndex = 0;
    let protocolIndex = 0;
    const onReconnect = vi.fn();
    const host = new DeepSeekHarnessHost({
      executable: "dsh",
      sharedHome,
      stateDir,
      workspacePath: "/workspace",
      spawnDsh: () => children[spawnIndex++]!,
      protocolFactory: () => protocols[protocolIndex++]!,
      startupTimeoutMs: 1_000,
      restartDelayMs: 60_000,
    });

    const connecting = host.connect({
      onMuxFrame: () => {},
      onHostFrame: () => {},
      onReconnect,
    });
    await vi.waitFor(() => expect(spawnIndex).toBe(1));
    children[0]!.stdout.emitData("dsh web: http://127.0.0.1:43123\n");
    await connecting;

    children[0]!.emit("close", 1, null);
    const request = host.request("session.list", {});
    await vi.waitFor(() => expect(spawnIndex).toBe(2));
    children[1]!.stdout.emitData("dsh web: http://127.0.0.1:43124\n");

    await expect(request).resolves.toEqual({ accepted: true });
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onReconnect).toHaveBeenCalledWith({ reason: "host-restart" });
    await host.close();
  });

  it("discards a replacement protocol when reconnect recovery fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-recovery-fail-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, "settings.yaml"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "{}\n", "utf8");
    const children = [new FakeChild(), new FakeChild(), new FakeChild()];
    const protocols = [new FakeProtocol(), new FakeProtocol(), new FakeProtocol()];
    let spawnIndex = 0;
    let protocolIndex = 0;
    const onReconnect = vi.fn()
      .mockRejectedValueOnce(new Error("history recovery failed"))
      .mockResolvedValue(undefined);
    const host = new DeepSeekHarnessHost({
      executable: "dsh",
      sharedHome,
      stateDir,
      workspacePath: "/workspace",
      spawnDsh: () => children[spawnIndex++]!,
      protocolFactory: () => protocols[protocolIndex++]!,
      startupTimeoutMs: 1_000,
      restartDelayMs: 60_000,
    });

    const connecting = host.connect({ onMuxFrame: () => {}, onHostFrame: () => {}, onReconnect });
    await vi.waitFor(() => expect(spawnIndex).toBe(1));
    children[0]!.stdout.emitData("dsh web: http://127.0.0.1:43123\n");
    await connecting;

    children[0]!.emit("close", 1, null);
    const failedRequest = host.request("session.list", {});
    await vi.waitFor(() => expect(spawnIndex).toBe(2));
    children[1]!.stdout.emitData("dsh web: http://127.0.0.1:43124\n");
    await expect(failedRequest).rejects.toThrow("history recovery failed");
    expect(protocols[1]!.closed).toBe(true);

    const retriedRequest = host.request("session.list", {});
    await vi.waitFor(() => expect(spawnIndex).toBe(3));
    children[2]!.stdout.emitData("dsh web: http://127.0.0.1:43125\n");
    await expect(retriedRequest).resolves.toEqual({ accepted: true });
    expect(onReconnect).toHaveBeenCalledTimes(2);
    await host.close();
  });

  it("preserves restart identity when the replacement crashes during reconnect recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-harness-recovery-crash-"));
    roots.push(root);
    const sharedHome = path.join(root, "shared");
    const stateDir = path.join(root, "instance");
    await mkdir(path.join(sharedHome, "profiles"), { recursive: true });
    await writeFile(path.join(sharedHome, "settings.yaml"), "{}\n", "utf8");
    await writeFile(path.join(sharedHome, ".credentials.yaml"), "{}\n", "utf8");
    const children = [new FakeChild(), new FakeChild(), new FakeChild()];
    const protocols = [new FakeProtocol(), new FakeProtocol(), new FakeProtocol()];
    let spawnIndex = 0;
    let protocolIndex = 0;
    let finishFirstRecovery!: () => void;
    const firstRecovery = new Promise<void>((resolve) => {
      finishFirstRecovery = resolve;
    });
    const onReconnect = vi.fn()
      .mockImplementationOnce(async () => await firstRecovery)
      .mockResolvedValue(undefined);
    const host = new DeepSeekHarnessHost({
      executable: "dsh",
      sharedHome,
      stateDir,
      workspacePath: "/workspace",
      spawnDsh: () => children[spawnIndex++]!,
      protocolFactory: () => protocols[protocolIndex++]!,
      startupTimeoutMs: 1_000,
      restartDelayMs: 60_000,
    });

    const connecting = host.connect({ onMuxFrame: () => {}, onHostFrame: () => {}, onReconnect });
    await vi.waitFor(() => expect(spawnIndex).toBe(1));
    children[0]!.stdout.emitData("dsh web: http://127.0.0.1:43123\n");
    await connecting;

    children[0]!.emit("close", 1, null);
    const interruptedRequest = host.request("session.list", {});
    await vi.waitFor(() => expect(spawnIndex).toBe(2));
    children[1]!.stdout.emitData("dsh web: http://127.0.0.1:43124\n");
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));

    children[1]!.emit("close", 1, null);
    await vi.waitFor(() => expect(protocols[1]!.closed).toBe(true));
    finishFirstRecovery();
    await expect(interruptedRequest).rejects.toThrow("exited during reconnect recovery");

    const recoveredRequest = host.request("session.list", {});
    await vi.waitFor(() => expect(spawnIndex).toBe(3));
    children[2]!.stdout.emitData("dsh web: http://127.0.0.1:43125\n");
    await expect(recoveredRequest).resolves.toEqual({ accepted: true });
    expect(onReconnect).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenNthCalledWith(2, { reason: "host-restart" });
    await host.close();
  });
});
