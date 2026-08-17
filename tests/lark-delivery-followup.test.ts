import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

  it("repairs a historical delivery claim that has no current-turn delivery directive", async () => {
    expect(await shouldRepairLarkDeliveryFollowup(
      "好了吗",
      "好了，水彩版 6 张刚发在上面，往上翻能看到。",
    )).toBe(true);
  });

  it("does not accept an invented path as proof of delivery", async () => {
    // The instruction handed to the engine says to verify each path exists.
    // Checking only that a TAG is present let a made-up path satisfy the
    // guard: the claim passed review, the send failed downstream, and the
    // operator got a delivery error instead of the file.
    expect(await shouldRepairLarkDeliveryFollowup(
      "我没有收到",
      "已经发过了,再发一次:[send-file:/tmp/definitely-missing-9f3a1c.docx]",
    )).toBe(true);
    // A real path INSIDE the workspace still satisfies it. (/etc/hosts was the
    // original example here and was wrong: the sender is workspace-sandboxed,
    // so an outside path can never deliver.)
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cctb-followup-ok-")));
    const good = path.join(ws, "ok.txt");
    writeFileSync(good, "x");
    try {
      expect(await shouldRepairLarkDeliveryFollowup(
        "我没有收到",
        `已经发过了,再发一次:[send-file:${good}]`,
        ws,
      )).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
    // A fenced file: block carries its own content — but the sender uploads it
    // ONLY when it is the entire reply, so prose around it means nothing was
    // delivered. (This example previously had the prose and still passed.)
    expect(await shouldRepairLarkDeliveryFollowup("我没有收到", "```file:note.txt\nhello\n```")).toBe(false);
    expect(await shouldRepairLarkDeliveryFollowup(
      "我没有收到",
      "已经发过了:\n```file:note.txt\nhello\n```",
    )).toBe(true);
  });

  it("requires EVERY named artifact to be deliverable, not just one", async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "cctb-followup-ws-"));
    const good = path.join(ws, "ok.txt");
    writeFileSync(good, "x");
    try {
      const tag = (p: string) => `[send-file:${p}]`;
      // One real + one missing used to clear the claim, and the user then got
      // half a delivery — the same complaint from their side.
      expect(await shouldRepairLarkDeliveryFollowup(
        "我没有收到",
        `已经发过了:${tag(good)} ${tag(path.join(ws, "missing.docx"))}`,
        ws,
      )).toBe(true);
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", `已经发过了:${tag(good)}`, ws)).toBe(false);
      // A directory is not a deliverable artifact.
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", `已经发过了:${tag(ws)}`, ws)).toBe(true);
      // The send layer is workspace-sandboxed: an outside path cannot deliver.
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", "已经发过了:[send-file:/etc/hosts]", ws)).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("uses the instance's default workspace when there is no workspace override", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "cctb-followup-default-root-"));
    const workspace = path.join(stateDir, "workspace");
    const good = path.join(workspace, "result.txt");
    mkdirSync(workspace);
    writeFileSync(good, "ok");
    try {
      expect(await shouldRepairLarkDeliveryFollowup(
        "我没有收到文件",
        `已经发过了 [send-file:${good}]`,
        { stateDir },
      )).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not accept a structured send.* tag that carries no usable path", async () => {
    const ws = mkdtempSync(path.join(os.tmpdir(), "cctb-followup-tool-"));
    const good = path.join(ws, "ok.txt");
    writeFileSync(good, "x");
    const tool = (name: string, payload: unknown) => `已经发过了 [tool:${JSON.stringify({ name, payload })}]`;
    try {
      // The tool NAME alone used to satisfy the guard.
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", tool("send.file", {}), ws)).toBe(true);
      expect(await shouldRepairLarkDeliveryFollowup(
        "我没有收到",
        tool("send.file", { path: path.join(ws, "missing.docx") }),
        ws,
      )).toBe(true);
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", tool("send.file", { path: good }), ws)).toBe(false);
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", tool("send.batch", { files: [good] }), ws)).toBe(false);
      expect(await shouldRepairLarkDeliveryFollowup(
        "我没有收到",
        tool("send.batch", { files: [good, path.join(ws, "no.png")] }),
        ws,
      )).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("refuses paths the real sender would refuse", async () => {
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cctb-followup-sandbox-")));
    const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cctb-followup-outside-")));
    const good = path.join(ws, "ok.txt");
    writeFileSync(good, "x");
    const secret = path.join(ws, ".env");
    writeFileSync(secret, "KEY=v");
    const escaping = path.join(ws, "link.txt");
    writeFileSync(path.join(outside, "outside.txt"), "x");
    symlinkSync(path.join(outside, "outside.txt"), escaping);
    try {
      // Without a known workspace root the sender still sandboxes, so an
      // arbitrary path is NOT evidence — the guard used to accept it.
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", "已经发过了:[send-file:/etc/hosts]")).toBe(true);
      // Credential-style files are refused by the sender.
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", `已经发过了:[send-file:${secret}]`, ws)).toBe(true);
      // A symlink pointing outside the workspace escapes the sandbox.
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", `已经发过了:[send-file:${escaping}]`, ws)).toBe(true);
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", `已经发过了:[send-file:${good}]`, ws)).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("speaks the send tool's real protocol, not an invented one", async () => {
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cctb-followup-proto-")));
    const good = path.join(ws, "ok.txt");
    writeFileSync(good, "x");
    const tool = (name: string, payload: unknown) => `已经发过了 [tool:${JSON.stringify({ name, payload })}]`;
    try {
      // send.batch reads images/files/audios/videos. An earlier guard accepted
      // invented `items`/`paths` keys while missing valid media shapes.
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", tool("send.batch", { files: [good] }), ws)).toBe(false);
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", tool("send.batch", { images: [good] }), ws)).toBe(false);
      expect(await shouldRepairLarkDeliveryFollowup(
        "我没有收到",
        tool("send.batch", { images: [{ path: good, caption: "P1 · 封面" }] }),
        ws,
      )).toBe(false);
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", tool("send.batch", { audios: [good] }), ws)).toBe(false);
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", tool("send.batch", { videos: [good] }), ws)).toBe(false);
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", tool("send.batch", { items: [{ path: good }] }), ws)).toBe(true);
      // A batch carrying only a message delivers no artifact.
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", tool("send.batch", { message: "hi" }), ws)).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("checks every directive across legacy and structured syntax", async () => {
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cctb-followup-cross-syntax-")));
    const good = path.join(ws, "ok.txt");
    const missing = path.join(ws, "missing.txt");
    writeFileSync(good, "x");
    const tool = (filePath: string) => `[tool:${JSON.stringify({ name: "send.file", payload: { path: filePath } })}]`;
    try {
      expect(await shouldRepairLarkDeliveryFollowup(
        "我没有收到",
        `已经发过了 [send-file:${good}] ${tool(missing)}`,
        ws,
      )).toBe(true);
      expect(await shouldRepairLarkDeliveryFollowup(
        "我没有收到",
        `已经发过了 ${tool(good)} ${tool(missing)}`,
        ws,
      )).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects a path above the sender's 30MB upload cap", async () => {
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cctb-followup-oversize-")));
    const huge = path.join(ws, "huge.bin");
    writeFileSync(huge, "");
    truncateSync(huge, 31 * 1024 * 1024);
    try {
      expect(await shouldRepairLarkDeliveryFollowup(
        "我没有收到文件",
        `已经发过了 [send-file:${huge}]`,
        ws,
      )).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("counts a fenced file: block only when it is the entire reply", async () => {
    const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cctb-followup-block-")));
    try {
      // The sender uploads a fenced file: block ONLY when it is the whole
      // response; surrounded by prose it posts plain markdown and delivers
      // nothing, so accepting it anywhere cleared an empty claim.
      expect(await shouldRepairLarkDeliveryFollowup(
        "我没有收到",
        "已经发过了:\n```file:a.txt\nhi\n```\n就这样",
        ws,
      )).toBe(true);
      expect(await shouldRepairLarkDeliveryFollowup("我没有收到", "```file:a.txt\nhi\n```", ws)).toBe(false);
      expect(await shouldRepairLarkDeliveryFollowup(
        "我没有收到",
        "```file:.env\n已经发过了\n```",
        ws,
      )).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
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

  it("accepts a current-turn resend with exact image tags", async () => {
    expect(await shouldRepairLarkDeliveryFollowup(
      "好了吗",
      "P1\n[send-image:/tmp/workspace/p1.png]\nP2\n[send-image:/tmp/workspace/p2.png]",
    )).toBe(false);
  });

  it("accepts send.batch and honest unfinished/missing statuses", async () => {
    expect(await shouldRepairLarkDeliveryFollowup(
      "没收到图片",
      '[tool:{"name":"send.batch","payload":{"images":["/tmp/workspace/p1.png"]}}]',
    )).toBe(false);
    expect(await shouldRepairLarkDeliveryFollowup("好了吗", "还在生成第 5 张，尚未发送。")).toBe(false);
    expect(await shouldRepairLarkDeliveryFollowup("文件呢", "文件不存在，无法发送。")).toBe(false);
  });

  it("does not mistake future delivery promises for historical delivery claims", async () => {
    expect(await shouldRepairLarkDeliveryFollowup(
      "好了吗",
      "还没好——返工agent跑到第3步了（共5步）：新页和脚本已经写完，正在LibreOffice重算+逐项核对验收，之后还有beta联动测试和结果汇总。它跑完我立刻让codex复审，通过后把文件发你。等着就行，好了我主动发。",
    )).toBe(false);
    expect(await shouldRepairLarkDeliveryFollowup(
      "好了吗",
      "现在如实汇报交付状态：成品还没好，这一刻没有可交付的文件。磁盘上的模型是返工进行中的中间版本。流程走完后，我会把最终版连同修订说明一起用 [send-file:] 发过来。",
    )).toBe(false);
  });

  it("does not repair an unrelated response even if it discusses historical delivery", async () => {
    expect(await shouldRepairLarkDeliveryFollowup(
      "审查交付模块",
      "问题在于它之前已经发送过一次。",
    )).toBe(false);
  });
});
