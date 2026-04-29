import type { FileWorkflowStore } from "../state/file-workflow-store.js";
import { handleCrewTelegramWorkflow as defaultHandleCrewTelegramWorkflow } from "./crew-workflow.js";
import type { SessionStore } from "../state/session-store.js";
import { handleDelegationTelegramCommand as defaultHandleDelegationTelegramCommand } from "./delegation-commands.js";
import { handleLocalEngineTelegramCommand as defaultHandleLocalEngineTelegramCommand } from "./engine-commands.js";
import type { ResumeState } from "./instance-config.js";
import { prepareTelegramMessageInput as defaultPrepareTelegramMessageInput } from "./message-input.js";
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
import type { EngineApprovalDecision, EngineApprovalRequest, EngineStreamEvent } from "../codex/adapter.js";
import type { DeliveryAcceptedReceipt, DeliveryRejectedReceipt, DeliverySource } from "./delivery-ledger.js";

export interface AuthorizedTelegramDispatchConfig {
  engine: "codex" | "claude";
  budgetUsd?: number;
  effort?: string;
  model?: string;
  resume?: ResumeState;
}

export interface AuthorizedTelegramDispatchContext {
  api: Pick<TelegramApi, "sendMessage" | "sendDocument" | "sendPhoto" | "getFile" | "downloadFile">;
  bridge: {
    supportsTurnScopedEnv?: boolean;
    validateCodexThread?(threadId: string): Promise<void>;
    handleAuthorizedMessage(input: {
      chatId: number;
      userId: number;
      chatType: string;
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
  sessionIdOverride?: string;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  instanceName?: string;
  updateId?: number;
}

export interface AuthorizedTelegramDispatchDeps {
  sessionStore: Pick<SessionStore, "findByChatIdSafe" | "inspect" | "removeByChatId" | "clearAll" | "upsert">;
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
  handleSimpleLocalTelegramCommand?: typeof defaultHandleSimpleLocalTelegramCommand;
  handleCronCommand?: typeof defaultHandleCronCommand;
  handleDelegationTelegramCommand?: typeof defaultHandleDelegationTelegramCommand;
  handleCrewTelegramWorkflow?: typeof defaultHandleCrewTelegramWorkflow;
  prepareTelegramMessageInput?: typeof defaultPrepareTelegramMessageInput;
  executeWorkflowAwareTelegramTurn?: typeof defaultExecuteWorkflowAwareTelegramTurn;
}

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
    handleSimpleLocalTelegramCommand = defaultHandleSimpleLocalTelegramCommand,
    handleCronCommand = defaultHandleCronCommand,
    handleDelegationTelegramCommand = defaultHandleDelegationTelegramCommand,
    handleCrewTelegramWorkflow = defaultHandleCrewTelegramWorkflow,
    prepareTelegramMessageInput = defaultPrepareTelegramMessageInput,
    executeWorkflowAwareTelegramTurn = defaultExecuteWorkflowAwareTelegramTurn,
  } = handlers ?? {};

  const allowTelegramCommands = context.source !== "cron";

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

  if (allowTelegramCommands && await handleSimpleLocalTelegramCommand({
    stateDir,
    startedAt,
    locale,
    cfg: {
      engine: cfg.engine,
      effort: cfg.effort,
      model: cfg.model,
    },
    normalized,
    context,
    updateInstanceConfig,
    resolveStatus: async (chatId) => {
      const sessionResult = await sessionStore.findByChatIdSafe(chatId);
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
        threadId: sessionResult.warning || cfg.engine !== "codex"
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

  const inputPreparation = await prepareTelegramMessageInput({
    locale,
    inboxDir: context.inboxDir,
    normalized,
    api: context.api,
  });

  if (inputPreparation.kind === "reply") {
    await context.api.sendMessage(normalized.chatId, inputPreparation.text);
    return;
  }

  normalized.text = inputPreparation.text;

  await executeWorkflowAwareTelegramTurn({
    stateDir,
    startedAt,
    locale,
    cfg: {
      engine: cfg.engine,
      budgetUsd: cfg.budgetUsd,
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
