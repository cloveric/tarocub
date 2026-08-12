import { describe, expect, it } from "vitest";

import {
  isLarkDeliveryFollowupRequest,
  larkDeliveryFollowupInstruction,
  shouldRepairLarkDeliveryFollowup,
} from "../src/lark/delivery-followup.js";

describe("Lark delivery follow-up guard", () => {
  it.each([
    "好了吗",
    "发了吗？",
    "图片呢",
    "我这边还没收到图片",
    "重新发一下",
    "where are the images?",
  ])("recognizes a direct delivery follow-up: %s", (text) => {
    expect(isLarkDeliveryFollowupRequest(text)).toBe(true);
    expect(larkDeliveryFollowupInstruction(text)).toContain("THIS turn");
  });

  it("does not classify a longer diagnostic discussion as a delivery follow-up", () => {
    const text = "请解释为什么机器人有时会回复‘往上翻’，以及整个交付机制应该如何重构";
    expect(isLarkDeliveryFollowupRequest(text)).toBe(false);
    expect(larkDeliveryFollowupInstruction(text)).toBeUndefined();
  });

  it.each([
    "我没看到 config.json 里有这个字段",
    "帮我查一下为什么日志里没看到 ERROR",
    "你没收到我上一条消息吗",
    "config 文件里没看到这个字段",
  ])("does not mistake a technical or conversational message for a delivery follow-up: %s", (text) => {
    expect(isLarkDeliveryFollowupRequest(text)).toBe(false);
    expect(larkDeliveryFollowupInstruction(text)).toBeUndefined();
  });

  it.each([
    "我没有收到",
    "没看到图片",
    "这边还没收到附件。",
    "结果到底在哪里？",
  ])("keeps recognizing an anchored delivery status: %s", (text) => {
    expect(isLarkDeliveryFollowupRequest(text)).toBe(true);
  });

  it("repairs a historical delivery claim that has no current-turn delivery directive", () => {
    expect(shouldRepairLarkDeliveryFollowup(
      "好了吗",
      "好了，水彩版 6 张刚发在上面，往上翻能看到。",
    )).toBe(true);
  });

  it("accepts a current-turn resend with exact image tags", () => {
    expect(shouldRepairLarkDeliveryFollowup(
      "好了吗",
      "P1\n[send-image:/tmp/workspace/p1.png]\nP2\n[send-image:/tmp/workspace/p2.png]",
    )).toBe(false);
  });

  it("accepts send.batch and honest unfinished/missing statuses", () => {
    expect(shouldRepairLarkDeliveryFollowup(
      "没收到图片",
      '[tool:{"name":"send.batch","payload":{"images":["/tmp/workspace/p1.png"]}}]',
    )).toBe(false);
    expect(shouldRepairLarkDeliveryFollowup("好了吗", "还在生成第 5 张，尚未发送。")).toBe(false);
    expect(shouldRepairLarkDeliveryFollowup("文件呢", "文件不存在，无法发送。")).toBe(false);
  });

  it("does not repair an unrelated response even if it discusses historical delivery", () => {
    expect(shouldRepairLarkDeliveryFollowup(
      "审查交付模块",
      "问题在于它之前已经发送过一次。",
    )).toBe(false);
  });
});
