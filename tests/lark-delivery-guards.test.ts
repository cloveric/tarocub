import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CronStore } from "../src/state/cron-store.js";
import {
  extractInvalidDeliveryPseudoTagMatches,
  stripInvalidDeliveryPseudoTags,
} from "../src/telegram/delivery-tags.js";
import { deliverLarkResponse } from "../src/lark/delivery.js";
import { preflightLarkResponseDeliveryDirectives } from "../src/lark/delivery-followup.js";
import { createLarkServiceRuntime } from "../src/lark/service.js";
import type { LarkChannelLike } from "../src/lark/types.js";

function fakeChannel(): LarkChannelLike {
  return {
    send: vi.fn(async () => ({ messageId: "sent_1" })),
    stream: vi.fn(),
    downloadResource: vi.fn(async () => Buffer.alloc(0)),
  } as unknown as LarkChannelLike;
}

function tool(name: string, payload: Record<string, unknown>): string {
  return `[tool:${JSON.stringify({ name, payload })}]`;
}

describe("Lark delivery protocol guards", () => {
  it("detects and strips pseudo send tags while ignoring quoted examples", () => {
    const text = [
      "result",
      "[send.batch={\"images\":[\"/tmp/p.png\"]}]",
      "`[send.file=/tmp/example.txt]`",
      "> [send.image=/tmp/quoted.png]",
    ].join("\n");

    expect(extractInvalidDeliveryPseudoTagMatches(text)).toEqual([
      expect.objectContaining({ tag: '[send.batch={"images":["/tmp/p.png"]}]' }),
    ]);
    expect(stripInvalidDeliveryPseudoTags(text)).not.toContain("[send.batch=");
    expect(stripInvalidDeliveryPseudoTags(text)).toContain("`[send.file=/tmp/example.txt]`");
    expect(stripInvalidDeliveryPseudoTags(text)).toContain("> [send.image=/tmp/quoted.png]");
  });

  it("marks pseudo send tags as invalid preflight directives", async () => {
    const result = await preflightLarkResponseDeliveryDirectives("[send.batch=/tmp/p.png]");
    expect(result).toMatchObject({ sawDirective: true, artifactCount: 0 });
    expect(result.issues).toEqual([
      expect.objectContaining({ reason: "invalid-directive" }),
    ]);
  });

  it("never exposes a pseudo send tag as visible reply text", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-pseudo-tag-"));
    const channel = fakeChannel();
    try {
      await deliverLarkResponse({
        channel,
        runtime: createLarkServiceRuntime(),
        chatId: "oc_chat",
        text: "Here it is\n[send.batch=/tmp/p.png]",
        stateDir,
      });
      const sent = JSON.stringify((channel.send as ReturnType<typeof vi.fn>).mock.calls);
      expect(sent).toContain("Here it is");
      expect(sent).not.toContain("send.batch=");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("normalizes unsupported math in ordinary markdown delivery", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-markdown-normalize-"));
    const channel = fakeChannel();
    try {
      await deliverLarkResponse({
        channel,
        runtime: createLarkServiceRuntime(),
        chatId: "oc_chat",
        text: "Fee $5 \\rightarrow $10",
        stateDir,
      });
      const sent = JSON.stringify((channel.send as ReturnType<typeof vi.fn>).mock.calls);
      expect(sent).toContain("Fee $5 → $10");
      expect(sent).not.toContain("\\\\rightarrow");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("blocks cron mutations emitted by a scheduled run", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-recursion-"));
    const store = new CronStore(stateDir);
    const runtime = createLarkServiceRuntime({
      cronRuntime: { store, scheduler: { refresh: vi.fn(async () => undefined), runJobNow: vi.fn(async () => undefined) } },
    });
    const channel = fakeChannel();
    try {
      const result = await deliverLarkResponse({
        channel,
        runtime,
        chatId: "oc_chat",
        text: tool("cron.add", { in: "10m", prompt: "spawn another" }),
        stateDir,
        allowCronMutations: false,
      });
      expect(result.ok).toBe(false);
      expect(await store.list()).toHaveLength(0);
      expect(JSON.stringify((channel.send as ReturnType<typeof vi.fn>).mock.calls)).toContain("不能创建或修改其他定时任务");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps one recurring schedule and suppresses sibling boundary one-shots", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-cron-dedupe-"));
    const store = new CronStore(stateDir);
    const runtime = createLarkServiceRuntime({
      cronRuntime: { store, scheduler: { refresh: vi.fn(async () => undefined), runJobNow: vi.fn(async () => undefined) } },
    });
    const channel = fakeChannel();
    try {
      const result = await deliverLarkResponse({
        channel,
        runtime,
        chatId: "oc_chat",
        text: [
          tool("cron.add", { cron: "0 9 * * *", prompt: "daily" }),
          tool("cron.add", { at: "2030-01-01T09:00:00+08:00", prompt: "end boundary" }),
          '[cron-add:{"in":"5m","prompt":"current boundary"}]',
        ].join("\n"),
        stateDir,
      });
      expect(result.ok).toBe(true);
      const jobs = await store.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ cronExpr: "0 9 * * *", prompt: "daily" });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
