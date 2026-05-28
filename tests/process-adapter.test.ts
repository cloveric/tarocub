import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODEX_PROCESS_INACTIVITY_TIMEOUT_MS,
  CODEX_PROCESS_TURN_TIMEOUT_MS,
  ProcessCodexAdapter,
} from "../src/codex/process-adapter.js";

async function waitForSpawn(calls: Array<unknown>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (calls.length > 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Codex process was not spawned in time");
}

async function waitForLength(items: Array<unknown>, length: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (items.length >= length) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Expected at least ${length} items`);
}

describe("ProcessCodexAdapter", () => {
  it("creates a logical telegram session placeholder", async () => {
    const adapter = new ProcessCodexAdapter("codex");
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "telegram-12345",
    });
  });

  it("sets Codex thread goals through a short-lived app-server helper", async () => {
    const { spawnCodex, child, calls } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex, undefined, undefined, undefined, undefined, "/tmp/workspace");

    const promise = adapter.setThreadGoal("telegram-12345", {
      objective: "ship the release",
      tokenBudget: null,
      workspaceOverride: "/tmp/project",
    });

    await waitForSpawn(calls);
    expect(calls[0]?.args).toEqual(["app-server"]);

    const initialize = JSON.parse(child.stdin.writes[0]?.trim() ?? "{}");
    child.stdout.emitData(`{"id":${initialize.id},"result":{"platformOs":"macos"}}\n`);

    await waitForLength(child.stdin.writes, 2);
    const threadStart = JSON.parse(child.stdin.writes[1]?.trim() ?? "{}");
    expect(threadStart.method).toBe("thread/start");
    expect(threadStart.params.cwd).toBe("/tmp/project");
    child.stdout.emitData(`{"id":${threadStart.id},"result":{"thread":{"id":"thread-123"}}}\n`);

    await waitForLength(child.stdin.writes, 3);
    const goalSet = JSON.parse(child.stdin.writes[2]?.trim() ?? "{}");
    expect(goalSet).toMatchObject({
      method: "thread/goal/set",
      params: {
        threadId: "thread-123",
        objective: "ship the release",
        tokenBudget: null,
      },
    });
    child.stdout.emitData(`{"id":${goalSet.id},"result":{"goal":{"threadId":"thread-123","objective":"ship the release","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1,"updatedAt":1}}}\n`);

    await expect(promise).resolves.toEqual({
      goal: {
        threadId: "thread-123",
        objective: "ship the release",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      sessionId: "thread-123",
    });
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("emits engine events from structured Codex stdout", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);
    const engineEvents: unknown[] = [];

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
      onEngineEvent: (event) => {
        engineEvents.push(event);
      },
    });

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-456"}\n');
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"Hello back"}}\n');
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "Hello back",
      sessionId: "thread-456",
    });
    expect(engineEvents).toEqual([
      { type: "session", sessionId: "thread-456" },
      { type: "assistant_text", text: "Hello back", sessionId: "thread-456" },
    ]);
  });

  it("turns Codex image generation events into send-image stream output", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);
    const engineEvents: unknown[] = [];
    const imagePath = "/tmp/codex-generated/photo.png";

    const promise = adapter.sendUserMessage("thread-123", {
      text: "make the image fun",
      files: [],
      onEngineEvent: (event) => {
        engineEvents.push(event);
      },
    });

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-456"}\n');
    child.stdout.emitData(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        saved_path: imagePath,
      },
    }) + "\n");
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: `[send-image:${imagePath}]`,
      sessionId: "thread-456",
    });
    expect(engineEvents).toContainEqual({
      type: "assistant_text",
      text: `[send-image:${imagePath}]`,
      sessionId: "thread-456",
    });
  });

  it("keeps generated image tags when a later Codex agent message arrives", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);
    const imagePath = "/tmp/codex-generated/photo.png";

    const promise = adapter.sendUserMessage("thread-123", {
      text: "make the image fun",
      files: [],
    });

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-456"}\n');
    child.stdout.emitData(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        saved_path: imagePath,
      },
    }) + "\n");
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"做好了"}}\n');
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: `做好了\n[send-image:${imagePath}]`,
      sessionId: "thread-456",
    });
  });

  it("only forwards side-channel extra env keys to the Codex child process", async () => {
    const { spawnCodex, child, calls } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
      extraEnv: {
        CCTB_SEND_URL: "http://127.0.0.1:12345/send/token",
        CCTB_SEND_TOKEN: "token",
        CCTB_SEND_COMMAND: "/tmp/.cctb-send/helper",
        CCTB_CRON_URL: "http://127.0.0.1:12345/cron/token",
        CCTB_CRON_TOKEN: "cron-token",
        PATH: `/tmp/.cctb-bin${path.delimiter}/usr/bin`,
        LD_PRELOAD: "/tmp/injected.dylib",
        NODE_OPTIONS: "--require /tmp/injected.js",
      },
    });
    await waitForSpawn(calls);

    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
    child.close(0);
    await promise;

    expect(calls[0]?.options.env).toMatchObject({
      CCTB_SEND_URL: "http://127.0.0.1:12345/send/token",
      CCTB_SEND_TOKEN: "token",
      CCTB_SEND_COMMAND: "/tmp/.cctb-send/helper",
      PATH: `/tmp/.cctb-bin${path.delimiter}/usr/bin`,
    });
    expect(calls[0]?.options.env?.CCTB_CRON_URL).toBeUndefined();
    expect(calls[0]?.options.env?.CCTB_CRON_TOKEN).toBeUndefined();
    expect(calls[0]?.options.env?.LD_PRELOAD).toBeUndefined();
    expect(calls[0]?.options.env?.NODE_OPTIONS).toBeUndefined();
  });

  it("pre-approves normal Codex turns before running them with full-auto", async () => {
    const { spawnCodex, child, calls } = createSpawnHarness();
    const approvals: unknown[] = [];
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Delete the temporary file",
      files: ["notes.txt"],
      workspaceOverride: "/tmp/workspace",
      onApprovalRequest: async (request) => {
        approvals.push(request);
        return { behavior: "allow", scope: "once" };
      },
    });
    await waitForSpawn(calls);

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "done",
      sessionId: "thread-123",
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      engine: "codex",
      toolName: "Codex full-auto turn",
      cwd: "/tmp/workspace",
      toolInput: {
        prompt: "Delete the temporary file\nAttachment: notes.txt",
      },
    });
    expect(calls[0]?.args).toEqual(["exec", "--json", "--skip-git-repo-check", "--full-auto", "-"]);
  });

  it("defaults configured Codex process instances without approval mode to unsafe bypass", async () => {
    const { spawnCodex, child, calls } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, "{}\n", "utf8");
      const adapter = new ProcessCodexAdapter("codex", spawnCodex, undefined, undefined, configPath);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });
      await waitForSpawn(calls);

      child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
      child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
      child.close(0);

      await expect(promise).resolves.toEqual({
        text: "ok",
        sessionId: "thread-123",
      });
      expect(calls[0]?.args).toEqual(["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-"]);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not start Codex when Telegram denies the pre-turn approval", async () => {
    const spawnCodex = vi.fn();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    await expect(adapter.sendUserMessage("telegram-12345", {
      text: "Delete the temporary file",
      files: [],
      onApprovalRequest: async () => ({ behavior: "deny" }),
    })).rejects.toThrow("Codex turn was denied from Telegram");
    expect(spawnCodex).not.toHaveBeenCalled();
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

  it("validates external sessions against the local Codex session index", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-session-index-"));
    const codexHome = path.join(root, ".codex");
    try {
      await mkdir(codexHome, { recursive: true });
      await writeFile(
        path.join(codexHome, "session_index.jsonl"),
        [
          JSON.stringify({ id: "thread-123", thread_name: "Example thread" }),
          JSON.stringify({ id: "thread-456", thread_name: "Human-readable title" }),
        ].join("\n") + "\n",
        "utf8",
      );
      const adapter = new ProcessCodexAdapter("codex", { CODEX_HOME: codexHome });

      await expect(adapter.validateExternalSession("thread-123")).resolves.toBeUndefined();
      await expect(adapter.validateExternalSession("Human-readable title")).rejects.toThrow(
        "codex process could not resume thread Human-readable title",
      );
      await expect(adapter.validateExternalSession("thread-missing")).rejects.toThrow(
        "codex process could not resume thread thread-missing",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("validates external sessions against local Codex rollout files when the index is stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-session-files-"));
    const codexHome = path.join(root, ".codex");
    try {
      await mkdir(path.join(codexHome, "sessions", "2026", "04", "13"), { recursive: true });
      await writeFile(
        path.join(codexHome, "sessions", "2026", "04", "13", "rollout-2026-04-13T19-36-23-thread-abc.jsonl"),
        "{}\n",
        "utf8",
      );
      await writeFile(
        path.join(codexHome, "session_index.jsonl"),
        JSON.stringify({ id: "thread-other", thread_name: "Other thread" }) + "\n",
        "utf8",
      );
      const adapter = new ProcessCodexAdapter("codex", { CODEX_HOME: codexHome });

      await expect(adapter.validateExternalSession("thread-abc")).resolves.toBeUndefined();
      await expect(adapter.validateExternalSession("thread-missing")).rejects.toThrow(
        "codex process could not resume thread thread-missing",
      );
    } finally {
      await removeTempRoot(root);
    }
  });

  it("validates external sessions against archived Codex rollout files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-archived-session-files-"));
    const codexHome = path.join(root, ".codex");
    try {
      await mkdir(path.join(codexHome, "archived_sessions"), { recursive: true });
      await writeFile(
        path.join(codexHome, "archived_sessions", "rollout-2026-04-19T16-09-28-thread-archived.jsonl"),
        "{}\n",
        "utf8",
      );
      const adapter = new ProcessCodexAdapter("codex", { CODEX_HOME: codexHome });

      await expect(adapter.validateExternalSession("thread-archived")).resolves.toBeUndefined();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("caps local Codex rollout scanning depth", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-session-depth-"));
    const codexHome = path.join(root, ".codex");
    try {
      let deepPath = path.join(codexHome, "sessions");
      for (let index = 0; index < 32; index++) {
        deepPath = path.join(deepPath, `level-${index}`);
      }
      await mkdir(deepPath, { recursive: true });
      await writeFile(path.join(deepPath, "rollout-2026-04-27T00-00-00-thread-too-deep.jsonl"), "{}\n", "utf8");
      const adapter = new ProcessCodexAdapter("codex", { CODEX_HOME: codexHome });

      await expect(adapter.validateExternalSession("thread-too-deep")).rejects.toThrow(
        "codex process could not resume thread thread-too-deep",
      );
    } finally {
      await removeTempRoot(root);
    }
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

  it("keeps the assistant response when Codex only reports plugin warm-cache diagnostics", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"answer survived"}}\n');
    child.stderr.emitData(
      [
        "2026-05-04T02:46:05Z  WARN codex_core::plugins::manager: failed to warm featured plugin ids cache error=remote plugin sync request to https://chatgpt.com/backend-api/plugins/featured failed with status 403 Forbidden: <html>challenge</html>",
        "2026-05-04T02:46:53Z  WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt: prompt must be at most 128 characters path=/Users/test/.codex/.tmp/plugins/plugins/build-ios-apps/.codex-plugin/plugin.json",
        "2026-05-04T02:46:53Z  WARN codex_core_skills::loader: ignoring interface.icon_small: icon path must not contain '..'",
      ].join("\n"),
    );
    child.close(1);

    await expect(promise).resolves.toEqual({ text: "answer survived" });
  });

  it("keeps both the head and tail of oversized stderr diagnostics", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.stderr.emitData(`STACK_START\n${"x".repeat(20_000)}\nSTACK_END`);
    child.close(2);

    await expect(promise).rejects.toThrow("STACK_START");
    await expect(promise).rejects.toThrow("STACK_END");
    await expect(promise).rejects.toThrow("bytes elided");
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
      await removeTempRoot(root);
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
      await removeTempRoot(root);
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
      await removeTempRoot(root);
    }
  });

  it("rejects when engine stdout exceeds the safety buffer", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData("x".repeat(1024 * 1024 + 1));
    child.close(1);

    await expect(promise).rejects.toThrow(/maximum buffer size/i);
  });

  it("allows oversized structured Codex stdout lines", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);
    const largeText = "x".repeat(1024 * 1024 + 1);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.stdout.emitData(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: largeText } }) + "\n");
    child.stdout.emitData('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2,"cached_input_tokens":3}}\n');
    child.close(0);

    const response = await promise;
    expect(response.text).toHaveLength(largeText.length);
    expect(response.text).toBe(largeText);
    expect(response.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cachedTokens: 3,
    });
  });

  it("does not fail when stderr is noisy but stdout still produces a valid result", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });

    child.stderr.emitData("warn\n".repeat(300_000));
    child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
    child.stdout.emitData('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2,"cached_input_tokens":3}}\n');
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "ok",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedTokens: 3,
      },
    });
  });

  it("forwards Codex fast mode into process startup config", async () => {
    const { spawnCodex, child, calls } = createSpawnHarness();
    const root = await mkdtemp(path.join(os.tmpdir(), "cc-telegram-bridge-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ codexServiceTier: "fast" }) + "\n", "utf8");
      const adapter = new ProcessCodexAdapter("codex", spawnCodex, undefined, undefined, configPath);

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await waitForSpawn(calls);
      expect(calls[0]?.args).toEqual([
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "--enable",
        "fast_mode",
        "-c",
        'service_tier="fast"',
        "-",
      ]);

      child.stdout.emitData('{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n');
      child.close(0);
      await promise;
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects when the overall Codex process turn exceeds the runtime timeout", async () => {
    vi.useFakeTimers();
    const { spawnCodex } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter(
      "codex",
      spawnCodex,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      CODEX_PROCESS_TURN_TIMEOUT_MS,
      null,
    );

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });
    const rejection = expect(promise).rejects.toThrow("Codex process turn timed out after 60 minutes");

    await vi.advanceTimersByTimeAsync(CODEX_PROCESS_TURN_TIMEOUT_MS);
    await rejection;
  });

  it("rejects when the Codex process turn goes inactive", async () => {
    vi.useFakeTimers();
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    const promise = adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    });
    const rejection = expect(promise).rejects.toThrow("Codex process turn became inactive after 30 minutes");

    child.stdout.emitData('{"type":"thread.started","thread_id":"thread-123"}\n');
    await vi.advanceTimersByTimeAsync(CODEX_PROCESS_INACTIVITY_TIMEOUT_MS);
    await rejection;
  });

  it("kills the child promptly when the abort signal is already aborted", async () => {
    const { spawnCodex, child } = createSpawnHarness();
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
      abortSignal: controller.signal,
    })).rejects.toThrow("Task was stopped by user");
    expect(child.stdin.ended).toBe(false);
  });

  it("rejects immediately when stdin.end throws synchronously", async () => {
    const child = new FakeChildProcess();
    child.stdin.end = () => {
      throw new Error("EPIPE");
    };
    const spawnCodex = () => child;
    const adapter = new ProcessCodexAdapter("codex", spawnCodex);

    await expect(adapter.sendUserMessage("thread-123", {
      text: "Hello",
      files: [],
    })).rejects.toThrow("EPIPE");
    expect(child.stdin.ended).toBe(false);
  });
});

class FakeStream extends EventEmitter {
  emitData(chunk: string) {
    this.emit("data", chunk);
  }
}

class FakeChildProcess extends EventEmitter {
  killedSignals: string[] = [];
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

  kill(signal?: string) {
    this.killedSignals.push(signal ?? "SIGTERM");
    return true;
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
