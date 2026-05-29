import { describe, expect, it } from "vitest";

import {
  applyLarkEngineEvent,
  initialLarkRunState,
  renderLarkApprovalCard,
  renderLarkRunCard,
  renderLarkRunCardCompact,
} from "../src/lark/card-renderer.js";

describe("lark card renderer", () => {
  it("renders streaming engine events into one interactive run card", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "thinking", text: "thinking..." });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Read", toolInput: { file: "README.md" }, toolUseId: "t1" });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "t1", output: "file contents here" });
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "Hello world" });
    state = applyLarkEngineEvent(state, { type: "result", text: "Hello world" });

    const card = renderLarkRunCard(state) as any;
    const serialized = JSON.stringify(card);

    expect(card.schema).toBe("2.0");
    expect(card.config.streaming_mode).toBe(false);
    expect(serialized).toContain("thinking...");
    expect(serialized).toContain("Read");
    // The streamed answer is the canonical body of the single card.
    expect(serialized).toContain("Hello world");
    // tool_result output is rendered now that the engine emits it.
    expect(serialized).toContain("file contents here");
    expect(serialized).not.toContain("停止");
  });

  it("renders the final answer exactly once in the done card body (card is canonical)", () => {
    const answer = "This is the full final answer body shown in the single canonical card.";
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: answer });
    state = applyLarkEngineEvent(state, { type: "result", text: answer });

    const doneCard = renderLarkRunCard(state) as any;
    const body = JSON.stringify(doneCard.body);
    expect(state.status).toBe("done");
    // The answer is shown in the card body (the card is the single reply).
    expect(body).toContain(answer);
    // ...and it appears exactly once (no streamed-vs-result duplication).
    const occurrences = body.split(answer).length - 1;
    expect(occurrences).toBe(1);
  });

  it("renders a compact terminal card with the answer and no stop button, smaller than the full card", () => {
    let state = initialLarkRunState("lark:oc_chat");
    // A long, tool-heavy turn whose full card would be huge.
    for (let i = 0; i < 60; i++) {
      state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Bash", toolInput: { command: `cmd ${i}` }, toolUseId: `t${i}` });
      state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: `t${i}`, output: "x".repeat(400) });
    }
    state = applyLarkEngineEvent(state, { type: "result", text: "The final answer." });

    const full = JSON.stringify(renderLarkRunCard(state));
    const compact = JSON.stringify(renderLarkRunCardCompact(state));

    expect(compact).toContain("The final answer.");
    expect(compact).not.toContain("停止");            // terminal: no stop button
    expect((renderLarkRunCardCompact(state) as any).config.streaming_mode).toBe(false);
    // The compact card is dramatically smaller (no tool history).
    expect(compact.length).toBeLessThan(full.length / 2);
  });

  it("does not render a duplicate permission_request block for AskUserQuestion", () => {
    let state = initialLarkRunState("lark:oc_chat");
    // Claude emits the assistant tool_use block (carries an id, resolves via
    // tool_result) AND a permission_request control event for AskUserQuestion.
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "AskUserQuestion", toolInput: {}, toolUseId: "a1" });
    state = applyLarkEngineEvent(state, { type: "permission_request", toolName: "AskUserQuestion", toolInput: {} });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "a1", output: "ok" });
    state = applyLarkEngineEvent(state, { type: "result", text: "done" });
    // Only one AskUserQuestion tool block exists, and it is resolved (no
    // orphan stuck "running" panel).
    const toolBlocks = state.blocks.filter((block) => block.kind === "tool");
    expect(toolBlocks).toHaveLength(1);
    expect(toolBlocks[0]).toMatchObject({ kind: "tool", tool: { status: "done" } });
  });

  it("concatenates Codex app-server token deltas without inserting newlines", () => {
    let state = initialLarkRunState("lark:oc_chat");
    // Codex app-server emits one assistant_text per token fragment (delta:true).
    for (const part of ["Hello", " world", "!", "\n\nSecond paragraph."]) {
      state = applyLarkEngineEvent(state, { type: "assistant_text", text: part, delta: true });
    }
    state = applyLarkEngineEvent(state, { type: "result", text: "Hello world!\n\nSecond paragraph." });
    const body = JSON.stringify((renderLarkRunCard(state) as any).body);
    // Fragments join exactly (no spurious "\n" between every token).
    expect(body).toContain("Hello world!");
    expect(body).not.toContain("Hello\\n world");
  });

  it("keeps non-delta (complete-message) engine texts on separate lines", () => {
    let state = initialLarkRunState("lark:oc_chat");
    // Claude / Codex process emit one complete message per event (no delta flag).
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "First message." });
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "Second message." });
    const body = JSON.stringify((renderLarkRunCard(state) as any).body);
    expect(body).toContain("First message.\\nSecond message.");
  });

  it("downgrades markdown headings to bold so the card font is not oversized", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "## 已发布 v0.1.47\n\n正文内容\n\n### 子标题\nmore" });
    state = applyLarkEngineEvent(state, { type: "result", text: "## 已发布 v0.1.47\n\n正文内容\n\n### 子标题\nmore" });
    const body = JSON.stringify((renderLarkRunCard(state) as any).body);
    // Headings become bold (normal size), the raw "## " markdown is gone.
    expect(body).toContain("**已发布 v0.1.47**");
    expect(body).toContain("**子标题**");
    expect(body).not.toContain("## 已发布");
    expect(body).not.toContain("### 子标题");
    expect(body).toContain("正文内容");
  });

  it("renders an interrupted terminal marker without a stop button", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "partial" });
    state = { ...state, status: "interrupted", footer: null };
    const card = renderLarkRunCard(state) as any;
    const serialized = JSON.stringify(card);
    expect(card.config.streaming_mode).toBe(false);
    expect(serialized).toContain("已被中断");
    expect(serialized).not.toContain("停止");
  });

  it("renders an idle-timeout terminal marker with the minute count", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = { ...state, status: "idle_timeout", idleTimeoutMinutes: 15, footer: null };
    const serialized = JSON.stringify(renderLarkRunCard(state));
    expect(serialized).toContain("15 分钟无响应");
  });

  it("seeds the final answer for non-streaming engines that only emit a result", () => {
    let state = initialLarkRunState("lark:oc_chat");
    // No assistant_text events (e.g. Codex process) — only the final result.
    state = applyLarkEngineEvent(state, { type: "result", text: "codex final output" });
    const card = renderLarkRunCard(state) as any;
    expect(JSON.stringify(card.body)).toContain("codex final output");
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
    // Reasoning is captured in its own collapsible panel.
    expect(serialized).toContain("先分析问题边界");
    // Interleaved tool blocks render their own panels (Read, Bash).
    expect(serialized).toContain("Read");
    expect(serialized).toContain("Bash");
    expect(serialized).toContain("正在输出");
    expect(serialized).toContain("我正在整理结果。");
  });

  it("collapses three or more tool calls into a single summary panel", () => {
    let state = initialLarkRunState("lark:oc_chat", "group");
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Read", toolInput: { file_path: "a.ts" }, toolUseId: "t1" });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "t1", output: "ok" });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Grep", toolInput: { pattern: "foo" }, toolUseId: "t2" });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "t2", output: "ok" });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, toolUseId: "t3" });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "t3", output: "ok" });
    state = applyLarkEngineEvent(state, { type: "result", text: "done" });

    const serialized = JSON.stringify(renderLarkRunCard(state));
    // Finalized run with >=3 tools → one collapsed summary listing all tools.
    expect(serialized).toContain("工具调用 (3)");
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
