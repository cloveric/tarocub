import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { joinStatePath, resolveInstanceStateDir } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import { appendAuditEvent } from "../state/audit-log.js";
import { GENERATED_TELEGRAM_TRANSPORT_INSTRUCTIONS } from "../telegram/agent-instructions.js";

export interface InstanceTokenEnv {
  HOME?: string;
  USERPROFILE?: string;
  TAROCUB_INSTANCE?: string;
  CODEX_TELEGRAM_INSTANCE?: string;
  CODEX_TELEGRAM_STATE_DIR?: string;
}

export interface PersistedInstanceToken {
  instanceName: string;
  stateDir: string;
  envPath: string;
}

// Migration evidence is append-only. Do not update these snapshots when the
// live prompt or tool registry changes; add a new historical snapshot instead.
const FROZEN_SEND_FILE_TOOL_TAG = '[tool:{"name":"send.file","payload":{"path":"/absolute/path"}}]';
const FROZEN_SEND_IMAGE_TOOL_TAG = '[tool:{"name":"send.image","payload":{"path":"/absolute/image.png"}}]';
const FROZEN_SEND_BATCH_TOOL_TAG = '[tool:{"name":"send.batch","payload":{"message":"Done","images":["/absolute/image.png"],"files":["/absolute/report.pdf"]}}]';
const FROZEN_CRON_ADD_IN_TOOL_TAG = '[tool:{"name":"cron.add","payload":{"in":"10m","prompt":"check email"}}]';
const FROZEN_CRON_ADD_AT_TOOL_TAG = '[tool:{"name":"cron.add","payload":{"at":"2026-05-01T09:00:00Z","prompt":"Monday standup"}}]';
const FROZEN_CRON_ADD_CRON_TOOL_TAG = '[tool:{"name":"cron.add","payload":{"cron":"0 9 * * 1","prompt":"weekly summary"}}]';
const FROZEN_SEND_BATCH_TOOL_CALL_BLOCK = [
  "```tool-call",
  '{"name":"send.batch","payload":{"message":"Done","images":["/absolute/image.png"],"files":["/absolute/report.pdf"]}}',
  "```",
].join("\n");

const REMINDER_TOOL_GUARDRAIL_SENTENCE =
  "Only emit reminder tool tags when the user explicitly asks to schedule/remind; do not infer reminders from ordinary dates/times in analysis. `at` must be an ISO date-time with timezone, such as 2026-05-27T13:30:00+08:00. For anything recurring (every N minutes/hours, or repeating over a window) emit exactly ONE `cron` tag with a single STANDARD 5-field expression (`minute hour day-of-month month day-of-week` — NO seconds field, NO year field; croner rejects 6-7 field exprs so they silently never fire), e.g. every 15 minutes through the afternoon = `*/15 13-14 * * *` — never many one-shot `at`/`in` tags or one tag per interval; a single cron job still fires (and notifies) separately each time.";

const GENERATED_INSTANCE_AGENT_INSTRUCTIONS = GENERATED_TELEGRAM_TRANSPORT_INSTRUCTIONS;

const NATIVE_SESSION_LOCAL_SCHEDULER_SENTENCE =
  "Use native/session-local schedulers only if the user explicitly asks for non-Telegram scheduling.";

const GENERATED_SCHEDULED_TASKS_BLOCKS = [
  [
    "## Scheduled Tasks",
    "",
    `For Telegram reminders emit ${FROZEN_CRON_ADD_IN_TOOL_TAG}; payload needs \`prompt\` plus exactly one of \`in\`/\`at\`/\`cron\`, optional \`description\`, never \`chatId\`/\`userId\`. ${REMINDER_TOOL_GUARDRAIL_SENTENCE} Let the bridge confirm. Use native/session-local schedulers only if explicitly asked.`,
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    `For reminders or recurring tasks, emit one inline tool tag, such as ${FROZEN_CRON_ADD_IN_TOOL_TAG}, ${FROZEN_CRON_ADD_AT_TOOL_TAG}, or ${FROZEN_CRON_ADD_CRON_TOOL_TAG}. Use exactly one of \`in\`, \`at\`, or \`cron\`; optional \`description\` is shown in \`/cron list\`; never include \`chatId\` or \`userId\`. ${REMINDER_TOOL_GUARDRAIL_SENTENCE} The bridge confirms success or failure; do not claim scheduling succeeded in your own words. ${NATIVE_SESSION_LOCAL_SCHEDULER_SENTENCE}`,
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    `For reminders or recurring tasks, emit one inline tool tag, such as ${FROZEN_CRON_ADD_IN_TOOL_TAG}, ${FROZEN_CRON_ADD_AT_TOOL_TAG}, or ${FROZEN_CRON_ADD_CRON_TOOL_TAG}. Use exactly one of \`in\`, \`at\`, or \`cron\`; optional \`description\` is shown in \`/cron list\`; never include \`chatId\` or \`userId\`. ${REMINDER_TOOL_GUARDRAIL_SENTENCE} The bridge confirms success or failure; do not claim scheduling succeeded in your own words.`,
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For reminders or recurring tasks, emit one inline tag in your reply, such as `[cron-add:{\"in\":\"10m\",\"prompt\":\"check email\"}]`, `[cron-add:{\"at\":\"2026-05-01T09:00:00Z\",\"prompt\":\"Monday standup\"}]`, or `[cron-add:{\"cron\":\"0 9 * * 1\",\"prompt\":\"weekly summary\"}]`. Use exactly one of `in`, `at`, or `cron`; optional `description` is shown in `/cron list`; never include `chatId` or `userId`. The bridge will confirm success or failure, so do not claim a reminder is scheduled in your own words.",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For reminders or recurring tasks, use `cctb cron add --in 10m --prompt \"...\"`, `cctb cron add --at ISO_TIME --prompt \"...\"`, or `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"...\"` when available; use `cctb cron list` to inspect. If `cctb cron` is unavailable, ask the user to send `/cron add <m h dom mon dow> <task>` or emit one `[cron-add:{\"in\":\"10m\",\"prompt\":\"...\"}]` fallback tag; use `at` or `cron` instead of `in` when needed, never include chatId/userId, and let the bridge confirm. Do not claim a reminder is scheduled unless the command succeeds or the bridge confirms the fallback.",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For reminders or recurring tasks, use `cctb cron add --in 10m --prompt \"...\"`, `cctb cron add --at ISO_TIME --prompt \"...\"`, or `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"...\"` when available; use `cctb cron list` to inspect. If `cctb cron` is unavailable, ask the user to send `/cron add <m h dom mon dow> <task>` in chat. Do not claim a reminder is scheduled unless the command succeeds.",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For reminders or recurring tasks, use `cctb cron add --in 10m --prompt \"...\"`, `cctb cron add --at ISO_TIME --prompt \"...\"`, or `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"...\"` when available; use `cctb cron list` to inspect. If `cctb cron` is unavailable, ask the user to send `/cron add <m h dom mon dow> <task>` in chat. Do not use Claude/Codex native schedule, cron, automation, reminder, loop, CronCreate, or ScheduleWakeup tools for Telegram reminders; they are session-local and may not deliver through Telegram. Do not claim a reminder is scheduled unless the command succeeds.",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For Telegram-delivered reminders or recurring tasks, use `cctb cron add --in 10m --prompt \"...\"`, `cctb cron add --at ISO_TIME --prompt \"...\"`, or `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"...\"` when available; use `cctb cron list` to inspect. If `cctb cron` is unavailable, ask the user to send `/cron add <m h dom mon dow> <task>` in chat. If the user explicitly asks for a native/session-local scheduler, you may use Claude/Codex native schedule, cron, automation, reminder, loop, CronCreate, or ScheduleWakeup tools, but first state that those jobs are session-local and may not persist or deliver through Telegram. Do not claim a Telegram reminder is scheduled unless the `cctb cron` or `/cron` command succeeds.",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For persistent recurring tasks that should send results back to this Telegram chat (\"every day at 9am summarize X\", \"每周一汇总…\"), use the Bash tool to call `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"<task>\"` (env `CCTB_CRON_URL` / `CCTB_CRON_TOKEN` are already set; PATH already has `cctb`). Run `cctb cron --help` to see all subcommands (list, delete, toggle, etc.). The user can also type `/cron ...` directly in chat. Do NOT use the Claude Code `schedule` skill (detached, output won't reach Telegram), the `loop` skill (single-session only, dies when turn ends), or system `crontab`/`at` (won't survive bot restart). `ScheduleWakeup` is acceptable only for short within-turn waits (<10 minutes).",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For persistent recurring tasks that should send results back to this Telegram chat (\"every day at 9am summarize X\", \"每周一汇总…\"), prefer asking the user to send `/cron add <m h dom mon dow> <task>` in chat. In turn-scoped CLI sessions, `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"<task>\"` may also be available; if it reports missing `CCTB_CRON_URL` / `CCTB_CRON_TOKEN`, fall back to the chat `/cron` command. Do NOT use the Claude Code `schedule` skill (detached, output won't reach Telegram), the `loop` skill (single-session only, dies when turn ends), or system `crontab`/`at` (won't survive bot restart). `ScheduleWakeup` is acceptable only for short within-turn waits (<10 minutes).",
  ].join("\n"),
];

const LEGACY_GENERATED_TELEGRAM_TRANSPORT_BLOCKS = [
  [
    "## Telegram Transport",
    "",
    `Plain text; ask in chat. Tags when needed: file/image ${FROZEN_SEND_FILE_TOOL_TAG} (\`send.image\` same); batch fenced \`tool-call\` JSON {name:"send.batch",payload:{message?,images?,files?}}. Reminder ${FROZEN_CRON_ADD_IN_TOOL_TAG} with one of \`in\`/\`at\`/\`cron\`, optional \`description\`, no \`chatId\`/\`userId\`; manage with \`[tool:{"name":"cron.list","payload":{}}]\`, \`[tool:{"name":"cron.remove","payload":{"query":"task text"}}]\`, \`[tool:{"name":"cron.remove","payload":{"id":"<job-id>"}}]\`, or \`[tool:{"name":"cron.toggle","payload":{"query":"task text"}}]\`; use query only when it uniquely identifies the task, list first if ambiguous, never invent IDs. ${REMINDER_TOOL_GUARDRAIL_SENTENCE} Plain reminders notify directly; set deliveryMode:"agent" only for AI-run tasks. Let bridge confirm; native schedulers only if explicitly asked.`,
    "Web/current facts: if URL(s) are provided, read them directly with `web_extract` or browser first; use `web_search` for discovery/current facts when no exact URL or direct read fails, and disclose fallback.",
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    `Plain text; ask in chat. Tags when needed: file/image ${FROZEN_SEND_FILE_TOOL_TAG} (\`send.image\` same); batch fenced \`tool-call\` JSON {name:"send.batch",payload:{message?,images?,files?}}. Reminder ${FROZEN_CRON_ADD_IN_TOOL_TAG} with one of \`in\`/\`at\`/\`cron\`, optional \`description\`, no \`chatId\`/\`userId\`; manage with \`[tool:{"name":"cron.list","payload":{}}]\`, \`[tool:{"name":"cron.remove","payload":{"query":"task text"}}]\`, \`[tool:{"name":"cron.remove","payload":{"id":"<job-id>"}}]\`, or \`[tool:{"name":"cron.toggle","payload":{"query":"task text"}}]\`; use query only when it uniquely identifies the task, list first if ambiguous, never invent IDs. Plain reminders notify directly; set deliveryMode:"agent" only for AI-run tasks. Let bridge confirm; native schedulers only if explicitly asked.`,
    "Web/current facts: if URL(s) are provided, read them directly with `web_extract` or browser first; use `web_search` for discovery/current facts when no exact URL or direct read fails, and disclose fallback.",
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    `Plain text; ask in chat. Tags when needed: file/image ${FROZEN_SEND_FILE_TOOL_TAG} (\`send.image\` same); batch fenced \`tool-call\` JSON {name:"send.batch",payload:{message?,images?,files?}}; reminder ${FROZEN_CRON_ADD_IN_TOOL_TAG} with one of \`in\`/\`at\`/\`cron\`, optional \`description\`, no \`chatId\`/\`userId\`. Plain reminders notify directly; set deliveryMode:"agent" only for AI-run tasks. Let bridge confirm; native schedulers only if explicitly asked.`,
    "Web/current facts: if URL(s) are provided, read them directly with `web_extract` or browser first; use `web_search` for discovery/current facts when no exact URL or direct read fails, and disclose fallback.",
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    `Plain text; ask in chat. Tags when needed: file/image ${FROZEN_SEND_FILE_TOOL_TAG} (\`send.image\` same); batch fenced \`tool-call\` JSON {name:"send.batch",payload:{message?,images?,files?}}; reminder ${FROZEN_CRON_ADD_IN_TOOL_TAG} with one of \`in\`/\`at\`/\`cron\`, optional \`description\`, no \`chatId\`/\`userId\`. Let bridge confirm; native schedulers only if explicitly asked.`,
    "Web/current facts: if URL(s) are provided, read them directly with `web_extract` or browser first; use `web_search` for discovery/current facts when no exact URL or direct read fails, and disclose fallback.",
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    `Plain text; ask in chat. Tags when needed: file/image ${FROZEN_SEND_FILE_TOOL_TAG} (\`send.image\` same); batch fenced \`tool-call\` JSON {name:"send.batch",payload:{message?,images?,files?}}; reminder ${FROZEN_CRON_ADD_IN_TOOL_TAG} with one of \`in\`/\`at\`/\`cron\`, optional \`description\`, no \`chatId\`/\`userId\`. Let bridge confirm; native schedulers only if explicitly asked.`,
    "Web/current facts: prefer `web_search` MCP; use native search only if unavailable/fails, and disclose fallback.",
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    `Plain text; ask in chat. Tags when needed: file/image ${FROZEN_SEND_FILE_TOOL_TAG} (\`send.image\` same); batch fenced \`tool-call\` JSON {name:"send.batch",payload:{message?,images?,files?}}; reminder ${FROZEN_CRON_ADD_IN_TOOL_TAG} with one of \`in\`/\`at\`/\`cron\`, optional \`description\`, no \`chatId\`/\`userId\`. Let bridge confirm; native schedulers only if explicitly asked.`,
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    `Plain text only; ask in chat. For one file use ${FROZEN_SEND_FILE_TOOL_TAG}; use \`send.image\` similarly. For batches/long replies use fenced \`tool-call\` JSON: {name:"send.batch",payload:{message?,images?,files?}}. Small text/code may use fenced \`file:name.ext\`. Let the bridge confirm delivery.`,
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    `Plain text only; ask in chat, not blocking prompt tools. For one existing file/image, emit one inline tool tag such as ${FROZEN_SEND_FILE_TOOL_TAG} or ${FROZEN_SEND_IMAGE_TOOL_TAG}. For batch delivery or long messages, emit a fenced tool-call block like:\n${FROZEN_SEND_BATCH_TOOL_CALL_BLOCK}\nSmall text/code may use one fenced \`file:name.ext\` block. Never claim delivery succeeded in your own words; let the bridge receipt confirm it.`,
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    `Plain text only; ask in chat, not blocking prompt tools. For existing file delivery, emit one inline tool tag such as ${FROZEN_SEND_FILE_TOOL_TAG}, ${FROZEN_SEND_IMAGE_TOOL_TAG}, or ${FROZEN_SEND_BATCH_TOOL_TAG}. Small text/code may use one fenced \`file:name.ext\` block; never claim delivery by path only.`,
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    "Plain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`; if `cctb` is unavailable, emit [tool:{\"name\":\"send.file\",\"payload\":{\"path\":\"/absolute/path\"}}] or `send.image`; small text/code may use one fenced `file:name.ext` block; never claim delivery by path only.",
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    "Plain text only; ask in chat, not blocking prompt tools; deliver files with `telegram send --file PATH` / `telegram send --image PATH`, write disk outputs to `.telegram-out/current`, or use one fenced `file:name.ext` block for small text/code; never claim delivery by only naming a path.",
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    "Plain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`, or one fenced `file:name.ext` block for small text/code; never claim delivery by path only.",
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    "Plain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`; if `cctb` is unavailable, use `[send-file:<absolute path>]` / `[send-image:<absolute path>]`; small text/code may use one fenced `file:name.ext` block; never claim delivery by path only.",
  ].join("\n"),
];

export type InstanceAgentInstructionsState =
  | "missing"
  | "empty"
  | "persona-only"
  | "generated-current"
  | "legacy-generated"
  | "custom-transport";

export interface InstanceAgentInstructionsInspection {
  state: InstanceAgentInstructionsState;
  path: string;
  detail: string;
}

export interface InstanceAgentInstructionsUpgradeResult {
  status: "current" | "migrated" | "manual-review" | "force-migrated";
  path: string;
  changed: boolean;
  dryRun?: boolean;
  backupPath?: string;
}

function trimForCompare(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

interface GeneratedTransportMatch {
  start: number;
  end: number;
  state: "generated-current" | "legacy-generated";
}

const KNOWN_GENERATED_TELEGRAM_TRANSPORT_BLOCKS: ReadonlyArray<{
  text: string;
  state: GeneratedTransportMatch["state"];
}> = [
  { text: GENERATED_INSTANCE_AGENT_INSTRUCTIONS, state: "generated-current" },
  ...LEGACY_GENERATED_TELEGRAM_TRANSPORT_BLOCKS.map((text) => ({
    text,
    state: "legacy-generated" as const,
  })),
];

function isBlockBoundary(content: string, start: number, end: number): boolean {
  return (start === 0 || content[start - 1] === "\n")
    && (end === content.length || content[end] === "\n");
}

function findKnownGeneratedTelegramTransportBlock(content: string, startIndex = 0): GeneratedTransportMatch | null {
  const normalized = content.replace(/\r\n/g, "\n");
  let best: GeneratedTransportMatch | null = null;

  for (const candidate of KNOWN_GENERATED_TELEGRAM_TRANSPORT_BLOCKS) {
    const block = trimForCompare(candidate.text);
    let offset = startIndex;
    while (offset <= normalized.length - block.length) {
      const start = normalized.indexOf(block, offset);
      if (start < 0) {
        break;
      }
      const end = start + block.length;
      if (isBlockBoundary(normalized, start, end)) {
        if (!best || start < best.start || (start === best.start && end > best.end)) {
          best = { start, end, state: candidate.state };
        }
        break;
      }
      offset = start + 1;
    }
  }

  return best;
}

interface MarkdownHeading {
  start: number;
  level: number;
  text: string;
}

function markdownHeadingsOutsideFences(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { marker: string; length: number } | null = null;
  let lineStart = 0;

  while (lineStart <= content.length) {
    const lineEnd = content.indexOf("\n", lineStart);
    const end = lineEnd < 0 ? content.length : lineEnd;
    const line = content.slice(lineStart, end);
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] ?? "";
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length };
      } else if (fence.marker === marker && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
    } else if (!fence) {
      const headingMatch = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
      if (headingMatch) {
        headings.push({
          start: lineStart,
          level: headingMatch[1].length,
          text: headingMatch[2].trim().replace(/[ \t]+#+[ \t]*$/, ""),
        });
      }
    }

    if (lineEnd < 0) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return headings;
}

function findTelegramTransportSection(content: string): { start: number; end: number; text: string } | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const headings = markdownHeadingsOutsideFences(normalized);
  const headingIndex = headings.findIndex((heading) => heading.level === 2 && heading.text.startsWith("Telegram Transport"));
  if (headingIndex < 0) {
    return null;
  }
  const start = headings[headingIndex].start;
  // Force removal is intentionally conservative: stop at any later Markdown
  // heading, even a subsection, rather than risk deleting user-owned persona.
  const end = headings[headingIndex + 1]?.start ?? normalized.length;
  return { start, end, text: normalized.slice(start, end) };
}

export function inspectInstanceAgentInstructionsContent(
  content: string,
  agentPath = "",
): InstanceAgentInstructionsInspection {
  const trimmed = trimForCompare(content);
  if (!trimmed) {
    return { state: "empty", path: agentPath, detail: "agent.md is empty" };
  }
  const analysis = analyzeGeneratedTelegramTransportBlocks(content);
  if (analysis.customOrModified) {
    return { state: "custom-transport", path: agentPath, detail: "Telegram Transport section is custom or modified" };
  }
  if (analysis.matches.length > 0) {
    const state = analysis.state;
    return {
      state,
      path: agentPath,
      detail: state === "generated-current"
        ? "agent.md contains runtime-owned Telegram transport instructions"
        : "agent.md contains known generated Telegram instruction residue",
    };
  }

  const section = findTelegramTransportSection(content);
  if (!section) {
    return { state: "persona-only", path: agentPath, detail: "agent.md contains only user-owned instructions" };
  }
  return { state: "custom-transport", path: agentPath, detail: "Telegram Transport section is custom or unknown" };
}

function stripGeneratedScheduledTasksResidue(content: string): string {
  let remaining = content.trimStart();
  while (remaining.startsWith(NATIVE_SESSION_LOCAL_SCHEDULER_SENTENCE)) {
    remaining = remaining.slice(NATIVE_SESSION_LOCAL_SCHEDULER_SENTENCE.length).trimStart();
  }
  return remaining;
}

function firstNonWhitespaceIndex(content: string, start: number): number {
  const offset = content.slice(start).search(/\S/);
  return offset < 0 ? content.length : start + offset;
}

function matchingKnownBlockEndAt(content: string, start: number, blocks: readonly string[]): number | null {
  for (const candidate of blocks) {
    const block = trimForCompare(candidate);
    const end = start + block.length;
    if (content.startsWith(block, start) && isBlockBoundary(content, start, end)) {
      return end;
    }
  }
  return null;
}

function extendGeneratedRemovalEnd(content: string, initialEnd: number): number {
  let end = initialEnd;
  while (end < content.length) {
    const next = firstNonWhitespaceIndex(content, end);
    if (next >= content.length) {
      return end;
    }

    const scheduledEnd = matchingKnownBlockEndAt(content, next, GENERATED_SCHEDULED_TASKS_BLOCKS);
    if (scheduledEnd !== null) {
      end = scheduledEnd;
      continue;
    }

    const residueEnd = next + NATIVE_SESSION_LOCAL_SCHEDULER_SENTENCE.length;
    if (
      content.startsWith(NATIVE_SESSION_LOCAL_SCHEDULER_SENTENCE, next)
      && isBlockBoundary(content, next, residueEnd)
    ) {
      end = residueEnd;
      continue;
    }
    return end;
  }
  return end;
}

interface GeneratedTransportAnalysis {
  matches: Array<GeneratedTransportMatch & { removalEnd: number }>;
  state: "generated-current" | "legacy-generated";
  customOrModified: boolean;
}

function isSafeGeneratedRemovalBoundary(content: string, end: number): boolean {
  const next = firstNonWhitespaceIndex(content, end);
  if (next >= content.length) {
    return true;
  }
  return markdownHeadingsOutsideFences(content.slice(next))[0]?.start === 0;
}

function analyzeGeneratedTelegramTransportBlocks(content: string): GeneratedTransportAnalysis {
  const normalized = content.replace(/\r\n/g, "\n");
  const matches: GeneratedTransportAnalysis["matches"] = [];
  let cursor = 0;
  let state: GeneratedTransportAnalysis["state"] = "generated-current";

  while (cursor < normalized.length) {
    const match = findKnownGeneratedTelegramTransportBlock(normalized, cursor);
    if (!match) {
      break;
    }
    const removalEnd = extendGeneratedRemovalEnd(normalized, match.end);
    matches.push({ ...match, removalEnd });
    if (match.state === "legacy-generated" || removalEnd > match.end) {
      state = "legacy-generated";
    }
    cursor = Math.max(removalEnd, match.end);
  }

  const knownStarts = new Set(matches.map((match) => match.start));
  const hasUnknownHeading = markdownHeadingsOutsideFences(normalized).some((heading) =>
    heading.level === 2
    && heading.text.startsWith("Telegram Transport")
    && !knownStarts.has(heading.start)
  );
  const hasModifiedSuffix = matches.some((match) => !isSafeGeneratedRemovalBoundary(normalized, match.removalEnd));
  return {
    matches,
    state,
    customOrModified: hasUnknownHeading || hasModifiedSuffix,
  };
}

function removeContentRange(content: string, start: number, end: number): string {
  const before = content.slice(0, start).trimEnd();
  const after = content.slice(end).trimStart();
  const stripped = `${before}${before && after ? "\n\n" : ""}${after}`.trim();
  return stripped ? `${stripped}\n` : "";
}

function removeContentRanges(
  content: string,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): string {
  const retained: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    retained.push(content.slice(cursor, range.start));
    cursor = range.end;
  }
  retained.push(content.slice(cursor));
  const normalized = retained.map((part) => part.trim()).filter(Boolean).join("\n\n");
  return normalized ? `${normalized}\n` : "";
}

function stripTelegramTransportSection(content: string): { content: string; removed: boolean } {
  const normalized = content.replace(/\r\n/g, "\n");
  const section = findTelegramTransportSection(normalized);
  if (!section) {
    return { content, removed: false };
  }

  let after = normalized.slice(section.end).trimStart();
  let strippedGeneratedScheduledTasks = false;
  for (const block of GENERATED_SCHEDULED_TASKS_BLOCKS) {
    const normalizedBlock = block.replace(/\r\n/g, "\n");
    if (after.startsWith(normalizedBlock)) {
      after = after.slice(normalizedBlock.length).trimStart();
      strippedGeneratedScheduledTasks = true;
      break;
    }
  }
  if (strippedGeneratedScheduledTasks) {
    after = stripGeneratedScheduledTasksResidue(after);
  }
  const adjustedEnd = normalized.length - after.length;
  return { content: removeContentRange(normalized, section.start, adjustedEnd), removed: true };
}

export function stripGeneratedTelegramTransportSection(content: string): { content: string; removed: boolean } {
  const normalized = content.replace(/\r\n/g, "\n");
  const analysis = analyzeGeneratedTelegramTransportBlocks(normalized);
  if (analysis.customOrModified || analysis.matches.length === 0) {
    return { content, removed: false };
  }

  return {
    content: removeContentRanges(
      normalized,
      analysis.matches.map((match) => ({ start: match.start, end: match.removalEnd })),
    ),
    removed: true,
  };
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

async function writeAgentBackup(agentPath: string, content: string, now: () => Date): Promise<string> {
  const baseBackupPath = `${agentPath}.bak.${Math.floor(now().getTime() / 1000)}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const backupPath = attempt === 0 ? baseBackupPath : `${baseBackupPath}-${attempt}`;
    try {
      await writeFile(backupPath, content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return backupPath;
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not create unique backup path for ${agentPath}`);
}

export async function inspectInstanceAgentInstructions(
  env: Pick<InstanceTokenEnv, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): Promise<InstanceAgentInstructionsInspection> {
  const agentPath = resolveInstanceAgentInstructionsPath(env, instanceName);
  try {
    return inspectInstanceAgentInstructionsContent(await readFile(agentPath, "utf8"), agentPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { state: "missing", path: agentPath, detail: "agent.md is missing" };
    }
    throw error;
  }
}

export async function migrateInstanceAgentInstructions(
  env: Pick<InstanceTokenEnv, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
  options: { force?: boolean; dryRun?: boolean; now?: () => Date } = {},
): Promise<InstanceAgentInstructionsUpgradeResult> {
  const agentPath = resolveInstanceAgentInstructionsPath(env, instanceName);

  let content: string | undefined;
  try {
    content = await readFile(agentPath, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return { status: "current", path: agentPath, changed: false };
    }
    throw error;
  }

  const inspection = inspectInstanceAgentInstructionsContent(content, agentPath);
  if (
    inspection.state === "empty"
    || inspection.state === "persona-only"
    || inspection.state === "missing"
  ) {
    return { status: "current", path: agentPath, changed: false };
  }
  if (inspection.state === "generated-current" || inspection.state === "legacy-generated") {
    if (options.dryRun) {
      return { status: "migrated", path: agentPath, changed: false, dryRun: true };
    }
    const stripped = stripGeneratedTelegramTransportSection(content);
    if (!stripped.removed) {
      return { status: "manual-review", path: agentPath, changed: false };
    }
    await writeFile(agentPath, stripped.content, { encoding: "utf8", mode: 0o600 });
    return { status: "migrated", path: agentPath, changed: true };
  }
  if (!options.force) {
    return { status: "manual-review", path: agentPath, changed: false };
  }

  if (options.dryRun) {
    return { status: "force-migrated", path: agentPath, changed: false, dryRun: true };
  }
  const backupPath = await writeAgentBackup(agentPath, content, options.now ?? (() => new Date()));
  const stripped = stripTelegramTransportSection(content);
  await writeFile(agentPath, stripped.content, { encoding: "utf8", mode: 0o600 });
  return { status: "force-migrated", path: agentPath, changed: true, backupPath };
}

/** Backward-compatible API name; `upgrade` now migrates transport rules to runtime injection. */
export const upgradeInstanceAgentInstructions = migrateInstanceAgentInstructions;

export function resolveInstanceAccessStatePath(
  env: Pick<InstanceTokenEnv, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): string {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
  });

  return joinStatePath(stateDir, "access.json");
}

export function resolveInstanceAgentInstructionsPath(
  env: Pick<InstanceTokenEnv, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): string {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
  });

  return joinStatePath(stateDir, "agent.md");
}

export async function ensureDefaultInstanceAgentInstructions(
  env: Pick<InstanceTokenEnv, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): Promise<{ path: string; created: boolean }> {
  const agentPath = resolveInstanceAgentInstructionsPath(env, instanceName);

  await mkdir(path.dirname(agentPath), { recursive: true, mode: 0o700 });

  try {
    await writeFile(agentPath, "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { path: agentPath, created: true };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      return { path: agentPath, created: false };
    }
    throw error;
  }
}

export async function writeInstanceBotToken(
  env: InstanceTokenEnv,
  instanceName: string,
  botToken: string,
): Promise<PersistedInstanceToken> {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
  });
  const envPath = joinStatePath(stateDir, ".env");
  const nextLine = `TELEGRAM_BOT_TOKEN=${JSON.stringify(botToken)}`;
  let contents = nextLine;

  try {
    const existing = await readFile(envPath, "utf8");
    const lines = existing.replace(/\r?\n$/, "").split(/\r?\n/);
    const mergedLines = lines.filter((line) => !line.startsWith("TELEGRAM_BOT_TOKEN="));
    mergedLines.push(nextLine);
    contents = mergedLines.join("\n");
    contents += "\n";
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }

    contents = `${nextLine}\n`;
  }

  await mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  await writeFile(envPath, contents, { encoding: "utf8", mode: 0o600 });
  await ensureDefaultInstanceAgentInstructions(env, normalizedInstanceName);
  await appendAuditEvent(stateDir, {
    type: "configure.token",
    instanceName: normalizedInstanceName,
    outcome: "success",
  });

  return { instanceName: normalizedInstanceName, stateDir, envPath };
}
