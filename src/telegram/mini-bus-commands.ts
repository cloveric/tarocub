import type {
  AdapterUsage,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
} from "../codex/adapter.js";
import type { BusCrewConfig } from "../bus/bus-config.js";
import {
  MiniBusStore,
  MINI_BUS_CREW_ROLES,
  normalizeMiniBusCrewRole,
  normalizeMiniBusPeerName,
  type MiniBusCrewRole,
  type MiniBusGroupRecord,
  type MiniBusPeerRecord,
} from "../state/mini-bus-store.js";
import {
  appendUpdateHandleAuditEventBestEffort,
  maybeReplyWithBudgetExhausted,
  recordTurnUsageAndBudgetAudit,
  type TelegramTurnContext,
} from "./turn-bookkeeping.js";
import { handleCrewTelegramWorkflow, type CrewRoleName } from "./crew-workflow.js";
import { getNormalizedTelegramConversationKey } from "./conversation-key.js";
import { chunkTelegramMessage, type Locale } from "./message-renderer.js";
import type { ResumeState } from "./instance-config.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

export interface MiniBusCommandContext extends TelegramTurnContext {
  abortSignal?: AbortSignal;
  runQueuedBridgeTurn?<T>(conversationKey: string, job: () => Promise<T>): Promise<T>;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
}

export interface MiniBusCommandBridge {
  handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    messageThreadId?: number;
    conversationKey?: string;
    locale: Locale;
    text: string;
    files: string[];
    workspaceOverride?: string;
    abortSignal?: AbortSignal;
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  }): Promise<{
    text: string;
    usage?: AdapterUsage;
  }>;
}

type MiniBusAction =
  | { kind: "status" }
  | { kind: "here"; name: string }
  | { kind: "remove"; name: string }
  | { kind: "order"; names: string[] }
  | { kind: "parallel"; names: string[] }
  | { kind: "verifier"; name: string | null }
  | { kind: "role"; role: string; name: string }
  | { kind: "crew"; prompt: string }
  | { kind: "crewStatus" }
  | { kind: "ask"; name: string; prompt: string }
  | { kind: "fan"; prompt: string }
  | { kind: "chain"; prompt: string }
  | { kind: "verify"; raw: string }
  | { kind: "usage" };

function parseMiniBusCommand(text: string): MiniBusAction | null {
  const match = text.trim().match(/^\/mini(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return null;
  }

  const body = (match[1] ?? "").trim();
  if (!body || body.toLowerCase() === "status") {
    return { kind: "status" };
  }

  const [rawAction = "", ...restParts] = body.split(/\s+/);
  const action = rawAction.toLowerCase();
  const rest = restParts.join(" ").trim();

  if (action === "here" || action === "add" || action === "set") {
    return rest ? { kind: "here", name: rest } : { kind: "usage" };
  }
  if (action === "rm" || action === "remove" || action === "delete") {
    return rest ? { kind: "remove", name: rest } : { kind: "usage" };
  }
  if (action === "order" || action === "chain-order") {
    return rest ? { kind: "order", names: rest.split(/\s+/).filter(Boolean) } : { kind: "usage" };
  }
  if (action === "parallel" || action === "fan-order") {
    return rest ? { kind: "parallel", names: rest.split(/\s+/).filter(Boolean) } : { kind: "usage" };
  }
  if (action === "verifier" || action === "reviewer") {
    if (!rest) return { kind: "usage" };
    return { kind: "verifier", name: rest.toLowerCase() === "off" ? null : rest };
  }
  if (action === "role") {
    const roleMatch = rest.match(/^(\S+)\s+(\S+)$/);
    return roleMatch ? { kind: "role", role: roleMatch[1]!, name: roleMatch[2]! } : { kind: "usage" };
  }
  if (action === "crew") {
    if (!rest || rest.toLowerCase() === "status") {
      return { kind: "crewStatus" };
    }
    const crewMatch = rest.match(/^research-report\s+([\s\S]+)$/i);
    return crewMatch ? { kind: "crew", prompt: crewMatch[1]!.trim() } : { kind: "usage" };
  }
  if (action === "ask") {
    const askMatch = rest.match(/^(\S+)\s+([\s\S]+)$/);
    return askMatch ? { kind: "ask", name: askMatch[1]!, prompt: askMatch[2]!.trim() } : { kind: "usage" };
  }
  if (action === "fan") {
    return rest ? { kind: "fan", prompt: rest } : { kind: "usage" };
  }
  if (action === "chain") {
    return rest ? { kind: "chain", prompt: rest } : { kind: "usage" };
  }
  if (action === "verify") {
    return rest ? { kind: "verify", raw: rest } : { kind: "usage" };
  }

  return { kind: "usage" };
}

function renderMiniBusUsage(locale: Locale): string {
  return locale === "zh"
    ? "用法: /mini [status|here <名称>|rm <名称>|order <名称...>|parallel <名称...>|verifier <名称|off>|role <角色> <名称>|crew research-report <提示>|ask <名称> <提示>|fan <提示>|chain <提示>|verify [名称] <提示>]"
    : "Usage: /mini [status|here <name>|rm <name>|order <names...>|parallel <names...>|verifier <name|off>|role <role> <name>|crew research-report <prompt>|ask <name> <prompt>|fan <prompt>|chain <prompt>|verify [name] <prompt>]";
}

function renderMiniBusGroupRequired(locale: Locale): string {
  return locale === "zh"
    ? "Mini Bus 需要在 Telegram 群聊或 forum topic 里使用。"
    : "Mini Bus must be used inside a Telegram group or forum topic.";
}

function renderInvalidPeerName(locale: Locale): string {
  return locale === "zh"
    ? "名称无效。请使用 1-32 位小写字母、数字、下划线或连字符。"
    : "Invalid name. Use 1-32 lowercase letters, numbers, underscores, or hyphens.";
}

function renderNoMiniPeers(locale: Locale): string {
  return locale === "zh"
    ? "当前群还没有 Mini Bus topic peer。请在每个目标 topic 内发送 /mini here <名称>。"
    : "No Mini Bus topic peers registered for this group. Send /mini here <name> inside each target topic.";
}

function renderMiniBusStatus(input: {
  locale: Locale;
  peers: MiniBusPeerRecord[];
  parallel: string[];
  chain: string[];
  verifier?: string;
  roles: MiniBusGroupRecord["roles"];
  crew: MiniBusGroupRecord["crew"];
  currentConversationKey: string;
}): string {
  if (input.peers.length === 0) {
    return renderNoMiniPeers(input.locale);
  }

  const rows = input.peers.map((peer) => {
    const topic = peer.messageThreadId === undefined ? "main chat" : `topic ${peer.messageThreadId}`;
    const current = peer.conversationKey === input.currentConversationKey ? " *" : "";
    return `- ${peer.name}: ${topic}${current}`;
  });
  const header = input.locale === "zh"
    ? "当前群的 Mini Bus topic peers："
    : "Mini Bus topic peers for this group:";
  const configRows = input.locale === "zh"
    ? [
        `parallel：${input.parallel.length > 0 ? input.parallel.join(", ") : "默认全部 peer"}`,
        `chain：${input.chain.length > 0 ? input.chain.join(" -> ") : "默认注册顺序"}`,
        `verifier：${input.verifier ?? "未设置"}`,
        `crew roles：${renderMiniCrewRoles(input.roles, "zh")}`,
        `crew：research-report (maxResearchQuestions=${input.crew.maxResearchQuestions}, maxRevisionRounds=${input.crew.maxRevisionRounds})`,
      ]
    : [
        `parallel: ${input.parallel.length > 0 ? input.parallel.join(", ") : "all peers by default"}`,
        `chain: ${input.chain.length > 0 ? input.chain.join(" -> ") : "registration order by default"}`,
        `verifier: ${input.verifier ?? "not set"}`,
        `crew roles: ${renderMiniCrewRoles(input.roles, "en")}`,
        `crew: research-report (maxResearchQuestions=${input.crew.maxResearchQuestions}, maxRevisionRounds=${input.crew.maxRevisionRounds})`,
      ];
  return [header, ...rows, "", ...configRows].join("\n");
}

function renderMiniCrewRoles(roles: MiniBusGroupRecord["roles"], locale: Locale): string {
  const pairs = MINI_BUS_CREW_ROLES
    .map((role) => roles[role] ? `${role}=${roles[role]}` : null)
    .filter((pair): pair is string => pair !== null);
  if (pairs.length === 0) {
    return locale === "zh" ? "未配置" : "not configured";
  }
  return pairs.join(", ");
}

function buildMiniChainStagePrompt(input: {
  locale: Locale;
  originalPrompt: string;
  previousPeer: string;
  previousOutput: string;
}): string {
  if (input.locale === "zh") {
    return [
      `原始任务：${input.originalPrompt}`,
      "",
      `上一阶段（${input.previousPeer}）输出：`,
      input.previousOutput,
      "",
      "请在此基础上继续处理，并返回你的结果。",
    ].join("\n");
  }

  return [
    `Original task: ${input.originalPrompt}`,
    "",
    `Previous stage output (${input.previousPeer}):`,
    input.previousOutput,
    "",
    "Continue from this point and return your updated result.",
  ].join("\n");
}

async function sendChunked(
  api: Pick<MiniBusCommandContext["api"], "sendMessage">,
  chatId: number,
  text: string,
): Promise<number> {
  const chunks = chunkTelegramMessage(text);
  await api.sendMessage(chatId, chunks[0]!);
  for (const chunk of chunks.slice(1)) {
    await api.sendMessage(chatId, chunk);
  }
  return chunks.length;
}

async function sendMiniReplyAndAudit(input: {
  stateDir: string;
  startedAt: number;
  context: MiniBusCommandContext;
  normalized: NormalizedTelegramMessage;
  responseText: string;
  outcome: "success" | "reply" | "invalid";
  action: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await input.context.api.sendMessage(input.normalized.chatId, input.responseText);
  await appendUpdateHandleAuditEventBestEffort(input.stateDir, input.context, input.normalized, {
    outcome: input.outcome,
    detail: input.detail,
    metadata: {
      durationMs: Date.now() - input.startedAt,
      command: "mini",
      action: input.action,
      responseChars: input.responseText.length,
      chunkCount: chunkTelegramMessage(input.responseText).length,
      ...input.metadata,
    },
  });
}

async function executeMiniPeer(input: {
  bridge: MiniBusCommandBridge;
  peer: MiniBusPeerRecord;
  normalized: NormalizedTelegramMessage;
  locale: Locale;
  prompt: string;
  resume?: ResumeState;
  abortSignal?: AbortSignal;
  runQueuedBridgeTurn?: MiniBusCommandContext["runQueuedBridgeTurn"];
  onApprovalRequest?: MiniBusCommandContext["onApprovalRequest"];
  onEngineEvent?: MiniBusCommandContext["onEngineEvent"];
}): Promise<{ name: string; text: string; usage?: AdapterUsage; error: null | string }> {
  try {
    const run = input.runQueuedBridgeTurn ?? (async <T>(_conversationKey: string, job: () => Promise<T>) => await job());
    const result = await run(input.peer.conversationKey, async () => await input.bridge.handleAuthorizedMessage({
      chatId: input.peer.chatId,
      userId: input.normalized.userId,
      chatType: "bus",
      ...(input.peer.messageThreadId !== undefined ? { messageThreadId: input.peer.messageThreadId } : {}),
      conversationKey: input.peer.conversationKey,
      locale: input.locale,
      text: input.prompt,
      files: [],
      workspaceOverride: input.resume?.workspacePath,
      abortSignal: input.abortSignal,
      onApprovalRequest: input.onApprovalRequest,
      onEngineEvent: input.onEngineEvent,
    }));
    return { name: input.peer.name, text: result.text, usage: result.usage, error: null };
  } catch (error) {
    return { name: input.peer.name, text: "", error: error instanceof Error ? error.message : String(error) };
  }
}

async function executeCurrentTopic(input: {
  bridge: MiniBusCommandBridge;
  normalized: NormalizedTelegramMessage;
  locale: Locale;
  prompt: string;
  resume?: ResumeState;
  abortSignal?: AbortSignal;
  onApprovalRequest?: MiniBusCommandContext["onApprovalRequest"];
  onEngineEvent?: MiniBusCommandContext["onEngineEvent"];
}): Promise<{ text: string; usage?: AdapterUsage }> {
  return await input.bridge.handleAuthorizedMessage({
    chatId: input.normalized.chatId,
    userId: input.normalized.userId,
    chatType: input.normalized.chatType,
    ...(input.normalized.messageThreadId !== undefined ? { messageThreadId: input.normalized.messageThreadId } : {}),
    conversationKey: getNormalizedTelegramConversationKey(input.normalized),
    locale: input.locale,
    text: input.prompt,
    files: [],
    workspaceOverride: input.resume?.workspacePath,
    abortSignal: input.abortSignal,
    onApprovalRequest: input.onApprovalRequest,
    onEngineEvent: input.onEngineEvent,
  });
}

function runnablePeers(peers: MiniBusPeerRecord[], currentConversationKey: string): MiniBusPeerRecord[] {
  return peers.filter((peer) => peer.conversationKey !== currentConversationKey);
}

function resolveNamedPeers(input: {
  peers: MiniBusPeerRecord[];
  names: string[];
  currentConversationKey: string;
}): { peers: MiniBusPeerRecord[]; missing: string[]; skippedCurrent: string[] } {
  const byName = new Map(input.peers.map((peer) => [peer.name, peer]));
  const resolved: MiniBusPeerRecord[] = [];
  const missing: string[] = [];
  const skippedCurrent: string[] = [];
  for (const rawName of input.names) {
    const name = normalizeMiniBusPeerName(rawName);
    const peer = name ? byName.get(name) : undefined;
    if (!name || !peer) {
      missing.push(rawName);
      continue;
    }
    if (peer.conversationKey !== input.currentConversationKey) {
      resolved.push(peer);
    } else {
      skippedCurrent.push(peer.name);
    }
  }
  return { peers: resolved, missing, skippedCurrent };
}

function resolveConfiguredPeers(input: {
  peers: MiniBusPeerRecord[];
  configuredNames: string[];
  currentConversationKey: string;
}): { peers: MiniBusPeerRecord[]; missing: string[]; skippedCurrent: string[] } {
  if (input.configuredNames.length === 0) {
    return { peers: runnablePeers(input.peers, input.currentConversationKey), missing: [], skippedCurrent: [] };
  }
  return resolveNamedPeers({
    peers: input.peers,
    names: input.configuredNames,
    currentConversationKey: input.currentConversationKey,
  });
}

function resolveMiniCrewRolePeers(input: {
  group: MiniBusGroupRecord;
  currentConversationKey: string;
}): {
  peersByRole: Record<MiniBusCrewRole, MiniBusPeerRecord> | null;
  missingRoles: MiniBusCrewRole[];
  missingPeers: string[];
  selfRoles: MiniBusCrewRole[];
  duplicatePeers: string[];
} {
  const byName = new Map(input.group.peers.map((peer) => [peer.name, peer]));
  const missingRoles: MiniBusCrewRole[] = [];
  const missingPeers: string[] = [];
  const selfRoles: MiniBusCrewRole[] = [];
  const rolesByPeerName = new Map<string, MiniBusCrewRole[]>();
  const peersByRole: Partial<Record<MiniBusCrewRole, MiniBusPeerRecord>> = {};

  for (const role of MINI_BUS_CREW_ROLES) {
    const peerName = input.group.roles[role];
    if (!peerName) {
      missingRoles.push(role);
      continue;
    }
    const peer = byName.get(peerName);
    if (!peer) {
      missingPeers.push(peerName);
      continue;
    }
    if (peer.conversationKey === input.currentConversationKey) {
      selfRoles.push(role);
      continue;
    }
    rolesByPeerName.set(peer.name, [...(rolesByPeerName.get(peer.name) ?? []), role]);
    peersByRole[role] = peer;
  }

  const duplicatePeers = [...rolesByPeerName.entries()]
    .filter(([, roles]) => roles.length > 1)
    .map(([peerName, roles]) => `${peerName} (${roles.join(", ")})`);

  if (missingRoles.length > 0 || missingPeers.length > 0 || selfRoles.length > 0 || duplicatePeers.length > 0) {
    return { peersByRole: null, missingRoles, missingPeers, selfRoles, duplicatePeers };
  }

  return {
    peersByRole: peersByRole as Record<MiniBusCrewRole, MiniBusPeerRecord>,
    missingRoles,
    missingPeers,
    selfRoles,
    duplicatePeers,
  };
}

function renderMiniCrewRoleProblem(input: {
  locale: Locale;
  missingRoles: MiniBusCrewRole[];
  missingPeers: string[];
  selfRoles: MiniBusCrewRole[];
  duplicatePeers: string[];
}): string {
  const parts: string[] = [];
  if (input.missingRoles.length > 0) {
    parts.push(input.locale === "zh"
      ? `未配置角色：${input.missingRoles.join(", ")}`
      : `missing roles: ${input.missingRoles.join(", ")}`);
  }
  if (input.missingPeers.length > 0) {
    parts.push(input.locale === "zh"
      ? `找不到 peer：${input.missingPeers.join(", ")}`
      : `missing peers: ${input.missingPeers.join(", ")}`);
  }
  if (input.selfRoles.length > 0) {
    parts.push(input.locale === "zh"
      ? `角色不能指向当前 topic：${input.selfRoles.join(", ")}`
      : `roles cannot target the current topic: ${input.selfRoles.join(", ")}`);
  }
  if (input.duplicatePeers.length > 0) {
    parts.push(input.locale === "zh"
      ? `重复角色 peer：${input.duplicatePeers.join(", ")}`
      : `duplicate role peers: ${input.duplicatePeers.join(", ")}`);
  }
  return input.locale === "zh"
    ? `Mini crew 配置不完整：${parts.join("；")}。请用 /mini role <角色> <peer> 配置。`
    : `Mini crew is not configured: ${parts.join("; ")}. Use /mini role <role> <peer>.`;
}

function createMiniCrewConfig(input: {
  coordinatorName: string;
  group: MiniBusGroupRecord;
  peersByRole: Record<MiniBusCrewRole, MiniBusPeerRecord>;
}): BusCrewConfig {
  return {
    enabled: true,
    workflow: "research-report",
    coordinator: input.coordinatorName,
    roles: {
      researcher: input.peersByRole.researcher.name,
      analyst: input.peersByRole.analyst.name,
      writer: input.peersByRole.writer.name,
      reviewer: input.peersByRole.reviewer.name,
    },
    maxResearchQuestions: input.group.crew.maxResearchQuestions,
    maxRevisionRounds: input.group.crew.maxRevisionRounds,
  };
}

async function enqueueMiniCrewPeerTurn<T>(
  queues: Map<string, Promise<void>>,
  conversationKey: string,
  job: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(conversationKey) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(job);
  queues.set(conversationKey, run.then(
    () => undefined,
    () => undefined,
  ));
  return await run;
}

export async function handleMiniBusTelegramCommand(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: {
    budgetUsd?: number;
    resume?: ResumeState;
  };
  normalized: NormalizedTelegramMessage;
  context: MiniBusCommandContext;
  bridge: MiniBusCommandBridge;
  store?: MiniBusStore;
}): Promise<boolean> {
  const action = parseMiniBusCommand(input.normalized.text);
  if (!action) {
    return false;
  }

  const { stateDir, startedAt, locale, cfg, normalized, context, bridge } = input;
  const store = input.store ?? new MiniBusStore(stateDir);
  const currentConversationKey = getNormalizedTelegramConversationKey(normalized);

  if (normalized.chatType === "private") {
    const responseText = renderMiniBusGroupRequired(locale);
    await context.api.sendMessage(normalized.chatId, responseText);
    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: "reply",
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "mini",
        action: action.kind,
      },
    });
    return true;
  }

  if (action.kind === "usage") {
    const responseText = renderMiniBusUsage(locale);
    await context.api.sendMessage(normalized.chatId, responseText);
    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: "invalid",
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "mini",
      },
    });
    return true;
  }

  if (action.kind === "status" || action.kind === "crewStatus") {
    const group = await store.getGroup(normalized.chatId);
    const responseText = renderMiniBusStatus({
      locale,
      peers: group.peers,
      parallel: group.parallel,
      chain: group.chain,
      verifier: group.verifier,
      roles: group.roles,
      crew: group.crew,
      currentConversationKey,
    });
    await context.api.sendMessage(normalized.chatId, responseText);
    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: "success",
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "mini",
        action: action.kind === "crewStatus" ? "crew-status" : "status",
      },
    });
    return true;
  }

  if (action.kind === "order" || action.kind === "parallel") {
    const normalizedNames = action.names.map((name) => normalizeMiniBusPeerName(name));
    if (normalizedNames.some((name) => name === null)) {
      await sendMiniReplyAndAudit({
        stateDir,
        startedAt,
        context,
        normalized,
        responseText: renderInvalidPeerName(locale),
        outcome: "invalid",
        action: action.kind,
      });
      return true;
    }
    const peers = await store.listPeers(normalized.chatId);
    const missing = normalizedNames
      .filter((name): name is string => name !== null)
      .filter((name) => !peers.some((peer) => peer.name === name));
    if (missing.length > 0) {
      const responseText = locale === "zh"
        ? `未找到 Mini Bus peer：${missing.join(", ")}`
        : `Mini topic peers not found: ${missing.join(", ")}`;
      await sendMiniReplyAndAudit({
        stateDir,
        startedAt,
        context,
        normalized,
        responseText,
        outcome: "invalid",
        action: action.kind,
        metadata: { missing },
      });
      return true;
    }

    const saved = action.kind === "order"
      ? await store.setChain(normalized.chatId, action.names)
      : await store.setParallel(normalized.chatId, action.names);
    const responseText = action.kind === "order"
      ? (locale === "zh" ? `Mini chain 顺序：${saved.join(" -> ")}` : `Mini chain order: ${saved.join(" -> ")}`)
      : (locale === "zh" ? `Mini parallel peers：${saved.join(", ")}` : `Mini parallel peers: ${saved.join(", ")}`);
    await sendMiniReplyAndAudit({
      stateDir,
      startedAt,
      context,
      normalized,
      responseText,
      outcome: "success",
      action: action.kind,
      metadata: { miniTargets: saved },
    });
    return true;
  }

  if (action.kind === "verifier") {
    if (action.name !== null) {
      const name = normalizeMiniBusPeerName(action.name);
      const peer = name ? await store.getPeer(normalized.chatId, name) : null;
      if (!name || !peer) {
        const responseText = !name
          ? renderInvalidPeerName(locale)
          : locale === "zh" ? `未找到 Mini Bus peer ${name}。` : `Mini topic peer ${name} was not found.`;
        await sendMiniReplyAndAudit({
          stateDir,
          startedAt,
          context,
          normalized,
          responseText,
          outcome: "invalid",
          action: "verifier",
        });
        return true;
      }
    }
    const verifier = await store.setVerifier(normalized.chatId, action.name);
    const responseText = verifier
      ? (locale === "zh" ? `Mini verifier：${verifier}` : `Mini verifier: ${verifier}`)
      : (locale === "zh" ? "Mini verifier 已关闭。" : "Mini verifier disabled.");
    await sendMiniReplyAndAudit({
      stateDir,
      startedAt,
      context,
      normalized,
      responseText,
      outcome: "success",
      action: "verifier",
      metadata: { verifier },
    });
    return true;
  }

  if (action.kind === "role") {
    const role = normalizeMiniBusCrewRole(action.role);
    const name = normalizeMiniBusPeerName(action.name);
    if (!role || !name) {
      await sendMiniReplyAndAudit({
        stateDir,
        startedAt,
        context,
        normalized,
        responseText: !role
          ? (locale === "zh"
              ? `角色无效。可用角色：${MINI_BUS_CREW_ROLES.join(", ")}`
              : `Invalid role. Available roles: ${MINI_BUS_CREW_ROLES.join(", ")}`)
          : renderInvalidPeerName(locale),
        outcome: "invalid",
        action: "role",
      });
      return true;
    }
    const peer = await store.getPeer(normalized.chatId, name);
    if (!peer) {
      await sendMiniReplyAndAudit({
        stateDir,
        startedAt,
        context,
        normalized,
        responseText: locale === "zh"
          ? `未找到 Mini Bus peer ${name}。请先在目标 topic 发送 /mini here ${name}。`
          : `Mini topic peer ${name} was not found. Send /mini here ${name} in the target topic first.`,
        outcome: "invalid",
        action: "role",
        metadata: { role, miniTarget: name },
      });
      return true;
    }
    const saved = await store.setRole(normalized.chatId, role, peer.name);
    await sendMiniReplyAndAudit({
      stateDir,
      startedAt,
      context,
      normalized,
      responseText: locale === "zh"
        ? `Mini crew role ${role}：${saved}`
        : `Mini crew role ${role}: ${saved}`,
      outcome: "success",
      action: "role",
      metadata: { role, miniTarget: saved },
    });
    return true;
  }

  if (action.kind === "here") {
    const name = normalizeMiniBusPeerName(action.name);
    if (!name) {
      await sendMiniReplyAndAudit({
        stateDir,
        startedAt,
        context,
        normalized,
        responseText: renderInvalidPeerName(locale),
        outcome: "invalid",
        action: "here",
      });
      return true;
    }

    const peer = await store.upsertPeer({
      name,
      chatId: normalized.chatId,
      messageThreadId: normalized.messageThreadId,
      conversationKey: currentConversationKey,
    });
    const topic = peer.messageThreadId === undefined ? "main chat" : `topic ${peer.messageThreadId}`;
    const responseText = locale === "zh"
      ? `已注册 Mini Bus peer ${peer.name} (${topic})。`
      : `Registered mini topic peer ${peer.name} (${topic}).`;
    await context.api.sendMessage(normalized.chatId, responseText);
    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: "success",
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "mini",
        action: "here",
        miniPeer: peer.name,
      },
    });
    return true;
  }

  if (action.kind === "remove") {
    const removedName = normalizeMiniBusPeerName(action.name);
    if (!removedName) {
      await sendMiniReplyAndAudit({
        stateDir,
        startedAt,
        context,
        normalized,
        responseText: renderInvalidPeerName(locale),
        outcome: "invalid",
        action: "remove",
      });
      return true;
    }

    const removed = await store.removePeer(normalized.chatId, removedName);
    const responseText = removed
      ? (locale === "zh" ? `已移除 Mini Bus peer ${removedName}。` : `Removed mini topic peer ${removedName}.`)
      : (locale === "zh" ? `未找到 Mini Bus peer ${removedName}。` : `Mini topic peer ${removedName} was not found.`);
    await context.api.sendMessage(normalized.chatId, responseText);
    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: "success",
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "mini",
        action: "remove",
        miniPeer: removedName,
        removed,
      },
    });
    return true;
  }

  if (await maybeReplyWithBudgetExhausted(stateDir, cfg.budgetUsd, locale, context, normalized)) {
    return true;
  }

  if (action.kind === "crew") {
    const group = await store.getGroup(normalized.chatId);
    const resolved = resolveMiniCrewRolePeers({ group, currentConversationKey });
    if (!resolved.peersByRole) {
      await sendMiniReplyAndAudit({
        stateDir,
        startedAt,
        context,
        normalized,
        responseText: renderMiniCrewRoleProblem({
          locale,
          missingRoles: resolved.missingRoles,
          missingPeers: resolved.missingPeers,
          selfRoles: resolved.selfRoles,
          duplicatePeers: resolved.duplicatePeers,
        }),
        outcome: "invalid",
        action: "crew",
        metadata: {
          missingRoles: resolved.missingRoles,
          missingPeers: resolved.missingPeers,
          selfRoles: resolved.selfRoles,
          duplicatePeers: resolved.duplicatePeers,
        },
      });
      return true;
    }

    const coordinatorName = "mini";
    const crewConfig = createMiniCrewConfig({
      coordinatorName,
      group,
      peersByRole: resolved.peersByRole,
    });
    const rolePeers = resolved.peersByRole;
    const roleQueues = new Map<string, Promise<void>>();
    const crewNormalized: NormalizedTelegramMessage = {
      ...normalized,
      text: action.prompt,
      attachments: [],
    };
    return await handleCrewTelegramWorkflow({
      stateDir,
      startedAt,
      locale,
      cfg,
      normalized: crewNormalized,
      context: {
        ...context,
        bridge,
        onApprovalRequest: context.onApprovalRequest,
        onEngineEvent: context.onEngineEvent,
      },
      crewConfig,
      coordinatorName,
      activeRunKey: `${stateDir}:${currentConversationKey}:mini-crew`,
      auditCommand: "mini",
      auditMetadata: { action: "crew" },
      delegateRole: async (delegateInput) => {
        const role = delegateInput.role as CrewRoleName;
        const peer = rolePeers[role];
        const result = await enqueueMiniCrewPeerTurn(roleQueues, peer.conversationKey, async () => await executeMiniPeer({
            bridge,
            peer,
            normalized,
            locale,
            prompt: delegateInput.prompt,
            resume: cfg.resume,
            abortSignal: context.abortSignal,
            runQueuedBridgeTurn: context.runQueuedBridgeTurn,
            onApprovalRequest: context.onApprovalRequest,
            onEngineEvent: context.onEngineEvent,
          }));
        if (result.error) {
          throw new Error(`${delegateInput.targetName}: ${result.error}`);
        }
        return { text: result.text, usage: result.usage };
      },
    });
  }

  if (action.kind === "ask") {
    const peer = await store.getPeer(normalized.chatId, action.name);
    if (!peer) {
      await sendMiniReplyAndAudit({
        stateDir,
        startedAt,
        context,
        normalized,
        responseText: locale === "zh" ? `未找到 Mini Bus peer ${action.name}。` : `Mini topic peer ${action.name} was not found.`,
        outcome: "invalid",
        action: "ask",
        metadata: { miniTarget: action.name },
      });
      return true;
    }
    if (peer.conversationKey === currentConversationKey) {
      await sendMiniReplyAndAudit({
        stateDir,
        startedAt,
        context,
        normalized,
        responseText: locale === "zh" ? "不能委托给当前 topic 自己。" : "Cannot delegate to the current topic.",
        outcome: "invalid",
        action: "ask",
        metadata: { miniTarget: peer.name, selfTarget: true },
      });
      return true;
    }

    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? `正在询问 Mini topic ${peer.name}...` : `Asking mini topic ${peer.name}...`,
    );
    const result = await executeMiniPeer({
      bridge,
      peer,
      normalized,
      locale,
      prompt: action.prompt,
      resume: cfg.resume,
      abortSignal: context.abortSignal,
      runQueuedBridgeTurn: context.runQueuedBridgeTurn,
      onApprovalRequest: context.onApprovalRequest,
      onEngineEvent: context.onEngineEvent,
    });
    if (result.usage) {
      await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);
    }
    const responseText = result.error
      ? `[${result.name}] Error: ${result.error}`
      : `[${result.name}]\n\n${result.text}`;
    const chunkCount = await sendChunked(context.api, normalized.chatId, responseText);
    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: result.error ? "error" : "success",
      detail: result.error ?? undefined,
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "mini",
        action: "ask",
        miniTarget: peer.name,
        responseChars: responseText.length,
        chunkCount,
      },
    });
    return true;
  }

  if (action.kind === "verify") {
    const group = await store.getGroup(normalized.chatId);
    const [candidate = "", ...restParts] = action.raw.split(/\s+/);
    const candidateName = normalizeMiniBusPeerName(candidate);
    const candidatePeer = candidateName ? group.peers.find((peer) => peer.name === candidateName) : undefined;
    const verifierName = candidatePeer && restParts.length > 0 ? candidatePeer.name : group.verifier;
    const prompt = candidatePeer && restParts.length > 0 ? restParts.join(" ").trim() : action.raw;
    const verifier = verifierName ? group.peers.find((peer) => peer.name === verifierName) : undefined;

    if (!verifier) {
      await sendMiniReplyAndAudit({
        stateDir,
        startedAt,
        context,
        normalized,
        responseText: locale === "zh"
          ? "未设置 Mini verifier。请先发送 /mini verifier <名称>，或使用 /mini verify <名称> <提示>。"
          : "No Mini verifier set. Send /mini verifier <name> first, or use /mini verify <name> <prompt>.",
        outcome: "invalid",
        action: "verify",
      });
      return true;
    }
    if (verifier.conversationKey === currentConversationKey) {
      await sendMiniReplyAndAudit({
        stateDir,
        startedAt,
        context,
        normalized,
        responseText: locale === "zh" ? "Mini verifier 不能是当前 topic 自己。" : "Mini verifier cannot be the current topic.",
        outcome: "invalid",
        action: "verify",
        metadata: { verifier: verifier.name, selfTarget: true },
      });
      return true;
    }

    await context.api.sendMessage(normalized.chatId, locale === "zh" ? "正在执行..." : "Executing...");
    let verifyOutcome: "success" | "error" = "success";
    try {
      const currentResult = await executeCurrentTopic({
        bridge,
        normalized,
        locale,
        prompt,
        resume: cfg.resume,
        abortSignal: context.abortSignal,
        onApprovalRequest: context.onApprovalRequest,
        onEngineEvent: context.onEngineEvent,
      });
      if (currentResult.usage) {
        await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, currentResult.usage);
      }
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? `正在让 Mini verifier ${verifier.name} 检查...` : `Sending to mini verifier ${verifier.name}...`,
      );
      const verifyResult = await executeMiniPeer({
        bridge,
        peer: verifier,
        normalized,
        locale,
        prompt: locale === "zh"
          ? `请验证以下回复的正确性和质量：\n\n原始问题：${prompt}\n\n回复：${currentResult.text}`
          : `Please verify the correctness and quality of this response:\n\nOriginal question: ${prompt}\n\nResponse: ${currentResult.text}`,
        resume: cfg.resume,
        abortSignal: context.abortSignal,
        runQueuedBridgeTurn: context.runQueuedBridgeTurn,
        onApprovalRequest: context.onApprovalRequest,
        onEngineEvent: context.onEngineEvent,
      });
      if (verifyResult.usage) {
        await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, verifyResult.usage);
      }
      if (verifyResult.error) {
        throw new Error(`${verifier.name}: ${verifyResult.error}`);
      }
      const responseText = [
        locale === "zh" ? "[当前 topic 的回复]" : "[Current topic response]",
        currentResult.text,
        "",
        "---",
        "",
        locale === "zh" ? `[Mini verifier: ${verifier.name}]` : `[Mini verifier: ${verifier.name}]`,
        verifyResult.text,
      ].join("\n");
      const chunkCount = await sendChunked(context.api, normalized.chatId, responseText);
      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "mini",
          action: "verify",
          verifier: verifier.name,
          responseChars: responseText.length,
          chunkCount,
        },
      });
    } catch (error) {
      verifyOutcome = "error";
      const detail = error instanceof Error ? error.message : String(error);
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? `Mini verify 失败：${detail}` : `Mini verify failed: ${detail}`,
      );
      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: verifyOutcome,
        detail,
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "mini",
          action: "verify",
          verifier: verifier.name,
        },
      });
    }
    return true;
  }

  const group = await store.getGroup(normalized.chatId);
  const configuredNames = action.kind === "fan" ? group.parallel : group.chain;
  const resolved = resolveConfiguredPeers({
    peers: group.peers,
    configuredNames,
    currentConversationKey,
  });
  if (resolved.missing.length > 0) {
    await sendMiniReplyAndAudit({
      stateDir,
      startedAt,
      context,
      normalized,
      responseText: locale === "zh"
        ? `Mini Bus 配置引用了不存在的 peer：${resolved.missing.join(", ")}`
        : `Mini Bus config references missing peers: ${resolved.missing.join(", ")}`,
      outcome: "invalid",
      action: action.kind,
      metadata: { missing: resolved.missing },
    });
    return true;
  }
  const peers = resolved.peers;
  if (peers.length === 0) {
    await sendMiniReplyAndAudit({
      stateDir,
      startedAt,
      context,
      normalized,
      responseText: renderNoMiniPeers(locale),
      outcome: "invalid",
      action: action.kind,
    });
    return true;
  }
  if (resolved.skippedCurrent.length > 0) {
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh"
        ? `已跳过当前 topic：${resolved.skippedCurrent.join(", ")}`
        : `Skipped current topic in mini ${action.kind}: ${resolved.skippedCurrent.join(", ")}`,
    );
  }

  if (action.kind === "fan") {
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? `正在并行查询 ${peers.length} 个 Mini topic...` : `Querying ${peers.length} mini topics...`,
    );
    const results = await Promise.all(peers.map((peer) => executeMiniPeer({
      bridge,
      peer,
      normalized,
      locale,
      prompt: action.prompt,
      resume: cfg.resume,
      abortSignal: context.abortSignal,
      runQueuedBridgeTurn: context.runQueuedBridgeTurn,
      onApprovalRequest: context.onApprovalRequest,
      onEngineEvent: context.onEngineEvent,
    })));
    for (const result of results) {
      if (result.usage) {
        await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);
      }
    }
    const responseText = results
      .map((result) => result.error ? `[${result.name}] Error: ${result.error}` : `[${result.name}]\n${result.text}`)
      .join("\n\n---\n\n");
    const chunkCount = await sendChunked(context.api, normalized.chatId, responseText);
    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: results.some((result) => result.error) ? "error" : "success",
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "mini",
        action: "fan",
        miniTargets: peers.map((peer) => peer.name),
        skippedCurrent: resolved.skippedCurrent,
        errorCount: results.filter((result) => result.error).length,
        responseChars: responseText.length,
        chunkCount,
      },
    });
    return true;
  }

  if (action.kind === "chain") {
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? `正在串联 ${peers.length} 个 Mini topic...` : `Running chain across ${peers.length} mini topics...`,
    );
    let stagePrompt = action.prompt;
    const sections: string[] = [];

    try {
      for (const [index, peer] of peers.entries()) {
        const result = await executeMiniPeer({
          bridge,
          peer,
          normalized,
          locale,
          prompt: stagePrompt,
          resume: cfg.resume,
          abortSignal: context.abortSignal,
          runQueuedBridgeTurn: context.runQueuedBridgeTurn,
          onApprovalRequest: context.onApprovalRequest,
          onEngineEvent: context.onEngineEvent,
        });
        if (result.error) {
          throw new Error(`${peer.name}: ${result.error}`);
        }
        if (result.usage) {
          await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);
        }
        sections.push(
          locale === "zh"
            ? `[Mini 链路阶段 ${index + 1}: ${peer.name}]\n${result.text}`
            : `[Mini chain stage ${index + 1}: ${peer.name}]\n${result.text}`,
        );
        stagePrompt = buildMiniChainStagePrompt({
          locale,
          originalPrompt: action.prompt,
          previousPeer: peer.name,
          previousOutput: result.text,
        });
      }
      const responseText = sections.join("\n\n---\n\n");
      const chunkCount = await sendChunked(context.api, normalized.chatId, responseText);
      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "mini",
          action: "chain",
          miniTargets: peers.map((peer) => peer.name),
          skippedCurrent: resolved.skippedCurrent,
          stageCount: peers.length,
          responseChars: responseText.length,
          chunkCount,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? `Mini 串联执行失败：${detail}` : `Mini chain failed: ${detail}`,
      );
      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: "error",
        detail,
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "mini",
          action: "chain",
          miniTargets: peers.map((peer) => peer.name),
          skippedCurrent: resolved.skippedCurrent,
        },
      });
    }
    return true;
  }

  return false;
}
