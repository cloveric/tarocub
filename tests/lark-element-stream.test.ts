import { describe, expect, it, vi } from "vitest";

import {
  ELEMENT_CONTENT_MAX_BYTES,
  LARK_CARD_ANSWER_MAX,
  applyLarkEngineEvent,
  initialLarkRunState,
  liveRunCardStreamElement,
  renderLarkRunCard,
  trimToStreamSafeBoundary,
} from "../src/lark/card-renderer.js";
import {
  updateManagedCard,
  updateManagedCardElement,
  type ManagedCardHandle,
} from "../src/lark/managed-card.js";

function runningState(text: string) {
  let state = initialLarkRunState("lark:oc_chat", "private");
  state = applyLarkEngineEvent(state, { type: "assistant_text", text });
  return state;
}

describe("trimToStreamSafeBoundary", () => {
  it("cuts at the last newline or sentence-ending punctuation", () => {
    expect(trimToStreamSafeBoundary("第一句。第二句还没写完")).toBe("第一句。");
    expect(trimToStreamSafeBoundary("line one\nline two partial")).toBe("line one\n");
  });

  it("never exposes a half-open code fence", () => {
    const text = "intro done.\n```python\nprint(";
    expect(trimToStreamSafeBoundary(text)).toBe("intro done.\n");
  });

  it("force-flushes long unpunctuated runs but not while a fence is open", () => {
    const longRun = "x".repeat(60);
    expect(trimToStreamSafeBoundary(longRun)).toBe(longRun);
    expect(trimToStreamSafeBoundary("```" + "x".repeat(60))).toBe("");
  });

  it("returns empty when nothing safe has accumulated yet", () => {
    expect(trimToStreamSafeBoundary("short")).toBe("");
  });
});

describe("liveRunCardStreamElement", () => {
  it("identifies the live trailing text element and tags it in the rendered card", () => {
    const state = runningState("正在生成的答案。");
    const live = liveRunCardStreamElement(state);
    expect(live).not.toBeNull();
    expect(live!.content).toContain("正在生成的答案。");

    const card = renderLarkRunCard(state, "zh") as {
      body: { elements: Array<Record<string, unknown>> };
    };
    const tagged = card.body.elements.find((element) => element.element_id === live!.elementId);
    expect(tagged).toBeDefined();
    expect(tagged!.tag).toBe("markdown");
    expect(tagged!.content).toBe(live!.content);
  });

  it("returns null when a tool group is trailing (new deltas open a new element)", () => {
    let state = runningState("答案第一段。");
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, toolUseId: "t1" });
    expect(liveRunCardStreamElement(state)).toBeNull();
  });

  it("returns null once the turn is no longer running", () => {
    let state = runningState("最终答案。");
    state = applyLarkEngineEvent(state, { type: "result", text: "最终答案。" });
    expect(liveRunCardStreamElement(state)).toBeNull();
  });
});

describe("run card element-stream fast path", () => {
  async function flushTimers(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  function managedChannel(overrides: {
    elementContent?: ReturnType<typeof vi.fn>;
    cardUpdate?: ReturnType<typeof vi.fn>;
  } = {}) {
    const elementContent = overrides.elementContent ?? vi.fn(async () => ({}));
    const cardUpdate = overrides.cardUpdate ?? vi.fn(async () => ({}));
    const channel = {
      send: vi.fn(async () => ({ messageId: "om_card" })),
      stream: vi.fn(),
      updateCard: vi.fn(async () => undefined),
      recallMessage: vi.fn(async () => undefined),
      downloadResource: vi.fn(async () => Buffer.from("")),
      rawClient: {
        cardkit: {
          v1: {
            card: {
              create: vi.fn(async () => ({ data: { card_id: "card_live" } })),
              update: cardUpdate,
            },
            cardElement: { content: elementContent },
          },
        },
        im: { v1: { message: { create: vi.fn(async () => ({ data: { message_id: "om_card" } })) } } },
      },
    };
    return { channel, elementContent, cardUpdate };
  }

  async function createController(channel: unknown) {
    const { createLarkRunCardController } = await import("../src/lark/message-handler.js");
    return await createLarkRunCardController({
      channel: channel as never,
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      locale: "zh",
    });
  }

  it("streams trailing text via the element endpoint and keeps structure changes on full patches", async () => {
    const { channel, elementContent, cardUpdate } = managedChannel();
    const controller = await createController(channel);
    expect(controller).toBeDefined();

    // First delta: leading-edge FULL update establishes the element remotely.
    await controller!.apply({ type: "assistant_text", text: "第一句。" });
    await flushTimers(20);
    const fullAfterFirst = cardUpdate.mock.calls.length;
    expect(fullAfterFirst).toBeGreaterThanOrEqual(1);

    // Subsequent text deltas: element endpoint, no further full patches.
    await controller!.apply({ type: "assistant_text", text: "第二句。" });
    await flushTimers(320);
    expect(elementContent).toHaveBeenCalledTimes(1);
    const sentContent = elementContent.mock.calls[0][0].data.content as string;
    expect(sentContent).toContain("第一句。");
    expect(sentContent).toContain("第二句。");
    expect(cardUpdate.mock.calls.length).toBe(fullAfterFirst);

    // Structure change (tool group appears): back to the full-patch path.
    await controller!.apply({ type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, toolUseId: "t1" });
    await flushTimers(450);
    expect(cardUpdate.mock.calls.length).toBeGreaterThan(fullAfterFirst);

    await controller!.finish("第一句。第二句。done");
  });

  it("degrades permanently to full patches when an element update fails", async () => {
    const elementContent = vi.fn(async () => {
      throw new Error("element update rejected");
    });
    const { channel, cardUpdate } = managedChannel({ elementContent });
    const controller = await createController(channel);

    await controller!.apply({ type: "assistant_text", text: "第一句。" });
    await flushTimers(20);
    const fullAfterFirst = cardUpdate.mock.calls.length;

    await controller!.apply({ type: "assistant_text", text: "第二句。" });
    await flushTimers(320);
    expect(elementContent).toHaveBeenCalledTimes(1);

    // Failure → the element path is abandoned and a full patch carries the text.
    await flushTimers(450);
    expect(cardUpdate.mock.calls.length).toBeGreaterThan(fullAfterFirst);

    // Later deltas never try the element endpoint again.
    await controller!.apply({ type: "assistant_text", text: "第三句。" });
    await flushTimers(320);
    expect(elementContent).toHaveBeenCalledTimes(1);

    await controller!.finish("done");
  });

  it("freezes at the per-element cap on very long CJK text without erroring or spamming", async () => {
    const { channel, elementContent, cardUpdate } = managedChannel();
    const controller = await createController(channel);

    // Establish the element with a first delta, then stream far past both the
    // char cap and (for CJK) the byte cap.
    await controller!.apply({ type: "assistant_text", text: "开头。" });
    await flushTimers(20);
    const fullAfterFirst = cardUpdate.mock.calls.length;
    for (let i = 0; i < 6; i += 1) {
      await controller!.apply({ type: "assistant_text", text: `${"超长中文内容".repeat(300)}。` });
      await flushTimers(320);
    }

    // Element ticks happened, every payload respects the caps, and the content
    // is monotonic (a capped tick never rolls the typewriter back).
    expect(elementContent.mock.calls.length).toBeGreaterThanOrEqual(1);
    let previous = "";
    for (const call of elementContent.mock.calls) {
      const content = (call[0] as { data: { content: string } }).data.content;
      expect(content.length).toBeLessThanOrEqual(LARK_CARD_ANSWER_MAX + 1);
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(ELEMENT_CONTENT_MAX_BYTES);
      expect(content.startsWith(previous)).toBe(true);
      previous = content;
    }
    // Once frozen at the cap, ticks stop instead of re-sending identical text.
    const capped = elementContent.mock.calls.length;
    await controller!.apply({ type: "assistant_text", text: "尾巴。" });
    await flushTimers(320);
    expect(elementContent.mock.calls.length).toBe(capped);
    // The overflow decision itself is finalize's (full-path) job — untouched here.
    expect(cardUpdate.mock.calls.length).toBe(fullAfterFirst);

    await controller!.finish("done");
  });

  it("hands off to the full path around AskUserQuestion and resumes element streaming after", async () => {
    const { channel, elementContent, cardUpdate } = managedChannel();
    const controller = await createController(channel);

    await controller!.apply({ type: "assistant_text", text: "我先问你一个问题。" });
    await flushTimers(20);

    // AskUserQuestion arrives as a tool_use (+ its permission_request, which the
    // reducer intentionally drops as a duplicate): the trailing group is now a
    // tool, so deltas leave the element fast path for the full-patch path.
    await controller!.apply({ type: "tool_use", toolName: "AskUserQuestion", toolInput: { question: "选哪个?" }, toolUseId: "q1" });
    await controller!.apply({ type: "permission_request", toolName: "AskUserQuestion", toolInput: { question: "选哪个?" } });
    await flushTimers(450);
    const fullAfterQuestion = cardUpdate.mock.calls.length;
    expect(fullAfterQuestion).toBeGreaterThanOrEqual(2);
    const elementCallsAtQuestion = elementContent.mock.calls.length;

    // The user answered; the engine resumes with NEW text — a NEW element
    // (md_1). The full patch re-records the structure, then element streaming
    // resumes on the new element.
    await controller!.apply({ type: "tool_result", toolUseId: "q1", output: "A" });
    await controller!.apply({ type: "assistant_text", text: "好,按 A 继续。" });
    await flushTimers(450);
    await controller!.apply({ type: "assistant_text", text: "这是后续内容。" });
    await flushTimers(320);

    const newElementCalls = elementContent.mock.calls.slice(elementCallsAtQuestion);
    expect(newElementCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = newElementCalls[newElementCalls.length - 1][0] as {
      path: { element_id: string };
      data: { content: string };
    };
    expect(lastCall.path.element_id).toBe("md_1");
    expect(lastCall.data.content).toContain("好,按 A 继续。");

    await controller!.finish("done");
  });

  it("respects /stream off (elementStream: false controller input) — full patches only", async () => {
    const { channel, elementContent, cardUpdate } = managedChannel();
    const { createLarkRunCardController } = await import("../src/lark/message-handler.js");
    const controller = await createLarkRunCardController({
      channel: channel as never,
      chatId: "oc_chat",
      conversationKey: "lark:oc_chat",
      bridgeChatType: "private",
      locale: "zh",
      elementStream: false,
    });

    await controller!.apply({ type: "assistant_text", text: "第一句。" });
    await flushTimers(20);
    await controller!.apply({ type: "assistant_text", text: "第二句。" });
    await flushTimers(450);

    expect(elementContent).not.toHaveBeenCalled();
    expect(cardUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);
    await controller!.finish("done");
  });

  it("respects the CCTB_LARK_ELEMENT_STREAM=off kill switch", async () => {
    process.env.CCTB_LARK_ELEMENT_STREAM = "off";
    try {
      const { channel, elementContent, cardUpdate } = managedChannel();
      const controller = await createController(channel);

      await controller!.apply({ type: "assistant_text", text: "第一句。" });
      await flushTimers(20);
      await controller!.apply({ type: "assistant_text", text: "第二句。" });
      await flushTimers(450);

      expect(elementContent).not.toHaveBeenCalled();
      expect(cardUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);
      await controller!.finish("done");
    } finally {
      delete process.env.CCTB_LARK_ELEMENT_STREAM;
    }
  });
});

describe("updateManagedCardElement", () => {
  function channelWith(content: ReturnType<typeof vi.fn>, update?: ReturnType<typeof vi.fn>) {
    return {
      rawClient: {
        cardkit: {
          v1: {
            ...(update ? { card: { update } } : {}),
            cardElement: { content },
          },
        },
      },
    };
  }

  it("sends element content with the handle's monotonic sequence", async () => {
    const content = vi.fn(async () => ({}));
    const handle: ManagedCardHandle = { messageId: "om_1", cardId: "card_1", sequence: 3 };

    const ok = await updateManagedCardElement(channelWith(content), handle, "md_0", "你好。");

    expect(ok).toBe(true);
    expect(content).toHaveBeenCalledWith({
      path: { card_id: "card_1", element_id: "md_0" },
      data: { content: "你好。", sequence: 4, uuid: "e_card_1_4" },
    });
  });

  it("shares the sequence space and delivery order with full-card updates", async () => {
    const order: string[] = [];
    const update = vi.fn(async (_req: { data: { sequence: number } }) => { order.push("full"); });
    const content = vi.fn(async (_req: { data: { sequence: number } }) => { order.push("element"); });
    const channel = channelWith(content, update);
    const handle: ManagedCardHandle = { messageId: "om_1", cardId: "card_1", sequence: 0 };

    await Promise.all([
      updateManagedCard(channel, handle, { a: 1 }),
      updateManagedCardElement(channel, handle, "md_0", "text"),
    ]);

    expect(order).toEqual(["full", "element"]);
    expect(update.mock.calls[0][0].data.sequence).toBe(1);
    expect(content.mock.calls[0][0].data.sequence).toBe(2);
  });

  it("returns false when the element API is unavailable or fails", async () => {
    const handle: ManagedCardHandle = { messageId: "om_1", cardId: "card_1", sequence: 0 };
    expect(await updateManagedCardElement({}, handle, "md_0", "x")).toBe(false);

    const failing = vi.fn(async () => { throw new Error("230099"); });
    expect(await updateManagedCardElement(channelWith(failing), handle, "md_0", "x")).toBe(false);
  });
});
