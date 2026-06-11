import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/runtime/background-processes.js", () => ({
  listInstanceProcessGroup: vi.fn(async () => [
    { pid: 69560, ppid: 1, rssMb: 2846, etime: "02:10", command: "ugrep -G -aoE 评估", role: "orphan" as const },
    { pid: 66606, ppid: 64997, rssMb: 124, etime: "40:36", command: "claude -p --verbose", role: "engine" as const },
  ]),
  killInstanceGroupProcess: vi.fn(async () => ({ killed: true, reason: "ok" as const })),
  killInstanceGroupOrphans: vi.fn(async () => ({ killedPids: [69560], unsupported: false })),
}));

import {
  killInstanceGroupOrphans,
  killInstanceGroupProcess,
} from "../src/runtime/background-processes.js";
import { createLarkServiceRuntime, handleLarkMessage } from "../src/lark/service.js";
import { removeTempRoot } from "./helpers/temp-files.js";

async function runBgCommand(content: string) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-bg-"));
  const sent: string[] = [];
  const channel = {
    send: vi.fn(async (_to: string, payload: unknown) => {
      sent.push(JSON.stringify(payload));
      return { messageId: "sent_1" };
    }),
    stream: vi.fn(),
    updateCard: vi.fn(async () => undefined),
    recallMessage: vi.fn(async () => undefined),
    downloadResource: vi.fn(async () => Buffer.from("")),
  };
  const bridge = {
    checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
    handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
  };
  try {
    await handleLarkMessage({
      channel,
      bridge,
      runtime: createLarkServiceRuntime(),
      stateDir,
      message: {
        messageId: "om_bg",
        chatId: "oc_chat",
        chatType: "p2p",
        senderId: "ou_user",
        content,
        rawContentType: "text",
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: Date.now(),
      },
    });
    return { sent, bridge };
  } finally {
    await removeTempRoot(stateDir);
  }
}

describe("/bg pre-queue dispatch", () => {
  it("runs while a turn occupies the conversation queue (not serialized behind it)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-bg-prequeue-"));
    const runtime = createLarkServiceRuntime();
    const sent: string[] = [];
    const channel = {
      send: vi.fn(async (_to: string, payload: unknown) => {
        sent.push(JSON.stringify(payload));
        return { messageId: "sent_1" };
      }),
      stream: vi.fn(),
      updateCard: vi.fn(async () => undefined),
      recallMessage: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };

    // A long-running turn holds the conversation queue, like a real in-flight
    // engine turn. /bg must NOT wait behind it.
    let releaseTurn!: () => void;
    const runningTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
    void runtime.chatQueue.enqueue("lark:oc_chat", async () => { await runningTurn; });
    runtime.activeRuns.set("lark:oc_chat", { abortController: new AbortController() });

    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "allow" as const })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      const handled = await handleLarkMessage({
        channel,
        bridge,
        runtime,
        stateDir,
        message: {
          messageId: "om_bg_live", chatId: "oc_chat", chatType: "p2p", senderId: "ou_user",
          content: "/bg", rawContentType: "text", resources: [], mentions: [],
          mentionAll: false, mentionedBot: false, createTime: Date.now(),
        },
      });

      // /bg returned its listing while the turn is STILL running (never released).
      expect(handled).toBe(true);
      expect(sent.join("\n")).toContain("69560");
      // The blocking turn is still queued — /bg did not wait for it.
      expect(runtime.chatQueue.pendingCount("lark:oc_chat")).toBe(0);
    } finally {
      releaseTurn();
      await removeTempRoot(stateDir);
    }
  });

  it("denies /bg to an unauthorized sender (no process listing leaked)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-bg-denied-"));
    const sent: string[] = [];
    const channel = {
      send: vi.fn(async (_to: string, payload: unknown) => {
        sent.push(JSON.stringify(payload));
        return { messageId: "sent_1" };
      }),
      stream: vi.fn(),
      updateCard: vi.fn(async () => undefined),
      recallMessage: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
    };
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "deny" as const, text: "denied" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge,
        runtime: createLarkServiceRuntime(),
        stateDir,
        message: {
          messageId: "om_bg_denied", chatId: "oc_chat", chatType: "p2p", senderId: "ou_user",
          content: "/bg", rawContentType: "text", resources: [], mentions: [],
          mentionAll: false, mentionedBot: false, createTime: Date.now(),
        },
      });

      const all = sent.join("\n");
      expect(all).not.toContain("69560");
      expect(all).not.toContain("孤儿");
    } finally {
      await removeTempRoot(stateDir);
    }
  });
});

describe("/bg command", () => {
  it("lists the instance process group with roles and memory", async () => {
    const { sent, bridge } = await runBgCommand("/bg");
    const all = sent.join("\n");
    expect(all).toContain("69560");
    expect(all).toContain("2846MB");
    expect(all).toContain("孤儿");
    expect(all).toContain("66606");
    // A command never starts an engine turn.
    expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
  });

  it("kills a specific pid via the guarded helper", async () => {
    const { sent } = await runBgCommand("/bg kill 69560");
    expect(killInstanceGroupProcess).toHaveBeenCalledWith(69560);
    expect(sent.join("\n")).toContain("69560");
  });

  it("sweeps orphans via killall", async () => {
    const { sent } = await runBgCommand("/bg killall");
    expect(killInstanceGroupOrphans).toHaveBeenCalled();
    expect(sent.join("\n")).toContain("69560");
  });

  it("replies usage for unknown arguments", async () => {
    const { sent } = await runBgCommand("/bg whatever");
    expect(sent.join("\n")).toContain("/bg kill <pid>");
  });
});
