import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { EngineApprovalRequest, EngineStreamEvent } from "../src/codex/adapter.js";
import {
  createLarkDocumentWithCli,
  createLarkServiceRuntime,
  handleLarkCardAction,
  handleLarkMessage,
  type LarkStreamControllerLike,
  requestLarkApproval,
} from "../src/lark/service.js";
import { stableLarkNumericId } from "../src/lark/message-normalizer.js";
import { parseTimelineEvents } from "../src/state/timeline-log.js";

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
        { text: expect.stringContaining("配对码") },
        { replyTo: "om_1", replyInThread: false },
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("routes Lark messages through the bridge and updates a streaming card", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-service-"));
    const updates: unknown[] = [];
    const channel = fakeChannel({
      stream: vi.fn(async (_to: string, input: {
        card: {
          initial: object;
          producer: (controller: LarkStreamControllerLike) => Promise<void>;
        };
      }) => {
        await input.card.producer({
          messageId: "card_1",
          current: input.card.initial,
          update: async (card: unknown) => {
            updates.push(card);
          },
        });
        return { messageId: "card_1" };
      }),
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

      expect(channel.stream).toHaveBeenCalledWith(
        "oc_chat",
        expect.objectContaining({ card: expect.any(Object) }),
        { replyTo: "om_1", replyInThread: false },
      );
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: expect.stringContaining("hello"),
      }));
      const bridgeInput = bridge.handleAuthorizedMessage.mock.calls[0]![0];
      expect(bridgeInput.files).toHaveLength(1);
      await expect(readFile(bridgeInput.files[0]!, "utf8")).resolves.toBe("hello file");
      expect(JSON.stringify(updates)).toContain("Done from bridge");
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

  it("delivers generated files from bridge delivery tags", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-delivery-"));
    const outputDir = path.join(stateDir, "workspace", "out");
    const filePath = path.join(outputDir, "report.txt");
    await mkdir(outputDir, { recursive: true });
    await writeFile(filePath, "report body");
    const updates: unknown[] = [];
    const channel = fakeChannel({
      stream: vi.fn(async (_to: string, input: {
        card: {
          initial: object;
          producer: (controller: LarkStreamControllerLike) => Promise<void>;
        };
      }) => {
        await input.card.producer({
          messageId: "card_1",
          current: input.card.initial,
          update: async (card: unknown) => {
            updates.push(card);
          },
        });
        return { messageId: "card_1" };
      }),
    });
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

      expect(JSON.stringify(updates)).not.toContain("[send-file:");
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { file: { source: Buffer.from("report body"), fileName: "report.txt" } },
        { replyTo: "card_1" },
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
    const updates: unknown[] = [];
    const channel = fakeChannel({
      stream: vi.fn(async (_to: string, input: {
        card: {
          initial: object;
          producer: (controller: LarkStreamControllerLike) => Promise<void>;
        };
      }) => {
        await input.card.producer({
          messageId: "card_1",
          current: input.card.initial,
          update: async (card: unknown) => {
            updates.push(card);
          },
        });
        return { messageId: "card_1" };
      }),
    });
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

      const rendered = JSON.stringify(updates);
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
      }, { replyTo: "stream_1" });
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
        { replyTo: "stream_1" },
      );
      expect(channel.send).toHaveBeenCalledWith(
        "oc_chat",
        { video: { source: Buffer.from("video body"), fileName: "clip.mp4" } },
        { replyTo: "stream_1" },
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
        { replyTo: "stream_1" },
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
    await writeFile(path.join(stateDir, "lark-id-map.json"), JSON.stringify({
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
      })).rejects.toThrow("Lark numeric ID collision");

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
      expect(channel.stream).toHaveBeenCalledWith(
        "oc_chat",
        expect.objectContaining({ card: expect.any(Object) }),
        { replyTo: "card_1" },
      );
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledWith(expect.objectContaining({
        chatType: "private",
        conversationKey: "lark:oc_chat",
        text: expect.stringContaining("continue"),
        requestOutputDir: expect.stringContaining(".lark-out"),
        onApprovalRequest: expect.any(Function),
        onEngineEvent: expect.any(Function),
      }));
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
});

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
