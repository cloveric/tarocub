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

  it("catches real delivery follow-ups with modifiers, word order, and file names", () => {
    // These are how the operator actually asks. The first narrowing pass
    // required the artifact noun to sit immediately after the negation, so
    // every one of these silently skipped verification — the exact class of
    // "you said you sent it, I never got it" this guard exists for.
    for (const text of [
      "怎么没收到文件",
      "我没收到那个 docx",
      "刚才的图我没收到",
      "那份报告我没看到",
      "没看到你发的图",
      "图片在哪",
      "没收到附件",
      "图片没收到",
      "我没有收到",
      "好了吗",
      "文件呢",
      "再发一次",
    ]) {
      expect(isLarkDeliveryFollowupRequest(text), text).toBe(true);
    }
  });

  it("still ignores ordinary talk that merely contains 没收到 / 没看到", () => {
    // Unanchored matching made ANY sentence with these words trigger the
    // guard, which suppressed the streamed answer and could replace a correct
    // reply with a blocked-claim notice. Widening must never reintroduce that.
    for (const text of [
      "我没看到你说的那个函数在哪",
      "我没看到 config.json 里有这个字段",
      "刚才那个报错我没看到具体行号",
      "帮我查一下为什么日志里没看到 ERROR",
      "这段代码我没看懂,你没看到问题吗",
      "你没收到我上一条消息吗",
      "日志里没看到 ERROR 是不是级别配错了",
      "我没看到收益提升",
      "这个报告写得不错",
      "文件读取失败了吗",
    ]) {
      expect(isLarkDeliveryFollowupRequest(text), text).toBe(false);
    }
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

  it("does not accept an invented path as proof of delivery", () => {
    // The instruction handed to the engine says to verify each path exists.
    // Checking only that a TAG is present let a made-up path satisfy the
    // guard: the claim passed review, the send failed downstream, and the
    // operator got a delivery error instead of the file.
    expect(shouldRepairLarkDeliveryFollowup(
      "我没有收到",
      "已经发过了,再发一次:[send-file:/tmp/definitely-missing-9f3a1c.docx]",
    )).toBe(true);
    // A real path still satisfies it.
    expect(shouldRepairLarkDeliveryFollowup(
      "我没有收到",
      "已经发过了,再发一次:[send-file:/etc/hosts]",
    )).toBe(false);
    // An inline file block carries its own content — nothing to look up.
    expect(shouldRepairLarkDeliveryFollowup(
      "我没有收到",
      "已经发过了:\n```file:note.txt\nhello\n```",
    )).toBe(false);
  });

  it("matches English follow-ups the way the Chinese patterns do", () => {
    for (const text of [
      "we have not seen the images",
      "i did not receive them",
      "did you send the files",
      "where are the images",
      "the file never arrived",
      "done yet",
    ]) {
      expect(isLarkDeliveryFollowupRequest(text), text).toBe(true);
    }
    for (const text of [
      "i did not see the error in the log",
      "i haven't seen that function anywhere",
      "we did not receive approval from legal",
    ]) {
      expect(isLarkDeliveryFollowupRequest(text), text).toBe(false);
    }
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
