import type { EngineStreamEvent } from "../codex/adapter.js";
import type { Locale } from "../telegram/message-renderer.js";

export interface LarkRunState {
  conversationKey: string;
  bridgeChatType?: "private" | "group";
  status: "running" | "done" | "error";
  thinking: string[];
  tools: Array<{
    toolName: string;
    toolInput?: unknown;
  }>;
  assistantText: string;
  resultText: string;
  taskNotifications: string[];
}

export interface LarkApprovalCardInput {
  requestId: string;
  toolName: string;
  toolInput?: unknown;
  replyInThread?: boolean;
  locale?: Locale;
}

export function initialLarkRunState(conversationKey: string, bridgeChatType?: "private" | "group"): LarkRunState {
  return {
    conversationKey,
    ...(bridgeChatType ? { bridgeChatType } : {}),
    status: "running",
    thinking: [],
    tools: [],
    assistantText: "",
    resultText: "",
    taskNotifications: [],
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
        thinking: appendLimited(state.thinking, event.text),
      };
    case "tool_use":
    case "permission_request":
      return {
        ...state,
        tools: appendLimited(state.tools, {
          toolName: event.toolName,
          ...(event.toolInput === undefined ? {} : { toolInput: event.toolInput }),
        }),
      };
    case "assistant_text":
      return {
        ...state,
        assistantText: joinText(state.assistantText, event.text),
      };
    case "result":
      return {
        ...state,
        status: "done",
        resultText: event.text,
      };
    case "task_notification":
      return {
        ...state,
        taskNotifications: appendLimited(state.taskNotifications, event.text),
      };
    case "session":
      return state;
  }
}

export function renderLarkRunCard(state: LarkRunState, locale: Locale = "zh"): Record<string, unknown> {
  const labels = runCardLabels(locale);
  const elements: unknown[] = [
    markdownElement(state.status === "running" ? `**${labels.running}**` : `**${labels.done}**`),
  ];

  if (state.thinking.length > 0) {
    elements.push(collapsiblePanel({
      title: state.status === "running" ? labels.thinkingActive : labels.thinkingDone,
      expanded: state.status === "running",
      color: "grey",
      body: state.thinking.slice(-2).join("\n\n"),
    }));
  }

  if (state.tools.length > 0) {
    const tools = state.tools
      .slice(-5)
      .map((tool) => {
        const input = tool.toolInput === undefined ? "" : `\n${formatJson(tool.toolInput)}`;
        return `- ${tool.toolName}${input}`;
      })
      .join("\n");
    elements.push(collapsiblePanel({
      title: labels.tools,
      expanded: state.status === "running",
      color: "blue",
      body: tools,
    }));
  }

  const bodyText = state.resultText || state.assistantText;
  if (bodyText) {
    elements.push(markdownElement(bodyText));
  }

  if (state.taskNotifications.length > 0) {
    elements.push(markdownElement(`**Background**\n${state.taskNotifications.slice(-3).join("\n\n")}`));
  }

  if (state.status === "running") {
    elements.push(markdownElement(`_${labels.outputting}_`));
    elements.push({
      tag: "hr",
    });
    elements.push({
      tag: "button",
      text: {
        tag: "plain_text",
        content: labels.stop,
      },
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
      summary: {
        content: cardSummary(state, locale),
      },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

function runCardLabels(locale: Locale): {
  running: string;
  done: string;
  stop: string;
  thinkingActive: string;
  thinkingDone: string;
  tools: string;
  outputting: string;
} {
  return locale === "en"
    ? {
      running: "Task is running...",
      done: "Done",
      stop: "Stop",
      thinkingActive: "Thinking",
      thinkingDone: "Thinking complete",
      tools: "Tool calls",
      outputting: "Streaming output",
    }
    : {
      running: "任务处理中...",
      done: "已完成",
      stop: "停止",
      thinkingActive: "思考中",
      thinkingDone: "思考完成",
      tools: "工具调用",
      outputting: "正在输出",
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
      title: { tag: "markdown", content: `**${input.title}**` },
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

function joinText(current: string, next: string): string {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return `${current}\n${next}`;
}

function appendLimited<T>(items: T[], item: T, limit = 20): T[] {
  return [...items, item].slice(-limit);
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function cardSummary(state: LarkRunState, locale: Locale): string {
  if (state.status === "running") {
    return locale === "en" ? "Task is running" : "任务处理中";
  }
  const text = state.resultText || state.assistantText;
  return text.trim().slice(0, 80) || (locale === "en" ? "Done" : "已完成");
}
