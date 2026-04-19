import { randomInt, randomUUID } from "node:crypto";

import { delegateToInstance as defaultDelegateToInstance } from "../bus/bus-client.js";
import { loadBusConfig as defaultLoadBusConfig, type BusConfig, type BusCrewConfig } from "../bus/bus-config.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { CrewRunStore } from "../state/crew-run-store.js";
import {
  appendUpdateHandleAuditEventBestEffort,
  maybeReplyWithBudgetExhausted,
  recordTurnUsageAndBudgetAudit,
  type TelegramTurnContext,
} from "./turn-bookkeeping.js";
import { chunkTelegramMessage, type Locale } from "./message-renderer.js";
import type { TelegramApi } from "./api.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

type CrewStageName = "decomposition" | "research" | "analysis" | "writing" | "review";
type ResearchStageEntry =
  | { question: string; finding: string }
  | { question: string; error: string };

const activeCrewRunKeys = new Set<string>();
const SYNTHETIC_COORDINATOR_CHAT_ID_BASE = Number.MAX_SAFE_INTEGER - 1_000_000_000;
const CREW_RESEARCH_TIMEOUT_MS = 60_000;
const CREW_ANALYSIS_TIMEOUT_MS = 120_000;
const CREW_WRITING_TIMEOUT_MS = 120_000;
const CREW_REVIEW_TIMEOUT_MS = 120_000;

export interface CrewWorkflowContext extends TelegramTurnContext {
  api: Pick<TelegramApi, "sendMessage">;
  bridge: {
    handleAuthorizedMessage(input: {
      chatId: number;
      userId: number;
      chatType: string;
      locale: Locale;
      text: string;
      files: string[];
      workspaceOverride?: string;
      abortSignal?: AbortSignal;
    }): Promise<{
      text: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens?: number;
        costUsd?: number;
      };
    }>;
  };
  abortSignal?: AbortSignal;
  instanceName?: string;
  updateId?: number;
}

function createSyntheticCoordinatorChatId(): number {
  return -(SYNTHETIC_COORDINATOR_CHAT_ID_BASE + randomInt(1_000_000_000));
}

function parseCoordinatorSubquestions(text: string, maxQuestions: number): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  return lines.slice(0, maxQuestions);
}

function buildDecompositionPrompt(input: { locale: Locale; userPrompt: string; maxQuestions: number }): string {
  const targetRange = input.maxQuestions >= 3
    ? `3 to ${input.maxQuestions}`
    : `up to ${input.maxQuestions}`;
  if (input.locale === "zh") {
    return [
      `你是 coordinator agent。你的唯一工作是把用户研究任务拆成 ${input.maxQuestions >= 3 ? `3 到 ${input.maxQuestions}` : `最多 ${input.maxQuestions} 个`}研究子问题。`,
      "只返回子问题列表，每行一个。",
      "不要回答问题本身，不要解释，不要写前言。",
      `最多返回 ${input.maxQuestions} 个子问题。`,
      "",
      "用户任务：",
      input.userPrompt,
    ].join("\n");
  }

  return [
    `You are the coordinator agent. Your only job is to decompose the user's research task into ${targetRange} research sub-questions.`,
    "Return only the sub-question list, one per line.",
    "Do not answer the task. Do not explain. Do not add intro text.",
    `Return at most ${input.maxQuestions} sub-questions.`,
    "",
    "USER TASK:",
    input.userPrompt,
  ].join("\n");
}

function buildResearchPrompt(input: { locale: Locale; originalPrompt: string; subQuestion: string }): string {
  if (input.locale === "zh") {
    return [
      "你是研究 specialist。你的唯一工作是查找并整理准确、尽量新的信息。",
      "输出要求：",
      "- 每条信息尽量标注来源",
      "- 给每条信息标注置信度（high/medium/low）",
      "- 如果可能过时，要明确标出",
      "- 不要分析，不要写总结性 prose",
      "",
      `原始任务：${input.originalPrompt}`,
      `研究子问题：${input.subQuestion}`,
    ].join("\n");
  }

  return [
    "You are the research specialist. Your only job is to find accurate, current information.",
    "Return structured findings only:",
    "- include sources whenever possible",
    "- include confidence (high/medium/low) for each finding",
    "- flag anything that may be outdated",
    "- do not analyze and do not write polished prose",
    "",
    `Original task: ${input.originalPrompt}`,
    `Research sub-question: ${input.subQuestion}`,
  ].join("\n");
}

function buildResearchPacket(entries: ResearchStageEntry[]): string {
  return entries
    .map((entry, index) => [
      `SUB-QUESTION ${index + 1}: ${entry.question}`,
      "finding" in entry ? entry.finding : `RESEARCH FAILED: ${entry.error}`,
    ].join("\n"))
    .join("\n\n---\n\n");
}

function buildAnalystPrompt(input: { locale: Locale; originalPrompt: string; researchPacket: string }): string {
  if (input.locale === "zh") {
    return [
      "你是 analyst specialist。你的唯一工作是分析研究结果并提炼洞察。",
      "给定原始研究数据：",
      "- 识别 3 到 5 个最重要的模式",
      "- 标出来源之间的矛盾",
      "- 标出证据不足的断言",
      "- 只输出结构化分析，不要写最终报告",
      "",
      `原始任务：${input.originalPrompt}`,
      "",
      "研究数据：",
      input.researchPacket,
    ].join("\n");
  }

  return [
    "You are the analyst specialist. Your only job is to analyze research findings and extract insights.",
    "Given raw research data:",
    "- identify the 3 to 5 most important patterns",
    "- note contradictions between sources",
    "- flag claims that lack sufficient evidence",
    "- return structured analysis only, not a final report",
    "",
    `Original task: ${input.originalPrompt}`,
    "",
    "RESEARCH DATA:",
    input.researchPacket,
  ].join("\n");
}

function buildWriterPrompt(input: {
  locale: Locale;
  originalPrompt: string;
  researchPacket: string;
  analysis: string;
}): string {
  if (input.locale === "zh") {
    return [
      "你是 writer specialist。你的唯一工作是把分析结果写成清晰、专业、可读的报告。",
      "要求：",
      "- 先给 executive summary",
      "- 然后给结构化章节",
      "- 尽量引用具体数字和来源",
      "- 可扫描，3 分钟内能抓住重点",
      "- 不要做新的研究，不要擅自改变分析结论",
      "",
      `原始任务：${input.originalPrompt}`,
      "",
      "研究数据：",
      input.researchPacket,
      "",
      "分析结果：",
      input.analysis,
    ].join("\n");
  }

  return [
    "You are the writer specialist. Your only job is to turn analyzed data into a polished, readable report.",
    "Requirements:",
    "- start with an executive summary",
    "- then write structured sections",
    "- cite concrete numbers and sources when available",
    "- keep it scannable",
    "- do not do new research and do not change the conclusions from the analysis",
    "",
    `Original task: ${input.originalPrompt}`,
    "",
    "RAW RESEARCH:",
    input.researchPacket,
    "",
    "ANALYSIS:",
    input.analysis,
  ].join("\n");
}

function buildReviewerPrompt(input: {
  locale: Locale;
  originalPrompt: string;
  researchPacket: string;
  draft: string;
}): string {
  if (input.locale === "zh") {
    return [
      "你是 reviewer specialist。你的唯一工作是把完成稿和原始研究对照检查。",
      "检查：",
      "- 有无未被研究支持的断言",
      "- 有无遗漏的重要发现",
      "- 是否存在逻辑不一致或弱推理",
      "- 数字和统计是否准确",
      "- 可读性是否有明显问题",
      "",
      "严格按以下格式返回：",
      "VERDICT: PASS 或 REVISE",
      "ISSUES:",
      "- issue 1",
      "- issue 2",
      "",
      `原始任务：${input.originalPrompt}`,
      "",
      "原始研究：",
      input.researchPacket,
      "",
      "草稿：",
      input.draft,
    ].join("\n");
  }

  return [
    "You are the reviewer specialist. Your only job is to check the finished report against the original research.",
    "Check for:",
    "- claims not supported by the research",
    "- important findings omitted from the report",
    "- logical inconsistencies or weak reasoning",
    "- accuracy of numbers and statistics",
    "- clarity and readability issues",
    "",
    "Return in this exact format:",
    "VERDICT: PASS or REVISE",
    "ISSUES:",
    "- issue 1",
    "- issue 2",
    "",
    `Original task: ${input.originalPrompt}`,
    "",
    "RAW RESEARCH:",
    input.researchPacket,
    "",
    "DRAFT REPORT:",
    input.draft,
  ].join("\n");
}

function parseReviewerVerdict(text: string): { verdict: "pass" | "revise"; issues: string } {
  const match = text.match(/VERDICT:\s*(PASS|REVISE)/i);
  const verdict = match?.[1]?.toUpperCase() === "PASS" ? "pass" : "revise";
  const issuesMatch = text.match(/ISSUES:\s*([\s\S]*)/i);
  const issues = issuesMatch?.[1]?.trim() ?? text.trim();
  return { verdict, issues };
}

function buildWriterRevisionPrompt(input: {
  locale: Locale;
  originalPrompt: string;
  researchPacket: string;
  analysis: string;
  draft: string;
  reviewIssues: string;
}): string {
  if (input.locale === "zh") {
    return [
      "你是 writer specialist。请基于 reviewer 的问题修订当前报告。",
      "不要重新研究；只根据已有研究和分析修订。",
      "",
      `原始任务：${input.originalPrompt}`,
      "",
      "原始研究：",
      input.researchPacket,
      "",
      "分析结果：",
      input.analysis,
      "",
      "当前草稿：",
      input.draft,
      "",
      "Reviewer 提出的问题：",
      input.reviewIssues,
    ].join("\n");
  }

  return [
    "You are the writer specialist. Revise the current report using the review issues below.",
    "Do not do new research; only revise using the existing research and analysis.",
    "",
    `Original task: ${input.originalPrompt}`,
    "",
    "RAW RESEARCH:",
    input.researchPacket,
    "",
    "ANALYSIS:",
    input.analysis,
    "",
    "CURRENT DRAFT:",
    input.draft,
    "",
    "REVIEW ISSUES:",
    input.reviewIssues,
  ].join("\n");
}

async function appendCrewTimelineEvent(
  stateDir: string,
  input: {
    type: "crew.run.started" | "crew.stage.started" | "crew.stage.completed" | "crew.run.completed" | "crew.run.failed";
    context: CrewWorkflowContext;
    normalized: NormalizedTelegramMessage;
    runId: string;
    workflow: BusCrewConfig["workflow"];
    stage?: CrewStageName;
    outcome?: string;
    detail?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await appendTimelineEventBestEffort(stateDir, {
    type: input.type,
    channel: "telegram",
    chatId: input.normalized.chatId,
    userId: input.normalized.userId,
    updateId: input.context.updateId,
    instanceName: input.context.instanceName,
    outcome: input.outcome,
    detail: input.detail,
    metadata: {
      runId: input.runId,
      workflow: input.workflow,
      ...(input.stage ? { stage: input.stage } : {}),
      ...(input.metadata ?? {}),
    },
  }, "crew timeline event");
}

export async function handleCrewTelegramWorkflow(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: {
    budgetUsd?: number;
    resume?: {
      workspacePath: string;
    };
  };
  normalized: NormalizedTelegramMessage;
  context: CrewWorkflowContext;
  loadBusConfig?: (stateDir: string) => Promise<BusConfig | null>;
  delegateToInstance?: typeof defaultDelegateToInstance;
}): Promise<boolean> {
  const {
    stateDir,
    startedAt,
    locale,
    cfg,
    normalized,
    context,
    loadBusConfig = defaultLoadBusConfig,
    delegateToInstance = defaultDelegateToInstance,
  } = input;

  if (normalized.attachments.length > 0) {
    return false;
  }

  const busConfig = await loadBusConfig(stateDir);
  const crew = busConfig?.crew;
  const currentInstance = context.instanceName ?? "default";
  if (!crew?.enabled || crew.workflow !== "research-report" || crew.coordinator !== currentInstance) {
    return false;
  }

  const activeRunKey = `${stateDir}:${normalized.chatId}`;
  if (activeCrewRunKeys.has(activeRunKey)) {
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? "当前聊天已有 crew 正在运行。" : "A crew run is already active for this chat.",
    );
    return true;
  }

  activeCrewRunKeys.add(activeRunKey);

  if (await maybeReplyWithBudgetExhausted(stateDir, cfg.budgetUsd, locale, context, normalized)) {
    activeCrewRunKeys.delete(activeRunKey);
    return true;
  }

  const runId = randomUUID();
  const crewRunStore = new CrewRunStore(stateDir);
  const createdAt = new Date().toISOString();
  let activeStage: CrewStageName = "decomposition";

  const coordinatorChatId = createSyntheticCoordinatorChatId();
  const runCoordinatorTurn = async (text: string) => {
    const result = await context.bridge.handleAuthorizedMessage({
      chatId: coordinatorChatId,
      userId: normalized.userId,
      chatType: "bus",
      locale,
      text,
      files: [],
      workspaceOverride: cfg.resume?.workspacePath,
      abortSignal: context.abortSignal,
    });
    await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);
    return result.text;
  };

  await crewRunStore.create({
    runId,
    workflow: crew.workflow,
    status: "running",
    currentStage: "decomposition",
    coordinator: currentInstance,
    chatId: normalized.chatId,
    userId: normalized.userId,
    locale,
    originalPrompt: normalized.text,
    createdAt,
    updatedAt: createdAt,
    stages: {},
  });
  await appendCrewTimelineEvent(stateDir, {
    type: "crew.run.started",
    context,
    normalized,
    runId,
    workflow: crew.workflow,
    outcome: "success",
  });

  await context.api.sendMessage(
    normalized.chatId,
    locale === "zh" ? "正在运行 research-report crew..." : "Running research-report crew...",
  );

  try {
    await crewRunStore.update(runId, (record) => {
      record.currentStage = "decomposition";
      record.stages.decomposition = {
        ...(record.stages.decomposition ?? {}),
        status: "running",
        updatedAt: new Date().toISOString(),
      };
    });
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.stage.started",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      stage: "decomposition",
      outcome: "success",
    });
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? "Coordinator 正在拆分研究问题..." : "Coordinator is decomposing the research task...",
    );
    const decomposition = await runCoordinatorTurn(buildDecompositionPrompt({
      locale,
      userPrompt: normalized.text,
      maxQuestions: crew.maxResearchQuestions,
    }));
    const subQuestions = parseCoordinatorSubquestions(decomposition, crew.maxResearchQuestions);
    if (subQuestions.length === 0) {
      throw new Error(locale === "zh" ? "Coordinator 没有生成可用的研究子问题。" : "Coordinator did not produce usable research sub-questions.");
    }
    await crewRunStore.update(runId, (record) => {
      record.stages.decomposition = {
        status: "completed",
        updatedAt: new Date().toISOString(),
        output: decomposition,
        subQuestions,
      };
    });
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.stage.completed",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      stage: "decomposition",
      outcome: "success",
      metadata: { questionCount: subQuestions.length },
    });

    await crewRunStore.update(runId, (record) => {
      record.currentStage = "research";
      record.stages.research = {
        ...(record.stages.research ?? {}),
        status: "running",
        updatedAt: new Date().toISOString(),
        subQuestions,
      };
    });
    activeStage = "research";
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.stage.started",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      stage: "research",
      outcome: "success",
      metadata: { questionCount: subQuestions.length },
    });
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? `研究阶段：${subQuestions.length} 个子问题` : `Research stage: ${subQuestions.length} sub-questions`,
    );
    const researchResults = await Promise.all(subQuestions.map(async (question): Promise<ResearchStageEntry> => {
      try {
        const result = await delegateToInstance({
          fromInstance: currentInstance,
          targetInstance: crew.roles.researcher,
          prompt: buildResearchPrompt({
            locale,
            originalPrompt: normalized.text,
            subQuestion: question,
          }),
          depth: 0,
          stateDir,
          timeoutMs: CREW_RESEARCH_TIMEOUT_MS,
        });
        return { question, finding: result.text };
      } catch (error) {
        return {
          question,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));
    const successfulResearchFindings = researchResults
      .filter((entry): entry is Extract<ResearchStageEntry, { finding: string }> => "finding" in entry)
      .map((entry) => entry.finding);
    const failedResearch = researchResults
      .filter((entry): entry is Extract<ResearchStageEntry, { error: string }> => "error" in entry)
      .map((entry) => ({ question: entry.question, error: entry.error }));
    if (successfulResearchFindings.length === 0) {
      throw new Error(
        locale === "zh"
          ? "所有 research specialist 子任务都失败了。"
          : "All research specialist sub-questions failed.",
      );
    }
    const researchPacket = buildResearchPacket(researchResults);
    await crewRunStore.update(runId, (record) => {
      record.stages.research = {
        status: "completed",
        updatedAt: new Date().toISOString(),
        subQuestions,
        findings: successfulResearchFindings,
        researchPacket,
        failedQuestions: failedResearch,
      };
    });
    if (failedResearch.length > 0) {
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh"
          ? `研究阶段完成，但有 ${failedResearch.length} 个子问题失败。`
          : `Research stage completed with ${failedResearch.length} failed sub-question${failedResearch.length === 1 ? "" : "s"}.`,
      );
    }
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.stage.completed",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      stage: "research",
      outcome: failedResearch.length > 0 ? "partial" : "success",
      metadata: { questionCount: subQuestions.length, failedQuestionCount: failedResearch.length },
    });

    await crewRunStore.update(runId, (record) => {
      record.currentStage = "analysis";
      record.stages.analysis = {
        ...(record.stages.analysis ?? {}),
        status: "running",
        updatedAt: new Date().toISOString(),
      };
    });
    activeStage = "analysis";
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.stage.started",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      stage: "analysis",
      outcome: "success",
    });
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? "分析阶段..." : "Analysis stage...",
    );
    const analysis = (await delegateToInstance({
      fromInstance: currentInstance,
      targetInstance: crew.roles.analyst,
      prompt: buildAnalystPrompt({
        locale,
        originalPrompt: normalized.text,
        researchPacket,
      }),
      depth: 0,
      stateDir,
      timeoutMs: CREW_ANALYSIS_TIMEOUT_MS,
    })).text;
    await crewRunStore.update(runId, (record) => {
      record.stages.analysis = {
        status: "completed",
        updatedAt: new Date().toISOString(),
        output: analysis,
      };
    });
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.stage.completed",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      stage: "analysis",
      outcome: "success",
    });

    await crewRunStore.update(runId, (record) => {
      record.currentStage = "writing";
      record.stages.writing = {
        ...(record.stages.writing ?? {}),
        status: "running",
        updatedAt: new Date().toISOString(),
        revisionCount: 0,
      };
    });
    activeStage = "writing";
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.stage.started",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      stage: "writing",
      outcome: "success",
      metadata: { revisionCount: 0 },
    });
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? "写作阶段..." : "Writing stage...",
    );
    let draft = (await delegateToInstance({
      fromInstance: currentInstance,
      targetInstance: crew.roles.writer,
      prompt: buildWriterPrompt({
        locale,
        originalPrompt: normalized.text,
        researchPacket,
        analysis,
      }),
      depth: 0,
      stateDir,
      timeoutMs: CREW_WRITING_TIMEOUT_MS,
    })).text;
    await crewRunStore.update(runId, (record) => {
      record.stages.writing = {
        status: "completed",
        updatedAt: new Date().toISOString(),
        draft,
        revisionCount: 0,
      };
    });
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.stage.completed",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      stage: "writing",
      outcome: "success",
      metadata: { revisionCount: 0 },
    });

    await crewRunStore.update(runId, (record) => {
      record.currentStage = "review";
      record.stages.review = {
        ...(record.stages.review ?? {}),
        status: "running",
        updatedAt: new Date().toISOString(),
      };
    });
    activeStage = "review";
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.stage.started",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      stage: "review",
      outcome: "success",
    });
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? "审查阶段..." : "Review stage...",
    );
    const reviewerText = (await delegateToInstance({
      fromInstance: currentInstance,
      targetInstance: crew.roles.reviewer,
      prompt: buildReviewerPrompt({
        locale,
        originalPrompt: normalized.text,
        researchPacket,
        draft,
      }),
      depth: 0,
      stateDir,
      timeoutMs: CREW_REVIEW_TIMEOUT_MS,
    })).text;
    const reviewerResult = parseReviewerVerdict(reviewerText);
    await crewRunStore.update(runId, (record) => {
      record.stages.review = {
        status: "completed",
        updatedAt: new Date().toISOString(),
        output: reviewerText,
        verdict: reviewerResult.verdict,
        issues: reviewerResult.issues,
      };
    });
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.stage.completed",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      stage: "review",
      outcome: reviewerResult.verdict === "pass" ? "success" : "review",
      metadata: { verdict: reviewerResult.verdict },
    });

    let revisionCount = 0;
    while (reviewerResult.verdict === "revise" && revisionCount < crew.maxRevisionRounds) {
      revisionCount += 1;
      await crewRunStore.update(runId, (record) => {
        record.currentStage = "writing";
        record.stages.writing = {
          ...(record.stages.writing ?? {}),
          status: "running",
          updatedAt: new Date().toISOString(),
          draft,
          revisionCount,
        };
      });
      activeStage = "writing";
      await appendCrewTimelineEvent(stateDir, {
        type: "crew.stage.started",
        context,
        normalized,
        runId,
        workflow: crew.workflow,
        stage: "writing",
        outcome: "success",
        metadata: { revisionCount, revisionReason: reviewerResult.issues },
      });
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? "Reviewer 提出了问题，正在回写修订..." : "Reviewer flagged issues, sending back for revision...",
      );
      draft = (await delegateToInstance({
        fromInstance: currentInstance,
        targetInstance: crew.roles.writer,
        prompt: buildWriterRevisionPrompt({
          locale,
          originalPrompt: normalized.text,
          researchPacket,
          analysis,
          draft,
          reviewIssues: reviewerResult.issues,
        }),
        depth: 0,
        stateDir,
        timeoutMs: CREW_WRITING_TIMEOUT_MS,
      })).text;
      await crewRunStore.update(runId, (record) => {
        record.stages.writing = {
          status: "completed",
          updatedAt: new Date().toISOString(),
          draft,
          revisionCount,
        };
      });
      await appendCrewTimelineEvent(stateDir, {
        type: "crew.stage.completed",
        context,
        normalized,
        runId,
        workflow: crew.workflow,
        stage: "writing",
        outcome: "success",
        metadata: { revisionCount },
      });

      await crewRunStore.update(runId, (record) => {
        record.currentStage = "review";
        record.stages.review = {
          ...(record.stages.review ?? {}),
          status: "running",
          updatedAt: new Date().toISOString(),
        };
      });
      activeStage = "review";
      await appendCrewTimelineEvent(stateDir, {
        type: "crew.stage.started",
        context,
        normalized,
        runId,
        workflow: crew.workflow,
        stage: "review",
        outcome: "success",
        metadata: { revisionCount },
      });
      const revisedReviewerText = (await delegateToInstance({
        fromInstance: currentInstance,
        targetInstance: crew.roles.reviewer,
        prompt: buildReviewerPrompt({
          locale,
          originalPrompt: normalized.text,
          researchPacket,
          draft,
        }),
        depth: 0,
        stateDir,
        timeoutMs: CREW_REVIEW_TIMEOUT_MS,
      })).text;
      const revisedReviewerResult = parseReviewerVerdict(revisedReviewerText);
      reviewerResult.verdict = revisedReviewerResult.verdict;
      reviewerResult.issues = revisedReviewerResult.issues;
      await crewRunStore.update(runId, (record) => {
        record.stages.review = {
          status: "completed",
          updatedAt: new Date().toISOString(),
          output: revisedReviewerText,
          verdict: reviewerResult.verdict,
          issues: reviewerResult.issues,
        };
      });
      await appendCrewTimelineEvent(stateDir, {
        type: "crew.stage.completed",
        context,
        normalized,
        runId,
        workflow: crew.workflow,
        stage: "review",
        outcome: reviewerResult.verdict === "pass" ? "success" : "review",
        metadata: { verdict: reviewerResult.verdict, revisionCount },
      });
    }

    const chunks = chunkTelegramMessage(draft);
    await context.api.sendMessage(normalized.chatId, chunks[0]!);
    for (const chunk of chunks.slice(1)) {
      await context.api.sendMessage(normalized.chatId, chunk);
    }

    await crewRunStore.update(runId, (record) => {
      record.status = "completed";
      record.currentStage = "completed";
      record.finalOutput = draft;
    });
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.run.completed",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      outcome: "success",
      metadata: {
        reviewerVerdict: reviewerResult.verdict,
      },
    });

    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: "success",
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "crew",
        workflow: crew.workflow,
        coordinator: currentInstance,
        researcher: crew.roles.researcher,
        analyst: crew.roles.analyst,
        writer: crew.roles.writer,
        reviewer: crew.roles.reviewer,
        researchQuestionCount: subQuestions.length,
        reviewerVerdict: reviewerResult.verdict,
        responseChars: draft.length,
        chunkCount: chunks.length,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await crewRunStore.update(runId, (record) => {
      record.status = "failed";
      record.currentStage = activeStage;
      record.lastError = detail;
      record.stages[activeStage] = {
        ...(record.stages[activeStage] ?? {}),
        status: "failed",
        updatedAt: new Date().toISOString(),
        detail,
      };
    });
    await appendCrewTimelineEvent(stateDir, {
      type: "crew.run.failed",
      context,
      normalized,
      runId,
      workflow: crew.workflow,
      outcome: "error",
      detail,
      metadata: {
        stage: activeStage,
      },
    });
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? `Crew 执行失败：${detail}` : `Crew execution failed: ${detail}`,
    );
    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: "error",
      detail,
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "crew",
        workflow: crew.workflow,
        coordinator: currentInstance,
      },
    });
  }
  finally {
    activeCrewRunKeys.delete(activeRunKey);
  }

  return true;
}
