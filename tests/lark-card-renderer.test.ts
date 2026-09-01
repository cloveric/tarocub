import { describe, expect, it } from "vitest";

import {
  ELEMENT_CONTENT_MAX_BYTES,
  LARK_CARD_ANSWER_MAX,
  LARK_OVERFLOW_CARD_MAX_BYTES,
  LARK_OVERFLOW_CARD_MAX_CHARS,
  type LarkRunState,
  applyLarkEngineEvent,
  cleanCardText,
  exceedsCardAnswerBudget,
  initialLarkRunState,
  renderLarkApprovalCard,
  renderLarkContinuationCard,
  renderLarkNotificationCard,
  renderLarkReminderCard,
  renderLarkRunCard,
  renderLarkRunCardCompact,
  renderLarkRunCardMinimal,
  rollingTailContent,
  splitLarkAnswerIntoCardChunks,
  liveRunCardStreamElement,
  resolveLarkFinalAnswerText,
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

function findMarkdownElement(card: unknown, needle: string): Record<string, unknown> | undefined {
  if (Array.isArray(card)) {
    for (const item of card) {
      const found = findMarkdownElement(item, needle);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (card && typeof card === "object") {
    const rec = card as Record<string, unknown>;
    if (rec.tag === "markdown" && typeof rec.content === "string" && rec.content.includes(needle)) {
      return rec;
    }
    for (const value of Object.values(rec)) {
      const found = findMarkdownElement(value, needle);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
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

  it("does not render a '后台任务' preview section for a task_notification (content is surfaced as the answer / its own card)", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, {
      type: "task_notification",
      text: "# 审计完成\n\n## 高危\n\n这里是非常长的后台报告。" + "内容".repeat(400),
      status: "completed",
    });

    const card = renderLarkRunCard(state, "zh");
    // The stray, truncating "后台任务" preview box was removed: a task_notification
    // no longer echoes a 650-char preview into the run card. The real content is
    // delivered on its own path (settling → the formal answer; non-settling → a
    // standalone notification card), so nothing here truncates it.
    expect(findMarkdownElement(card, "后台任务")).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain("后台任务");
    expect(JSON.stringify(card)).not.toContain("内容内容内容");
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

    // No single card element may exceed our per-element byte cap (the safety
    // bound under Feishu's raised per-element limit).
    expect(maxBytes(renderLarkRunCard(state))).toBeLessThanOrEqual(ELEMENT_CONTENT_MAX_BYTES);
    expect(maxBytes(renderLarkRunCardCompact(state))).toBeLessThanOrEqual(ELEMENT_CONTENT_MAX_BYTES);
  });

  it("keeps the byte cap ≥ 3× the char cap so a max-length CJK answer never byte-truncates", () => {
    // CJK is ≈3 bytes/char, so a full LARK_CARD_ANSWER_MAX answer of CJK is ≈3× that in
    // bytes. Keeping ELEMENT_CONTENT_MAX_BYTES ≥ that makes the char cap the single binding
    // constraint for any 1–3-byte text: the byte cap is a defensive net, never a silent
    // mid-answer truncator. (Lowering the byte cap below 3× the char cap would re-introduce
    // the old "fits char cap but byte-truncated" bug.)
    expect(ELEMENT_CONTENT_MAX_BYTES).toBeGreaterThanOrEqual(LARK_CARD_ANSWER_MAX * 3);
  });

  it("renders the live oversize text group as a rolling tail that matches the element stream byte-for-byte", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "早期内容。".repeat(1200) + "最新进展标记。" });
    const live = liveRunCardStreamElement(state);
    expect(live?.rolling).toBe(true);
    // The rolling tail shows the omission notice and the NEWEST text, not a frozen prefix.
    expect(live!.content).toContain("实时预览仅显示最新输出");
    expect(live!.content).toContain("最新进展标记");
    expect(live!.content.length).toBeLessThanOrEqual(LARK_CARD_ANSWER_MAX + 1);
    // The full-card patch renders the SAME content for that element, so a
    // structure update never rewinds the preview to the old frozen prefix.
    const card = renderLarkRunCard(state) as { body: { elements: Array<Record<string, unknown>> } };
    const element = card.body.elements.find((el) => el.element_id === live!.elementId);
    expect(element?.content).toBe(live!.content);
  });

  it("renders every over-cap running text group as a rolling tail (a following tool call doesn't rewind it)", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "开场白独特前缀。" + "叙述内容。".repeat(1200) + "分组末尾标记。" });
    // A tool call follows — the text group is no longer live, but it must keep
    // rendering as the rolling tail instead of snapping back to the ancient
    // truncate() prefix the operator already scrolled past.
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Bash", toolInput: { command: "ls" }, toolUseId: "t1" });

    const card = renderLarkRunCard(state, "zh") as { body: { elements: Array<Record<string, unknown>> } };
    const element = card.body.elements.find((el) => el.element_id === "md_0");
    const content = element?.content as string;
    expect(content).toContain("实时预览仅显示最新输出");
    expect(content).toContain("分组末尾标记");
    expect(content).not.toContain("开场白独特前缀");
  });

  it("softens the omission notice to '已省略' — no promise the omitted text is delivered later", () => {
    // Only the FINAL answer arrives in full at finalize; a mid-turn narration
    // group ends up truncated in the finished card's process panel, so the
    // notice must not promise "完整发出".
    const zh = rollingTailContent("长".repeat(6000), "zh");
    expect(zh).toContain("已省略");
    expect(zh).not.toContain("任务结束后完整发出");
    const en = rollingTailContent("x".repeat(6000), "en");
    expect(en).toContain("omitted");
    expect(en).not.toContain("arrive in full");
  });

  it("keys the rolling switch on the dual char+byte answer budget and byte-caps the tail output", () => {
    // Both axes inside their caps → not over budget (a full CJK answer at the
    // char cap is ≈3 bytes/char, within the byte cap by design).
    expect(exceedsCardAnswerBudget("好".repeat(LARK_CARD_ANSWER_MAX))).toBe(false);
    // Chars over the cap → over budget; the byte axis (mirroring finalize's
    // answerFitsCard rule) is the defensive net should the caps ever change,
    // since UTF-16 text tops out at 3 bytes per length unit today.
    expect(exceedsCardAnswerBudget("好".repeat(LARK_CARD_ANSWER_MAX + 1))).toBe(true);
    // Byte-dense CJK past the cap: rolling engages and the tail output honors
    // BOTH element budgets while still showing the newest text.
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "密".repeat(LARK_CARD_ANSWER_MAX + 200) + "结尾标记。" });
    const live = liveRunCardStreamElement(state);
    expect(live?.rolling).toBe(true);
    expect(live!.content.length).toBeLessThanOrEqual(LARK_CARD_ANSWER_MAX + 1);
    expect(Buffer.byteLength(live!.content, "utf8")).toBeLessThanOrEqual(ELEMENT_CONTENT_MAX_BYTES);
    expect(live!.content).toContain("结尾标记");
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

  it("keeps the rolling-tail preview and the stop button when a running card degrades to compact", () => {
    let state = initialLarkRunState("lark:oc_chat", "group");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "早期内容。".repeat(1200) + "最新进展标记。" });

    const card = renderLarkRunCardCompact(state, "zh");
    const serialized = JSON.stringify(card);
    // Degrade hits mid-run on exactly the long turns the rolling tail shipped
    // for: the answer element stays the rolling tail (newest slice + omission
    // notice), not a re-frozen truncate() prefix…
    expect(serialized).toContain("实时预览仅显示最新输出");
    expect(serialized).toContain("最新进展标记");
    expect(maxMarkdownElementLength(card)).toBeLessThanOrEqual(LARK_CARD_ANSWER_MAX + 1);
    // …and the operator keeps the same stop control the full card carries.
    expect(serialized).toContain("停止");
    expect(serialized).toContain('"cctb_lark":"stop"');
    expect(serialized).toContain('"bridgeChatType":"group"');
    // A running compact card carries the stop button even before any text.
    expect(JSON.stringify(renderLarkRunCardCompact(initialLarkRunState("lark:oc_chat"), "zh"))).toContain("停止");
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

  it("promotes a substantive assistant update when the terminal result is only a running placeholder", () => {
    const substantive = [
      "同意，而且比 A 强。理由是这句自带两个钩子：数字先把话说满，再用反差承诺接住读者。",
      "主标题：不换开源模型，token 也能砍掉 90% 以上。",
    ].join("\n\n");
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: substantive });
    state = applyLarkEngineEvent(state, { type: "result", text: "在跑了。" });

    const fullCard = renderLarkRunCard(state, "zh") as any;
    const compactCard = renderLarkRunCardCompact(state, "zh") as any;
    expect(fullCard.body.elements[1].content).toBe(substantive);
    expect(compactCard.body.elements[1].content).toBe(substantive);
    expect(JSON.stringify(fullCard.body)).not.toContain("在跑了");
    expect(JSON.stringify(fullCard.body)).not.toContain("过程");
    expect(fullCard.config.summary.content).toContain("同意，而且比 A 强");
  });

  it("keeps a legitimate short terminal answer instead of promoting earlier narration", () => {
    const earlier = "我核对了配置和运行日志，两个来源给出的状态一致。";
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: earlier });
    state = applyLarkEngineEvent(state, { type: "result", text: "是的。" });

    const card = renderLarkRunCard(state, "zh") as any;
    expect(card.body.elements[1].content).toBe("是的。");
    expect(JSON.stringify(card.body)).toContain(earlier);
    expect(card.config.summary.content).toBe("是的。");
  });

  it("never promotes away a terminal reply that carries a delivery directive", () => {
    // normalizedTerminalText strips send tags before the low-information
    // lookup, so "在跑了。[send-image:…]" classified as a bare placeholder and
    // promotion replaced the WHOLE result — tag included. The file was never
    // delivered and no ledger row existed to redeliver it.
    const narration = "我先检查 systemd 单元状态，然后看看最近三天的重启记录，稍等。";
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: narration });
    const withTag = "在跑了。\n[send-image:/tmp/pic.png]";
    expect(resolveLarkFinalAnswerText(state, withTag)).toBe(withTag);
    const fileTag = "[send-file:/tmp/report.pdf]\n处理中";
    expect(resolveLarkFinalAnswerText(state, fileTag)).toBe(fileTag);
    // Without a directive the placeholder still promotes.
    expect(resolveLarkFinalAnswerText(state, "在跑了。")).toBe(narration);
  });

  it("preserves inline and fenced send tool calls while still promoting non-send tools", () => {
    const narration = "我已经核对完所有文件，下面把最终产物一次性发送给你。";
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: narration });

    const sendTools = ["send.file", "send.image", "send.audio", "send.video", "send.batch"];
    for (const name of sendTools) {
      const payload = name === "send.batch"
        ? { files: ["/tmp/report.pdf"] }
        : { path: `/tmp/${name.slice("send.".length)}.bin` };
      const call = JSON.stringify({ name, payload });
      const inline = `在跑了。\n[tool:${call}]`;
      const fenced = `在跑了。\n\`\`\`tool-call\n${call}\n\`\`\``;
      expect(resolveLarkFinalAnswerText(state, inline)).toBe(inline);
      expect(resolveLarkFinalAnswerText(state, fenced)).toBe(fenced);
    }

    const nonSend = [
      "在跑了。",
      "```tool-call",
      JSON.stringify({ name: "web.search", payload: { query: "release notes" } }),
      "```",
    ].join("\n");
    expect(resolveLarkFinalAnswerText(state, nonSend)).toBe(narration);
  });

  it("does not promote short progress narration or tool output over a running placeholder", () => {
    let shortProgress = initialLarkRunState("lark:oc_chat");
    shortProgress = applyLarkEngineEvent(shortProgress, { type: "assistant_text", text: "我先检查一下。" });
    shortProgress = applyLarkEngineEvent(shortProgress, { type: "result", text: "在跑了。" });
    expect((renderLarkRunCard(shortProgress, "zh") as any).body.elements[1].content).toBe("在跑了。");

    let toolOnly = initialLarkRunState("lark:oc_chat");
    toolOnly = applyLarkEngineEvent(toolOnly, {
      type: "tool_use",
      toolName: "Bash",
      toolUseId: "t1",
      toolInput: { command: "npm test" },
    });
    toolOnly = applyLarkEngineEvent(toolOnly, {
      type: "tool_result",
      toolUseId: "t1",
      output: "This tool output is detailed but must stay inside the process panel.",
    });
    toolOnly = applyLarkEngineEvent(toolOnly, { type: "result", text: "在跑了。" });
    expect((renderLarkRunCard(toolOnly, "zh") as any).body.elements[1].content).toBe("在跑了。");
  });

  it("labels an engine failure after streamed output as partial instead of fully failed", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "已生成的正文内容。" });
    state = {
      ...state,
      status: "partial",
      footer: null,
      errorText: "所选模型当前容量不足。",
    };

    const body = JSON.stringify((renderLarkRunCard(state, "zh") as any).body);
    expect(body).toContain("部分完成");
    expect(body).toContain("已生成的正文内容。");
    expect(body).toContain("以上内容可能不完整");
    expect(body).not.toContain("执行失败");
  });

  it("does not repeat a streamed answer prefix when the terminal result adds a suffix", () => {
    const streamed = "The final answer starts here and is still streaming";
    const result = `${streamed}, then the terminal event adds this suffix.`;
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "I checked the implementation first." });
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Read", toolInput: { file_path: "src/a.ts" }, toolUseId: "t1" });
    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "t1", output: "ok" });
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: streamed });
    state = applyLarkEngineEvent(state, { type: "result", text: result });

    const body = JSON.stringify((renderLarkRunCard(state) as any).body);
    expect(body.split(streamed).length - 1).toBe(1);
    expect(body).toContain("I checked the implementation first.");
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

  it("attaches child-agent progress only to its running parent tool", () => {
    let state = initialLarkRunState("lark:oc_chat", "group");
    state = applyLarkEngineEvent(state, { type: "tool_use", toolName: "Agent", toolUseId: "agent-1" });
    state = applyLarkEngineEvent(state, { type: "tool_progress", toolUseId: "missing", text: "wrong task" });
    state = applyLarkEngineEvent(state, { type: "tool_progress", toolUseId: "agent-1", text: "first update" });
    state = applyLarkEngineEvent(state, {
      type: "tool_progress",
      toolUseId: "agent-1",
      text: `${"later ".repeat(250)}latest marker`,
    });

    const running = state.blocks.find((block) => block.kind === "tool");
    expect(running).toMatchObject({ kind: "tool", tool: { toolName: "Agent", status: "running" } });
    if (!running || running.kind !== "tool") {
      throw new Error("Agent tool block missing");
    }
    expect(running.tool.output).toContain("latest marker");
    expect(running.tool.output).not.toContain("wrong task");
    expect(running.tool.output!.length).toBeLessThanOrEqual(1200);

    state = applyLarkEngineEvent(state, { type: "tool_result", toolUseId: "agent-1", output: "final child result" });
    const done = state.blocks.find((block) => block.kind === "tool");
    expect(done).toMatchObject({ kind: "tool", tool: { status: "done", output: "final child result" } });
    const unchanged = applyLarkEngineEvent(state, { type: "tool_progress", toolUseId: "agent-1", text: "late update" });
    expect(unchanged).toBe(state);
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

  it("neutralizes Setext heading underlines outside fenced code blocks", () => {
    const divider = "=".repeat(40);
    expect(cleanCardText(`Overall: ALL PASS\n${divider}`)).toBe(
      `Overall: ALL PASS\n\\${divider}`,
    );
    expect(cleanCardText(`\`\`\`text\nOverall: ALL PASS\n${divider}\n\`\`\``)).toBe(
      `\`\`\`text\nOverall: ALL PASS\n${divider}\n\`\`\``,
    );
  });

  it("normalizes unsupported inline math arrows for Lark cards", () => {
    expect(cleanCardText(
      "先工商过户 $\\rightarrow$ 会计师验资 $\\Rightarrow$ 中登发股",
    )).toBe("先工商过户 → 会计师验资 ⇒ 中登发股");
  });

  it("moves bold markers inside quotation marks so inline quotes render in Lark markdown", () => {
    expect(cleanCardText(
      "卖方主张**“上市公司先支付首期款”**，再办理工商过户。",
    )).toBe("卖方主张“**上市公司先支付首期款**”，再办理工商过户。");
  });

  it("does not normalize card markdown inside fenced or inline code", () => {
    const raw = [
      "正文 $\\rightarrow$ 结果",
      "`示例 $\\rightarrow$ **“原样”**`",
      "```text",
      "流程 $\\rightarrow$ **“原样”**",
      "```",
    ].join("\n");
    expect(cleanCardText(raw)).toBe([
      "正文 → 结果",
      "`示例 $\\rightarrow$ **“原样”**`",
      "```text",
      "流程 $\\rightarrow$ **“原样”**",
      "```",
    ].join("\n"));
  });

  it("downgrades a heading inside a blockquote (> ##) without losing the callout, and keeps inner bold balanced", () => {
    // The real bug: Fable emitted `> ## 🥇 …的**逐笔成交明细**` — a level-2
    // heading inside a blockquote with an inner bold span. The old regex only
    // matched headings at line start, so the `>`-prefixed heading escaped the
    // downgrade and Feishu rendered it oversized (grey callout + giant font).
    const raw = "> ## 🥇 只需要这个的**逐笔成交明细**\n> 正文在引用里";
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: raw });
    state = applyLarkEngineEvent(state, { type: "result", text: raw });
    const body = JSON.stringify((renderLarkRunCard(state) as any).body);
    // No oversized heading marker survives.
    expect(body).not.toContain("## 🥇");
    // The blockquote callout is preserved.
    expect(body).toContain(">");
    // The inner bold span stays intact and balanced — no outer ** was added
    // around a title that already contained **.
    expect(body).toContain("🥇 只需要这个的**逐笔成交明细**");
    expect(body).not.toContain("**🥇");
  });

  it("renders an interrupted terminal marker without a stop button", () => {
    let state = initialLarkRunState("lark:oc_chat");
    state = applyLarkEngineEvent(state, { type: "assistant_text", text: "partial" });
    state = { ...state, status: "interrupted", footer: null };
    const card = renderLarkRunCard(state) as any;
    const serialized = JSON.stringify(card);
    expect(card.config.streaming_mode).toBe(false);
    // streaming_config rides only on running cards.
    expect(card.config.streaming_config).toBeUndefined();
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
    // The native typewriter is tuned to ~120 chars/s — faster than engine
    // token streams, so the animation never makes text visible later than the
    // old 400ms full-card path did (operator requirement: efficiency first).
    expect(card.config.streaming_config).toEqual({
      print_frequency_ms: { default: 25, android: 25, ios: 25, pc: 25 },
      print_step: { default: 3, android: 3, ios: 3, pc: 3 },
      print_strategy: "fast",
    });
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

  it("renders a resolved approval card (decidedStatus) showing the outcome with no buttons", () => {
    const card = renderLarkApprovalCard({
      requestId: "req_1",
      toolName: "Codex command approval",
      toolInput: { command: "rm -rf /tmp/x" },
      decidedStatus: "✅ 已允许一次。",
    }) as any;
    const serialized = JSON.stringify(card);
    // Keeps the command for context + shows the decision; the buttons are dropped.
    expect(serialized).toContain("rm -rf /tmp/x");
    expect(serialized).toContain("✅ 已允许一次。");
    expect(serialized).not.toContain("column_set");
    expect(serialized).not.toContain("allow_session");
    expect(serialized).not.toContain('"type":"callback"');
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

describe("long-answer continuation cards", () => {
  it("returns a single chunk for an answer that already fits one card", () => {
    expect(splitLarkAnswerIntoCardChunks("hello\nworld")).toEqual(["hello\nworld"]);
    expect(splitLarkAnswerIntoCardChunks("")).toEqual([""]);
  });

  it("packs whole lines into budget-sized chunks losslessly (rejoin reconstructs the original)", () => {
    const text = Array.from({ length: 60 }, (_, i) => `第${i}行：` + "测".repeat(100)).join("\n");
    const chunks = splitLarkAnswerIntoCardChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(LARK_OVERFLOW_CARD_MAX_CHARS);
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(LARK_OVERFLOW_CARD_MAX_BYTES);
    }
    // Splits only at line boundaries → rejoining with newlines is exact.
    expect(chunks.join("\n")).toBe(text);
  });

  it("balances ``` fences at chunk seams so a code block spanning the split renders correctly on both cards", () => {
    // Enough prose to fill most of chunk 1, then a code block long enough to
    // cross the seam into chunk 2.
    const prose = Array.from({ length: 40 }, (_, i) => `第${i}行前置说明，` + "铺".repeat(90)).join("\n");
    const code = Array.from({ length: 30 }, (_, i) => `const line${i} = "` + "v".repeat(80) + '";').join("\n");
    const text = `${prose}\n\`\`\`ts\n${code}\n\`\`\`\n结尾说明。`;

    const chunks = splitLarkAnswerIntoCardChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Chunks stay within the card budgets AFTER the seam fences were added…
      expect(chunk.length).toBeLessThanOrEqual(LARK_OVERFLOW_CARD_MAX_CHARS);
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(LARK_OVERFLOW_CARD_MAX_BYTES);
      // …and every chunk carries balanced fences (none ends mid-block open or
      // opens mid-block as prose).
      expect((chunk.match(/```/g) ?? []).length % 2).toBe(0);
    }
    // The seam fell inside the code block: chunk 1 was closed at the seam and
    // chunk 2 reopened the block.
    expect(chunks[0]!.endsWith("```")).toBe(true);
    expect(chunks[1]!.startsWith("```\n")).toBe(true);
    // Total content is preserved minus the synthetic fence markers.
    const withoutFences = (s: string): string => s.replace(/```[^\n]*/g, "").replace(/\n+/g, "\n");
    expect(withoutFences(chunks.join("\n"))).toBe(withoutFences(text));
  });

  it("leaves fence-free chunk seams untouched (split stays lossless)", () => {
    const text = Array.from({ length: 60 }, (_, i) => `第${i}行：` + "测".repeat(100)).join("\n");
    const chunks = splitLarkAnswerIntoCardChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toBe(text);
  });

  it("hard-splits a single oversized line without losing any characters", () => {
    const bigLine = "甲".repeat(5000); // ~15000 bytes, no line breaks to split on
    const chunks = splitLarkAnswerIntoCardChunks(bigLine);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(LARK_OVERFLOW_CARD_MAX_BYTES);
    }
    // Hard-split pieces of one line concatenate back with nothing inserted or dropped.
    expect(chunks.join("")).toBe(bigLine);
  });

  it("renders a continuation card with a sequence heading and the chunk body, untruncated", () => {
    const chunks = splitLarkAnswerIntoCardChunks("好".repeat(5000));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const card = renderLarkContinuationCard(chunks[1]!, 2, chunks.length, "zh");
    const elements = (card.body as { elements: Array<{ content?: string }> }).elements;
    expect(elements[0]?.content).toContain(`接上 · 2/${chunks.length}`);
    // A splitter chunk is within the element byte budget, so it renders in full (no "…").
    expect(elements[1]?.content).toBe(chunks[1]);
    expect(Buffer.byteLength(elements[1]?.content ?? "", "utf8")).toBeLessThanOrEqual(ELEMENT_CONTENT_MAX_BYTES);
    expect(JSON.stringify(renderLarkContinuationCard("body", 2, 3, "en"))).toContain("Continued · 2/3");
  });

  it("cleans continuation chunk text like the run card (downgrades headings, strips delivery tags)", () => {
    const chunk = "## 大标题\n正文内容\n[send-file:/Users/me/report.pdf]\n更多正文";
    const card = renderLarkContinuationCard(chunk, 2, 2, "zh");
    const body = (card.body as { elements: Array<{ content?: string }> }).elements[1]?.content ?? "";
    // "## " heading downgraded (no giant Feishu title) and the delivery tag stripped
    // (not leaked as literal text) — consistent with the run card carrying chunk 1.
    expect(body).not.toContain("## ");
    expect(body).not.toContain("[send-file:");
    expect(body).toContain("大标题");
    expect(body).toContain("正文内容");
    expect(body).toContain("更多正文");
  });
});

describe("renderLarkNotificationCard", () => {
  it("renders a header + cleaned-markdown body in one card", () => {
    const card = renderLarkNotificationCard("后台任务完成", "✅ v2.8.9 发布\n\n## 腾讯加层\n- 一条\n今晚 `evening.py` 复盘。");
    expect(card).not.toBeNull();
    const elements = (card as any).body.elements as Array<{ tag: string; content: string }>;
    expect(elements[0].content).toBe("**后台任务完成**");
    // Heading downgraded to bold (no oversized Feishu title), inline code kept.
    expect(elements[1].content).toContain("**腾讯加层**");
    expect(elements[1].content).not.toContain("## 腾讯");
    expect(elements[1].content).toContain("`evening.py`");
    // The chat-list preview summary is the header.
    expect((card as any).config.summary.content).toBe("后台任务完成");
  });

  it("returns null when the body is empty (nothing to show)", () => {
    expect(renderLarkNotificationCard("后台任务完成", "   \n  ")).toBeNull();
  });

  it("returns null when the body is too large for one card element (caller keeps plain text)", () => {
    const huge = "中".repeat(LARK_CARD_ANSWER_MAX + 1);
    expect(renderLarkNotificationCard("后台任务完成", huge)).toBeNull();
  });

  it("strips delivery tags from the body so they never leak as literal text", () => {
    const card = renderLarkNotificationCard("后台任务完成", "结果在这里。\n[send-file:/tmp/report.txt]");
    expect(JSON.stringify(card)).not.toContain("[send-file:");
    expect(JSON.stringify(card)).toContain("结果在这里。");
  });

  it("declines the card when the body is a fenced file: block (delivered as a file by the plain path, not echoed)", () => {
    // A whole-response ```file:…``` block must NOT be both attached and shown in
    // the card; returning null routes it to the plain/file delivery path instead.
    expect(renderLarkNotificationCard("后台任务完成", "```file:report.txt\nhello world\n```")).toBeNull();
  });
});

describe("truncateBytes surrogate safety (v0.1.205)", () => {
  it("never ends output inside a surrogate pair", async () => {
    const { truncateBytes } = await import("../src/lark/card-renderer.js");
    for (let maxBytes = 8; maxBytes <= 40; maxBytes += 1) {
      const out = truncateBytes("a😀😀😀😀😀😀😀😀", maxBytes);
      expect((out as string & { isWellFormed(): boolean }).isWellFormed(), `maxBytes=${maxBytes} produced lone surrogate`).toBe(true);
    }
  });
});
