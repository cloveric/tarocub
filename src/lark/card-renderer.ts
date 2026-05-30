import type { EngineStreamEvent } from "../codex/adapter.js";
import type { Locale } from "../telegram/message-renderer.js";
import { stripDeliveryTags } from "../telegram/delivery-tags.js";
import { stripCronAddTags } from "../telegram/cron-tags.js";
import { stripTelegramToolTags } from "../telegram/tool-tags.js";

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
  status: "running" | "done" | "error" | "interrupted" | "idle_timeout";
  blocks: LarkRunBlock[];
  reasoning: { content: string; active: boolean };
  /** Latest TodoWrite/Codex plan (the `{ todos: [...] }` input); rendered as the plan panel. */
  plan?: unknown;
  footer: "thinking" | "tool_running" | "streaming" | null;
  taskNotifications: string[];
  resultText: string;
  errorText: string;
  idleTimeoutMinutes?: number;
}

export interface LarkApprovalCardInput {
  requestId: string;
  toolName: string;
  toolInput?: unknown;
  replyInThread?: boolean;
  locale?: Locale;
}

export interface LarkQueueWaitCardInput {
  conversationKey: string;
  bridgeChatType?: "private" | "group";
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
    taskNotifications: [],
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
      return {
        ...state,
        blocks: applyToolResult(state.blocks, event),
      };
    case "result":
      return finalizeWithResult(state, event.text);
    case "task_notification":
      return {
        ...state,
        taskNotifications: [...state.taskNotifications, event.text].slice(-20),
      };
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
    for (const group of groupBlocks(state.blocks)) {
      if (group.kind === "text") {
        const cleaned = cleanCardText(group.content);
        if (cleaned) {
          elements.push(markdownElement(cleaned));
        }
      } else {
        for (const element of renderToolGroup(group.tools, false, labels)) {
          elements.push(element);
        }
      }
    }
  } else {
    // Once finished, condense: show the final answer prominently and fold the
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
  } else if (state.status === "error" && state.errorText.trim()) {
    elements.push(markdownElement(`⚠️ ${state.errorText.trim()}`));
  } else if (state.status === "done" && elements.length === 1) {
    elements.push(markdownElement(`_${labels.empty}_`));
  }

  if (state.taskNotifications.length > 0) {
    elements.push(markdownElement(`**${labels.background}**\n${state.taskNotifications.slice(-3).join("\n\n")}`));
  }

  if (state.status === "running") {
    if (state.footer) {
      elements.push(noteElement(footerStatusText(state.footer, labels)));
    }
    elements.push({ tag: "hr" });
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: labels.stop },
      type: "danger",
      behaviors: [callbackBehavior({
        cctb_lark: "stop",
        conversationKey: state.conversationKey,
        ...(state.bridgeChatType ? { bridgeChatType: state.bridgeChatType } : {}),
      })],
    });
  }

  return {
    schema: "2.0",
    config: {
      streaming_mode: state.status === "running",
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

const COMPACT_ANSWER_MAX = 8000;
const PROCESS_PANEL_MAX = 3000;

/** The canonical final answer: the engine's result text, or the last non-empty text block. */
function finalAnswerText(state: LarkRunState): string {
  if (state.resultText.trim()) {
    return state.resultText;
  }
  const lastText = [...state.blocks].reverse().find(
    (block): block is Extract<LarkRunBlock, { kind: "text" }> => block.kind === "text" && block.content.trim().length > 0,
  );
  return lastText?.content ?? "";
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
  let answerSkipped = false;
  for (const block of state.blocks) {
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
    // Skip the one block that is the final answer (shown above), but keep any
    // earlier intermediate narration.
    if (!answerSkipped && answer && text === answer) {
      answerSkipped = true;
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
  const answer = cleanCardText(finalAnswerText(state));
  if (answer) {
    elements.push(markdownElement(truncate(answer, COMPACT_ANSWER_MAX)));
  }

  if (state.status === "interrupted") {
    elements.push(noteElement(`_⏹ ${labels.interrupted}_`));
  } else if (state.status === "idle_timeout") {
    elements.push(noteElement(`_⏱ ${labels.idleTimeout(state.idleTimeoutMinutes ?? 0)}_`));
  } else if (state.status === "error" && state.errorText.trim()) {
    elements.push(markdownElement(`⚠️ ${truncate(state.errorText.trim(), 600)}`));
  } else if (!answer) {
    elements.push(markdownElement(`_${labels.empty}_`));
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
        return `✅ ${content}`;
      }
      if (status === "in_progress") {
        return `🔄 **${active || content}**`;
      }
      return `⬜ ${content}`;
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
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
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

function cleanCardText(content: string): string {
  const stripped = stripCronAddTags(stripTelegramToolTags(stripDeliveryTags(content)));
  return collapseBlankLines(downgradeMarkdownHeadings(stripped)).trim();
}

/**
 * Feishu renders markdown ATX headings (`#`–`######`) at large heading sizes,
 * which looks oversized and noisy inside a chat card — especially for answers
 * with many `##` sections. Downgrade headings to bold so they keep their
 * structure at normal body size.
 */
function downgradeMarkdownHeadings(text: string): string {
  return text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_match, title: string) => {
    const trimmed = title.trim();
    // Avoid double-bolding a title that is already fully bold.
    return /^\*\*.*\*\*$/.test(trimmed) ? trimmed : `**${trimmed}**`;
  });
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

function runCardStatusLabel(
  status: LarkRunState["status"],
  labels: ReturnType<typeof runCardLabels>,
): string {
  if (status === "running") return labels.running;
  if (status === "error") return labels.error;
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

function runCardLabels(locale: Locale): {
  running: string;
  done: string;
  error: string;
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
  background: string;
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
      done: "Done",
      error: "Failed",
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
      background: "Background",
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
      done: "已完成",
      error: "执行失败",
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
      background: "后台任务",
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

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: `Approval requested: ${input.toolName}`,
      },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        markdownElement(`**Approval requested**\n${input.toolName}${toolInput}`),
        {
          tag: "column_set",
          columns: [
            approvalButtonColumn(input.requestId, "allow_once", labels.allowOnce, "primary", input.replyInThread),
            approvalButtonColumn(input.requestId, "allow_session", labels.allowSession, "default", input.replyInThread),
            approvalButtonColumn(input.requestId, "deny", labels.deny, "danger", input.replyInThread),
          ],
        },
      ],
    },
  };
}

export function renderLarkQueueWaitCard(input: LarkQueueWaitCardInput): Record<string, unknown> {
  const locale = input.locale ?? "zh";
  const seconds = Math.max(1, Math.round(input.waitedMs / 1000));
  const title = locale === "en" ? "Queued behind the active turn" : "正在排队等待当前任务";
  const body = locale === "en"
    ? `This conversation already has a running task. This message has waited about ${seconds}s and will continue automatically.\n\nIf the active task is stuck, stop it here or send \`/stop\`.`
    : `同一个会话里还有任务在运行。这条消息已等待约 ${seconds} 秒，前一个任务结束后会自动继续。\n\n如果前一个任务卡住，可以点下面按钮或发送 \`/stop\` 停止。`;
  const stop = locale === "en" ? "Stop active task" : "停止当前任务";
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

function approvalCardLabels(locale: Locale): { allowOnce: string; allowSession: string; deny: string } {
  return locale === "en"
    ? { allowOnce: "Allow once", allowSession: "Allow for this turn", deny: "Deny" }
    : { allowOnce: "允许一次", allowSession: "本轮允许", deny: "拒绝" };
}

function markdownElement(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
  };
}

function noteElement(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
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
    elements: [{ tag: "markdown", content: input.body || "_无内容_", text_size: "notation" }],
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
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function cardSummary(state: LarkRunState, locale: Locale): string {
  if (state.status === "running") {
    return locale === "en" ? "Task is running" : "任务处理中";
  }
  if (state.status === "error") {
    return locale === "en" ? "Failed" : "执行失败";
  }
  if (state.status === "interrupted") {
    return locale === "en" ? "Interrupted" : "已中断";
  }
  if (state.status === "idle_timeout") {
    return locale === "en" ? "Auto-stopped" : "无响应已终止";
  }
  const lastText = [...state.blocks].reverse().find((block): block is Extract<LarkRunBlock, { kind: "text" }> => block.kind === "text" && block.content.trim().length > 0);
  const text = cleanCardText(lastText?.content ?? state.resultText);
  return text.trim().slice(0, 80) || (locale === "en" ? "Done" : "已完成");
}
