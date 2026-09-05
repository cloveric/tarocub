import type { EngineStreamEvent } from "../codex/adapter.js";
import type { Locale } from "../telegram/message-renderer.js";
import { stripDeliveryTags } from "../telegram/delivery-tags.js";
import { stripCronAddTags } from "../telegram/cron-tags.js";
import {
  extractTelegramToolTagMatches,
  parseTelegramToolTagPayload,
  stripTelegramToolTags,
} from "../telegram/tool-tags.js";
import { isLarkSendToolName } from "./delivery-preflight.js";

// ---------------------------------------------------------------------------
// Run state — a single rich card is the canonical reply. Text and tool calls
// are kept as an ordered block stream (interleaved exactly as the engine
// emitted them) so the card reads like the Claude Code / Codex terminal.
// ---------------------------------------------------------------------------

export type LarkToolStatus = "running" | "done" | "error";

export interface LarkToolEntry {
  toolUseId?: string;
  toolName: string;
  toolInput?: unknown;
  status: LarkToolStatus;
  output?: string;
}

export type LarkRunBlock =
  | { kind: "text"; content: string; streaming: boolean }
  | { kind: "tool"; tool: LarkToolEntry };

export interface LarkRunState {
  conversationKey: string;
  bridgeChatType?: "private" | "group";
  status:
    | "running"
    | "delivering"
    | "done"
    | "partial"
    | "error"
    | "delivery_error"
    | "interrupted"
    | "idle_timeout";
  blocks: LarkRunBlock[];
  reasoning: { content: string; active: boolean };
  /** Latest TodoWrite/Codex plan (the `{ todos: [...] }` input); rendered as the plan panel. */
  plan?: unknown;
  footer: "thinking" | "tool_running" | "streaming" | null;
  resultText: string;
  /** First text/tool block eligible to replace a low-information terminal result. */
  finalAnswerBlockStart?: number;
  errorText: string;
  idleTimeoutMinutes?: number;
  /**
   * When set, this run is an autonomous `/goal` pursuit; rendered as a 🎯 banner
   * so the card visibly signals "goal mode engaged" (parity with the Codex
   * thread-goal card). Claude/Antigravity `/goal` runs as a normal engine turn,
   * so without this the card is indistinguishable from any other reply.
   */
  goalObjective?: string;
}

export interface LarkApprovalCardInput {
  requestId: string;
  toolName: string;
  toolInput?: unknown;
  replyInThread?: boolean;
  locale?: Locale;
  /** When set, the card is rendered resolved (this status line replaces the buttons) — used to update the card in place after the operator decides. */
  decidedStatus?: string;
}

export interface LarkQueueWaitCardInput {
  conversationKey: string;
  bridgeChatType?: "private" | "group";
  /** Id of this queued task, so the card's button cancels just this task. */
  taskId?: string;
  waitedMs: number;
  replyInThread?: boolean;
  locale?: Locale;
}

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;
const TOOL_HEADER_SUMMARY_MAX = 80;
const TOOL_INPUT_FIELD_MAX = 600;
const TOOL_OUTPUT_MAX = 1200;
const TOOL_BODY_TOTAL_MAX = 2500;
const MAX_BLOCKS = 200;

export function initialLarkRunState(conversationKey: string, bridgeChatType?: "private" | "group"): LarkRunState {
  return {
    conversationKey,
    ...(bridgeChatType ? { bridgeChatType } : {}),
    status: "running",
    blocks: [],
    reasoning: { content: "", active: false },
    footer: "thinking",
    resultText: "",
    errorText: "",
  };
}

export function applyLarkEngineEvent(
  state: LarkRunState,
  event: EngineStreamEvent,
): LarkRunState {
  switch (event.type) {
    case "thinking":
      return {
        ...state,
        reasoning: {
          content: truncate(state.reasoning.content + event.text, REASONING_MAX),
          active: true,
        },
        footer: "thinking",
      };
    case "assistant_text":
      return appendAssistantText(state, event.text, event.delta === true);
    case "tool_use":
    case "permission_request":
      if (event.type === "permission_request" && event.toolName === "AskUserQuestion") {
        // AskUserQuestion is surfaced as its own interactive choice card and is
        // already represented by the assistant tool_use block (which resolves
        // via tool_result). Skip the duplicate permission_request block, which
        // carries no toolUseId and would otherwise spin "running" forever.
        return { ...state, reasoning: { ...state.reasoning, active: false } };
      }
      if (event.type === "tool_use" && event.toolName === "TodoWrite") {
        // The plan/checklist is meta-state shown as the dedicated plan panel —
        // not a block. Keeping it out of the block stream means repeated plan
        // updates never accumulate stale blocks and never close (chop) the
        // streaming answer text.
        return { ...state, plan: event.toolInput };
      }
      return {
        ...state,
        blocks: capBlocks([
          ...closeStreamingText(state.blocks),
          {
            kind: "tool",
            tool: {
              ...("toolUseId" in event && event.toolUseId ? { toolUseId: event.toolUseId } : {}),
              toolName: event.toolName,
              ...(event.toolInput === undefined ? {} : { toolInput: event.toolInput }),
              status: "running" as const,
            },
          },
        ]),
        reasoning: { ...state.reasoning, active: false },
        footer: "tool_running",
      };
    case "tool_result":
      // A TodoWrite/plan is meta-state (state.plan), never a block, so its
      // result has nothing to complete. Ignore it outright — otherwise an
      // id-less plan result (some Codex payloads omit the id) would fall through
      // to applyToolResult's "most recent running tool" branch and wrongly mark
      // an unrelated, still-running tool as done.
      if (event.toolName === "TodoWrite") {
        return state;
      }
      return {
        ...state,
        blocks: applyToolResult(state.blocks, event),
      };
    case "tool_progress": {
      const blocks = applyToolProgress(state.blocks, event);
      if (blocks === state.blocks) {
        return state;
      }
      return {
        ...state,
        blocks,
        reasoning: { ...state.reasoning, active: false },
        footer: "tool_running",
      };
    }
    case "result":
      return finalizeWithResult(state, event.text);
    case "background_task_started":
    case "background_task_finished":
      // Bookkeeping-only event (timeline pairing for the restart busy guard);
      // nothing to render on the run card.
      return state;
    case "task_notification":
      // No-op for the run card: a background-task notification is surfaced on
      // its own — a settling one finalizes the turn as the formal answer (the
      // adapter emits a `result` with the full text), a non-settling one is
      // delivered as its own standalone card. The run card used to ALSO echo a
      // 650-char "后台任务" preview here, which truncated real content and read
      // as a stray section; that preview was removed (operator request).
      return state;
    case "session":
      return state;
  }
}

function appendAssistantText(state: LarkRunState, text: string, isDelta: boolean): LarkRunState {
  if (!text) {
    return { ...state, reasoning: { ...state.reasoning, active: false }, footer: "streaming" };
  }
  const last = state.blocks[state.blocks.length - 1];
  if (last && last.kind === "text" && last.streaming) {
    // Token fragments (Codex app-server) concatenate with no separator so the
    // model's own spacing/newlines survive. Complete messages (Claude, Codex
    // process) stay on their own line.
    const joiner = isDelta ? "" : "\n";
    const next: LarkRunBlock = { ...last, content: last.content + joiner + text };
    return {
      ...state,
      blocks: [...state.blocks.slice(0, -1), next],
      reasoning: { ...state.reasoning, active: false },
      footer: "streaming",
    };
  }
  return {
    ...state,
    blocks: capBlocks([...state.blocks, { kind: "text", content: text, streaming: true }]),
    reasoning: { ...state.reasoning, active: false },
    footer: "streaming",
  };
}

function applyToolResult(
  blocks: LarkRunBlock[],
  event: Extract<EngineStreamEvent, { type: "tool_result" }>,
): LarkRunBlock[] {
  const status: LarkToolStatus = event.isError ? "error" : "done";
  const matchById = (block: LarkRunBlock): boolean =>
    block.kind === "tool" && event.toolUseId !== undefined && block.tool.toolUseId === event.toolUseId;

  let targetIndex = -1;
  if (event.toolUseId !== undefined) {
    targetIndex = blocks.findIndex(matchById);
    // An id was given but no block carries it — the originating tool_use was not
    // rendered as a block (e.g. a TodoWrite/plan update). Do NOT fall back to the
    // last running tool, or this result would wrongly finish an unrelated tool.
    if (targetIndex === -1) {
      return blocks;
    }
  } else {
    // No id — attach to the most recent still-running tool.
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]!;
      if (block.kind === "tool" && block.tool.status === "running") {
        targetIndex = i;
        break;
      }
    }
  }
  if (targetIndex === -1) {
    return blocks;
  }
  const target = blocks[targetIndex]!;
  if (target.kind !== "tool") {
    return blocks;
  }
  const next = [...blocks];
  next[targetIndex] = {
    kind: "tool",
    tool: {
      ...target.tool,
      status,
      ...(event.output !== undefined ? { output: event.output } : {}),
    },
  };
  return next;
}

function applyToolProgress(
  blocks: LarkRunBlock[],
  event: Extract<EngineStreamEvent, { type: "tool_progress" }>,
): LarkRunBlock[] {
  if (!event.text) {
    return blocks;
  }
  const targetIndex = blocks.findIndex((block) =>
    block.kind === "tool" && block.tool.toolUseId === event.toolUseId,
  );
  if (targetIndex === -1) {
    return blocks;
  }
  const target = blocks[targetIndex]!;
  if (target.kind !== "tool" || target.tool.status !== "running") {
    return blocks;
  }

  const combined = target.tool.output
    ? `${target.tool.output}\n${event.text}`
    : event.text;
  let output = combined;
  if (output.length > TOOL_OUTPUT_MAX) {
    let start = output.length - (TOOL_OUTPUT_MAX - 2);
    if (/^[\uDC00-\uDFFF]$/.test(output[start] ?? "") && /[\uD800-\uDBFF]/.test(output[start - 1] ?? "")) {
      start += 1;
    }
    output = `…\n${output.slice(start)}`;
  }

  const next = [...blocks];
  next[targetIndex] = {
    kind: "tool",
    tool: {
      ...target.tool,
      output,
    },
  };
  return next;
}

function finalizeWithResult(state: LarkRunState, text: string): LarkRunState {
  const blocks = closeStreamingText(state.blocks);
  const hasText = blocks.some((block) => block.kind === "text" && block.content.trim().length > 0);
  // Non-streaming engines (e.g. Codex process) emit only the final result with
  // no incremental assistant_text. Seed a text block so the answer still shows.
  const finalBlocks = hasText || !text.trim()
    ? blocks
    : capBlocks([...blocks, { kind: "text", content: text, streaming: false }]);
  return {
    ...state,
    status: "done",
    blocks: finalBlocks,
    reasoning: { ...state.reasoning, active: false },
    footer: null,
    resultText: text,
  };
}

function closeStreamingText(blocks: LarkRunBlock[]): LarkRunBlock[] {
  return blocks.map((block) =>
    block.kind === "text" && block.streaming ? { ...block, streaming: false } : block,
  );
}

function capBlocks(blocks: LarkRunBlock[]): LarkRunBlock[] {
  return blocks.length > MAX_BLOCKS ? blocks.slice(blocks.length - MAX_BLOCKS) : blocks;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderLarkRunCard(state: LarkRunState, locale: Locale = "zh"): Record<string, unknown> {
  const labels = runCardLabels(locale);
  const elements: unknown[] = [
    markdownElement(`**${runCardStatusLabel(state.status, labels)}**`),
  ];

  // Goal banner: when this run is an autonomous /goal pursuit, show the
  // objective up top so the card reads as "goal mode" (parity with Codex /goal),
  // not just a normal reply. Persists across running → done/interrupted.
  if (state.goalObjective && state.goalObjective.trim()) {
    elements.push(markdownElement(
      locale === "en"
        ? `🎯 **Goal:** ${truncate(state.goalObjective.trim(), 120)}`
        : `🎯 **目标:** ${truncate(state.goalObjective.trim(), 120)}`,
    ));
  }

  if (state.status === "running") {
    // While the task runs, show the live process in full: thinking, every text
    // span, and tool panels interleaved as they happen.
    if (state.reasoning.content.trim()) {
      elements.push(collapsiblePanel({
        title: state.reasoning.active ? labels.thinkingActive : labels.thinkingDone,
        expanded: state.reasoning.active,
        color: "grey",
        body: state.reasoning.content,
      }));
    }
    const livePlan = todoPlanPanel(state, labels, true);
    if (livePlan) {
      elements.push(livePlan);
    }
    let streamTextIndex = 0;
    for (const group of groupBlocks(state.blocks)) {
      if (group.kind === "text") {
        const cleaned = cleanCardText(group.content);
        if (cleaned) {
          // Cap each streamed text element — a long answer would otherwise
          // overflow Feishu's per-element limit and fail every card update.
          // Stable element_id lets the live (last) text element be updated via
          // the CardKit element-content endpoint (native typewriter) instead of
          // re-sending the whole card on every delta. EVERY group past the
          // answer budget renders the rolling tail: the live one so a full
          // patch agrees byte-for-byte with the element stream, and finished
          // ones so a tool call arriving after a long narration doesn't snap
          // the element from the newest tail back to the ancient prefix.
          elements.push(markdownElement(
            exceedsCardAnswerBudget(cleaned)
              ? rollingTailContent(cleaned, locale)
              : truncate(cleaned, LARK_CARD_ANSWER_MAX),
            streamTextElementId(streamTextIndex),
          ));
          streamTextIndex += 1;
        }
      } else {
        for (const element of renderToolGroup(group.tools, false, labels)) {
          elements.push(element);
        }
      }
    }
  } else {
    // Once engine output is final, condense: show the answer prominently and fold the
    // whole process (thinking + every tool call) into one collapsed panel, so
    // the card doesn't become a giant scroll of intermediate steps.
    const answer = cleanCardText(finalAnswerText(state));
    if (answer) {
      elements.push(markdownElement(truncate(answer, COMPACT_ANSWER_MAX)));
    }
    const donePlan = todoPlanPanel(state, labels, false);
    if (donePlan) {
      elements.push(donePlan);
    }
    const processPanel = condensedProcessPanel(state, labels);
    if (processPanel) {
      elements.push(processPanel);
    }
  }

  if (state.status === "interrupted") {
    elements.push(noteElement(`_⏹ ${labels.interrupted}_`));
  } else if (state.status === "idle_timeout") {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteElement(`_⏱ ${labels.idleTimeout(mins)}_`));
  } else if (
    (state.status === "error" || state.status === "partial" || state.status === "delivery_error")
    && state.errorText.trim()
  ) {
    const prefix = state.status === "partial" ? `${labels.partialWarning}\n\n` : "";
    elements.push(markdownElement(`⚠️ ${truncate(prefix + state.errorText.trim(), LARK_CARD_ANSWER_MAX)}`));
  } else if (state.status === "done" && elements.length === 1) {
    elements.push(markdownElement(`_${labels.empty}_`));
  }

  if (state.status === "running") {
    if (state.footer) {
      elements.push(noteElement(footerStatusText(state.footer, labels)));
    }
    elements.push({ tag: "hr" });
    elements.push(stopButtonElement(state, labels));
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: state.status === "running",
      ...(state.status === "running" ? { streaming_config: LARK_STREAMING_CONFIG } : {}),
      update_multi: true,
      summary: { content: cardSummary(state, locale) },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

// Feishu's native typewriter defaults to 70ms per character (~14 chars/s) —
// far slower than the engines' token streams, so with defaults the text lags
// behind generation and the card FEELS slower than the old 400ms full-card
// jumps. 25ms × 3 chars ≈ 120 chars/s deliberately outruns generation: the
// animation always catches up within a push interval, so the last char is
// visible no later than the old full-card path while still easing in — the
// operator's requirement is efficiency first, smoothness second. "fast"
// renders any remaining backlog immediately on the next push instead of
// queuing it behind the animation. Custom params need Feishu client ≥ 7.23;
// older clients silently fall back to the defaults.
const LARK_STREAMING_CONFIG = {
  print_frequency_ms: { default: 25, android: 25, ios: 25, pc: 25 },
  print_step: { default: 3, android: 3, ios: 3, pc: 3 },
  print_strategy: "fast",
} as const;

// Per-element cap for the answer text. Feishu's real ceilings are: per-element
// ~11310 (raised over time — a 15KB / 5000-CJK single element renders fine as of
// 2026-06-26, where 9KB used to 11310) and whole-card 30KB. 5000 chars (≈15KB for
// CJK) keeps one answer element comfortably under the per-element limit while
// leaving whole-card room for the process/reasoning panels; longer answers are
// truncated in the card and the full text spills to continuation cards / a Doc.
export const LARK_CARD_ANSWER_MAX = 5000;
const COMPACT_ANSWER_MAX = LARK_CARD_ANSWER_MAX;
const PROCESS_PANEL_MAX = 3000;

// The dual answer-element budget, mirroring the rule finalize's answerFitsCard
// check documents: an answer element is capped in chars (LARK_CARD_ANSWER_MAX)
// AND bytes (ELEMENT_CONTENT_MAX_BYTES). Every rolling/spill decision must test
// BOTH axes — keying on chars alone would let byte-dense content hit the byte
// cap first and freeze the preview until the char cap caught up.
export function exceedsCardAnswerBudget(cleaned: string): boolean {
  return cleaned.length > LARK_CARD_ANSWER_MAX
    || Buffer.byteLength(cleaned, "utf8") > ELEMENT_CONTENT_MAX_BYTES;
}

function streamTextElementId(index: number): string {
  return `md_${index}`;
}

// Rolling-tail live preview: once a streamed text group outgrows the answer
// budget, its element stops being a frozen prefix (which made hours-long turns
// look stuck) and instead always shows the MOST RECENT slice of the narration,
// prefixed with an omission notice. Only the FINAL answer is re-delivered in
// full at finalize (continuation cards / a Doc); a mid-turn narration group
// ends up truncated in the finished card's process panel — so the notice only
// says the earlier chars are omitted, never promising full delivery later.
const LARK_STREAM_TAIL_TARGET = 4000;

export function rollingTailContent(cleaned: string, locale: Locale = "zh"): string {
  let start = Math.max(0, cleaned.length - LARK_STREAM_TAIL_TARGET);
  // Prefer starting at a line boundary so the tail doesn't open mid-word, as
  // long as that doesn't eat most of the window.
  const newline = cleaned.indexOf("\n", start);
  if (newline >= 0 && newline < cleaned.length - 200) {
    start = newline + 1;
  }
  let tail = cleaned.slice(start);
  // Fence parity: if the cut fell inside a ``` block (odd fence count in the
  // dropped prefix), reopen it so the tail renders as code; if the tail itself
  // ends with an open fence (writer mid-code), close it for this tick.
  const prefixFences = (cleaned.slice(0, start).match(/```/g) ?? []).length;
  if (prefixFences % 2 === 1) {
    tail = "```\n" + tail;
  }
  if (((tail.match(/```/g) ?? []).length) % 2 === 1) {
    tail = tail + "\n```";
  }
  const notice = locale === "en"
    ? `_… live preview shows the latest output only (${start} earlier chars omitted) …_`
    : `_…实时预览仅显示最新输出（前 ${start} 字已省略）…_`;
  return truncateBytes(truncate(`${notice}\n\n${tail}`, LARK_CARD_ANSWER_MAX), ELEMENT_CONTENT_MAX_BYTES);
}

/**
 * The run card's live streaming text element: the LAST block group while the
 * turn is running, only when that group is text (a trailing tool group means
 * new deltas will open a NEW text element, so there is nothing live to stream
 * into). Content goes through the exact same truncation as markdownElement so
 * an element-level update and a full-card patch always agree byte-for-byte.
 */
export function liveRunCardStreamElement(
  state: LarkRunState,
  locale: Locale = "zh",
): { elementId: string; content: string; rolling: boolean } | null {
  if (state.status !== "running") {
    return null;
  }
  const groups = [...groupBlocks(state.blocks)];
  const last = groups[groups.length - 1];
  if (!last || last.kind !== "text") {
    return null;
  }
  let textIndex = -1;
  for (const group of groups) {
    if (group.kind === "text" && cleanCardText(group.content)) {
      textIndex += 1;
    }
  }
  const cleaned = cleanCardText(last.content);
  if (!cleaned || textIndex < 0) {
    return null;
  }
  // Rolling keys on the dual budget (chars AND bytes) — the char cap alone
  // would let byte-dense content hit ELEMENT_CONTENT_MAX_BYTES first, and the
  // monotonic guard would then freeze the byte-truncated preview until the
  // char count also crossed the cap.
  const rolling = exceedsCardAnswerBudget(cleaned);
  return {
    elementId: streamTextElementId(textIndex),
    content: rolling
      ? rollingTailContent(cleaned, locale)
      : truncateBytes(cleaned, ELEMENT_CONTENT_MAX_BYTES),
    rolling,
  };
}

/**
 * Trim streaming text to the last "safe" markdown boundary so a half-open
 * code fence or a mid-sentence fragment is never rendered by the typewriter:
 * cut inside an unclosed ``` fence back to before the fence, then cut at the
 * last newline / sentence-ending punctuation. When no boundary exists yet,
 * flush anyway once enough text has accumulated (long unpunctuated runs must
 * not stall the stream forever).
 */
export function trimToStreamSafeBoundary(text: string, forceFlushChars = 48): string {
  let candidate = text;
  const fenceCount = (candidate.match(/```/g) ?? []).length;
  const fenceOpen = fenceCount % 2 === 1;
  if (fenceOpen) {
    candidate = candidate.slice(0, candidate.lastIndexOf("```"));
  }
  let boundary = -1;
  for (let i = candidate.length - 1; i >= 0; i -= 1) {
    if ("\n。！？；…!?.;".includes(candidate[i])) {
      boundary = i;
      break;
    }
  }
  if (boundary >= 0) {
    return candidate.slice(0, boundary + 1);
  }
  // No boundary at all: force-flush long runs, but never while a fence is open
  // (flushing would expose the raw half-open fence).
  if (!fenceOpen && candidate.length >= forceFlushChars) {
    return candidate;
  }
  return "";
}

const LOW_INFORMATION_TERMINAL_TEXTS = new Set([
  "在跑了",
  "已经在跑了",
  "正在跑",
  "还在跑",
  "任务在跑了",
  "任务正在跑",
  "处理中",
  "正在处理",
  "还在处理",
  "我在处理",
  "我正在处理",
  "正在执行",
  "执行中",
  "运行中",
  "running",
  "still running",
  "it is running",
  "it's running",
  "in progress",
  "working on it",
]);
const SUBSTANTIVE_FINAL_FALLBACK_MIN_CHARS = 24;

function normalizedTerminalText(text: string): string {
  return cleanCardText(text)
    .trim()
    .toLowerCase()
    .replace(/[\s。.!！?？…]+$/gu, "")
    .replace(/\s+/gu, " ");
}

function isLowInformationTerminalText(text: string): boolean {
  return LOW_INFORMATION_TERMINAL_TEXTS.has(normalizedTerminalText(text));
}

/**
 * A terminal reply that carries a delivery directive is never low-information,
 * whatever its prose says. normalizedTerminalText strips send tags before the
 * set lookup, so "在跑了。[send-image:…]" classified as a placeholder and the
 * promotion replaced the WHOLE result — the tag included — so the file was
 * never delivered and no ledger row existed to redeliver it.
 */
function carriesDeliveryDirective(text: string): boolean {
  if (/\[send-(?:file|image):/u.test(text) || /```file:[^\n`]+\n/u.test(text)) {
    return true;
  }

  return extractTelegramToolTagMatches(text).some((match) => {
    try {
      return isLarkSendToolName(parseTelegramToolTagPayload(match.payload).name);
    } catch {
      return false;
    }
  });
}

function lastSubstantiveAssistantText(state: LarkRunState): string {
  const firstEligibleBlock = state.finalAnswerBlockStart ?? 0;
  for (let index = state.blocks.length - 1; index >= firstEligibleBlock; index -= 1) {
    const block = state.blocks[index];
    if (block?.kind !== "text") {
      continue;
    }
    const cleaned = cleanCardText(block.content).trim();
    if (
      Array.from(cleaned).length >= SUBSTANTIVE_FINAL_FALLBACK_MIN_CHARS
      && !isLowInformationTerminalText(cleaned)
    ) {
      return block.content;
    }
  }
  return "";
}

/**
 * The canonical final answer. A few engines occasionally finish with a bare
 * lifecycle placeholder after already streaming the useful answer; prefer that
 * earlier user-visible assistant text, but never reasoning or tool output.
 */
function finalAnswerText(state: LarkRunState): string {
  if (state.resultText.trim()) {
    if (isLowInformationTerminalText(state.resultText) && !carriesDeliveryDirective(state.resultText)) {
      const fallback = lastSubstantiveAssistantText(state);
      if (fallback) {
        return fallback;
      }
    }
    return state.resultText;
  }
  const lastText = [...state.blocks].reverse().find(
    (block): block is Extract<LarkRunBlock, { kind: "text" }> => block.kind === "text" && block.content.trim().length > 0,
  );
  return lastText?.content ?? "";
}

/** Resolve a terminal result against assistant text emitted in the current attempt. */
export function resolveLarkFinalAnswerText(
  state: LarkRunState,
  resultText: string,
  blockStartIndex = 0,
): string {
  return finalAnswerText({
    ...state,
    resultText,
    finalAnswerBlockStart: blockStartIndex,
  });
}

/**
 * A standalone notification card for an out-of-band background-task completion —
 * a `task_notification` that arrives AFTER its originating turn's run card has
 * already finalized, so there is no live card to render into. Header + cleaned
 * markdown body in one card, matching the bot's card-based UX instead of a bare
 * plain-text message. Returns null when the body is empty or too large for a
 * single card element, so the caller keeps the chunked plain-text path and a
 * long notification is never truncated.
 */
// A fenced ```file:name\n…``` block is a "deliver this as a file" directive,
// not card prose: cleanCardText doesn't strip it (it would render as a raw code
// block), and the plain-text path delivers it correctly. Cards decline such
// bodies so the block can't be both attached AND echoed in a card.
export function hasLarkFileBlockDirective(text: string): boolean {
  return /```file:[^\n`]+\n[\s\S]*?```/.test(text);
}

export function renderLarkNotificationCard(headerText: string, bodyText: string): Record<string, unknown> | null {
  if (hasLarkFileBlockDirective(bodyText)) {
    return null;
  }
  const cleaned = cleanCardText(bodyText);
  if (!cleaned) {
    return null;
  }
  if (exceedsCardAnswerBudget(cleaned)) {
    return null;
  }
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: headerText } },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        markdownElement(`**${headerText}**`),
        markdownElement(cleaned),
      ],
    },
  };
}

/**
 * A single collapsed panel summarizing a finished turn's process — thinking,
 * intermediate narration, and tool calls in order. The final answer is shown
 * above the panel, so the matching text block is skipped here (no duplication);
 * any earlier narration is preserved (foldable) rather than dropped.
 */
function condensedProcessPanel(
  state: LarkRunState,
  labels: ReturnType<typeof runCardLabels>,
): Record<string, unknown> | undefined {
  const answer = cleanCardText(finalAnswerText(state)).trim();
  const parts: string[] = [];
  if (state.reasoning.content.trim()) {
    parts.push(`🧠 ${truncate(state.reasoning.content.trim(), 600)}`);
  }
  let toolCount = 0;
  const finalTextBlockIndex = findFinalAnswerBlockIndex(state.blocks, answer);
  for (const [blockIndex, block] of state.blocks.entries()) {
    if (block.kind === "tool") {
      // TodoWrite shows as the dedicated plan panel, not in the process list.
      if (block.tool.toolName === "TodoWrite") {
        continue;
      }
      toolCount += 1;
      parts.push(`- ${toolHeaderText(block.tool)}`);
      continue;
    }
    const text = cleanCardText(block.content).trim();
    if (!text) {
      continue;
    }
    // The streamed block can be only a prefix of resultText when the terminal
    // result arrives after the last card patch. Strip that overlap from the
    // final text block while preserving narration that preceded it.
    if (blockIndex === finalTextBlockIndex) {
      const processText = stripFinalAnswerOverlap(text, answer);
      if (processText) {
        parts.push(truncate(processText, 400));
      }
      continue;
    }
    parts.push(truncate(text, 400));
  }
  if (parts.length === 0) {
    return undefined;
  }
  const title = toolCount > 0 ? `${labels.process} · ${labels.processSteps(toolCount)}` : labels.process;
  return collapsiblePanel({
    title,
    expanded: false,
    color: "grey",
    body: truncate(parts.join("\n\n"), PROCESS_PANEL_MAX),
  });
}

function findFinalAnswerBlockIndex(blocks: LarkRunBlock[], answer: string): number {
  if (!answer) {
    return -1;
  }
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block?.kind !== "text") {
      continue;
    }
    const text = cleanCardText(block.content).trim();
    if (text && finalAnswerOverlapLength(text, answer) > 0) {
      return index;
    }
  }
  return -1;
}

function stripFinalAnswerOverlap(text: string, answer: string): string {
  const overlap = finalAnswerOverlapLength(text, answer);
  return overlap > 0 ? text.slice(0, text.length - overlap).trim() : text;
}

function finalAnswerOverlapLength(text: string, answer: string): number {
  if (!text || !answer) {
    return 0;
  }
  if (answer.startsWith(text)) {
    return text.length;
  }
  const maxOverlap = Math.min(text.length, answer.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (text.endsWith(answer.slice(0, length))) {
      // Short incidental word matches are common in narration. Exact answers
      // are safe at any length; partial overlaps need enough signal.
      if (length === answer.length || length >= Math.min(24, answer.length)) {
        return length;
      }
    }
  }
  return 0;
}

/**
 * A minimal terminal card: status + final answer (+ terminal marker), with no
 * tool/reasoning history. The full run card can grow past Feishu's card-patch
 * size limit on long, tool-heavy turns, which makes every updateCard fail and
 * leaves the card frozen in its "running" state. This compact variant stays
 * small enough to always patch, so finalization (done/error/interrupted) is
 * guaranteed to land and the card never stays spinning.
 */
export function renderLarkRunCardCompact(state: LarkRunState, locale: Locale = "zh"): Record<string, unknown> {
  const labels = runCardLabels(locale);
  const elements: unknown[] = [
    markdownElement(`**${runCardStatusLabel(state.status, labels)}**`),
  ];

  // Goal banner: when this run is an autonomous /goal pursuit, show the
  // objective up top so the card reads as "goal mode" (parity with Codex /goal),
  // not just a normal reply. Persists across running → done/interrupted.
  if (state.goalObjective && state.goalObjective.trim()) {
    elements.push(markdownElement(
      locale === "en"
        ? `🎯 **Goal:** ${truncate(state.goalObjective.trim(), 120)}`
        : `🎯 **目标:** ${truncate(state.goalObjective.trim(), 120)}`,
    ));
  }
  const answer = cleanCardText(finalAnswerText(state));
  if (answer) {
    // Degrade commonly hits MID-RUN on exactly the long, tool-heavy turns the
    // rolling tail shipped for (their full card breaches Feishu's 30KB
    // whole-card limit) — so a running compact card keeps the rolling-tail
    // preview past the answer budget instead of re-freezing on a truncated
    // prefix. Terminal compact cards keep the plain truncated answer.
    elements.push(markdownElement(
      state.status === "running" && exceedsCardAnswerBudget(answer)
        ? rollingTailContent(answer, locale)
        : truncate(answer, COMPACT_ANSWER_MAX),
    ));
  }

  if (state.status === "interrupted") {
    elements.push(noteElement(`_⏹ ${labels.interrupted}_`));
  } else if (state.status === "idle_timeout") {
    elements.push(noteElement(`_⏱ ${labels.idleTimeout(state.idleTimeoutMinutes ?? 0)}_`));
  } else if (
    (state.status === "error" || state.status === "partial" || state.status === "delivery_error")
    && state.errorText.trim()
  ) {
    const prefix = state.status === "partial" ? `${labels.partialWarning}\n\n` : "";
    elements.push(markdownElement(`⚠️ ${truncate(prefix + state.errorText.trim(), 600)}`));
  } else if (state.status === "done" && !answer) {
    elements.push(markdownElement(`_${labels.empty}_`));
  }

  if (state.status === "running") {
    // Same Stop element the full card carries: degrading a long turn must not
    // take away the operator's only in-card way to stop it.
    elements.push({ tag: "hr" });
    elements.push(stopButtonElement(state, labels));
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      summary: { content: cardSummary(state, locale) },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

/**
 * The smallest possible terminal card: just the status (+ a note that the full
 * reply was sent as a separate message). It carries no answer/tool body, so it
 * is guaranteed to fit Feishu's element limit. finalize uses it as the last card
 * resort so the card can ALWAYS leave the "running" state, even when the full
 * and compact renders are both rejected (ErrCode 11310, element too large).
 */
export function renderLarkRunCardMinimal(state: LarkRunState, locale: Locale = "zh"): Record<string, unknown> {
  const labels = runCardLabels(locale);
  const elements: unknown[] = [markdownElement(`**${runCardStatusLabel(state.status, labels)}**`)];
  if (state.status === "interrupted") {
    elements.push(noteElement(`_⏹ ${labels.interrupted}_`));
  } else if (state.status === "idle_timeout") {
    elements.push(noteElement(`_⏱ ${labels.idleTimeout(state.idleTimeoutMinutes ?? 0)}_`));
  } else if (
    (state.status === "error" || state.status === "partial" || state.status === "delivery_error")
    && state.errorText.trim()
  ) {
    const prefix = state.status === "partial" ? `${labels.partialWarning}\n\n` : "";
    elements.push(markdownElement(`⚠️ ${truncate(prefix + state.errorText.trim(), 400)}`));
  } else if (state.status === "delivering") {
    elements.push(noteElement(locale === "en" ? "_Full reply is being delivered below._" : "_完整回复正在下方交付。_"));
  } else {
    elements.push(noteElement(locale === "en" ? "_Full reply sent as a message below._" : "_完整回复见下方消息。_"));
  }
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      summary: { content: cardSummary(state, locale) },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

/**
 * A standalone card for a fired `notify` cron reminder. Deliberately simple
 * (heading + body) — a reminder is a one-shot push, not a run. The card's
 * `summary` carries the reminder text so the phone notification preview stays
 * meaningful: Feishu shows the summary, not the card body, in the push. Each
 * fire sends its own card (separate, never batched), so notifications are
 * preserved exactly as with the plain-text path.
 */
export function renderLarkReminderCard(body: string, locale: Locale = "zh"): Record<string, unknown> {
  const heading = locale === "en" ? "⏰ Reminder" : "⏰ 提醒";
  const text = body.trim() || (locale === "en" ? "(reminder)" : "（提醒）");
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      summary: { content: truncate(`⏰ ${text}`, 100) },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        markdownElement(`**${heading}**`),
        markdownElement(truncate(text, LARK_CARD_ANSWER_MAX)),
      ],
    },
  };
}

type ToolGroup = { kind: "tools"; tools: LarkToolEntry[] };
type TextGroup = { kind: "text"; content: string };

function* groupBlocks(blocks: LarkRunBlock[]): Generator<ToolGroup | TextGroup> {
  let toolBuf: LarkToolEntry[] = [];
  for (const block of blocks) {
    if (block.kind === "tool") {
      // TodoWrite is surfaced as the dedicated plan panel, not the tool list.
      if (block.tool.toolName === "TodoWrite") {
        continue;
      }
      toolBuf.push(block.tool);
      continue;
    }
    if (toolBuf.length > 0) {
      yield { kind: "tools", tools: toolBuf };
      toolBuf = [];
    }
    yield { kind: "text", content: block.content };
  }
  if (toolBuf.length > 0) {
    yield { kind: "tools", tools: toolBuf };
  }
}

function renderToolGroup(
  tools: LarkToolEntry[],
  finalized: boolean,
  labels: ReturnType<typeof runCardLabels>,
): Record<string, unknown>[] {
  if (tools.length === 0) {
    return [];
  }
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((tool) => toolPanel(tool, !finalized && tool.status === "running", labels));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, labels)];
  }
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1]!;
  const out: Record<string, unknown>[] = [];
  if (prior.length > 0) {
    out.push(collapsedToolSummary(prior, labels));
  }
  out.push(toolPanel(latest, latest.status === "running", labels));
  return out;
}

function toolPanel(
  tool: LarkToolEntry,
  expanded: boolean,
  labels: ReturnType<typeof runCardLabels>,
): Record<string, unknown> {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    color: tool.status === "error" ? "red" : "blue",
    body: toolBodyMd(tool, labels) || `_${labels.noOutput}_`,
  });
}

function collapsedToolSummary(
  tools: LarkToolEntry[],
  labels: ReturnType<typeof runCardLabels>,
): Record<string, unknown> {
  const lines = tools.map((tool) => `- ${toolHeaderText(tool)}`).join("\n");
  return collapsiblePanel({
    title: `${labels.tools} (${tools.length})`,
    expanded: false,
    color: "blue",
    body: lines,
  });
}

function toolHeaderText(tool: LarkToolEntry): string {
  const icon = tool.status === "done" ? "✅" : tool.status === "error" ? "❌" : "⏳";
  const display = formatToolName(tool.toolName);
  const summary = summarizeToolInput(tool.toolName, tool.toolInput);
  return summary ? `${icon} **${display}** — ${summary}` : `${icon} **${display}**`;
}

/** MCP tools arrive as `mcp__server__tool`; show them as a readable "🔌 server · tool". */
function formatToolName(name: string): string {
  if (!name.startsWith("mcp__")) {
    return name;
  }
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep > 0) {
    const server = rest.slice(0, sep).replace(/_/g, " ");
    const tool = rest.slice(sep + 2);
    return `🔌 ${server} · ${tool}`;
  }
  return `🔌 ${rest.replace(/__/g, " · ")}`;
}

function toolBodyMd(tool: LarkToolEntry, labels: ReturnType<typeof runCardLabels>): string {
  // TodoWrite is Claude's plan/checklist — render it as ☐/✅ items, not a raw
  // JSON dump or a useless "todos updated" output.
  if (tool.toolName === "TodoWrite") {
    return renderTodoList(tool.toolInput) || `_${labels.noOutput}_`;
  }
  const parts: string[] = [];
  const inputMd = renderToolInput(tool);
  if (inputMd) {
    parts.push(inputMd);
  }
  if (tool.output && tool.output.trim()) {
    const out = truncate(tool.output, TOOL_OUTPUT_MAX);
    // Annotate the output with its line count (computed from the full output,
    // so it stays accurate even when the shown block is truncated).
    const lineCount = tool.output.replace(/\n+$/, "").split("\n").length;
    const meta = lineCount > 1 ? ` · ${labels.outputLines(lineCount)}` : "";
    parts.push(tool.status === "error"
      ? `**Error**${meta}\n\`\`\`\n${out}\n\`\`\``
      : `**Output**${meta}\n\`\`\`\n${out}\n\`\`\``);
  } else if (tool.status === "running") {
    parts.push(`_${labels.toolRunning}_`);
  }
  const body = parts.join("\n\n");
  if (body.length <= TOOL_BODY_TOTAL_MAX) {
    return body;
  }
  return `${body.slice(0, TOOL_BODY_TOTAL_MAX)}…`;
}

/** The dedicated plan panel showing the latest TodoWrite/Codex plan (always visible). */
function todoPlanPanel(
  state: LarkRunState,
  labels: ReturnType<typeof runCardLabels>,
  expanded: boolean,
): Record<string, unknown> | undefined {
  if (state.plan === undefined) {
    return undefined;
  }
  const list = renderTodoList(state.plan);
  if (!list) {
    return undefined;
  }
  const todos = state.plan && typeof state.plan === "object" && Array.isArray((state.plan as Record<string, unknown>).todos)
    ? (state.plan as Record<string, unknown>).todos as unknown[]
    : [];
  const done = todos.filter((todo) => todo && typeof todo === "object" && (todo as Record<string, unknown>).status === "completed").length;
  return collapsiblePanel({
    title: `${labels.plan} · ${done}/${todos.length}`,
    expanded,
    color: "grey",
    body: list,
  });
}

/** Render a TodoWrite todo list as a checklist (read-only display of Claude's plan). */
function renderTodoList(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }
  const raw = (input as Record<string, unknown>).todos;
  const todos = Array.isArray(raw) ? raw : [];
  const lines = todos
    .map((entry) => {
      const todo = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      const status = typeof todo.status === "string" ? todo.status : "pending";
      const content = typeof todo.content === "string" ? todo.content.trim() : "";
      const active = typeof todo.activeForm === "string" ? todo.activeForm.trim() : "";
      if (!content && !active) {
        return "";
      }
      if (status === "completed") {
        return `✅ ${content || active}`;
      }
      if (status === "in_progress") {
        return `🔄 **${active || content}**`;
      }
      return `⬜ ${content || active}`;
    })
    .filter((line) => line.length > 0);
  return lines.join("\n");
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }
  const rec = input as Record<string, unknown>;
  const pick = (key: string, max = TOOL_HEADER_SUMMARY_MAX): string => {
    const value = rec[key];
    if (typeof value !== "string") {
      return "";
    }
    const oneLine = value.replace(/\s+/g, " ").trim();
    return truncate(oneLine, max);
  };
  switch (name) {
    case "Bash":
      return pick("command");
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return shortenPath(pick("file_path"));
    case "Grep": {
      const pattern = pick("pattern", 40);
      const path = pick("path", 30);
      return path ? `${pattern} in ${shortenPath(path)}` : pattern;
    }
    case "Glob":
      return pick("pattern");
    case "WebFetch":
      return pick("url");
    case "WebSearch":
      return pick("query", 60);
    case "Agent":
    case "Task":
      return pick("description") || pick("subagent_type");
    case "TodoWrite": {
      const todos = Array.isArray(rec.todos) ? rec.todos as unknown[] : [];
      const done = todos.filter((todo) => todo && typeof todo === "object" && (todo as Record<string, unknown>).status === "completed").length;
      return todos.length > 0 ? `${done}/${todos.length}` : "";
    }
    default:
      return pick("command") || pick("file_path") || pick("path") || pick("query");
  }
}

function renderToolInput(tool: LarkToolEntry): string {
  const input = tool.toolInput;
  if (!input || typeof input !== "object") {
    return "";
  }
  const rec = input as Record<string, unknown>;
  const str = (key: string): string => (typeof rec[key] === "string" ? (rec[key] as string) : "");
  switch (tool.toolName) {
    case "Bash": {
      const cmd = str("command");
      return cmd ? `**Command**\n\`\`\`bash\n${truncate(cmd, TOOL_INPUT_FIELD_MAX)}\n\`\`\`` : "";
    }
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const fp = str("file_path");
      return fp ? `**File** \`${shortenPath(fp)}\`` : "";
    }
    case "Grep": {
      const lines: string[] = [];
      if (str("pattern")) lines.push(`**Pattern** \`${str("pattern")}\``);
      if (str("path")) lines.push(`**Path** \`${shortenPath(str("path"))}\``);
      return lines.join("\n");
    }
    case "WebFetch":
      return str("url") ? `**URL** ${str("url")}` : "";
    case "WebSearch":
      return str("query") ? `**Query** \`${truncate(str("query"), TOOL_INPUT_FIELD_MAX)}\`` : "";
    default:
      return "";
  }
}

export function cleanCardText(content: string): string {
  const stripped = stripCronAddTags(stripTelegramToolTags(stripDeliveryTags(content)));
  const compatible = normalizeLarkMarkdownCompatibility(stripped);
  return collapseBlankLines(neutralizeMarkdownSetextHeadings(downgradeMarkdownHeadings(compatible))).trim();
}

const LARK_INLINE_MATH_SYMBOLS: Readonly<Record<string, string>> = {
  rightarrow: "→",
  Rightarrow: "⇒",
  leftarrow: "←",
  Leftarrow: "⇐",
  leftrightarrow: "↔",
  Leftrightarrow: "⇔",
  to: "→",
};

function normalizeLarkMarkdownCompatibility(text: string): string {
  const lines = text.split("\n");
  let fence: { marker: "`" | "~"; length: number } | undefined;

  return lines.map((line) => {
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (
        fenceMatch
        && fenceMatch[1][0] === fence.marker
        && fenceMatch[1].length >= fence.length
        && line.slice(fenceMatch[0].length).trim() === ""
      ) {
        fence = undefined;
      }
      return line;
    }
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1][0] as "`" | "~",
        length: fenceMatch[1].length,
      };
      return line;
    }
    return normalizeOutsideInlineCode(line);
  }).join("\n");
}

function normalizeOutsideInlineCode(line: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf("`", cursor);
    if (open === -1) {
      return output + normalizeLarkMarkdownProse(line.slice(cursor));
    }
    output += normalizeLarkMarkdownProse(line.slice(cursor, open));
    let markerLength = 1;
    while (line[open + markerLength] === "`") {
      markerLength += 1;
    }
    const marker = "`".repeat(markerLength);
    let close = line.indexOf(marker, open + markerLength);
    while (close !== -1 && line[close + markerLength] === "`") {
      close = line.indexOf(marker, close + markerLength + 1);
    }
    if (close === -1) {
      return output + line.slice(open);
    }
    output += line.slice(open, close + markerLength);
    cursor = close + markerLength;
  }
  return output;
}

function normalizeLarkMarkdownProse(text: string): string {
  return text
    .replace(
      /\$\s*\\(rightarrow|Rightarrow|leftarrow|Leftarrow|leftrightarrow|Leftrightarrow|to)\s*\$/g,
      (_match, command: string) => LARK_INLINE_MATH_SYMBOLS[command] ?? _match,
    )
    // CommonMark cannot open emphasis when ** is followed by punctuation and
    // preceded by ordinary text. Put the emphasis inside the quote instead.
    .replace(/\*\*“([^*\n]+)”\*\*/g, "“**$1**”")
    .replace(/\*\*‘([^*\n]+)’\*\*/g, "‘**$1**’")
    .replace(/\*\*\"([^*\n\"]+)\"\*\*/g, "\"**$1**\"");
}

function neutralizeMarkdownSetextHeadings(text: string): string {
  const lines = text.split("\n");
  let fence: { marker: "`" | "~"; length: number } | undefined;

  return lines.map((line) => {
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (
        fenceMatch
        && fenceMatch[1][0] === fence.marker
        && fenceMatch[1].length >= fence.length
        && line.slice(fenceMatch[0].length).trim() === ""
      ) {
        fence = undefined;
      }
      return line;
    }
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1][0] as "`" | "~",
        length: fenceMatch[1].length,
      };
      return line;
    }

    // A line of '=' characters turns the preceding line into a Setext H1 in
    // Feishu. Escape the first marker while preserving divider-like output.
    return line.replace(/^([ \t]{0,3}(?:>[ \t]?)*)(={3,})[ \t]*$/, "$1\\$2");
  }).join("\n");
}

/**
 * Feishu renders markdown ATX headings (`#`–`######`) at large heading sizes,
 * which looks oversized and noisy inside a chat card — especially for answers
 * with many `##` sections. Downgrade headings to bold so they keep their
 * structure at normal body size.
 *
 * Headings can sit behind a blockquote marker (`> ## Title`), which Feishu
 * renders as a grey callout box AROUND the oversized heading — the exact
 * "font suddenly large + grey + clashes with body" report. Match an optional
 * blockquote prefix and preserve it, downgrading only the heading inside.
 */
function downgradeMarkdownHeadings(text: string): string {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  return text.split("\n").map((line) => {
    if (fence) {
      const closeMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*\r?$/);
      if (closeMatch) {
        const run = closeMatch[1]!;
        const marker = run[0] as "`" | "~";
        if (fence.marker === marker && run.length >= fence.length) {
          fence = undefined;
        }
      }
      return line;
    }
    const openMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (openMatch) {
      const run = openMatch[1]!;
      const marker = run[0] as "`" | "~";
      fence = { marker, length: run.length };
      return line;
    }
    return line.replace(/^[ \t]{0,3}((?:>[ \t]?)*)#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/, (_match, quote: string, title: string) => {
      const trimmed = title.trim();
      // Don't wrap in ** when the title already contains a ** span (fully bold,
      // or an inner bold like `…的**逐笔成交明细**`) — an outer ** would create
      // unbalanced/nested markers. Drop the heading marker and keep the text.
      return trimmed.includes("**") ? `${quote}${trimmed}` : `${quote}**${trimmed}**`;
    });
  }).join("\n");
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

function runCardStatusLabel(
  status: LarkRunState["status"],
  labels: ReturnType<typeof runCardLabels>,
): string {
  if (status === "running") return labels.running;
  if (status === "delivering") return labels.delivering;
  if (status === "partial") return labels.partial;
  if (status === "error") return labels.error;
  if (status === "delivery_error") return labels.deliveryError;
  if (status === "interrupted") return labels.interruptedTitle;
  if (status === "idle_timeout") return labels.idleTimeoutTitle;
  return labels.done;
}

function footerStatusText(
  footer: NonNullable<LarkRunState["footer"]>,
  labels: ReturnType<typeof runCardLabels>,
): string {
  if (footer === "thinking") return labels.footerThinking;
  if (footer === "tool_running") return labels.footerTool;
  return labels.footerStreaming;
}

/**
 * The 停止 button every running card carries — shared by the full and compact
 * renders so degrading mid-run never takes away the operator's stop control.
 */
function stopButtonElement(
  state: LarkRunState,
  labels: ReturnType<typeof runCardLabels>,
): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: labels.stop },
    type: "danger",
    behaviors: [callbackBehavior({
      cctb_lark: "stop",
      conversationKey: state.conversationKey,
      ...(state.bridgeChatType ? { bridgeChatType: state.bridgeChatType } : {}),
    })],
  };
}

function runCardLabels(locale: Locale): {
  running: string;
  delivering: string;
  done: string;
  partial: string;
  partialWarning: string;
  error: string;
  deliveryError: string;
  stop: string;
  thinkingActive: string;
  thinkingDone: string;
  tools: string;
  process: string;
  processSteps: (n: number) => string;
  outputLines: (n: number) => string;
  plan: string;
  noOutput: string;
  toolRunning: string;
  empty: string;
  interrupted: string;
  interruptedTitle: string;
  idleTimeoutTitle: string;
  idleTimeout: (mins: number) => string;
  footerThinking: string;
  footerTool: string;
  footerStreaming: string;
} {
  return locale === "en"
    ? {
      running: "Task is running...",
      delivering: "Delivering result...",
      done: "Done",
      partial: "Partially completed",
      partialWarning: "The engine failed after producing output; the content above may be incomplete.",
      error: "Failed",
      deliveryError: "Delivery incomplete",
      stop: "Stop",
      thinkingActive: "🧠 Thinking",
      thinkingDone: "🧠 Thinking complete · tap to view",
      tools: "Tool calls",
      process: "Process",
      processSteps: (n) => `${n} step${n === 1 ? "" : "s"}`,
      outputLines: (n) => `${n} line${n === 1 ? "" : "s"}`,
      plan: "📋 Plan",
      noOutput: "no output",
      toolRunning: "running…",
      empty: "(no content returned)",
      interrupted: "Interrupted",
      interruptedTitle: "Interrupted",
      idleTimeoutTitle: "Auto-stopped (no response)",
      idleTimeout: (mins) => `No response for ${mins} minute(s); auto-stopped`,
      footerThinking: "🧠 Thinking",
      footerTool: "🧰 Running tool",
      footerStreaming: "✍️ Streaming output",
    }
    : {
      running: "任务处理中...",
      delivering: "正在交付结果...",
      done: "已完成",
      partial: "部分完成",
      partialWarning: "引擎在输出内容后失败，以上内容可能不完整。",
      error: "执行失败",
      deliveryError: "交付未完成",
      stop: "停止",
      thinkingActive: "🧠 思考中",
      thinkingDone: "🧠 思考完成 · 点击查看",
      tools: "工具调用",
      process: "过程",
      processSteps: (n) => `${n} 步`,
      outputLines: (n) => `${n} 行`,
      plan: "📋 计划",
      noOutput: "无输出",
      toolRunning: "运行中…",
      empty: "（未返回内容）",
      interrupted: "已被中断",
      interruptedTitle: "已中断",
      idleTimeoutTitle: "无响应已自动终止",
      idleTimeout: (mins) => `${mins} 分钟无响应，已自动终止`,
      footerThinking: "🧠 正在思考",
      footerTool: "🧰 正在调用工具",
      footerStreaming: "✍️ 正在输出",
    };
}

export function renderLarkApprovalCard(input: LarkApprovalCardInput): Record<string, unknown> {
  const toolInput = input.toolInput === undefined ? "" : `\n${formatJson(input.toolInput)}`;
  const labels = approvalCardLabels(input.locale ?? "zh");

  const elements: unknown[] = [
    markdownElement(`**${labels.header}**\n${input.toolName}${toolInput}`),
  ];
  if (input.decidedStatus) {
    // Resolved in place after the operator decided: show the outcome, drop the buttons.
    elements.push(markdownElement(input.decidedStatus));
  } else {
    elements.push({
      tag: "column_set",
      columns: [
        approvalButtonColumn(input.requestId, "allow_once", labels.allowOnce, "primary", input.replyInThread),
        approvalButtonColumn(input.requestId, "allow_session", labels.allowSession, "default", input.replyInThread),
        approvalButtonColumn(input.requestId, "deny", labels.deny, "danger", input.replyInThread),
      ],
    });
  }

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: input.decidedStatus
          ? `${input.decidedStatus} — ${input.toolName}`
          : labels.summary(input.toolName),
      },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

export function renderLarkQueueWaitCard(input: LarkQueueWaitCardInput): Record<string, unknown> {
  const locale = input.locale ?? "zh";
  const seconds = Math.max(1, Math.round(input.waitedMs / 1000));
  const title = locale === "en" ? "Queued behind the active turn" : "正在排队等待当前任务";
  const body = locale === "en"
    ? `This conversation already has a running task. This message has waited about ${seconds}s and will continue automatically.\n\nDon't need it anymore? Cancel just this queued task below. To stop the task that's *running*, send \`/stop\`.`
    : `同一个会话里还有任务在运行。这条消息已等待约 ${seconds} 秒，前一个任务结束后会自动继续。\n\n不想等了？可点下面取消这条排队任务。要停止*正在运行*的任务，请发送 \`/stop\`。`;
  const stop = locale === "en" ? "Cancel this task" : "取消此排队任务";
  const keepWaiting = locale === "en" ? "Keep waiting" : "继续等待";
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: title,
      },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        markdownElement(`**${title}**\n${body}`),
        {
          tag: "column_set",
          columns: [
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: stop },
                  type: "danger",
                  width: "fill",
                  behaviors: [callbackBehavior({
                    cctb_lark: "stop",
                    conversationKey: input.conversationKey,
                    ...(input.taskId ? { taskId: input.taskId } : {}),
                    ...(input.bridgeChatType ? { bridgeChatType: input.bridgeChatType } : {}),
                    ...(input.replyInThread ? { replyInThread: true } : {}),
                  })],
                },
              ],
            },
            {
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: keepWaiting },
                  type: "default",
                  width: "fill",
                  behaviors: [callbackBehavior({
                    cctb_lark: "noop",
                  })],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** Read-only terminal card shown in place after a queued task is cancelled from
 * its card (no buttons). Used to flip a CardKit-managed queue card to "已取消". */
export function renderLarkQueueCancelledCard(locale: Locale = "zh"): Record<string, unknown> {
  const text = locale === "en" ? "Cancelled this queued task." : "已取消此排队任务。";
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: text } },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [markdownElement(`✅ ${text}`)],
    },
  };
}

function approvalCardLabels(locale: Locale): {
  header: string;
  summary: (toolName: string) => string;
  allowOnce: string;
  allowSession: string;
  deny: string;
} {
  return locale === "en"
    ? {
      header: "Approval requested",
      summary: (toolName) => `Approval requested: ${toolName}`,
      allowOnce: "Allow once",
      allowSession: "Allow for this turn",
      deny: "Deny",
    }
    : {
      header: "请求审批",
      summary: (toolName) => `请求审批：${toolName}`,
      allowOnce: "允许一次",
      allowSession: "本轮允许",
      deny: "拒绝",
    };
}

function markdownElement(content: string, elementId?: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content: truncateBytes(content, ELEMENT_CONTENT_MAX_BYTES),
    ...(elementId ? { element_id: elementId } : {}),
  };
}

function noteElement(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content: truncateBytes(content, ELEMENT_CONTENT_MAX_BYTES),
    text_size: "notation",
  };
}

function collapsiblePanel(input: {
  title: string;
  expanded: boolean;
  color: "grey" | "blue" | "red";
  body: string;
}): Record<string, unknown> {
  return {
    tag: "collapsible_panel",
    expanded: input.expanded,
    header: {
      title: { tag: "markdown", content: input.title.startsWith("**") || input.title.includes("**") ? input.title : `**${input.title}**` },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "follow_text",
      icon_expanded_angle: -180,
    },
    border: { color: input.color, corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: truncateBytes(input.body || "_无内容_", ELEMENT_CONTENT_MAX_BYTES), text_size: "notation" }],
  };
}

function approvalButtonColumn(
  requestId: string,
  decision: "allow_once" | "allow_session" | "deny",
  text: string,
  type: "primary" | "default" | "danger",
  replyInThread: boolean | undefined,
): Record<string, unknown> {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    elements: [
      {
        tag: "button",
        text: {
          tag: "plain_text",
          content: text,
        },
        type,
        behaviors: [callbackBehavior({
          cctb_lark: "approval",
          requestId,
          decision,
          ...(replyInThread ? { replyInThread: true } : {}),
        })],
      },
    ],
  };
}

function callbackBehavior(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "callback",
    value,
  };
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function shortenPath(p: string): string {
  if (!p) {
    return p;
  }
  const home = process.env.HOME || "";
  if (home && p.startsWith(home)) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  if (end > 0 && /[\uD800-\uDBFF]/.test(s[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(s[end] ?? "")) end -= 1;
  return `${s.slice(0, end)}…`;
}

// Feishu rejects any card whose SINGLE element exceeds the per-element size cap
// (ErrCode 11310, "element exceeds the limit") — and it's measured in BYTES, not
// characters (CJK is ~3 bytes/char). Char-length caps aren't enough, and some
// panels (the collapsed tool summary, the todo plan) aggregate unboundedly, so
// e.g. max reasoning effort can overflow one element and fail the whole card.
// Byte-cap every element's content at the factory level as a final safety net.
// Per-element byte ceiling. Feishu raised the single-element limit since the
// 9000→7000 era (2026-06-02): a 15KB single CJK element now renders cleanly
// (verified live 2026-06-26). 16000 lets a full 5000-char CJK answer (≈15KB)
// through without byte-truncation; the other panels are char-capped (process
// 3000, reasoning 1500), so no second element can also reach 16KB — keeping the
// whole card under Feishu's 30KB limit. The handler also uses this to decide an
// answer is too big for the card and must spill out-of-band (Doc/overflow), so a
// long CJK answer (≈3 bytes/char) is never silently lost.
export const ELEMENT_CONTENT_MAX_BYTES = 16000;
export function truncateBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) {
    return s;
  }
  const budget = maxBytes - Buffer.byteLength("…", "utf8");
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  // Never cut inside a surrogate pair: a byte budget can land mid-emoji, and a
  // lone high surrogate makes the string ill-formed (Feishu may reject the
  // whole card element). Backing off one unit always fits (a pair is 4 UTF-8
  // bytes; its high half alone would have encoded to 3).
  let cut = lo;
  const last = s.charCodeAt(cut - 1);
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) {
    cut -= 1;
  }
  return `${s.slice(0, cut)}…`;
}

// --- Long-answer overflow: continuation cards ------------------------------------
//
// A reply too long for one card used to be byte-truncated (lost) or shipped to a
// Feishu Doc. Instead, split it into card-sized chunks: the run card carries chunk 1
// and the rest follow as "continuation" cards (card 2 continues card 1) — more natural
// to read inline than opening a Doc. Only a genuinely document-sized reply (more than
// LARK_MAX_OVERFLOW_CARDS chunks) still falls back to a Doc, where a long stream of
// cards would be worse than one link.
//
// Each chunk must fit a card's answer element on BOTH axes the run card checks:
// LARK_CARD_ANSWER_MAX chars AND ELEMENT_CONTENT_MAX_BYTES bytes. Headroom is left so a
// chunk alongside the card's other small elements never trips the limit.
export const LARK_OVERFLOW_CARD_MAX_CHARS = LARK_CARD_ANSWER_MAX - 80;
export const LARK_OVERFLOW_CARD_MAX_BYTES = ELEMENT_CONTENT_MAX_BYTES - 400;
export const LARK_MAX_OVERFLOW_CARDS = 6;

// Headroom reserved while packing so the seam fence markers ("```\n" prefix /
// "\n```" suffix, ≤ 8 chars = 8 bytes) balanceChunkFenceParity may add can
// never push a balanced chunk past the card budgets.
const CHUNK_FENCE_HEADROOM = 8;

function fitsCardChunk(s: string): boolean {
  return s.length <= LARK_OVERFLOW_CARD_MAX_CHARS - CHUNK_FENCE_HEADROOM
    && Buffer.byteLength(s, "utf8") <= LARK_OVERFLOW_CARD_MAX_BYTES - CHUNK_FENCE_HEADROOM;
}

// Hard-split a single oversized line into budget-sized pieces without cutting a code
// point. Used only when one line alone exceeds the budget (e.g. a long URL list or a
// minified blob) and so can't sit on a line boundary.
function hardSplitCardLine(line: string): string[] {
  const pieces: string[] = [];
  let buf = "";
  for (const ch of line) {
    const next = buf + ch;
    if (!fitsCardChunk(next)) {
      if (buf) {
        pieces.push(buf);
      }
      buf = ch;
    } else {
      buf = next;
    }
  }
  if (buf) {
    pieces.push(buf);
  }
  return pieces;
}

// Split an answer into card-sized chunks, preferring line boundaries so the reflow
// reads naturally. Always returns at least one chunk.
export function splitLarkAnswerIntoCardChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };
  const addLine = (line: string): void => {
    const candidate = current ? `${current}\n${line}` : line;
    if (fitsCardChunk(candidate)) {
      current = candidate;
    } else {
      flush();
      current = line;
    }
  };
  for (const line of text.split("\n")) {
    if (fitsCardChunk(line)) {
      addLine(line);
      continue;
    }
    // One line is itself too big — flush, emit full pieces as their own chunks, and
    // carry the trailing partial piece so following lines can still pack onto it.
    flush();
    const pieces = hardSplitCardLine(line);
    for (let i = 0; i < pieces.length; i++) {
      if (i < pieces.length - 1) {
        chunks.push(pieces[i]!);
      } else {
        current = pieces[i]!;
      }
    }
  }
  flush();
  return chunks.length > 0 ? balanceChunkFenceParity(chunks) : [""];
}

// Fence parity at chunk seams — the same balancing rollingTailContent applies
// to its cut. Splitting on line boundaries alone lets a ``` code block span a
// seam: card N would end with an unclosed fence (everything after renders as
// code) and card N+1 would open mid-block (code renders as prose and gets
// heading-downgraded). Close the block at the end of any chunk that leaves one
// open and reopen it at the top of the next. A single chunk has no seam and is
// returned untouched. Packing reserves CHUNK_FENCE_HEADROOM, so the added
// markers never push a chunk past the card caps.
function balanceChunkFenceParity(chunks: string[]): string[] {
  if (chunks.length <= 1) {
    return chunks;
  }
  let insideFence = false;
  return chunks.map((chunk) => {
    const fenceCount = (chunk.match(/```/g) ?? []).length;
    const openAtEnd = fenceCount % 2 === 1 ? !insideFence : insideFence;
    let balanced = chunk;
    if (insideFence) {
      balanced = `\`\`\`\n${balanced}`;
    }
    if (openAtEnd) {
      balanced = `${balanced}\n\`\`\``;
    }
    insideFence = openAtEnd;
    return balanced;
  });
}

// A terminal card carrying one continuation chunk of a long answer. The heading marks
// its place in the sequence ("接上 · 2/3") so the operator reads card to card.
export function renderLarkContinuationCard(
  body: string,
  index: number,
  total: number,
  locale: Locale = "zh",
): Record<string, unknown> {
  const heading = locale === "en" ? `↪ Continued · ${index}/${total}` : `↪ 接上 · ${index}/${total}`;
  // Same text cleaning the run card applies (strip delivery/tool/cron tags, downgrade
  // markdown headings): without it a chunk starting with "## " would render as a giant
  // Feishu title and any [send-file:]/tool/cron tag would leak as literal text — making
  // continuation cards inconsistent with the run card that carries chunk 1.
  const cleaned = cleanCardText(body);
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      summary: { content: truncate(heading, 100) },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        noteElement(heading),
        markdownElement(cleaned || (locale === "en" ? "(empty)" : "（空）")),
      ],
    },
  };
}

function cardSummary(state: LarkRunState, locale: Locale): string {
  if (state.status === "running") {
    return locale === "en" ? "Task is running" : "任务处理中";
  }
  if (state.status === "delivering") {
    return locale === "en" ? "Delivering result" : "正在交付结果";
  }
  if (state.status === "error") {
    return locale === "en" ? "Failed" : "执行失败";
  }
  if (state.status === "partial") {
    return locale === "en" ? "Partially completed" : "部分完成";
  }
  if (state.status === "delivery_error") {
    return locale === "en" ? "Delivery incomplete" : "交付未完成";
  }
  if (state.status === "interrupted") {
    return locale === "en" ? "Interrupted" : "已中断";
  }
  if (state.status === "idle_timeout") {
    return locale === "en" ? "Auto-stopped" : "无响应已终止";
  }
  const text = cleanCardText(finalAnswerText(state));
  return text.trim().slice(0, 80) || (locale === "en" ? "Done" : "已完成");
}
