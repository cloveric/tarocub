import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ProcessAntigravityAdapter } from "../src/codex/antigravity-adapter.js";
import { removeTempRoot } from "./helpers/temp-files.js";

describe("ProcessAntigravityAdapter", () => {
  it("creates a logical telegram session placeholder", async () => {
    const adapter = new ProcessAntigravityAdapter("agy");
    await expect(adapter.createSession(12345)).resolves.toEqual({
      sessionId: "telegram-12345",
    });
  });

  it("runs agy print turns with prompt, attachments, workspace, and side-channel env", async () => {
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
        PATH: `/tmp/bin:/usr/bin`,
        NODE_OPTIONS: "--require /tmp/hack.js",
      },
    });

    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    child.stdout.emitData("  answer from agy  \n");
    child.close(0);

    await expect(promise).resolves.toEqual({ text: "answer from agy" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "agy",
      options: {
        cwd: "/tmp/workspace",
        shell: false,
        windowsHide: true,
      },
    });
    expect(calls[0]?.args).not.toContain("--conversation");
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--print",
      "--print-timeout",
      "1h",
      "--add-dir",
      "/tmp/workspace",
      "-",
    ]));
    expect(child.stdin.writes.join("")).toBe(
      "Reply through Telegram.\n---\nHello\nAttachment: a.png\nAttachment: b.pdf",
    );
    expect(calls[0]?.options.env?.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(childEnv.TELEGRAM_BOT_TOKEN).toBe("secret-token");
    expect(calls[0]?.options.env?.CCTB_SEND_URL).toBe("http://127.0.0.1/send");
    expect(calls[0]?.options.env?.NODE_OPTIONS).toBeUndefined();
  });

  it("binds new Telegram chats to the Antigravity conversation reported in the CLI log", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-home-"));
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter(
      "agy",
      { HOME: root },
      spawnAntigravity,
      undefined,
      undefined,
      "/tmp/workspace",
    );

    try {
      const onEngineEvent = vi.fn();
      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
        onEngineEvent,
      });

      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      const logDir = path.join(root, ".gemini", "antigravity-cli", "log");
      await mkdir(logDir, { recursive: true });
      await writeFile(
        path.join(logDir, "cli-20260520_095913.log"),
        'I0520 09:59:15.497863  4242 printmode.go:130] Print mode: conversation=fdfc8ab1-7936-4599-98b0-d8ba2593c250, sending message\n',
        "utf8",
      );
      child.stdout.emitData("ok");
      child.close(0);

      await expect(promise).resolves.toEqual({
        text: "ok",
        sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
      });
      expect(onEngineEvent).toHaveBeenCalledWith({
        type: "session",
        sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("emits stdout progress as assistant text stream events", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter(
      "agy",
      { HOME: "/tmp/home" },
      spawnAntigravity,
      undefined,
      undefined,
      "/tmp/workspace",
    );
    const onProgress = vi.fn();
    const onEngineEvent = vi.fn();

    const promise = adapter.sendUserMessage("telegram-12345", {
      text: "Stream",
      files: [],
      onProgress,
      onEngineEvent,
    });

    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    child.stdout.emitData("hello ");
    child.stdout.emitData("world");
    child.close(0);

    await expect(promise).resolves.toEqual({ text: "hello world" });
    expect(onProgress).toHaveBeenNthCalledWith(1, "hello ");
    expect(onProgress).toHaveBeenNthCalledWith(2, "hello world");
    expect(onEngineEvent).toHaveBeenCalledWith({
      type: "assistant_text",
      text: "hello ",
    });
    expect(onEngineEvent).toHaveBeenCalledWith({
      type: "assistant_text",
      text: "world",
    });
  });

  it("resumes non-logical Antigravity conversations with --conversation", async () => {
    const { spawnAntigravity, child, calls } = createSpawnHarness();
    const adapter = new ProcessAntigravityAdapter(
      "agy",
      { HOME: "/tmp/home" },
      spawnAntigravity,
      undefined,
      undefined,
      "/tmp/workspace",
    );

    const promise = adapter.sendUserMessage("fdfc8ab1-7936-4599-98b0-d8ba2593c250", {
      text: "Continue",
      files: [],
    });

    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    child.stdout.emitData("continued");
    child.close(0);

    await expect(promise).resolves.toEqual({
      text: "continued",
      sessionId: "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
    });
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "--conversation",
      "fdfc8ab1-7936-4599-98b0-d8ba2593c250",
    ]));
  });

  it("starts Antigravity in YOLO mode when full-auto is configured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ approvalMode: "full-auto" }), "utf8");
      const { spawnAntigravity, child, calls } = createSpawnHarness();
      const adapter = new ProcessAntigravityAdapter(
        "agy",
        { HOME: "/tmp/home" },
        spawnAntigravity,
        undefined,
        configPath,
        "/tmp/workspace",
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      child.stdout.emitData("ok");
      child.close(0);

      await expect(promise).resolves.toEqual({ text: "ok" });
      expect(calls[0]?.args).toEqual(expect.arrayContaining([
        "--print",
        "--print-timeout",
        "1h",
        "--dangerously-skip-permissions",
        "--add-dir",
        "/tmp/workspace",
        "-",
      ]));
    } finally {
      await removeTempRoot(root);
    }
  });

  it("defaults Antigravity engine configs without an approval mode to YOLO", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-adapter-"));
    const configPath = path.join(root, "config.json");

    try {
      await writeFile(configPath, JSON.stringify({ engine: "antigravity" }), "utf8");
      const { spawnAntigravity, child, calls } = createSpawnHarness();
      const adapter = new ProcessAntigravityAdapter(
        "agy",
        { HOME: "/tmp/home" },
        spawnAntigravity,
        undefined,
        configPath,
        "/tmp/workspace",
      );

      const promise = adapter.sendUserMessage("telegram-12345", {
        text: "Hello",
        files: [],
      });

      await vi.waitFor(() => {
        expect(calls).toHaveLength(1);
      });
      child.stdout.emitData("ok");
      child.close(0);

      await expect(promise).resolves.toEqual({ text: "ok" });
      expect(calls[0]?.args).toContain("--dangerously-skip-permissions");
    } finally {
      await removeTempRoot(root);
    }
  });
});

class FakeStream extends EventEmitter {
  emitData(chunk: string) {
    this.emit("data", chunk);
  }
}

class FakeChildProcess extends EventEmitter {
  pid = 4242;
  stdin = {
    writes: [] as string[],
    ended: false,
    end: (chunk?: string) => {
      if (chunk) {
        this.stdin.writes.push(chunk);
      }
      this.stdin.ended = true;
    },
  };
  stdout = new FakeStream();
  stderr = new FakeStream();

  kill() {
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
    options: { stdio: ["pipe", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv; cwd?: string; windowsHide?: boolean };
  }> = [];
  const spawnAntigravity = (
    command: string,
    args: string[],
    options: { stdio: ["pipe", "pipe", "pipe"]; shell?: boolean; env?: NodeJS.ProcessEnv; cwd?: string; windowsHide?: boolean },
  ) => {
    calls.push({ command, args, options });
    return child;
  };

  return { spawnAntigravity, child, calls };
}
