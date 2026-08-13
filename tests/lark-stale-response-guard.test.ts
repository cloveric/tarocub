import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isTruncatedPreviousLarkResponse,
  shouldRetryLarkStaleResponse,
} from "../src/lark/stale-response-guard.js";
import {
  markDeliveryDelivered,
  recordDeliveryObligation,
} from "../src/state/delivery-obligation-store.js";

describe("Lark stale response guard", () => {
  it("recognizes a prior answer's sentence-boundary truncation", () => {
    expect(isTruncatedPreviousLarkResponse(
      "可以，这版更像微信一点，但抓手还在。",
      "可以，这版更像微信一点，但抓手还在：第一，保留核心结论；第二，补充执行步骤；第三，明确下一步负责人。",
    )).toBe(true);
  });

  it("does not reject an ordinary exact repeat", () => {
    expect(isTruncatedPreviousLarkResponse(
      "检查完成，没有发现新的错误。",
      "检查完成，没有发现新的错误。",
    )).toBe(false);
  });

  it("does not match a short incidental shared prefix", () => {
    expect(isTruncatedPreviousLarkResponse(
      "检查完成",
      "检查完成后我继续运行了全量测试，并确认所有服务均已恢复。",
    )).toBe(false);
  });

  it("does not match an answer that is only slightly shorter", () => {
    expect(isTruncatedPreviousLarkResponse(
      "目前没有发现问题。",
      "目前没有发现问题。可以继续。",
    )).toBe(false);
  });

  it("requires real tool activity before retrying", async () => {
    const stateDir = await seedPreviousAnswer();
    try {
      await expect(shouldRetryLarkStaleResponse({
        stateDir,
        conversationKey: "lark:oc_chat",
        replyTo: "om_current",
        responseText: "可以，这版更像微信一点，但抓手还在。",
        sawToolActivity: false,
      })).resolves.toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("never retries a response that carries a delivery directive", async () => {
    const stateDir = await seedPreviousAnswer();
    try {
      await expect(shouldRetryLarkStaleResponse({
        stateDir,
        conversationKey: "lark:oc_chat",
        replyTo: "om_current",
        responseText: "可以，这版更像微信一点，但抓手还在。\n[send-file:/tmp/result.txt]",
        sawToolActivity: true,
      })).resolves.toBe(false);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

async function seedPreviousAnswer(): Promise<string> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-stale-guard-"));
  const id = await recordDeliveryObligation(stateDir, {
    channel: "lark",
    chatId: "oc_chat",
    conversationKey: "lark:oc_chat",
    replyTo: "om_previous",
    content: "可以，这版更像微信一点，但抓手还在：第一，保留核心结论；第二，补充执行步骤；第三，明确下一步负责人。",
  });
  await markDeliveryDelivered(stateDir, id!);
  return stateDir;
}
