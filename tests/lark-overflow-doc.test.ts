import { describe, expect, it, vi } from "vitest";

import { LARK_CARD_ANSWER_MAX } from "../src/lark/card-renderer.js";
import {
  LARK_OVERFLOW_DOC_MIN_CHARS,
  larkOverflowDocFileName,
  postLarkOverflowAnswerDoc,
} from "../src/lark/overflow-doc.js";

function fakeChannel(sendImpl?: (to: string, input: unknown) => Promise<{ messageId: string }>) {
  return {
    send: vi.fn(sendImpl ?? (async () => ({ messageId: "om_x" }))),
  } as never;
}

describe("postLarkOverflowAnswerDoc", () => {
  it("posts the Feishu doc link when creation succeeds (created with user identity)", async () => {
    const channel = fakeChannel();
    let actor: string | undefined;
    const createDocument = vi.fn(async (input: { as?: string }) => {
      actor = input.as;
      return { url: "https://feishu.cn/docx/AAA" };
    });

    const outcome = await postLarkOverflowAnswerDoc({
      channel,
      createDocument,
      chatId: "oc_chat",
      replyOptions: undefined,
      text: "x".repeat(7000),
      locale: "zh",
    });

    expect(outcome).toMatchObject({ delivered: true, mode: "doc", url: "https://feishu.cn/docx/AAA" });
    expect(actor).toBe("user"); // user identity so the operator can open the link
    const sent = (channel as unknown as { send: { mock: { calls: unknown[][] } } }).send.mock.calls[0]![1] as { markdown?: string };
    expect(sent.markdown).toContain("https://feishu.cn/docx/AAA");
  });

  it("falls back to a .md file when doc creation fails", async () => {
    const channel = fakeChannel();
    const createDocument = vi.fn(async () => { throw new Error("not logged in"); });

    const outcome = await postLarkOverflowAnswerDoc({
      channel,
      createDocument,
      chatId: "oc_chat",
      replyOptions: undefined,
      text: `FALLBACKMARKER ${"y".repeat(7000)}`,
      locale: "zh",
    });

    expect(outcome).toMatchObject({ delivered: true, mode: "file", docError: "not logged in" });
    const sent = (channel as unknown as { send: { mock: { calls: unknown[][] } } }).send.mock.calls[0]![1] as {
      file?: { source: Buffer; fileName: string };
    };
    expect(sent.file?.fileName).toMatch(/\.md$/);
    expect(sent.file?.source.toString("utf8")).toContain("FALLBACKMARKER");
  });

  it("reports failed (so the caller does an inline dump) when both the doc and the file send fail", async () => {
    const channel = fakeChannel(async () => { throw new Error("upload failed"); });
    const createDocument = vi.fn(async () => { throw new Error("not logged in"); });

    const outcome = await postLarkOverflowAnswerDoc({
      channel,
      createDocument,
      chatId: "oc_chat",
      replyOptions: undefined,
      text: "z".repeat(7000),
      locale: "zh",
    });

    expect(outcome).toMatchObject({
      delivered: false,
      mode: "failed",
      docError: "not logged in",
      fileError: "upload failed",
    });
  });

  it("derives a .md file name from the first meaningful line", () => {
    expect(larkOverflowDocFileName("# 审计结论\n正文……", "zh")).toBe("审计结论.md");
    expect(larkOverflowDocFileName("", "en")).toBe("Claude reply.md"); // title fallback
  });

  it("uses the card answer cap as the doc threshold (overflow == doc-worthy)", () => {
    expect(LARK_OVERFLOW_DOC_MIN_CHARS).toBe(LARK_CARD_ANSWER_MAX);
  });
});
