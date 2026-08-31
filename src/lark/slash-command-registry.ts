export interface LarkSlashCommandDefinition {
  command: string;
  description: {
    defaultValue: string;
    i18n: Record<string, string>;
  };
}

function defineCommand(command: string, en: string, zh: string): LarkSlashCommandDefinition {
  return {
    command,
    description: {
      defaultValue: en,
      i18n: { en_us: en, zh_cn: zh },
    },
  };
}

/** Canonical command panel. Aliases stay out so the native picker remains useful. */
export const TAROCUB_LARK_SLASH_COMMANDS: readonly LarkSlashCommandDefinition[] = [
  defineCommand("help", "Show TaroCub help and command groups", "查看 TaroCub 帮助与命令分类"),
  defineCommand("status", "Show engine, session, and runtime status", "查看引擎、会话与运行状态"),
  defineCommand("usage", "Show token usage and cost for this bot", "查看当前 Bot 的用量与成本"),
  defineCommand("btw", "Ask a side question without changing the session", "旁问一个不影响当前会话的问题"),
  defineCommand("ask", "Delegate a prompt to another configured bot", "把任务委托给另一个已配置 Bot"),
  defineCommand("engine", "Inspect or switch the agent engine", "查看或切换 Agent 引擎"),
  defineCommand("model", "Inspect or change the current model", "查看或切换当前模型"),
  defineCommand("effort", "Inspect or change reasoning effort", "查看或调整推理强度"),
  defineCommand("fast", "Inspect or toggle Codex Fast Mode", "查看或切换 Codex 快速模式"),
  defineCommand("yolo", "Inspect or change tool approval mode", "查看或调整工具审批模式"),
  defineCommand("config", "Open the interactive settings panel", "打开交互式设置面板"),
  defineCommand("stream", "Inspect or toggle typewriter streaming", "查看或切换打字机流式输出"),
  defineCommand("timeout", "Inspect or change runtime safeguards", "查看或调整任务超时保护"),
  defineCommand("steer", "Inspect or change the mid-turn steering window", "查看或调整任务中途引导窗口"),
  defineCommand("account", "Show the bound Feishu or Lark app", "查看当前绑定的飞书或 Lark 应用"),
  defineCommand("goal", "Set, inspect, or clear the conversation goal", "设置、查看或清除会话目标"),
  defineCommand("resume", "Find or bind an existing native agent session", "查找或绑定已有原生 Agent 会话"),
  defineCommand("detach", "Detach the current native agent session", "解绑当前原生 Agent 会话"),
  defineCommand("reset", "Reset the current chat session binding", "重置当前聊天的会话绑定"),
  defineCommand("stop", "Stop the current running task", "停止当前正在运行的任务"),
  defineCommand("q", "Force a message into the task queue", "强制把消息作为新任务排队"),
  defineCommand("bg", "Inspect or stop engine background processes", "查看或停止引擎后台进程"),
  defineCommand("continue", "Continue the latest waiting archive analysis", "继续最近一个等待中的压缩包分析"),
  defineCommand("ws", "List, save, use, or remove workspaces", "列出、保存、切换或删除工作区"),
  defineCommand("context", "Show engine context usage where supported", "查看支持引擎的上下文用量"),
  defineCommand("compact", "Compact the current native agent session", "压缩当前原生 Agent 会话"),
  defineCommand("ultrareview", "Run the Claude deep-review workflow", "运行 Claude 深度审查流程"),
  defineCommand("cron", "Manage reminders and scheduled agent tasks", "管理提醒与定时 Agent 任务"),
  defineCommand("board", "Manage durable Kanban tasks", "管理持久化看板任务"),
  defineCommand("mini", "Manage lightweight peer agents in threads", "管理话题中的轻量 Peer Agent"),
  defineCommand("fan", "Run a prompt across configured peers in parallel", "让已配置 Peer 并行执行同一任务"),
  defineCommand("chain", "Run a prompt through configured peers in sequence", "让已配置 Peer 串行执行任务"),
  defineCommand("verify", "Execute locally, then ask a peer to verify", "本地执行后再交给 Peer 复核"),
  defineCommand("group", "Manage group access and mention mode", "管理群授权与 @ 提及模式"),
  defineCommand("invite", "Grant group or user access by mention", "通过 @ 提及授予群或用户访问权"),
  defineCommand("remove", "Revoke group or user access by mention", "通过 @ 提及撤销群或用户访问权"),
  defineCommand("newgroup", "Create and authorize a new project group", "创建并授权新的项目群"),
  defineCommand("newtopic", "Create and authorize a new topic group", "创建并授权新的话题群"),
  defineCommand("approve", "Approve a pending tool request", "批准待处理的工具请求"),
  defineCommand("approve-session", "Approve a request for the whole session", "为整个会话批准指定请求"),
  defineCommand("deny", "Deny a pending tool request", "拒绝待处理的工具请求"),
  defineCommand("meeting", "Join, inspect, invite to, or end a meeting", "加入、查看、邀请成员或结束会议"),
];

// These are implemented but intentionally omitted from the native picker:
// aliases would add noise, while /approval is an internal text fallback.
// "kanban" is the documented alias of /board (docs/slash-commands.md); dropping
// it from this set silently ate /kanban in mention-only groups.
const LARK_HIDDEN_OR_ALIAS_COMMANDS = ["start", "queue", "approval", "kanban"] as const;
const LARK_SLASH_COMMAND_NAMES = new Set([
  ...TAROCUB_LARK_SLASH_COMMANDS.map((definition) => definition.command),
  ...LARK_HIDDEN_OR_ALIAS_COMMANDS,
]);

/** Return true only for a command TaroCub actually implements, not an absolute path. */
export function isTaroCubLarkSlashCommand(content: string | undefined): boolean {
  const match = content?.trim().match(
    /^\/([a-z][a-z0-9_-]*)(?:@[a-z0-9_][a-z0-9_.-]*)?(?=\s|$)/i,
  );
  return Boolean(match?.[1] && LARK_SLASH_COMMAND_NAMES.has(match[1].toLowerCase()));
}
