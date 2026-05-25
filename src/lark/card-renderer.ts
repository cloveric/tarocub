import type { EngineStreamEvent } from "../codex/adapter.js";

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

export function renderLarkRunCard(state: LarkRunState): Record<string, unknown> {
  const elements: unknown[] = [
    markdownElement(state.status === "running" ? "**CC Telegram Bridge is working...**" : "**Done**"),
  ];

  if (state.thinking.length > 0) {
    elements.push(markdownElement(`**Thinking**\n${state.thinking.slice(-2).join("\n\n")}`));
  }

  if (state.tools.length > 0) {
    const tools = state.tools
      .slice(-5)
      .map((tool) => {
        const input = tool.toolInput === undefined ? "" : `\n${formatJson(tool.toolInput)}`;
        return `- ${tool.toolName}${input}`;
      })
      .join("\n");
    elements.push(markdownElement(`**Tools**\n${tools}`));
  }

  const bodyText = state.resultText || state.assistantText;
  if (bodyText) {
    elements.push(markdownElement(bodyText));
  }

  if (state.taskNotifications.length > 0) {
    elements.push(markdownElement(`**Background**\n${state.taskNotifications.slice(-3).join("\n\n")}`));
  }

  if (state.status === "running") {
    elements.push({
      tag: "hr",
    });
    elements.push({
      tag: "button",
      text: {
        tag: "plain_text",
        content: "停止",
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
        content: cardSummary(state),
      },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

export function renderLarkApprovalCard(input: LarkApprovalCardInput): Record<string, unknown> {
  const toolInput = input.toolInput === undefined ? "" : `\n${formatJson(input.toolInput)}`;

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
            approvalButtonColumn(input.requestId, "allow_once", "允许一次", "primary"),
            approvalButtonColumn(input.requestId, "allow_session", "本轮允许", "default"),
            approvalButtonColumn(input.requestId, "deny", "拒绝", "danger"),
          ],
        },
      ],
    },
  };
}

function markdownElement(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
  };
}

function approvalButtonColumn(
  requestId: string,
  decision: "allow_once" | "allow_session" | "deny",
  text: string,
  type: "primary" | "default" | "danger",
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

function cardSummary(state: LarkRunState): string {
  if (state.status === "running") {
    return "Agent is running";
  }
  const text = state.resultText || state.assistantText;
  return text.trim().slice(0, 80) || "Done";
}
