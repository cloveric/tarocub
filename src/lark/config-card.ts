import path from "node:path";

import { SessionStore } from "../state/session-store.js";
import {
  applyEngineSelection,
  loadInstanceConfig,
  updateInstanceConfig,
  type GroupModeConfig,
  type InstanceConfig,
  type InstanceEngine,
} from "../telegram/instance-config.js";
import type { Locale } from "../telegram/message-renderer.js";
import { LarkGroupModeStore } from "./group-mode-store.js";
import { readRawLarkConfig } from "./locale.js";

const LARK_CONFIG_ENGINES: InstanceEngine[] = ["codex", "claude", "antigravity"];

export type LarkConfigActionName = "engine" | "fast" | "yolo" | "locale" | "group" | "refresh";

export interface LarkConfigCardActionValue extends Record<string, unknown> {
  cctb_lark: "config";
  action: LarkConfigActionName;
  value?: string;
  conversationKey: string;
  bridgeChatType?: "private" | "group";
  replyInThread?: boolean;
  larkChatId?: string;
  bridgeChatId?: number;
}

export interface LarkConfigCardContext {
  stateDir: string;
  conversationKey: string;
  bridgeChatType: "private" | "group";
  larkChatId: string;
  bridgeChatId: number;
  replyInThread?: boolean;
  locale: Locale;
  requireMentionInGroup?: boolean;
  notice?: string;
}

export function isLarkConfigCommand(text: string): boolean {
  return /^\/config(?:\s|$)/i.test(text.trim());
}

export function isLarkConfigCardActionValue(value: Record<string, unknown>): value is LarkConfigCardActionValue {
  return value.cctb_lark === "config" &&
    typeof value.conversationKey === "string" &&
    isLarkConfigActionName(value.action);
}

export async function renderLarkConfigCard(input: LarkConfigCardContext): Promise<Record<string, unknown>> {
  const cfg = await loadInstanceConfig(input.stateDir);
  const raw = await readRawLarkConfig(input.stateDir);
  const groupState = await readLarkConfigGroupState(input, cfg);
  const labels = larkConfigLabels(input.locale);
  const approvalMode = approvalModeLabel(raw.approvalMode, input.locale);
  const fastOn = cfg.codexServiceTier === "fast";
  const requiresMention = input.bridgeChatType === "group"
    ? input.requireMentionInGroup !== false && !groupState.listenAll
    : true;
  const summaryLines = [
    `**${labels.title}**`,
    "",
    input.notice ? `**${labels.updated}** ${input.notice}` : undefined,
    `- ${labels.engine}: ${cfg.engine}`,
    `- ${labels.model}: ${cfg.model ?? labels.defaultValue}`,
    `- ${labels.effort}: ${cfg.effort ?? labels.defaultValue}`,
    `- ${labels.fast}: ${fastOn ? labels.on : labels.off}`,
    `- ${labels.yolo}: ${approvalMode}`,
    `- ${labels.locale}: ${input.locale}`,
    input.bridgeChatType === "group"
      ? `- ${labels.group}: ${groupState.allowed ? labels.groupAllowed : labels.groupNotAllowed}; ${requiresMention ? labels.groupAt : labels.groupAll}`
      : `- ${labels.group}: ${labels.privateChat}`,
  ].filter((line): line is string => line !== undefined);

  const elements: unknown[] = [
    markdownElement(summaryLines.join("\n")),
    section(labels.engineSection, [
      button(labels.codex, "engine", "codex", input, cfg.engine === "codex" ? "primary" : "default"),
      button(labels.claude, "engine", "claude", input, cfg.engine === "claude" ? "primary" : "default"),
      button(labels.antigravity, "engine", "antigravity", input, cfg.engine === "antigravity" ? "primary" : "default"),
    ]),
    section(labels.speedSection, [
      button(labels.fastOn, "fast", "on", input, fastOn ? "primary" : "default"),
      button(labels.fastOff, "fast", "off", input, !fastOn ? "primary" : "default"),
    ]),
    section(labels.approvalSection, [
      button(labels.yoloOn, "yolo", "on", input, raw.approvalMode === "full-auto" ? "primary" : "default"),
      button(labels.yoloOff, "yolo", "off", input, !raw.approvalMode || raw.approvalMode === "normal" ? "primary" : "default"),
      button(labels.yoloUnsafe, "yolo", "unsafe", input, raw.approvalMode === "bypass" ? "danger" : "default"),
    ]),
    section(labels.localeSection, [
      button("中文", "locale", "zh", input, input.locale === "zh" ? "primary" : "default"),
      button("English", "locale", "en", input, input.locale === "en" ? "primary" : "default"),
    ]),
  ];

  if (input.bridgeChatType === "group") {
    elements.push(section(labels.groupSection, [
      button(labels.groupAllow, "group", "allow", input, groupState.allowed ? "primary" : "default"),
      button(labels.groupAllButton, "group", "all", input, groupState.listenAll ? "primary" : "default"),
      button(labels.groupAtButton, "group", "at", input, !groupState.listenAll ? "primary" : "default"),
    ]));
  }

  elements.push(section(labels.utilitySection, [
    button(labels.refresh, "refresh", "now", input, "default"),
  ]));

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: {
        content: labels.title,
      },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

export async function applyLarkConfigCardAction(
  stateDir: string,
  value: LarkConfigCardActionValue,
  locale: Locale,
): Promise<string> {
  const labels = larkConfigLabels(locale);
  if (value.action === "refresh") {
    return labels.refreshed;
  }
  if (value.action === "engine") {
    return await applyEngineAction(stateDir, value.value, locale);
  }
  if (value.action === "fast") {
    return await applyFastAction(stateDir, value.value, locale);
  }
  if (value.action === "yolo") {
    return await applyYoloAction(stateDir, value.value, locale);
  }
  if (value.action === "locale") {
    return await applyLocaleAction(stateDir, value.value, locale);
  }
  if (value.action === "group") {
    return await applyGroupAction(stateDir, value, locale);
  }
  return locale === "en" ? "Unsupported config action." : "不支持的配置操作。";
}

async function applyEngineAction(stateDir: string, value: string | undefined, locale: Locale): Promise<string> {
  if (!LARK_CONFIG_ENGINES.includes(value as InstanceEngine)) {
    return locale === "en" ? "Invalid engine choice." : "无效的引擎选择。";
  }
  const selected = value as InstanceEngine;
  const cfg = await loadInstanceConfig(stateDir);
  const engineChanged = cfg.engine !== selected;
  let resetSessionBindings = false;
  if (engineChanged) {
    resetSessionBindings = (await new SessionStore(path.join(stateDir, "session.json")).clearAll()) > 0;
  }
  let clearedModel = false;
  let enabledFullAuto = false;
  await updateInstanceConfig(stateDir, (config) => {
    const result = applyEngineSelection(config, selected);
    clearedModel = result.clearedModel;
    enabledFullAuto = result.enabledFullAuto;
  });
  const details = [
    clearedModel ? (locale === "en" ? "cleared model override" : "已清除模型覆盖") : undefined,
    resetSessionBindings ? (locale === "en" ? "reset session bindings" : "已重置会话绑定") : undefined,
    enabledFullAuto ? (locale === "en" ? "enabled YOLO/full-auto for Antigravity" : "Antigravity 已开启 YOLO/full-auto") : undefined,
  ].filter((detail): detail is string => Boolean(detail));
  if (locale === "en") {
    return `Engine set to ${selected}${details.length ? ` (${details.join("; ")})` : ""}. Restart Lark service to fully apply.`;
  }
  return `引擎已设为 ${selected}${details.length ? `（${details.join("；")}）` : ""}。重启 Lark service 后完全生效。`;
}

async function applyFastAction(stateDir: string, value: string | undefined, locale: Locale): Promise<string> {
  const cfg = await loadInstanceConfig(stateDir);
  if (cfg.engine !== "codex") {
    return locale === "en" ? "Fast Mode is Codex-only." : "Fast Mode 仅 Codex 支持。";
  }
  if (value === "on") {
    await updateInstanceConfig(stateDir, (config) => {
      config.codexServiceTier = "fast";
    });
    return locale === "en" ? "Codex Fast Mode enabled." : "Codex Fast Mode 已开启。";
  }
  if (value === "off") {
    await updateInstanceConfig(stateDir, (config) => {
      delete config.codexServiceTier;
    });
    return locale === "en" ? "Codex Fast Mode disabled." : "Codex Fast Mode 已关闭。";
  }
  return locale === "en" ? "Invalid Fast Mode choice." : "无效的 Fast Mode 选择。";
}

async function applyYoloAction(stateDir: string, value: string | undefined, locale: Locale): Promise<string> {
  if (value === "on") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "full-auto";
    });
    return locale === "en" ? "YOLO/full-auto enabled." : "YOLO/full-auto 已开启。";
  }
  if (value === "off") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "normal";
    });
    return locale === "en" ? "YOLO disabled; normal approvals restored." : "YOLO 已关闭，恢复普通审批。";
  }
  if (value === "unsafe") {
    await updateInstanceConfig(stateDir, (config) => {
      config.approvalMode = "bypass";
    });
    return locale === "en" ? "YOLO unsafe/bypass enabled." : "YOLO unsafe/bypass 已开启。";
  }
  return locale === "en" ? "Invalid YOLO choice." : "无效的 YOLO 选择。";
}

async function applyLocaleAction(stateDir: string, value: string | undefined, locale: Locale): Promise<string> {
  if (value !== "zh" && value !== "en") {
    return locale === "en" ? "Invalid locale choice." : "无效的语言选择。";
  }
  await updateInstanceConfig(stateDir, (config) => {
    config.locale = value;
  });
  return value === "en" ? "Locale set to English." : "语言已设为中文。";
}

async function applyGroupAction(
  stateDir: string,
  value: LarkConfigCardActionValue,
  locale: Locale,
): Promise<string> {
  if (value.bridgeChatType !== "group" || !value.larkChatId || !Number.isInteger(value.bridgeChatId)) {
    return locale === "en" ? "Group settings are available only inside a Lark group." : "群聊设置只能在飞书群里使用。";
  }
  const groupAction = value.value;
  const store = new LarkGroupModeStore(stateDir);
  if (groupAction === "allow") {
    await updateGroupMode(stateDir, (groupMode) => {
      allowGroup(groupMode, value.bridgeChatId!);
    });
    return locale === "en" ? "Current Lark group allowed." : "当前飞书群已允许。";
  }
  if (groupAction === "all") {
    await updateGroupMode(stateDir, (groupMode) => {
      allowGroup(groupMode, value.bridgeChatId!);
      if (!groupMode.listenAllChatIds.includes(value.bridgeChatId!)) {
        groupMode.listenAllChatIds.push(value.bridgeChatId!);
      }
    });
    await store.setListenAll(value.larkChatId, true);
    return locale === "en" ? "Current group now accepts ordinary messages." : "当前群已切到监听普通消息。";
  }
  if (groupAction === "at") {
    await updateGroupMode(stateDir, (groupMode) => {
      allowGroup(groupMode, value.bridgeChatId!);
      groupMode.listenAllChatIds = groupMode.listenAllChatIds.filter((chatId) => chatId !== value.bridgeChatId);
    });
    await store.setListenAll(value.larkChatId, false);
    return locale === "en" ? "Current group now requires @bot / mention." : "当前群已切回需要 @bot / mention。";
  }
  return locale === "en" ? "Invalid group setting." : "无效的群聊设置。";
}

async function readLarkConfigGroupState(input: LarkConfigCardContext, cfg: InstanceConfig): Promise<{
  allowed: boolean;
  listenAll: boolean;
}> {
  if (input.bridgeChatType !== "group") {
    return { allowed: false, listenAll: false };
  }
  const listenAll = await new LarkGroupModeStore(input.stateDir).isListenAll(input.larkChatId);
  return {
    allowed: cfg.groupMode.enabled && cfg.groupMode.allowedChatIds.includes(input.bridgeChatId),
    listenAll: cfg.groupMode.enabled && listenAll,
  };
}

async function updateGroupMode(stateDir: string, updater: (groupMode: GroupModeConfig) => void): Promise<void> {
  await updateInstanceConfig(stateDir, (config) => {
    const groupMode = currentGroupMode(config.groupMode);
    updater(groupMode);
    config.groupMode = normalizeGroupMode(groupMode);
  });
}

function currentGroupMode(raw: unknown): GroupModeConfig {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return normalizeGroupMode({
    enabled: value.enabled === false ? false : true,
    allowedChatIds: Array.isArray(value.allowedChatIds)
      ? value.allowedChatIds.filter((item): item is number => Number.isInteger(item))
      : [],
    listenAllChatIds: Array.isArray(value.listenAllChatIds)
      ? value.listenAllChatIds.filter((item): item is number => Number.isInteger(item))
      : [],
  });
}

function normalizeGroupMode(groupMode: GroupModeConfig): GroupModeConfig {
  return {
    enabled: groupMode.enabled,
    allowedChatIds: [...new Set(groupMode.allowedChatIds)],
    listenAllChatIds: groupMode.enabled ? [...new Set(groupMode.listenAllChatIds)] : [],
  };
}

function allowGroup(groupMode: GroupModeConfig, chatId: number): void {
  groupMode.enabled = true;
  if (!groupMode.allowedChatIds.includes(chatId)) {
    groupMode.allowedChatIds.push(chatId);
  }
}

function section(title: string, buttons: unknown[]): Record<string, unknown> {
  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: "default",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          markdownElement(`**${title}**`),
          {
            tag: "column_set",
            flex_mode: "none",
            columns: buttons.map((item) => ({
              tag: "column",
              width: "weighted",
              weight: 1,
              elements: [item],
            })),
          },
        ],
      },
    ],
  };
}

function button(
  label: string,
  action: LarkConfigActionName,
  value: string,
  context: LarkConfigCardContext,
  type: "default" | "primary" | "danger",
): Record<string, unknown> {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: label,
    },
    type,
    behaviors: [callbackBehavior({
      cctb_lark: "config",
      action,
      value,
      conversationKey: context.conversationKey,
      bridgeChatType: context.bridgeChatType,
      ...(context.replyInThread ? { replyInThread: true } : {}),
      larkChatId: context.larkChatId,
      bridgeChatId: context.bridgeChatId,
    })],
  };
}

function markdownElement(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
  };
}

function callbackBehavior(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "callback",
    value,
  };
}

function isLarkConfigActionName(value: unknown): value is LarkConfigActionName {
  return value === "engine" ||
    value === "fast" ||
    value === "yolo" ||
    value === "locale" ||
    value === "group" ||
    value === "refresh";
}

function approvalModeLabel(value: unknown, locale: Locale): string {
  if (value === "bypass") {
    return "unsafe/bypass";
  }
  if (value === "full-auto") {
    return "full-auto";
  }
  return locale === "en" ? "normal approvals" : "普通审批";
}

function larkConfigLabels(locale: Locale): {
  title: string;
  updated: string;
  engine: string;
  model: string;
  effort: string;
  fast: string;
  yolo: string;
  locale: string;
  group: string;
  defaultValue: string;
  on: string;
  off: string;
  privateChat: string;
  groupAllowed: string;
  groupNotAllowed: string;
  groupAt: string;
  groupAll: string;
  engineSection: string;
  codex: string;
  claude: string;
  antigravity: string;
  speedSection: string;
  fastOn: string;
  fastOff: string;
  approvalSection: string;
  yoloOn: string;
  yoloOff: string;
  yoloUnsafe: string;
  localeSection: string;
  groupSection: string;
  groupAllow: string;
  groupAllButton: string;
  groupAtButton: string;
  utilitySection: string;
  refresh: string;
  refreshed: string;
} {
  if (locale === "en") {
    return {
      title: "Lark Config Panel",
      updated: "Updated:",
      engine: "Engine",
      model: "Model",
      effort: "Effort",
      fast: "Codex Fast Mode",
      yolo: "YOLO",
      locale: "Locale",
      group: "Group",
      defaultValue: "default",
      on: "on",
      off: "off",
      privateChat: "private chat",
      groupAllowed: "allowed",
      groupNotAllowed: "not allowed",
      groupAt: "requires @bot",
      groupAll: "accepts ordinary messages",
      engineSection: "Engine",
      codex: "Codex",
      claude: "Claude",
      antigravity: "Antigravity",
      speedSection: "Speed",
      fastOn: "Fast On",
      fastOff: "Fast Off",
      approvalSection: "Approvals",
      yoloOn: "YOLO On",
      yoloOff: "YOLO Off",
      yoloUnsafe: "Unsafe",
      localeSection: "Language",
      groupSection: "Group Mode",
      groupAllow: "Allow Group",
      groupAllButton: "Listen All",
      groupAtButton: "@ Only",
      utilitySection: "Utility",
      refresh: "Refresh",
      refreshed: "Refreshed.",
    };
  }
  return {
    title: "飞书配置面板",
    updated: "已更新：",
    engine: "引擎",
    model: "模型",
    effort: "推理强度",
    fast: "Codex Fast Mode",
    yolo: "YOLO",
    locale: "语言",
    group: "群聊",
    defaultValue: "默认",
    on: "开启",
    off: "关闭",
    privateChat: "私聊",
    groupAllowed: "已允许",
    groupNotAllowed: "未允许",
    groupAt: "需要 @bot",
    groupAll: "监听普通消息",
    engineSection: "引擎",
    codex: "Codex",
    claude: "Claude",
    antigravity: "Antigravity",
    speedSection: "速度",
    fastOn: "Fast 开",
    fastOff: "Fast 关",
    approvalSection: "审批",
    yoloOn: "YOLO 开",
    yoloOff: "YOLO 关",
    yoloUnsafe: "Unsafe",
    localeSection: "语言",
    groupSection: "群聊模式",
    groupAllow: "允许本群",
    groupAllButton: "全量监听",
    groupAtButton: "仅 @",
    utilitySection: "工具",
    refresh: "刷新",
    refreshed: "已刷新。",
  };
}
