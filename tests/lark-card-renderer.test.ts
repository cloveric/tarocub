import { describe, expect, it } from "vitest";

import {
  LARK_CARD_ANSWER_MAX,
  type LarkRunState,
  applyLarkEngineEvent,
  initialLarkRunState,
  renderLarkApprovalCard,
  renderLarkReminderCard,
  renderLarkRunCard,
  renderLarkRunCardCompact,
  renderLarkRunCardMinimal,
} from "../src/lark/card-renderer.js";

function maxMarkdownElementLength(card: unknown): number {
  let max = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if (rec.tag === "markdown" && typeof rec.content === "string") {
        max = Math.max(max, rec.content.length);
      }
      Object.values(rec).forEach(walk);
    }
  };
  walk(card);
  return max;
}

describe("lark card renderer", () => {
  it("renders streaming engine events into one interactive run card", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "thinking", text: "thinking..." });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Read", toolInput: { file: "README.md" }, toolUseId: "t1" });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "t1", output: "file contents here" });

    // While running, the full live process renders inline (incl. tool output).
    const running = JSON.stringify(renderLarkRunCard(state));
    expect(running).toContain("thinking...");
    expect(running).toContain("Read");
    expect(running).toContain("file contents here");

    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "Hello world" });
    state = applyLarkEngineEvent(state, { type: "result", text: "Hello world" });

    const card = renderLarkRunCard(state) as any;
    const serialized = JSON.stringify(card);

    expect(card.schema).toBe("2.0");
    expect(card.config.streaming_mode).toBe(false);
    // The streamed answer is the canonical body of the single card.
    expect(serialized).toContain("Hello world");
    // Finished cards condense the process into one collapsed panel (tool name
    // kept, verbose output dropped) so they don't become a giant scroll.
    expect(serialized).toContain("过程");
    expect(serialized).toContain("Read");
    expect(serialized).not.toContain("file contents here");
    expect(serialized).not.toContain("停止");
  });

  it("frames a /goal run with a 🎯 goal banner (full + compact), persisting from running to done", () => {
    let state: LarkRunState = { ...initialLarkRunState("lark:oc_chat"), goalObjective: "review every bug in the auth module" };

    // Running: the banner sits up top alongside the live process.
    const running = JSON.stringify(renderLarkRunCard(state, "zh"));
    expect(running).toContain("🎯");
    expect(running).toContain("目标");
    expect(running).toContain("review every bug in the auth module");

    // Done: the banner persists so the finished card still reads as a goal.
    state = applyLarkEngineEvent(state, { type: "result", text: "All bugs reviewed. Goal complete." });
    const done = JSON.stringify(renderLarkRunCard(state, "zh"));
    expect(done).toContain("🎯");
    expect(done).toContain("review every bug in the auth module");
    // Compact render (used when the card degrades) keeps the banner too.
    expect(JSON.stringify(renderLarkRunCardCompact(state, "zh"))).toContain("🎯");
    // English locale localizes the label but keeps the marker + objective.
    const en = JSON.stringify(renderLarkRunCard(state, "en"));
    expect(en).toContain("🎯 **Goal:**");

    // A normal (non-goal) run shows no banner — the field is opt-in.
    const plain = JSON.stringify(renderLarkRunCard(initialLarkRunState("lark:oc_chat"), "zh"));
    expect(plain).not.toContain("🎯");
  });

  it("renders a reminder card with the ⏰ heading, body, and a push-friendly summary", () => {
    const card = renderLarkReminderCard("看盘：A股开盘", "zh") as {
      config: { summary: { content: string } };
    };
    const json = JSON.stringify(card);
    expect(json).toContain("⏰ 提醒");
    expect(json).toContain("看盘：A股开盘");
    // The summary is the phone-notification preview → must carry the reminder text.
    expect(card.config.summary.content).toContain("看盘：A股开盘");
    // English locale localizes the heading.
    expect(JSON.stringify(renderLarkReminderCard("check the market", "en"))).toContain("⏰ Reminder");
  });

  it("caps every card markdown element so a long answer cannot overflow Feishu's element limit", () => {
    const huge = "好".repeat(20000);
    let state = initialLarkRunState("lark:oc_chat");
    // While streaming (running): the streamed text element must be capped.
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: huge });
    expect(maxMarkdownElementLength(renderLarkRunCard(state))).toBeLessThanOrEqual(LARK_CARD_ANSWER_MAX + 1);
    // When done: the answer element (full + compact) must be capped too.
    state = applyLarkEngineEvent(state, { type: "result", text: huge });
    expect(maxMarkdownElementLength(renderLarkRunCard(state))).toBeLessThanOrEqual(LARK_CARD_ANSWER_MAX + 1);
    expect(maxMarkdownElementLength(renderLarkRunCardCompact(state))).toBeLessThanOrEqual(LARK_CARD_ANSWER_MAX + 1);
  });

  it("byte-caps every element so max-effort CJK reasoning + many tools can't overflow the 11310 limit", () => {
    const maxBytes = (card: unknown): number => {
      let max = 0;
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node && typeof node === "object") {
          const rec = node as Record<string, unknown>;
          if (rec.tag === "markdown" && typeof rec.content === "string") {
            max = Math.max(max, Buffer.byteLength(rec.content, "utf8"));
          }
          Object.values(rec).forEach(walk);
        }
      };
      walk(card);
      return max;
    };

    let state = initialLarkRunState("lark:oc_chat");
    // Max reasoning effort produces a huge CJK "thinking" stream (~3 bytes/char).
    state = applyLarkEngineEvent(state, { type: "thinking", text: "推".repeat(20000) });
    // ...and many tool calls, which fold into one aggregate "tool summary" panel
    // whose body was previously uncapped.
    for (let i = 0; i < 80; i += 1) {
      state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Bash", toolInput: { command: "回".repeat(60) }, toolUseId: `t${i}` });
      state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: `t${i}`, output: "输出".repeat(60) });
    }
    state = applyLarkEngineEvent(state, { type: "result", text: "答".repeat(20000) });

    // No single card element may exceed Feishu's per-element byte limit (11310).
    expect(maxBytes(renderLarkRunCard(state))).toBeLessThanOrEqual(11310);
    expect(maxBytes(renderLarkRunCardCompact(state))).toBeLessThanOrEqual(11310);
  });

  it("renders a guaranteed-tiny terminal card pointing to the full reply", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "x".repeat(50000) });
    state = applyLarkEngineEvent(state, { type: "result", text: "x".repeat(50000) });
    const card = renderLarkRunCardMinimal(state) as { body: unknown };
    const body = JSON.stringify(card.body);
    expect(body).toContain("完整回复见下方消息"); // points to the text message
    expect(body).not.toContain("xxxxx"); // no huge answer in the body
    expect(maxMarkdownElementLength(card.body)).toBeLessThan(100); // tiny — always fits Feishu's limit
  });

  it("ignores a TodoWrite tool_result so it can't finish an unrelated running tool", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Bash", toolInput: { command: "sleep 30" }, toolUseId: "b1" });
    // A Codex plan can complete as an id-less TodoWrite tool_result; it must not
    // fall through to mark the still-running Bash as done.
    state = applyLarkEngineEvent(state, { type: "tool_result", toolName: "TodoWrite", output: "" });
    const bash = state.blocks.find((b) => b.kind === "tool" && b.tool.toolName === "Bash");
    expect(bash && bash.kind === "tool" ? bash.tool.status : undefined).toBe("running");
  });

  it("renders a todo using activeForm when its content is empty", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, {
      type: "tool_use",
      toolName: "TodoWrite",
      toolInput: { todos: [{ content: "", activeForm: "Building the widget", status: "completed" }] },
    });
    const serialized = JSON.stringify(renderLarkRunCard(state));
    expect(serialized).toContain("Building the widget"); // no bare "✅ " blank row
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

  it("keeps intermediate narration in the finished process panel without duplicating the answer", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "Let me check the config first." });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Read", toolInput: { file_path: "cfg.ts" }, toolUseId: "t1" });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "t1", output: "ok" });
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "The answer is 42." });
    state = applyLarkEngineEvent(state, { type: "result", text: "The answer is 42." });

    const body = JSON.stringify((renderLarkRunCard(state) as any).body);
    // Final answer shown exactly once (not duplicated into the process panel).
    expect(body.split("The answer is 42.").length - 1).toBe(1);
    // Earlier narration is preserved (folded), not dropped.
    expect(body).toContain("Let me check the config first.");
    expect(body).toContain("过程");
    expect(body).toContain("Read");
  });

  it("renders a TodoWrite tool as a checklist with progress", () => {
    let state = initialLarkRunState("lark:oc_chat", "group");
    state = applyLarkEngineEvent(state, {
      type: "tool_use", toolName: "TodoWrite", toolUseId: "t1",
      toolInput: { todos: [
        { content: "Read the code", status: "completed", activeForm: "Reading the code" },
        { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
        { content: "Ship it", status: "pending", activeForm: "Shipping it" },
      ] },
    });
    const serialized = JSON.stringify(renderLarkRunCard(state));
    expect(serialized).toContain("✅ Read the code");   // completed
    expect(serialized).toContain("Writing tests");        // in-progress shows activeForm
    expect(serialized).toContain("⬜ Ship it");           // pending
    expect(serialized).toContain("1/3");                  // header progress (1 of 3 done)
  });

  it("keeps the plan as meta-state: repeated updates don't accumulate blocks or chop the answer", () => {
    let state = initialLarkRunState("lark:oc_chat", "group");
    // Stream answer text with plan updates interleaved (as Codex does).
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "Working", delta: true });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "TodoWrite", toolUseId: "p1", toolInput: { todos: [{ content: "A", status: "in_progress" }] } });
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: " on it.", delta: true });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "TodoWrite", toolUseId: "p2", toolInput: { todos: [{ content: "A", status: "completed" }, { content: "B", status: "in_progress" }] } });

    // No TodoWrite ever becomes a block; the streamed text stays in one piece.
    const toolBlocks = state.blocks.filter((b) => b.kind === "tool");
    expect(toolBlocks).toHaveLength(0);
    const textBlocks = state.blocks.filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text");
    expect(textBlocks).toHaveLength(1);
    expect(textBlocks[0].content).toBe("Working on it.");

    // The plan panel reflects the LATEST plan only.
    const serialized = JSON.stringify(renderLarkRunCard(state));
    expect(serialized).toContain("✅ A");      // completed in latest
    expect(serialized).toContain("B");          // newest step
    expect(serialized).toContain("📋");
  });

  it("ignores a tool_result whose id matches no block (no cross-attaching)", () => {
    let state = initialLarkRunState("lark:oc_chat", "group");
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Bash", toolUseId: "b1", toolInput: { command: "sleep 5" } });
    // A plan result (id p1) arrives while Bash is still running; Bash must stay running.
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "p1", output: "plan saved" });
    const bash = state.blocks.find((b) => b.kind === "tool");
    expect(bash).toMatchObject({ kind: "tool", tool: { toolName: "Bash", status: "running" } });
  });

  it("renders MCP tool names as a friendly 'server · tool'", () => {
    let state = initialLarkRunState("lark:oc_chat", "group");
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "mcp__chrome-devtools__click", toolInput: {}, toolUseId: "t1" });
    const serialized = JSON.stringify(renderLarkRunCard(state));
    expect(serialized).toContain("chrome-devtools · click");
    expect(serialized).not.toContain("mcp__chrome-devtools__click");
  });

  it("annotates multi-line tool output with a line count", () => {
    let state = initialLarkRunState("lark:oc_chat", "group");
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, toolUseId: "t1" });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "t1", output: "a\nb\nc" });
    const serialized = JSON.stringify(renderLarkRunCard(state));
    expect(serialized).toContain("3 行");
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

  it("folds a finished run's tools into one collapsed process panel", () => {
    let state = initialLarkRunState("lark:oc_chat", "group");
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Read", toolInput: { file_path: "a.ts" }, toolUseId: "t1" });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "t1", output: "ok" });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Grep", toolInput: { pattern: "foo" }, toolUseId: "t2" });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "t2", output: "ok" });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, toolUseId: "t3" });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "t3", output: "ok" });
    state = applyLarkEngineEvent(state, { type: "result", text: "done" });

    const serialized = JSON.stringify(renderLarkRunCard(state));
    // Finished run → one collapsed "过程 · N 步" panel listing the tool calls.
    expect(serialized).toContain("过程");
    expect(serialized).toContain("3 步");
    expect(serialized).toContain("Read");
    expect(serialized).toContain("Grep");
    expect(serialized).toContain("Bash");
    expect(serialized).toContain("done"); // the final answer
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
