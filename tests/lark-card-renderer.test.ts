import { describe, expect, it } from "vitest";

import {
  applyLarkEngineEvent,
  initialLarkRunState,
  renderLarkApprovalCard,
  renderLarkRunCard,
} from "../src/lark/card-renderer.js";

describe("lark card renderer", () => {
  it("renders streaming engine events into one interactive run card", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "thinking", text: "thinking..." });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Read", toolInput: { file: "README.md" } });
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "Hello" });
    state = applyLarkEngineEvent(state, { type: "result", text: "Hello world" });

    const card = renderLarkRunCard(state) as any;
    const serialized = JSON.stringify(card);

    expect(card.schema).toBe("2.0");
    expect(card.config.streaming_mode).toBe(false);
    expect(serialized).toContain("thinking...");
    expect(serialized).toContain("Read");
    expect(serialized).toContain("Hello world");
    expect(serialized).not.toContain("停止");
  });

  it("does not repeat the final answer in the done card body (markdown delivery is canonical)", () => {
    const answer = "This is the full final answer body that must not be duplicated.";
    let running = initialLarkRunState("lark:oc_chat");
    running = applyLarkEngineEvent(running, { type: "assistant_text", text: answer });

    // While running, the streaming preview shows the assistant text in the body.
    const runningBody = JSON.stringify((renderLarkRunCard(running) as any).body);
    expect(runningBody).toContain(answer);

    // Once done, the canonical answer is delivered as a separate markdown message,
    // so the card body must NOT include the full answer again (only the short
    // summary chrome may reference it).
    const done = applyLarkEngineEvent(running, { type: "result", text: answer });
    const doneCard = renderLarkRunCard(done) as any;
    expect(JSON.stringify(doneCard.body)).not.toContain(answer);
    expect(done.status).toBe("done");
  });

  it("renders a stop button while a run is active", () => {
    const card = renderLarkRunCard(initialLarkRunState("lark:oc_chat", "group")) as any;
    const serialized = JSON.stringify(card);

    expect(card.config.streaming_mode).toBe(true);
    expect(serialized).toContain("任务处理中");
    expect(serialized).not.toContain("CC Telegram Bridge is working");
    expect(serialized).toContain("停止");
    expect(serialized).toContain("lark:oc_chat");
    expect(serialized).toContain('"behaviors"');
    expect(serialized).toContain('"type":"callback"');
    expect(serialized).toContain('"bridgeChatType":"group"');
  });

  it("renders active runs as a collapsible task console", () => {
    let state = initialLarkRunState("lark:oc_chat", "group");
    state = applyLarkEngineEvent(state, { type: "thinking", text: "先分析问题边界" });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Read", toolInput: { file: "src/lark/card-renderer.ts" } });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Bash", toolInput: { command: "npm test" } });
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "我正在整理结果。" });

    const card = renderLarkRunCard(state) as any;
    const serialized = JSON.stringify(card);

    expect(card.config.streaming_mode).toBe(true);
    expect(serialized).toContain("collapsible_panel");
    expect(serialized).toContain("思考中");
    expect(serialized).toContain("工具调用");
    expect(serialized).toContain("正在输出");
    expect(serialized).toContain("我正在整理结果。");
  });

  it("renders active run cards in English when locale is English", () => {
    const card = renderLarkRunCard(initialLarkRunState("lark:oc_chat", "group"), "en") as any;
    const serialized = JSON.stringify(card);

    expect(card.config.streaming_mode).toBe(true);
    expect(serialized).toContain("Task is running");
    expect(serialized).toContain("Stop");
    expect(serialized).not.toContain("任务处理中");
    expect(serialized).not.toContain("停止");
  });

  it("renders approval cards with scoped allow and deny actions", () => {
    const card = renderLarkApprovalCard({
      requestId: "req_1",
      toolName: "Bash",
      toolInput: { command: "npm test" },
    }) as any;
    const serialized = JSON.stringify(card);

    expect(card.schema).toBe("2.0");
    expect(serialized).toContain("Bash");
    expect(serialized).toContain("allow_session");
    expect(serialized).toContain("deny");
    expect(serialized).toContain('"behaviors"');
    expect(serialized).toContain('"type":"callback"');
  });

  it("renders approval cards in English when locale is English", () => {
    const card = renderLarkApprovalCard({
      requestId: "req_1",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      locale: "en",
    }) as any;
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("Approval requested");
    expect(serialized).toContain("Allow once");
    expect(serialized).toContain("Allow for this turn");
    expect(serialized).toContain("Deny");
    expect(serialized).not.toContain("允许一次");
    expect(serialized).not.toContain("本轮允许");
    expect(serialized).not.toContain("拒绝");
  });
});
