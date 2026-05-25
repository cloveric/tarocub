import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import AdmZip from "adm-zip";
import { describe, expect, it, vi } from "vitest";

import type { EngineApprovalRequest, EngineStreamEvent } from "../src/codex/adapter.js";
import {
  buildLarkCronExecutor,
  createLarkDocumentWithCli,
  createLarkServiceRuntime,
  handleLarkCardAction,
  handleLarkComment,
  handleLarkMessage,
  type LarkStreamControllerLike,
  requestLarkApproval,
} from "../src/lark/service.js";
import { stableLarkNumericId } from "../src/lark/message-normalizer.js";
import { CronStore } from "../src/state/cron-store.js";
import { MiniBusStore } from "../src/state/mini-bus-store.js";
import { SessionStore } from "../src/state/session-store.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";
import { UsageStore } from "../src/state/usage-store.js";

function createZipBuffer(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [filename, contents] of Object.entries(files)) {
    zip.addFile(filename, Buffer.from(contents, "utf8"));
  }
  return zip.toBuffer();
}

describe("lark service", () => {
  it("does not run the engine for an unpaired Lark private chat", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-access-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "使用配对码 ABC123 配对此私聊" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: expect.stringContaining("node dist/src/index.js lark access pair ABC123") },
        { replyTo: "om_1", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("routes Lark messages through the bridge and sends the final result directly", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-service-"));
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => Buffer.from("hello file")),
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (input: {
        chatType: string;
        conversationKey?: string;
        files: string[];
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        await input.onEngineEvent?.({ type: "assistant_text", text: "Hi from bridge" });
        await input.onEngineEvent?.({ type: "result", text: "Done from bridge" });
        return { text: "Done from bridge" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [{ type: "file", fileKey: "file_1", fileName: "note.txt" }],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(channel.stream).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: expect.stringContaining("hello"),
      }));
      const bridgeInput = bridge.handleAuthorizedMessage.mock.calls[0]![0];
      expect(bridgeInput.files).toHaveLength(1);
      await expect(readFile(bridgeInput.files[0]!, "utf8")).resolves.toBe("hello file");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "Done from bridge" },
        { replyTo: "om_1" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("summarizes Lark zip archives and waits for continue instead of running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-archive-summary-"));
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => zipBuffer),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_zip",
          content: "分析这个压缩包",
          resources: [{ type: "file", fileKey: "file_zip", fileName: "repo.zip" }],
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Archive summary: repo.zip") },
        { replyTo: "om_zip", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("README.md") },
        { replyTo: "om_zip", replyInThread: false },
      );

      const workflowState = JSON.parse(await readFile(path.join(stateDir, "file-workflow.json"), "utf8")) as {
        records: Array<{ kind: string; status: string; chatId: number; summary: string }>;
      };
      expect(workflowState.records).toHaveLength(1);
      expect(workflowState.records[0]).toMatchObject({
        kind: "archive",
        status: "awaiting_continue",
        chatId: stableLarkNumericId("lark:oc_chat"),
      });
      expect(workflowState.records[0]?.summary).toContain("src/");
      expect(workflowState.records[0]?.summary).toContain("index.ts");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("continues Lark zip archive analysis from the waiting workflow", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-archive-continue-"));
    const zipBuffer = createZipBuffer({
      "README.md": "# hello",
      "src/index.ts": "console.log('hi')",
    });
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => zipBuffer),
    });
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "analysis done" })),
    };
    const runtime = createLarkServiceRuntime();

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_zip",
          content: "分析这个压缩包",
          resources: [{ type: "file", fileKey: "file_zip", fileName: "repo.zip" }],
        }),
      });

      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_continue",
          content: "继续分析 看看结构",
          resources: [],
        }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const bridgeInput = (bridge.handleAuthorizedMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        chatType: string;
        conversationKey: string;
        files: string[];
        text: string;
      };
      expect(bridgeInput).toEqual(expect.objectContaining({
        chatType: "private",
        conversationKey: "lark:oc_chat",
        files: [],
        text: expect.stringContaining("[Archive Analysis Context]"),
      }));
      expect(bridgeInput.text).toContain("看看结构");
      expect(bridgeInput.text).toContain("Extracted files live under:");
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "analysis done" },
        { replyTo: "om_continue" },
      );

      const workflowState = JSON.parse(await readFile(path.join(stateDir, "file-workflow.json"), "utf8")) as {
        records: Array<{ status: string }>;
      };
      expect(workflowState.records[0]?.status).toBe("completed");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers the Lark help command without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-help-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      validateCodexThread: vi.fn(async () => undefined),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_help",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "/help",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("/context") },
        { replyTo: "om_help", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("/ask <实例> <提示>") },
        { replyTo: "om_help", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers the Lark status command without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-status-"));
    const runtime = createLarkServiceRuntime();
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });
    await new SessionStore(path.join(stateDir, "session.json")).upsert({
      telegramChatId: stableLarkNumericId("lark:oc_chat"),
      conversationKey: "lark:oc_chat",
      codexSessionId: "thread-status-123",
      status: "idle",
      updatedAt: new Date("2026-05-25T00:00:00.000Z").toISOString(),
    });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          messageId: "om_status",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "/status",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        {
          markdown: expect.stringContaining("Current thread: thread-status-123"),
        },
        { replyTo: "om_status", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).toContain("lark:oc_chat");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Session bound: yes");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Active run: yes");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("aborts the active run from a Lark stop text command", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-stop-"));
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          messageId: "om_stop",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "/stop",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(abortController.signal.aborted).toBe(true);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "已停止。" },
        { replyTo: "om_stop", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers the Lark usage command from the shared usage store", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-usage-"));
    await new UsageStore(stateDir).record({
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 10,
      costUsd: 0.0123,
    }, new Date("2026-05-25T00:00:00.000Z"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_usage", content: "/usage" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("请求数：1") },
        { replyTo: "om_usage", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("sets Lark model and effort commands in the shared instance config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-config-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_model", content: "/model opus" }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_effort", content: "/effort max" }),
      });

      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.model).toBe("opus");
      expect(config.effort).toBe("max");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(JSON.stringify(channel.send.mock.calls)).toContain("模型已设为 opus");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("Effort 已设为 max");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps Lark Antigravity model commands local instead of forwarding them", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-agy-model-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "antigravity" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_model", content: "/model gemini-3.5-flash" }),
      });

      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.model).toBeUndefined();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Antigravity 模型") },
        { replyTo: "om_model", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("toggles Lark Codex fast mode through the shared instance config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-fast-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_fast", content: "/fast on" }),
      });

      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.codexServiceTier).toBe("fast");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Fast Mode 已开启") },
        { replyTo: "om_fast", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("switches the Lark engine through the shared instance config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-engine-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", model: "gpt-5.4" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_engine", content: "/engine antigravity" }),
      });

      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.engine).toBe("antigravity");
      expect(config.model).toBeUndefined();
      expect(config.approvalMode).toBe("full-auto");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("引擎已设为 antigravity") },
        { replyTo: "om_engine", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("toggles Lark YOLO mode through the shared instance config", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-yolo-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_yolo", content: "/yolo on" }),
      });

      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.approvalMode).toBe("full-auto");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("YOLO mode ON") },
        { replyTo: "om_yolo", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resets the current Lark conversation session without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-reset-"));
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    await sessionStore.upsert({
      telegramChatId: stableLarkNumericId("lark:oc_chat"),
      conversationKey: "lark:oc_chat",
      codexSessionId: "thread-old",
      status: "idle",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
      engine: "codex",
      resume: { sessionId: "old", dirName: "old", workspacePath: "/tmp/old" },
    }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_reset", content: "/reset" }),
      });

      expect(await sessionStore.findByConversationKey("lark:oc_chat")).toBeNull();
      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, unknown>;
      expect(config.resume).toBeUndefined();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("当前聊天的会话已重置") },
        { replyTo: "om_reset", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("detaches the current Lark Codex thread without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-detach-"));
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    await sessionStore.upsert({
      telegramChatId: stableLarkNumericId("lark:oc_chat"),
      conversationKey: "lark:oc_chat",
      codexSessionId: "thread-old",
      status: "idle",
      updatedAt: "2026-05-25T00:00:00.000Z",
    });
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      validateCodexThread: vi.fn(async () => undefined),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_detach", content: "/detach" }),
      });

      expect(await sessionStore.findByConversationKey("lark:oc_chat")).toBeNull();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已断开当前 Codex thread") },
        { replyTo: "om_detach", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("binds an explicit Codex thread from Lark resume without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-resume-thread-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      validateCodexThread: vi.fn(async () => undefined),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_resume", content: "/resume thread thread-abc" }),
      });

      const record = await sessionStore.findByConversationKey("lark:oc_chat");
      expect(record?.codexSessionId).toBe("thread-abc");
      expect(record?.telegramChatId).toBe(stableLarkNumericId("lark:oc_chat"));
      expect(bridge.validateCodexThread).toHaveBeenCalledWith("thread-abc");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已绑定 Codex thread：thread-abc") },
        { replyTo: "om_resume", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("binds an explicit Antigravity conversation from Lark resume without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-resume-agy-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "antigravity" }) + "\n");
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_resume",
          content: "/resume conversation fdfc8ab1-7936-4599-98b0-d8ba2593c250",
        }),
      });

      const record = await sessionStore.findByConversationKey("lark:oc_chat");
      expect(record?.codexSessionId).toBe("fdfc8ab1-7936-4599-98b0-d8ba2593c250");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已绑定 Antigravity conversation") },
        { replyTo: "om_resume", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resumes a scanned Claude session from Lark without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-resume-claude-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const scanRecentSessions = vi.fn(async () => [
      {
        sessionId: "claude-session-1",
        dirName: "-Users-cloveric-projects-demo",
        workspacePath: "/Users/cloveric/projects/demo",
        modifiedAt: new Date("2026-05-25T06:00:00.000Z"),
        displayName: "demo",
      },
    ]);

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          sessionRuntime: { scanRecentSessions },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_resume_scan", content: "/resume" }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          sessionRuntime: { scanRecentSessions },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_resume_pick", content: "/resume 1" }),
      });

      const record = await sessionStore.findByConversationKey("lark:oc_chat");
      expect(record?.codexSessionId).toBe("claude-session-1");
      expect(record?.telegramChatId).toBe(stableLarkNumericId("lark:oc_chat"));
      const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as Record<string, any>;
      expect(config.resume).toMatchObject({
        sessionId: "claude-session-1",
        dirName: "-Users-cloveric-projects-demo",
        workspacePath: "/Users/cloveric/projects/demo",
      });
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("demo") },
        { replyTo: "om_resume_scan", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已恢复 session：demo") },
        { replyTo: "om_resume_pick", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("adds Lark cron jobs with raw Lark routing metadata", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-add-"));
    const store = new CronStore(stateDir);
    const scheduler = { refresh: vi.fn(async () => undefined), runJobNow: vi.fn(async () => undefined) };
    const runtime = createLarkServiceRuntime({ cronRuntime: { store, scheduler } });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_cron",
          content: "/cron add 0 9 * * * morning summary",
        }),
      });

      const jobs = await store.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        larkChatId: "oc_chat",
        larkMessageId: "om_cron",
        conversationKey: "lark:oc_chat",
        prompt: "morning summary",
      });
      expect(scheduler.refresh).toHaveBeenCalledOnce();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已添加任务") },
        { replyTo: "om_cron", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("runs Lark cron notifications back to the raw Lark chat", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-run-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const executor = buildLarkCronExecutor({
      channel,
      bridge,
      runtime,
      stateDir,
    });

    try {
      await executor({
        id: "1234abcd",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        larkChatId: "oc_chat",
        cronExpr: "0 9 * * *",
        timezone: "Asia/Shanghai",
        prompt: "提醒我：明天早定课",
        enabled: true,
        runOnce: true,
        sessionMode: "new_per_run",
        deliveryMode: "notify",
        mute: false,
        silent: false,
        timeoutMins: 30,
        maxFailures: 3,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
        failureCount: 0,
        runHistory: [],
      });

      expect(bridge.checkAccess).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        conversationKey: "lark:oc_chat",
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "⏰ 提醒\n早定课" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("runs Lark cron notifications back into the originating Lark thread", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-thread-"));
    const channel = fakeChannel();
    const runtime = createLarkServiceRuntime();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const executor = buildLarkCronExecutor({
      channel,
      bridge,
      runtime,
      stateDir,
    });

    try {
      await executor({
        id: "1234abcd",
        channel: "lark",
        chatId: stableLarkNumericId("lark:oc_chat:omt_thread"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "group",
        conversationKey: "lark:oc_chat:omt_thread",
        larkChatId: "oc_chat",
        larkThreadId: "omt_thread",
        larkMessageId: "om_cron_thread",
        cronExpr: "0 9 * * *",
        timezone: "Asia/Shanghai",
        prompt: "提醒我：明天早定课",
        enabled: true,
        runOnce: true,
        sessionMode: "new_per_run",
        deliveryMode: "notify",
        mute: false,
        silent: false,
        timeoutMins: 30,
        maxFailures: 3,
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
        failureCount: 0,
        runHistory: [],
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "⏰ 提醒\n早定课" },
        { replyTo: "om_cron_thread", replyInThread: true },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("sets an unbounded structured Codex goal from Lark by default", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-goal-budget-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      setThreadGoal: vi.fn(async () => ({
        goal: {
          threadId: "lark:oc_chat",
          objective: "ship the release",
          status: "active" as const,
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1779690000,
          updatedAt: 1779690000,
        },
      })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal", content: "/goal ship the release" }),
      });

      expect(bridge.setThreadGoal).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        objective: "ship the release",
        tokenBudget: null,
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("无 token 预算") },
        { replyTo: "om_goal", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("sets a structured Codex goal from Lark without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-goal-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      setThreadGoal: vi.fn(async () => ({
        goal: {
          threadId: "lark:oc_chat",
          objective: "ship the release",
          status: "active" as const,
          tokenBudget: 50_000,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1779690000,
          updatedAt: 1779690000,
        },
      })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal", content: "/goal -b 50k ship the release" }),
      });

      expect(bridge.setThreadGoal).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        objective: "ship the release",
        tokenBudget: 50_000,
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Goal 已设置") },
        { replyTo: "om_goal", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes unbounded Claude goals through by default from Lark", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-claude-goal-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const seenTexts: string[] = [];
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { text: string }) => {
        seenTexts.push(input.text);
        return { text: "goal passed through" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal", content: "/goal 写发布说明" }),
      });

      expect(seenTexts).toEqual(["/goal 写发布说明"]);
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "goal passed through" },
        { replyTo: "om_goal" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes explicitly unbounded Claude goals through as native slash commands from Lark", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-claude-goal-unbounded-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const seenTexts: string[] = [];
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { text: string }) => {
        seenTexts.push(input.text);
        return { text: "goal passed through" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal", content: "/goal --unbounded 写发布说明" }),
      });

      expect(seenTexts).toEqual(["/goal 写发布说明"]);
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "goal passed through" },
        { replyTo: "om_goal" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("forwards Claude context commands from Lark without starting a regular stream turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-context-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }) + "\n");
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (input: { text: string }) => ({ text: `native ${input.text} result` })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_context", content: "/context" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: "/context",
        files: [],
      }));
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "native /context result" },
        { replyTo: "om_context", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark board add and list without running the engine", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-board-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_board_add", content: "/board add Ship Lark parity" }),
      });
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_board_list", content: "/board list" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已创建 B1") },
        { replyTo: "om_board_add", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("Ship Lark parity") },
        { replyTo: "om_board_list", replyInThread: false },
      );

      const events = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(events.filter((event) => event.metadata?.command === "board").map((event) => event.channel)).toEqual(["lark", "lark"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark fan delegation through the shared Agent Bus command path", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-fan-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "self answer" })),
    };
    const delegateToInstance = vi.fn(async () => ({ success: true, text: "peer answer" }));

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          busRuntime: {
            loadBusConfig: vi.fn(async () => ({
              peers: "*" as const,
              maxDepth: 3,
              port: 0,
              secret: "secret",
              parallel: ["peer1"],
              chain: [],
              verifier: null,
              crew: null,
            })),
            delegateToInstance,
          },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_fan", content: "/fan compare this" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: "compare this",
      }));
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({
        fromInstance: "lark",
        targetInstance: "peer1",
        prompt: "compare this",
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("正在并行查询 2 个 bot") },
        { replyTo: "om_fan", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("[peer1]\npeer answer") },
        { replyTo: "om_fan", replyInThread: false },
      );

      const events = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(events).toContainEqual(expect.objectContaining({
        channel: "lark",
        metadata: expect.objectContaining({ command: "fan", fanTargets: ["peer1"] }),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark /btw as an isolated side question without touching the current conversation", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-btw-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "side answer" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_btw", content: "/btw quick side question" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        userId: stableLarkNumericId("user:ou_user"),
        chatType: "bus",
        text: "quick side question",
        files: [],
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.not.objectContaining({
        conversationKey: "lark:oc_chat",
      }));
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "side answer" },
        { replyTo: "om_btw", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark ask delegation through the shared Agent Bus command path", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-ask-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const delegateToInstance = vi.fn(async () => ({ success: true, text: "peer answer" }));

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          busRuntime: {
            loadBusConfig: vi.fn(),
            delegateToInstance,
          },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_ask", content: "/ask reviewer inspect this" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({
        fromInstance: "lark",
        targetInstance: "reviewer",
        prompt: "inspect this",
        depth: 0,
        stateDir,
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "正在转发给 reviewer..." },
        { replyTo: "om_ask", replyInThread: false },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "[来自 reviewer]\n\npeer answer" },
        { replyTo: "om_ask", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark chain delegation through configured Agent Bus peers", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-chain-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ success: true, text: "draft" })
      .mockResolvedValueOnce({ success: true, text: "final" });

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          busRuntime: {
            loadBusConfig: vi.fn(async () => ({
              peers: "*" as const,
              maxDepth: 3,
              port: 0,
              secret: "secret",
              parallel: [],
              chain: ["reviewer", "writer"],
              verifier: null,
              crew: null,
            })),
            delegateToInstance,
          },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_chain", content: "/chain improve this" }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(delegateToInstance).toHaveBeenNthCalledWith(1, expect.objectContaining({
        fromInstance: "lark",
        targetInstance: "reviewer",
        prompt: "improve this",
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(2, expect.objectContaining({
        fromInstance: "lark",
        targetInstance: "writer",
        prompt: expect.stringContaining("draft"),
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("[链路阶段 2: writer]") },
        { replyTo: "om_chain", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("handles Lark verify delegation through the shared verifier path", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-verify-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "draft answer" })),
    };
    const delegateToInstance = vi.fn(async () => ({ success: true, text: "looks good" }));

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          busRuntime: {
            loadBusConfig: vi.fn(async () => ({
              peers: "*" as const,
              maxDepth: 3,
              port: 0,
              secret: "secret",
              parallel: [],
              chain: [],
              verifier: "reviewer",
              crew: null,
            })),
            delegateToInstance,
          },
        }),
        stateDir,
        message: fakeLarkMessage({ messageId: "om_verify", content: "/verify check this" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: "check this",
      }));
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({
        fromInstance: "lark",
        targetInstance: "reviewer",
        prompt: expect.stringContaining("draft answer"),
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("[reviewer 的验证]") },
        { replyTo: "om_verify", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("registers a Lark thread as a Mini Bus peer", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-mini-here-"));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_mini_here",
          chatType: "group",
          threadId: "omt_planner",
          mentionedBot: true,
          content: "/mini here planner",
        }),
      });

      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("已注册 Mini Bus peer planner") },
        { replyTo: "om_mini_here", replyInThread: true },
      );

      const groupChatId = stableLarkNumericId("lark-group:oc_chat");
      const threadId = stableLarkNumericId("lark-thread:omt_planner");
      await expect(new MiniBusStore(stateDir).listPeers(groupChatId)).resolves.toEqual([
        expect.objectContaining({
          name: "planner",
          chatId: groupChatId,
          messageThreadId: threadId,
          conversationKey: "lark:oc_chat:omt_planner",
        }),
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("asks a registered Lark Mini Bus peer through its thread conversation", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-mini-ask-"));
    const channel = fakeChannel();
    const groupChatId = stableLarkNumericId("lark-group:oc_chat");
    const writerThreadId = stableLarkNumericId("lark-thread:omt_writer");
    await new MiniBusStore(stateDir).upsertPeer({
      name: "writer",
      chatId: groupChatId,
      messageThreadId: writerThreadId,
      conversationKey: "lark:oc_chat:omt_writer",
    });
    const queuedBridgeTurns: string[] = [];
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "writer answer" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime({
          miniRuntime: {
            runQueuedBridgeTurn: async (conversationKey, job) => {
              queuedBridgeTurns.push(conversationKey);
              return await job();
            },
          },
        }),
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_mini_ask",
          chatType: "group",
          threadId: "omt_planner",
          mentionedBot: true,
          content: "/mini ask writer draft this",
        }),
      });

      expect(queuedBridgeTurns).toEqual(["lark:oc_chat:omt_writer"]);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatId: groupChatId,
        chatType: "bus",
        messageThreadId: writerThreadId,
        conversationKey: "lark:oc_chat:omt_writer",
        text: "draft this",
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("[writer]\n\nwriter answer") },
        { replyTo: "om_mini_ask", replyInThread: true },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("aborts the active run from a stop card action", async () => {
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    const channel = fakeChannel();

    const handled = await handleLarkCardAction({
      channel,
      runtime,
      event: {
        chatId: "oc_chat",
        messageId: "om_card",
        operator: { openId: "ou_user" },
        action: {
          value: { cctb_lark: "stop", conversationKey: "lark:oc_chat" },
        },
      },
    });

    expect(handled).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "已停止。" }, { replyTo: "om_card" });
  });

  it("ignores Lark document comments that do not mention the bot", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-skip-"));
    const commentClient = fakeCommentClient();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent({ mentionedBot: false }),
      });

      expect(handled).toBe(false);
      expect(commentClient.getCommentContext).not.toHaveBeenCalled();
      expect(commentClient.createReply).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("answers mentioned Lark document comments by replying in the comment thread", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-run-"));
    const commentClient = fakeCommentClient({
      getCommentContext: vi.fn(async () => ({
        quote: "被选中的原文",
        replies: [{
          replyId: "reply_1",
          userId: "ou_user",
          text: "@bot 帮我总结这里",
          docsLinks: ["https://example.feishu.cn/docx/doc_token"],
        }],
      })),
    });
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async (_input: {
        conversationKey?: string;
        files: string[];
        text: string;
      }) => ({ text: "这是评论回复。[send-file:/tmp/ignored.txt]" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(bridge.checkUserAuthorization).toHaveBeenCalledWith(expect.objectContaining({
        conversationKey: "lark-comment:doc_token",
        locale: "zh",
      }));
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        conversationKey: "lark-comment:doc_token",
        files: [],
        text: expect.stringContaining("<lark_comment_context>"),
      }));
      const text = bridge.handleAuthorizedMessage.mock.calls[0]![0].text;
      expect(text).toContain("file_token: doc_token");
      expect(text).toContain("comment_id: comment_1");
      expect(text).toContain("被选中的原文");
      expect(text).toContain("@bot 帮我总结这里");
      expect(commentClient.createReply).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        text: "这是评论回复。",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("replies with an access denial for unauthorized Lark document comment operators", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-comment-deny-"));
    const commentClient = fakeCommentClient();
    const bridge = {
      checkUserAuthorization: vi.fn(async () => ({ kind: "reply" as const, text: "使用配对码配对此用户" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkComment({
        bridge,
        runtime: createLarkServiceRuntime({ commentClient }),
        stateDir,
        event: fakeCommentEvent(),
      });

      expect(handled).toBe(true);
      expect(commentClient.getCommentContext).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(commentClient.createReply).toHaveBeenCalledWith({
        fileToken: "doc_token",
        fileType: "docx",
        commentId: "comment_1",
        text: "使用配对码配对此用户",
      });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers generated files from bridge delivery tags", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-delivery-"));
    const outputDir = path.join(stateDir, "workspace", "out");
    const filePath = path.join(outputDir, "report.txt");
    await mkdir(outputDir, { recursive: true });
    await writeFile(filePath, "report body");
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async (input: {
        onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      }) => {
        await input.onEngineEvent?.({ type: "result", text: `Here [send-file:${filePath}]` });
        return { text: `Here [send-file:${filePath}]` };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "make report",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { file: { source: Buffer.from("report body"), fileName: "report.txt" } },
        { replyTo: "om_1" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports a sanitized error when attachment download fails before the engine starts", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-download-fail-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel({
      downloadResource: vi.fn(async () => {
        throw new Error(`/private/tmp/${path.basename(stateDir)}/download failed`);
      }),
    });
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await expect(handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "see file",
          rawContentType: "text",
          resources: [{ type: "file", fileKey: "file_1", fileName: "note.txt" }],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      })).resolves.toBe(true);

      expect(runtime.activeRuns.size).toBe(0);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { text: "错误：准备飞书消息时失败，请稍后重试。" },
        { replyTo: "om_1", replyInThread: false },
      );
      expect(JSON.stringify(channel.send.mock.calls)).not.toContain(stateDir);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps engine error details out of user-visible Lark cards", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-engine-error-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => {
        throw new Error(`/Users/tester/.cctb/${path.basename(stateDir)}/engine exploded`);
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      const rendered = JSON.stringify(channel.send.mock.calls);
      expect(rendered).toContain("引擎运行失败");
      expect(rendered).not.toContain("/Users/tester");
      expect(rendered).not.toContain("engine exploded");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers rich Lark post and custom interactive card tool tags", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-rich-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: [
          "plain intro",
          '[tool:{"name":"lark.post","payload":{"post":{"zh_cn":{"title":"周报","content":[[{"tag":"text","text":"重点"}]]}}}}]',
          '[tool:{"name":"lark.card","payload":{"title":"请选择","body":"下一步怎么做？","actions":[{"label":"继续","value":"continue"},{"label":"停止","value":"stop"}]}}]',
        ].join("\n"),
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "send rich",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(channel.send).toHaveBeenCalledWith("oc_chat", {
        post: {
          zh_cn: {
            title: "周报",
            content: [[{ tag: "text", text: "重点" }]],
          },
        },
      }, { replyTo: "om_1" });
      const sendCalls = channel.send.mock.calls as unknown as Array<[string, unknown, unknown?]>;
      const cardCall = sendCalls.find((call) => JSON.stringify(call[1]).includes("下一步怎么做"));
      expect(cardCall?.[1]).toMatchObject({ card: expect.any(Object) });
      expect(JSON.stringify(cardCall?.[1])).toContain("cctb_lark");
      expect(JSON.stringify(cardCall?.[1])).toContain("choice");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("decorates raw lark.card buttons so choices route back to the bridge", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-raw-card-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.card","payload":{"card":{"schema":"2.0","body":{"elements":[{"tag":"button","text":{"tag":"plain_text","content":"批准"},"value":{"id":"approve"}}]}}}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "send raw card",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      const raw = JSON.stringify(channel.send.mock.calls);
      expect(raw).toContain('"behaviors"');
      expect(raw).toContain('"cctb_lark":"choice"');
      expect(raw).toContain('"conversationKey":"lark:oc_chat"');
      expect(raw).toContain('"id":"approve"');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("delivers audio and video tool tags through Lark media payloads", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-media-"));
    const outputDir = path.join(stateDir, "workspace", "out");
    const audioPath = path.join(outputDir, "clip.mp3");
    const videoPath = path.join(outputDir, "clip.mp4");
    await mkdir(outputDir, { recursive: true });
    await writeFile(audioPath, "audio body");
    await writeFile(videoPath, "video body");
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: [
          `[tool:{"name":"send.audio","payload":{"path":"${audioPath}"}}]`,
          `[tool:{"name":"send.video","payload":{"path":"${videoPath}"}}]`,
        ].join("\n"),
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "send media",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { audio: { source: Buffer.from("audio body"), fileName: "clip.mp3" } },
        { replyTo: "om_1" },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { video: { source: Buffer.from("video body"), fileName: "clip.mp4" } },
        { replyTo: "om_1" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("records Lark turns in the shared timeline", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-timeline-"));
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      const timeline = parseTimelineEvents(await readFile(path.join(stateDir, "timeline.log.jsonl"), "utf8"));
      expect(timeline).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "input.received",
          channel: "lark",
          conversationKey: "lark:oc_chat",
        }),
        expect.objectContaining({
          type: "turn.completed",
          channel: "lark",
          conversationKey: "lark:oc_chat",
          outcome: "success",
        }),
      ]));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("creates Feishu docs from lark.doc.create tool tags", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-doc-"));
    const runtime = createLarkServiceRuntime({
      createDocument: vi.fn(async () => ({
        title: "Spec",
        url: "https://example.feishu.cn/docx/doc_1",
        documentId: "doc_1",
      })),
    });
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({
        text: '[tool:{"name":"lark.doc.create","payload":{"title":"Spec","content":"# Spec\\n\\n正文","docFormat":"markdown"}}]',
      })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "write spec",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      });

      expect(runtime.createDocument).toHaveBeenCalledWith(expect.objectContaining({
        title: "Spec",
        content: "# Spec\n\n正文",
        docFormat: "markdown",
      }));
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: expect.stringContaining("https://example.feishu.cn/docx/doc_1") },
        { replyTo: "om_1" },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses the installed lark-cli docs +create flags for Feishu document creation", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cli-"));
    const binDir = path.join(tempDir, "bin");
    const logPath = path.join(tempDir, "args.json");
    const contentLogPath = path.join(tempDir, "content.txt");
    const fakeCliPath = path.join(binDir, "lark-cli");
    const originalPath = process.env.PATH;
    await mkdir(binDir, { recursive: true });
    await writeFile(fakeCliPath, [
      "#!/usr/bin/env node",
      "const path = require('node:path');",
      "const { readFileSync, writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));`,
      "const markdownIndex = process.argv.indexOf('--markdown');",
      "const markdownArg = markdownIndex === -1 ? '' : process.argv[markdownIndex + 1];",
      "if (markdownArg?.startsWith('@') && path.isAbsolute(markdownArg.slice(1))) { throw new Error('absolute @file path rejected'); }",
      `if (markdownArg?.startsWith('@')) writeFileSync(${JSON.stringify(contentLogPath)}, readFileSync(path.resolve(process.cwd(), markdownArg.slice(1)), 'utf8'));`,
      "console.log(JSON.stringify({ ok: true, data: { document: { title: 'Spec', url: 'https://example.feishu.cn/docx/doc_1', document_id: 'doc_1' } } }));",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const created = await createLarkDocumentWithCli({
        title: "Spec",
        content: "正文",
        docFormat: "markdown",
      });
      const args = JSON.parse(await readFile(logPath, "utf8")) as string[];

      expect(created.url).toBe("https://example.feishu.cn/docx/doc_1");
      expect(args).not.toContain("--api-version");
      expect(args).toContain("--title");
      expect(args).toContain("Spec");
      expect(args).toContain("--markdown");
      expect(args).not.toContain("--content");
      expect(args).not.toContain("--doc-format");
      expect(args).not.toContain("--format");
      const markdownArg = args[args.indexOf("--markdown") + 1]!;
      expect(markdownArg).toBe("@content.md");
      await expect(readFile(contentLogPath, "utf8")).resolves.toBe("正文");
    } finally {
      process.env.PATH = originalPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses lark-cli document JSON even when stdout has a banner", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cli-banner-"));
    const binDir = path.join(tempDir, "bin");
    const fakeCliPath = path.join(binDir, "lark-cli");
    const originalPath = process.env.PATH;
    await mkdir(binDir, { recursive: true });
    await writeFile(fakeCliPath, [
      "#!/usr/bin/env node",
      "console.log('=== Lark CLI ===');",
      "console.log(JSON.stringify({ ok: true, data: { document: { title: 'Spec', url: 'https://example.feishu.cn/docx/doc_1', document_id: 'doc_1' } } }));",
    ].join("\n"), { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const created = await createLarkDocumentWithCli({
        title: "Spec",
        content: "正文",
        docFormat: "markdown",
      });

      expect(created.documentId).toBe("doc_1");
      expect(created.url).toBe("https://example.feishu.cn/docx/doc_1");
    } finally {
      process.env.PATH = originalPath;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported parentPosition before invoking lark-cli", async () => {
    await expect(createLarkDocumentWithCli({
      title: "Spec",
      content: "正文",
      docFormat: "markdown",
      parentPosition: "after:doc_1",
    })).rejects.toThrow("parentPosition is not supported");
  });

  it("detects Lark numeric id collisions before access state can be shared", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-id-collision-"));
    const bridgeChatId = stableLarkNumericId("lark:oc_chat");
    await writeFile(path.join(stateDir, "lark-chat-id-map.json"), JSON.stringify({
      [String(bridgeChatId)]: "chat:lark:other_chat",
    }));
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await expect(handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_1",
          chatId: "oc_chat",
          chatType: "p2p",
          senderId: "ou_user",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: Date.now(),
        },
      })).rejects.toThrow("Lark chat numeric ID collision");

      expect(bridge.checkAccess).not.toHaveBeenCalled();
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("feeds interactive card choices back into the bridge", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      handleAuthorizedMessage: vi.fn(async () => ({ text: "choice handled" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_user", name: "Clover" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "继续",
              value: "continue",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(channel.stream).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { markdown: "choice handled" },
        { replyTo: "card_1" },
      );
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: expect.stringContaining("continue"),
        requestOutputDir: expect.stringContaining(".lark-out"),
        onApprovalRequest: expect.any(Function),
      }));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects unauthorized Lark card choices before running the bridge", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-choice-denied-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "未授权" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_intruder" },
          action: {
            value: {
              cctb_lark: "choice",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
              label: "继续",
              value: "continue",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(bridge.checkAccess).toHaveBeenCalledWith(expect.objectContaining({
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_intruder"),
        chatType: "private",
        conversationKey: "lark:oc_chat",
      }));
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "未授权" }, { replyTo: "card_1" });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects unauthorized Lark stop actions", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-stop-denied-"));
    const runtime = createLarkServiceRuntime();
    const abortController = new AbortController();
    runtime.activeRuns.set("lark:oc_chat", { abortController });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "未授权" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "card_1",
          operator: { openId: "ou_intruder" },
          action: {
            value: {
              cctb_lark: "stop",
              conversationKey: "lark:oc_chat",
              bridgeChatType: "private",
            },
          },
        },
      });

      expect(handled).toBe(true);
      expect(abortController.signal.aborted).toBe(false);
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "未授权" }, { replyTo: "card_1" });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("resolves approval card actions", async () => {
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const pending = requestLarkApproval({
      channel,
      runtime,
      chatId: "oc_chat",
      replyTo: "om_1",
      request: {
        engine: "claude",
        toolName: "Bash",
        toolInput: { command: "npm test" },
      } satisfies EngineApprovalRequest,
    });
    const requestId = [...runtime.pendingApprovals.keys()][0]!;

    await handleLarkCardAction({
      channel,
      runtime,
      event: {
        chatId: "oc_chat",
        messageId: "om_card",
        operator: { openId: "ou_user" },
        action: {
          value: { cctb_lark: "approval", requestId, decision: "allow_session" },
        },
      },
    });

    await expect(pending).resolves.toEqual({ behavior: "allow", scope: "session" });
  });

  it("rejects unauthorized Lark approval actions without resolving the approval", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-approval-denied-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "reply" as const, text: "未授权" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };
    const resolve = vi.fn();
    const reject = vi.fn();
    const timer = setTimeout(() => undefined, 60_000);
    runtime.pendingApprovals.set("req_1", {
      requestId: "req_1",
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      resolve,
      reject,
      timer,
    });

    try {
      const handled = await handleLarkCardAction({
        channel,
        bridge,
        runtime,
        stateDir,
        event: {
          chatId: "oc_chat",
          messageId: "om_card",
          operator: { openId: "ou_intruder" },
          action: {
            value: { cctb_lark: "approval", requestId: "req_1", decision: "allow_session" },
          },
        },
      });

      expect(handled).toBe(true);
      expect(resolve).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
      expect(runtime.pendingApprovals.has("req_1")).toBe(true);
      expect(channel.send).toHaveBeenCalledWith("oc_chat", { text: "未授权" }, { replyTo: "om_card" });
    } finally {
      clearTimeout(timer);
      runtime.pendingApprovals.clear();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function fakeCommentEvent(overrides: Partial<{
  fileToken: string;
  fileType: string;
  commentId: string;
  replyId: string;
  operator: { openId?: string; userId?: string; unionId?: string };
  mentionedBot: boolean;
  timestamp: number;
}> = {}) {
  const operator = overrides.operator ?? { openId: "ou_user" };
  return {
    fileToken: overrides.fileToken ?? "doc_token",
    fileType: overrides.fileType ?? "docx",
    commentId: overrides.commentId ?? "comment_1",
    operator: {
      openId: operator.openId ?? "ou_user",
      ...(operator.userId ? { userId: operator.userId } : {}),
      ...(operator.unionId ? { unionId: operator.unionId } : {}),
    },
    mentionedBot: overrides.mentionedBot ?? true,
    timestamp: overrides.timestamp ?? Date.now(),
    ...(overrides.replyId ? { replyId: overrides.replyId } : {}),
  };
}

function fakeLarkMessage(overrides: Partial<{
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  content: string;
  threadId: string;
  mentionedBot: boolean;
  resources: Array<{ type: string; fileKey: string; fileName?: string }>;
}> = {}) {
  return {
    messageId: overrides.messageId ?? "om_1",
    chatId: overrides.chatId ?? "oc_chat",
    chatType: overrides.chatType ?? "p2p",
    senderId: overrides.senderId ?? "ou_user",
    ...(overrides.threadId ? { threadId: overrides.threadId } : {}),
    content: overrides.content ?? "hello",
    rawContentType: "text",
    resources: overrides.resources ?? [],
    mentions: [],
    mentionAll: false,
    mentionedBot: overrides.mentionedBot ?? false,
    createTime: Date.now(),
  };
}

function fakeCommentClient(overrides: Partial<{
  getCommentContext: ReturnType<typeof vi.fn>;
  createReply: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    getCommentContext: overrides.getCommentContext ?? vi.fn(async () => ({
      quote: "",
      replies: [],
    })),
    createReply: overrides.createReply ?? vi.fn(async () => undefined),
  };
}

function fakeChannel(overrides: Partial<ReturnType<typeof baseFakeChannel>> = {}) {
  return {
    ...baseFakeChannel(),
    ...overrides,
  };
}

function baseFakeChannel() {
  return {
    send: vi.fn(async () => ({ messageId: "sent_1" })),
    stream: vi.fn(async (_to: string, input: {
      card: {
        initial: object;
        producer: (controller: LarkStreamControllerLike) => Promise<void>;
      };
    }) => {
      await input.card.producer({
        messageId: "stream_1",
        current: input.card.initial,
        update: async () => undefined,
      });
      return { messageId: "stream_1" };
    }),
    updateCard: vi.fn(async () => undefined),
    downloadResource: vi.fn(async () => Buffer.from("")),
  };
}
