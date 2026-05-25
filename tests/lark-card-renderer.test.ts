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

  it("renders a stop button while a run is active", () => {
    const card = renderLarkRunCard(initialLarkRunState("lark:oc_chat", "group")) as any;
    const serialized = JSON.stringify(card);

    expect(card.config.streaming_mode).toBe(true);
    expect(serialized).toContain("停止");
    expect(serialized).toContain("lark:oc_chat");
    expect(serialized).toContain('"behaviors"');
    expect(serialized).toContain('"type":"callback"');
    expect(serialized).toContain('"bridgeChatType":"group"');
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
});
