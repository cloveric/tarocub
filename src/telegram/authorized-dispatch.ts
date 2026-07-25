import type { FileWorkflowStore } from "../state/file-workflow-store.js";
import { handleCrewTelegramWorkflow as defaultHandleCrewTelegramWorkflow } from "./crew-workflow.js";
import { handleBoardTelegramCommand as defaultHandleBoardTelegramCommand } from "./board-commands.js";
import type { SessionStore } from "../state/session-store.js";
import { handleDelegationTelegramCommand as defaultHandleDelegationTelegramCommand } from "./delegation-commands.js";
import { handleLocalEngineTelegramCommand as defaultHandleLocalEngineTelegramCommand } from "./engine-commands.js";
import { handleGoalTelegramCommand as defaultHandleGoalTelegramCommand } from "./goal-commands.js";
import { handleMiniBusTelegramCommand as defaultHandleMiniBusTelegramCommand } from "./mini-bus-commands.js";
import type { InstanceEngine, ResumeState } from "./instance-config.js";
import {
  prepareTelegramMessageInput as defaultPrepareTelegramMessageInput,
  type TelegramMessageInputPreparationResult,
} from "./message-input.js";
import {
  executeWorkflowAwareTelegramTurn as defaultExecuteWorkflowAwareTelegramTurn,
  type WorkflowAwareTurnState,
} from "./message-turn.js";
import type { Locale } from "./message-renderer.js";
import { handleLocalSessionTelegramCommand as defaultHandleLocalSessionTelegramCommand } from "./session-commands.js";
import { handleSimpleLocalTelegramCommand as defaultHandleSimpleLocalTelegramCommand } from "./simple-commands.js";
import { handleCronCommand as defaultHandleCronCommand, isCronCommand } from "./cron-commands.js";
import { getActiveCronRuntime } from "../runtime/cron-runtime.js";
import type { TelegramApi } from "./api.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";
import type { CodexThreadGoal, EngineApprovalDecision, EngineApprovalRequest, EngineStreamEvent } from "../codex/adapter.js";
import type { DeliveryAcceptedReceipt, DeliveryRejectedReceipt, DeliverySource } from "./delivery-ledger.js";
import { getNormalizedTelegramConversationKey } from "./conversation-key.js";

export interface AuthorizedTelegramDispatchConfig {
  engine: InstanceEngine;
  budgetUsd?: number;
  effort?: string;
  model?: string;
  codexServiceTier?: "fast";
  disableRuntimeTimeout?: boolean;
  resume?: ResumeState;
}

export interface AuthorizedTelegramDispatchContext {
  api: Pick<TelegramApi, "sendMessage" | "sendDocument" | "sendPhoto" | "sendVoice" | "getFile" | "downloadFile">;
  bridge: {
    supportsTurnScopedEnv?: boolean;
    validateCodexThread?(threadId: string): Promise<void>;
    getThreadGoal?(input: {
      chatId: number;
      userId: number;
      chatType: string;
      messageThreadId?: number;
      conversationKey?: string;
      workspaceOverride?: string;
    }): Promise<{ goal: CodexThreadGoal | null }>;
    setThreadGoal?(input: {
      chatId: number;
      userId: number;
      chatType: string;
      messageThreadId?: number;
      conversationKey?: string;
      objective: string;
      tokenBudget?: number | null;
      workspaceOverride?: string;
    }): Promise<{ goal: CodexThreadGoal | null }>;
    clearThreadGoal?(input: {
      chatId: number;
      userId: number;
      chatType: string;
      messageThreadId?: number;
      conversationKey?: string;
      workspaceOverride?: string;
    }): Promise<{ cleared: boolean }>;
    handleAuthorizedMessage(input: {
      chatId: number;
      userId: number;
      chatType: string;
      messageThreadId?: number;
      conversationKey?: string;
      locale: Locale;
      text: string;
      replyContext?: NormalizedTelegramMessage["replyContext"];
      files: string[];
      onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
      onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
      requestOutputDir?: string;
      workspaceOverride?: string;
      sideChannelCommand?: string;
      extraEnv?: Record<string, string>;
      abortSignal?: AbortSignal;
      disableRuntimeTimeout?: boolean;
      sessionIdOverride?: string;
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
  inboxDir: string;
  source?: "telegram" | "cron";
  abortSignal?: AbortSignal;
  runQueuedBridgeTurn?<T>(conversationKey: string, job: () => Promise<T>): Promise<T>;
  sessionIdOverride?: string;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  onTurnActivity?: () => void | Promise<void>;
  instanceName?: string;
  updateId?: number;
}

export interface AuthorizedTelegramDispatchDeps {
  sessionStore: Pick<
    SessionStore,
    "findByChatIdSafe" |
    "findByConversationKeySafe" |
    "inspect" |
    "removeByChatId" |
    "removeByConversationKey" |
    "clearAll" |
    "upsert"
  >;
  turnState: WorkflowAwareTurnState;
  updateInstanceConfig: (updater: (config: Record<string, unknown>) => void) => Promise<void>;
  deliverTelegramResponse: (
    api: Pick<TelegramApi, "sendMessage" | "sendDocument" | "sendPhoto">,
    chatId: number,
    text: string,
    inboxDir: string,
    workspaceOverride: string | undefined,
    requestOutputDir: string | undefined,
    locale: Locale,
      options?: {
        onFileAccepted?: (sourcePath: string) => void;
        onDeliveryAccepted?: (receipt: DeliveryAcceptedReceipt) => void;
        onDeliveryRejected?: (receipt: DeliveryRejectedReceipt) => void;
        source?: DeliverySource;
        allowAnyAbsolutePath?: boolean;
        notifyRejected?: boolean;
      },
    ) => Promise<number>;
  sendTelegramOutFile: (chatId: number, filename: string, contents: Uint8Array) => Promise<void>;
  updateWorkflowBestEffort: (
    workflowStore: Pick<FileWorkflowStore, "update">,
    workflowRecordId: string,
    mutate: Parameters<FileWorkflowStore["update"]>[1],
  ) => Promise<void>;
}

export interface AuthorizedTelegramDispatchHandlers {
    handleLocalSessionTelegramCommand?: typeof defaultHandleLocalSessionTelegramCommand;
    handleLocalEngineTelegramCommand?: typeof defaultHandleLocalEngineTelegramCommand;
    handleGoalTelegramCommand?: typeof defaultHandleGoalTelegramCommand;
    handleSimpleLocalTelegramCommand?: typeof defaultHandleSimpleLocalTelegramCommand;
  handleCronCommand?: typeof defaultHandleCronCommand;
  handleDelegationTelegramCommand?: typeof defaultHandleDelegationTelegramCommand;
  handleBoardTelegramCommand?: typeof defaultHandleBoardTelegramCommand;
  handleMiniBusTelegramCommand?: typeof defaultHandleMiniBusTelegramCommand;
  handleCrewTelegramWorkflow?: typeof defaultHandleCrewTelegramWorkflow;
  prepareTelegramMessageInput?: typeof defaultPrepareTelegramMessageInput;
  executeWorkflowAwareTelegramTurn?: typeof defaultExecuteWorkflowAwareTelegramTurn;
}

type PreparedTelegramMessageInput = Extract<TelegramMessageInputPreparationResult, { kind: "ready" }>;

const preparedTelegramMessageInputs = new WeakMap<NormalizedTelegramMessage, PreparedTelegramMessageInput>();

function isBlockingWorkflowStatus(status: "preparing" | "processing" | "awaiting_continue" | "completed" | "failed"): boolean {
  return status === "preparing" || status === "processing" || status === "failed";
}

export async function dispatchAuthorizedTelegramMessage(input: {
  stateDir: string;
  startedAt: number;
  locale: Locale;
  cfg: AuthorizedTelegramDispatchConfig;
  normalized: NormalizedTelegramMessage;
  context: AuthorizedTelegramDispatchContext;
  workflowStore: Pick<FileWorkflowStore, "inspect" | "update">;
  deps: AuthorizedTelegramDispatchDeps;
  handlers?: AuthorizedTelegramDispatchHandlers;
}): Promise<void> {
  const {
    stateDir,
    startedAt,
    locale,
    cfg,
    normalized,
    context,
    workflowStore,
    deps,
    handlers,
  } = input;
  const {
    sessionStore,
    turnState,
    updateInstanceConfig,
    deliverTelegramResponse,
    sendTelegramOutFile,
    updateWorkflowBestEffort,
  } = deps;
  const {
    handleLocalSessionTelegramCommand = defaultHandleLocalSessionTelegramCommand,
    handleLocalEngineTelegramCommand = defaultHandleLocalEngineTelegramCommand,
    handleGoalTelegramCommand = defaultHandleGoalTelegramCommand,
    handleSimpleLocalTelegramCommand = defaultHandleSimpleLocalTelegramCommand,
    handleCronCommand = defaultHandleCronCommand,
    handleMiniBusTelegramCommand = defaultHandleMiniBusTelegramCommand,
    handleBoardTelegramCommand = defaultHandleBoardTelegramCommand,
    handleDelegationTelegramCommand = defaultHandleDelegationTelegramCommand,
    handleCrewTelegramWorkflow = defaultHandleCrewTelegramWorkflow,
    prepareTelegramMessageInput = defaultPrepareTelegramMessageInput,
    executeWorkflowAwareTelegramTurn = defaultExecuteWorkflowAwareTelegramTurn,
  } = handlers ?? {};

  const allowTelegramCommands = context.source !== "cron";
  const conversationKey = getNormalizedTelegramConversationKey(normalized);

  if (allowTelegramCommands && isCronCommand(normalized.text)) {
    const cronRuntime = getActiveCronRuntime();
    if (cronRuntime) {
      const result = await handleCronCommand(normalized.text, {
        api: context.api,
        store: cronRuntime.store,
        scheduler: cronRuntime.scheduler,
        chatId: normalized.chatId,
        userId: normalized.userId,
        chatType: normalized.chatType,
        messageThreadId: normalized.messageThreadId,
        conversationKey,
        locale: locale === "zh" ? "zh" : "en",
      });
      if (result.handled) {
        return;
      }
    } else {
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh"
          ? "定时任务子系统未启动，请联系运维。"
          : "Cron subsystem is not running. Please contact the operator.",
      );
      return;
    }
  }

  if (allowTelegramCommands && await handleLocalSessionTelegramCommand({
    stateDir,
    startedAt,
    locale,
    cfg: {
      engine: cfg.engine,
      resume: cfg.resume,
    },
    normalized,
    context,
    sessionStore,
    updateInstanceConfig,
    validateCodexThread: context.bridge.validateCodexThread?.bind(context.bridge),
  })) {
    return;
  }

  if (allowTelegramCommands && await handleLocalEngineTelegramCommand({
    stateDir,
    startedAt,
    locale,
    cfg: {
      engine: cfg.engine,
      model: cfg.model,
      resume: cfg.resume,
    },
    normalized,
    context,
    bridge: context.bridge,
    sessionStore,
    updateInstanceConfig,
  })) {
    return;
  }

  if (allowTelegramCommands && await handleGoalTelegramCommand({
    locale,
    cfg: {
      engine: cfg.engine,
      resume: cfg.resume,
    },
    normalized,
    context,
  })) {
    return;
  }

  if (allowTelegramCommands && await handleSimpleLocalTelegramCommand({
    stateDir,
    startedAt,
    locale,
    cfg: {
      engine: cfg.engine,
      effort: cfg.effort,
      model: cfg.model,
      codexServiceTier: cfg.codexServiceTier,
      disableRuntimeTimeout: cfg.disableRuntimeTimeout,
    },
    normalized,
    context,
    updateInstanceConfig,
      resolveStatus: async (chatId) => {
      const sessionResult = chatId === normalized.chatId
        ? await sessionStore.findByConversationKeySafe(conversationKey)
        : await sessionStore.findByChatIdSafe(chatId);
      const workflowResult = await workflowStore.inspect();
      const chatRecords = workflowResult.warning
        ? []
        : workflowResult.state.records.filter((record) => record.chatId === chatId);
      const blockingTasks = workflowResult.warning
        ? null
        : chatRecords.filter((record) => isBlockingWorkflowStatus(record.status)).length;
      const waitingTasks = workflowResult.warning
        ? null
        : chatRecords.filter((record) => record.status === "awaiting_continue").length;

      return {
        engine: cfg.engine,
        sessionBound: sessionResult.warning ? null : sessionResult.record !== null,
        threadId: sessionResult.warning || (cfg.engine !== "codex" && cfg.engine !== "antigravity")
          ? null
          : sessionResult.record?.codexSessionId ?? null,
        blockingTasks,
        waitingTasks,
        sessionWarning: sessionResult.warning,
        taskStateWarning: workflowResult.warning,
      };
    },
  })) {
    return;
  }

  if (allowTelegramCommands && await handleDelegationTelegramCommand({
    stateDir,
    startedAt,
    locale,
    cfg: {
      budgetUsd: cfg.budgetUsd,
      resume: cfg.resume,
    },
    normalized,
    context,
    bridge: context.bridge,
  })) {
    return;
  }

  if (allowTelegramCommands && await handleBoardTelegramCommand({
    stateDir,
    startedAt,
    locale,
    normalized,
    context: {
      ...context,
      cfg: {
        budgetUsd: cfg.budgetUsd,
        resume: cfg.resume,
      },
      bridge: context.bridge,
    },
  })) {
    return;
  }

  if (allowTelegramCommands && await handleMiniBusTelegramCommand({
    stateDir,
    startedAt,
    locale,
    cfg: {
      budgetUsd: cfg.budgetUsd,
      resume: cfg.resume,
    },
    normalized,
    context,
    bridge: context.bridge,
  })) {
    return;
  }

  if (await handleCrewTelegramWorkflow({
    stateDir,
    startedAt,
    locale,
    cfg: {
      budgetUsd: cfg.budgetUsd,
      resume: cfg.resume,
    },
    normalized,
    context,
  })) {
    return;
  }

  const cachedInputPreparation = preparedTelegramMessageInputs.get(normalized);
  const inputPreparation = cachedInputPreparation ?? await prepareTelegramMessageInput({
    locale,
    inboxDir: context.inboxDir,
    normalized,
    api: context.api,
    // Lets /stop kill a running cloud transcription instead of leaving the job
    // to its wall clock while the chat's queue slot stays held.
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
  });

  if (inputPreparation.kind === "reply") {
    await context.api.sendMessage(normalized.chatId, inputPreparation.text);
    return;
  }

  if (!cachedInputPreparation) {
    preparedTelegramMessageInputs.set(normalized, inputPreparation);
  }
  normalized.text = inputPreparation.text;

  await executeWorkflowAwareTelegramTurn({
    stateDir,
    startedAt,
    locale,
    cfg: {
      engine: cfg.engine,
      budgetUsd: cfg.budgetUsd,
      disableRuntimeTimeout: cfg.disableRuntimeTimeout,
      resume: cfg.resume,
    },
    normalized,
    context,
    workflowStore,
    downloadedAttachments: inputPreparation.downloadedAttachments,
    state: turnState,
    deliverTelegramResponse,
    sendTelegramOutFile,
    updateWorkflowBestEffort,
  });
}
