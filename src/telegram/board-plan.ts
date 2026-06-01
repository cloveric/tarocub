import type { BoardPlanTaskInput, BoardTaskPriority } from "../state/board-store.js";
import type { Locale } from "./message-renderer.js";

const BOARD_PRIORITIES: BoardTaskPriority[] = ["low", "normal", "high", "urgent"];

export function renderBoardPlanPrompt(goal: string, locale: Locale): string {
  const schema = `{"tasks":[{"key":"short-key","title":"Task title","description":"optional detail","assignee":"optional-agent","dependsOn":["short-key"],"acceptanceCriteria":["done when ..."],"checklist":["step"],"labels":["tag"],"priority":"normal","review":{"required":false}}]}`;
  return locale === "zh"
    ? [
        "把下面目标拆成一个可执行 Kanban 任务图。",
        "只返回 JSON，不要 Markdown，不要解释。",
        "字段必须匹配这个 schema：",
        schema,
        "priority 只能是 low/normal/high/urgent。dependsOn 使用 key，不要使用 B1 这种最终 ID。",
        "",
        `目标：${goal}`,
      ].join("\n")
    : [
        "Decompose the goal below into an executable Kanban task graph.",
        "Return JSON only. No Markdown. No explanation.",
        "The JSON must match this schema:",
        schema,
        "priority must be low/normal/high/urgent. dependsOn uses key values, not final B1-style ids.",
        "",
        `Goal: ${goal}`,
      ].join("\n");
}

export function parseBoardPlanOutput(text: string): BoardPlanTaskInput[] {
  const parsed = JSON.parse(extractJsonObject(text)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("board planner returned invalid JSON object");
  }
  const tasks = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("board planner returned no tasks");
  }
  return tasks.map((task, index) => normalizeBoardPlanTask(task, index));
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("board planner returned no JSON object");
  }
  return candidate.slice(start, end + 1);
}

function normalizeBoardPlanTask(value: unknown, index: number): BoardPlanTaskInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`board planner task ${index + 1} is invalid`);
  }
  const raw = value as Record<string, unknown>;
  const key = typeof raw.key === "string" ? raw.key.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!key || !title) {
    throw new Error(`board planner task ${index + 1} requires key and title`);
  }
  const priority = typeof raw.priority === "string" && isBoardPriority(raw.priority)
    ? raw.priority
    : undefined;
  const review = raw.review && typeof raw.review === "object" && !Array.isArray(raw.review)
    ? raw.review as Record<string, unknown>
    : null;
  return {
    key,
    title,
    ...(typeof raw.description === "string" && raw.description.trim() ? { description: raw.description.trim() } : {}),
    ...(typeof raw.assignee === "string" && raw.assignee.trim() ? { assignee: raw.assignee.trim() } : {}),
    ...(priority ? { priority } : {}),
    acceptanceCriteria: stringArray(raw.acceptanceCriteria),
    checklist: stringArray(raw.checklist),
    labels: stringArray(raw.labels),
    dependsOn: stringArray(raw.dependsOn),
    ...(review
      ? {
          review: {
            required: Boolean(review.required),
            ...(typeof review.reviewer === "string" && review.reviewer.trim() ? { reviewer: review.reviewer.trim() } : {}),
          },
        }
      : {}),
  };
}

function isBoardPriority(value: string): value is BoardTaskPriority {
  return (BOARD_PRIORITIES as string[]).includes(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}
