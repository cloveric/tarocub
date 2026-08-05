import type { EngineApprovalDecision, EngineApprovalRequest, EngineStreamEvent } from "../codex/adapter.js";
import { engineEventTimelineMetadata } from "../runtime/timeline-events.js";
import { handleBoardTelegramCommand, type BoardCommandContext } from "../telegram/board-commands.js";
import { BoardStore, normalizeBoardTaskId } from "../state/board-store.js";
import {
  handleCrewTelegramWorkflow,
  type CrewWorkflowContext,
} from "../telegram/crew-workflow.js";
import {
  handleDelegationTelegramCommand,
  type DelegationCommandBridge,
  type DelegationCommandContext,
} from "../telegram/delegation-commands.js";
import { loadInstanceConfig, resolveInstanceWorkspacePath } from "../telegram/instance-config.js";
import {
  handleMiniBusTelegramCommand,
  type MiniBusCommandBridge,
  type MiniBusCommandContext,
} from "../telegram/mini-bus-commands.js";
import type { NormalizedTelegramMessage } from "../telegram/update-normalizer.js";
import type { Locale } from "../telegram/message-renderer.js";
import {
  stableLarkNumericId,
  type LarkNormalizedBridgeMessage,
} from "./message-normalizer.js";
import { renderLarkBoardTaskCard } from "./board-card.js";
import { sendLarkCardWithFallback } from "./card-delivery.js";
import { deliverLarkResponse, sendLarkMarkdown } from "./delivery.js";
import { renderLarkBackgroundTaskHeader, resolveLarkLocale } from "./locale.js";
import { redactLarkErrorDetail } from "./redaction.js";
import type { LarkActiveRun, LarkServiceRuntime } from "./runtime.js";
import { appendLarkTimelineEvent } from "./timeline.js";
import type { LarkBridgeLike, LarkChannelLike } from "./types.js";

/**
 * Stop-target router for an autonomous /goal pursuit.
 *
 * A running /goal holds its conversation's activeRuns slot for the WHOLE
 * pursuit. Ordinary turns (chat messages, cron fires, board/mini/ask turns)
 * still run while it does — the chat queue already serializes their engine
 * turns behind the goal's turns at the bridge session-lock level; the
 * activeRuns slot is only stop-button/card bookkeeping. Instead of stealing
 * (and previously killing) the pursuit's slot, those turns ATTACH here, and
 * `abort()` — what /stop and every card stop button invoke on the slot's
 * controller — routes to the attached turn first. The resulting stop design:
 *
 * - /stop (or a stop button) while an ordinary turn runs alongside the
 *   pursuit stops that ORDINARY turn; the pursuit survives.
 * - /stop with nothing else running stops the pursuit itself.
 * - `/goal clear` (and a replacing /goal) call `abortGoal()`, which always
 *   ends the pursuit no matter what else is running.
 *
 * Defined here (not runtime.ts/commands.ts) so commands.ts, message-handler.ts
 * and cron.ts can all import it without a module cycle.
 */
export class LarkGoalRunController extends AbortController {
  private concurrentTurn: LarkActiveRun | null = null;

  /** The attached concurrent turn, if it is still live (not yet aborted). */
  liveConcurrentTurn(): LarkActiveRun | null {
    const turn = this.concurrentTurn;
    return turn && !turn.abortController.signal.aborted ? turn : null;
  }

  /**
   * Attach the conversation's current ordinary turn (the chat queue guarantees
   * at most one at a time). Returns a release that detaches only this turn, so
   * a stale release can never clobber a newer attachment.
   */
  attachConcurrentTurn(turn: LarkActiveRun): () => void {
    this.concurrentTurn = turn;
    return () => {
      if (this.concurrentTurn === turn) {
        this.concurrentTurn = null;
      }
    };
  }

  override abort(reason?: unknown): void {
    const turn = this.liveConcurrentTurn();
    if (turn) {
      turn.abortController.abort(reason);
      return;
    }
    super.abort(reason);
  }

  /** End the pursuit itself, bypassing the concurrent-turn stop routing. */
  abortGoal(reason?: unknown): void {
    super.abort(reason);
  }

  /**
   * End the pursuit AND any attached ordinary turn. Used by a replacing /goal,
   * which claims the slot for a new pursuit — leaving either running would
   * orphan it where no stop control can reach it.
   */
  abortAll(reason?: unknown): void {
    this.liveConcurrentTurn()?.abortController.abort(reason);
    super.abort(reason);
  }
}

/**
 * Claim the conversation's activeRuns slot for a turn — or, when a live /goal
 * pursuit holds the slot, attach the turn to the pursuit as its concurrent
 * turn instead (a pursuit must survive ordinary traffic; see
 * LarkGoalRunController). Returns a guarded release for the claimer's finally
 * block: it deletes the slot only while this turn still owns it (mirroring the
 * cron executor's guard, so a newer handle is never clobbered) and detaches
 * from the pursuit otherwise. A goalWatch holder without routing support (not
 * created by the /goal watcher) is left untouched — the turn simply runs
 * unslotted rather than killing the pursuit.
 *
 * `onOccupied` controls what happens when a live NON-goal run already holds the
 * slot: "replace" (default — chat-queue turns and cron, where serialization
 * guarantees any occupant is stale) overwrites it; "leave" (the bus command
 * handlers, which claim speculatively before their command even parses) keeps
 * the occupant and runs unslotted, so e.g. a /status probe or an unrelated
 * detached run is never clobbered by a command that turns out to be a no-op.
 */
export function claimLarkRunSlot(
  runtime: LarkServiceRuntime,
  conversationKey: string,
  run: LarkActiveRun,
  options?: { onOccupied?: "replace" | "leave" },
): () => void {
  const active = runtime.activeRuns.get(conversationKey);
  let detach: (() => void) | undefined;
  if (active?.goalWatch) {
    detach = active.abortController instanceof LarkGoalRunController
      ? active.abortController.attachConcurrentTurn(run)
      : undefined;
  } else if (!active || options?.onOccupied !== "leave") {
    runtime.activeRuns.set(conversationKey, run);
  }
  return () => {
    detach?.();
    // The pursuit may have ended mid-turn and promoted this turn into the
    // slot (the /goal watcher's finally), so the guarded delete applies to
    // the attached case too.
    if (runtime.activeRuns.get(conversationKey)?.abortController === run.abortController) {
      runtime.activeRuns.delete(conversationKey);
    }
  };
}

type LarkBusCommandInput = {
  channel: LarkChannelLike;
  bridge: LarkBridgeLike;
  runtime: LarkServiceRuntime;
  stateDir: string;
  instanceName?: string;
  requestApproval: (input: {
    channel: LarkChannelLike;
    runtime: LarkServiceRuntime;
    chatId: string;
    conversationKey?: string;
    bridgeChatType?: "private" | "group";
    requesterUserId?: number;
    replyTo?: string;
    replyInThread?: boolean;
    locale?: Locale;
    request: EngineApprovalRequest;
    abortSignal?: AbortSignal;
  }) => Promise<EngineApprovalDecision>;
};

export async function handleLarkBoardCommand(
  input: LarkBusCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveLarkLocale(input.stateDir);
  const abortController = new AbortController();
  const pendingReplies: string[] = [];
  const boardContext: BoardCommandContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        pendingReplies.push(text);
        return { message_id: 0, text };
      },
    },
    channel: "lark",
    instanceName: input.instanceName ?? "lark",
    cfg: {
      budgetUsd: cfg.budgetUsd,
      resume: cfg.resume,
    },
    bridge: input.bridge,
    abortSignal: abortController.signal,
    runQueuedBridgeTurn: async (conversationKey, job) => await input.runtime.chatQueue.enqueue(conversationKey, job),
    onApprovalRequest: async (request) => await input.requestApproval({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
      requesterUserId: normalized.bridgeUserId,
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      locale,
      request,
      abortSignal: request.abortSignal ?? abortController.signal,
    }),
    onEngineEvent: createLarkBusEngineEventHandler(input, normalized, {
      locale,
      source: "board",
      workspaceOverride: resolveInstanceWorkspacePath(cfg),
    }),
  };

  // Register the command's turn(s) under the ORIGINATING conversation so /stop
  // (and the stop button) can reach a running /board run — previously this
  // controller existed but nothing could ever abort it, so /stop reported
  // "nothing running" while the board turn kept going. claimLarkRunSlot attaches
  // to a live /goal pursuit instead of stealing its slot; "leave" keeps any
  // other live occupant (this claim happens before the command even parses);
  // the guarded release mirrors the cron executor's cleanup so a newer claim
  // is never clobbered.
  const releaseRunSlot = claimLarkRunSlot(input.runtime, normalized.conversationKey, {
    abortController,
    startedAt: Date.now(),
  }, { onOccupied: "leave" });
  let handled: boolean;
  try {
    handled = await handleBoardTelegramCommand({
      stateDir: input.stateDir,
      startedAt: Date.now(),
      locale,
      normalized: toBoardTelegramMessage(normalized, commandText),
      context: boardContext,
    });
  } finally {
    releaseRunSlot();
  }
  if (!handled) {
    return false;
  }
  for (const reply of pendingReplies) {
    await sendLarkBoardReply({
      channel: input.channel,
      stateDir: input.stateDir,
      normalized,
      commandText,
      reply,
      locale,
    });
  }
  return true;
}

async function sendLarkBoardReply(input: {
  channel: LarkChannelLike;
  stateDir: string;
  normalized: LarkNormalizedBridgeMessage;
  commandText: string;
  reply: string;
  locale: Locale;
}): Promise<void> {
  const showMatch = input.commandText.trim().match(/^\/(?:board|kanban)(?:@\w+)?\s+(?:show|view)\s+(\S+)/i);
  const taskId = showMatch ? normalizeBoardTaskId(showMatch[1]!) : null;
  if (taskId) {
    const task = await new BoardStore(input.stateDir).getTask(taskId);
    if (task) {
      await sendLarkCardWithFallback({
        channel: input.channel,
        chatId: input.normalized.chatId,
        card: renderLarkBoardTaskCard({
          task,
          markdown: input.reply,
          locale: input.locale,
          conversationKey: input.normalized.conversationKey,
          bridgeChatType: input.normalized.bridgeChatType,
          bridgeChatId: input.normalized.bridgeChatId,
          replyInThread: Boolean(input.normalized.threadId),
        }),
        fallbackText: input.reply,
        options: larkCommandReplyOptions(input.normalized),
        locale: input.locale,
      });
      return;
    }
  }
  await sendLarkMarkdown(input.channel, input.normalized.chatId, input.reply, larkCommandReplyOptions(input.normalized));
}

function toBoardTelegramMessage(
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): NormalizedTelegramMessage {
  return {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}

export async function handleLarkMiniBusCommand(
  input: LarkBusCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveLarkLocale(input.stateDir);
  const abortController = new AbortController();
  const context: MiniBusCommandContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        await sendLarkMarkdown(input.channel, normalized.chatId, text, larkCommandReplyOptions(normalized));
        return { message_id: 0, text };
      },
    },
    channel: "lark",
    instanceName: input.instanceName ?? "lark",
    abortSignal: abortController.signal,
    runQueuedBridgeTurn: input.runtime.miniRuntime?.runQueuedBridgeTurn
      ?? (async (conversationKey, job) => await input.runtime.chatQueue.enqueue(conversationKey, job)),
    onApprovalRequest: async (request) => await input.requestApproval({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
      requesterUserId: normalized.bridgeUserId,
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      locale,
      request,
      abortSignal: request.abortSignal ?? abortController.signal,
    }),
    onEngineEvent: createLarkBusEngineEventHandler(input, normalized, {
      locale,
      source: "mini",
      workspaceOverride: resolveInstanceWorkspacePath(cfg),
    }),
  };
  const bridge: MiniBusCommandBridge = {
    handleAuthorizedMessage: async (bridgeInput) => await input.bridge.handleAuthorizedMessage(bridgeInput),
  };

  // Same stop wiring as the board handler above: register under the originating
  // conversation so a running /mini or /ask turn is abortable via /stop and the
  // stop button instead of being an untracked controller nothing ever aborts.
  const releaseRunSlot = claimLarkRunSlot(input.runtime, normalized.conversationKey, {
    abortController,
    startedAt: Date.now(),
  }, { onOccupied: "leave" });
  try {
    return await handleMiniBusTelegramCommand({
      stateDir: input.stateDir,
      startedAt: Date.now(),
      locale,
      cfg: {
        budgetUsd: cfg.budgetUsd,
        resume: cfg.resume,
      },
      normalized: toMiniBusTelegramMessage(normalized, commandText),
      context,
      bridge,
    });
  } finally {
    releaseRunSlot();
  }
}

function toMiniBusTelegramMessage(
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): NormalizedTelegramMessage {
  const groupChatId = normalized.bridgeChatType === "group"
    ? stableLarkNumericId(`lark-group:${normalized.chatId}`)
    : normalized.bridgeChatId;
  const messageThreadId = normalized.threadId
    ? stableLarkNumericId(`lark-thread:${normalized.threadId}`)
    : undefined;

  return {
    chatId: groupChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType === "private" ? "private" : "supergroup",
    ...(messageThreadId !== undefined ? { messageThreadId } : {}),
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}

export async function handleLarkDelegationCommand(
  input: LarkBusCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): Promise<boolean> {
  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveLarkLocale(input.stateDir);
  // /ask (cross-instance delegation) previously ran with NO abort signal at
  // all: /stop said "nothing running" while the delegated turn kept going.
  // Same stop wiring as the board/mini handlers: a controller registered under
  // the originating conversation, its signal threaded through the context.
  const abortController = new AbortController();
  const context: DelegationCommandContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        await sendLarkMarkdown(input.channel, normalized.chatId, text, larkCommandReplyOptions(normalized));
        return { message_id: 0, text };
      },
    },
    channel: "lark",
    instanceName: input.instanceName ?? "lark",
    abortSignal: abortController.signal,
    onEngineEvent: createLarkBusEngineEventHandler(input, normalized, {
      locale,
      source: "delegation",
      workspaceOverride: resolveInstanceWorkspacePath(cfg),
    }),
  };
  const bridge: DelegationCommandBridge = {
    handleAuthorizedMessage: async (bridgeInput) => {
      const delegatedInput: Parameters<LarkBridgeLike["handleAuthorizedMessage"]>[0] = {
        ...bridgeInput,
        workspaceOverride: bridgeInput.workspaceOverride,
      };
      if (bridgeInput.chatType !== "bus") {
        delegatedInput.conversationKey = normalized.conversationKey;
      }
      return await input.bridge.handleAuthorizedMessage(delegatedInput);
    },
  };

  const releaseRunSlot = claimLarkRunSlot(input.runtime, normalized.conversationKey, {
    abortController,
    startedAt: Date.now(),
  }, { onOccupied: "leave" });
  try {
    return await handleDelegationTelegramCommand({
      stateDir: input.stateDir,
      startedAt: Date.now(),
      locale,
      cfg: {
        budgetUsd: cfg.budgetUsd,
        resume: cfg.resume,
      },
      normalized: toDelegationTelegramMessage(normalized, commandText),
      context,
      bridge,
      loadBusConfig: input.runtime.busRuntime?.loadBusConfig,
      delegateToInstance: input.runtime.busRuntime?.delegateToInstance,
    });
  } finally {
    releaseRunSlot();
  }
}

export async function handleLarkCrewWorkflow(
  input: LarkBusCommandInput & {
    abortSignal?: AbortSignal;
  },
  normalized: LarkNormalizedBridgeMessage,
  prompt: string,
): Promise<boolean> {
  if (normalized.attachments.length > 0) {
    return false;
  }

  const cfg = await loadInstanceConfig(input.stateDir);
  const locale = await resolveLarkLocale(input.stateDir);
  const context: CrewWorkflowContext = {
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        await sendLarkMarkdown(input.channel, normalized.chatId, text, larkCommandReplyOptions(normalized));
        return { message_id: 0, text };
      },
    },
    channel: "lark",
    instanceName: input.instanceName ?? "lark",
    abortSignal: input.abortSignal,
    bridge: {
      handleAuthorizedMessage: async (bridgeInput) => await input.bridge.handleAuthorizedMessage(bridgeInput),
    },
    onApprovalRequest: async (request) => await input.requestApproval({
      channel: input.channel,
      runtime: input.runtime,
      chatId: normalized.chatId,
      conversationKey: normalized.conversationKey,
      bridgeChatType: normalized.bridgeChatType,
      requesterUserId: normalized.bridgeUserId,
      replyTo: normalized.messageId,
      replyInThread: Boolean(normalized.threadId),
      locale,
      request,
      abortSignal: request.abortSignal ?? input.abortSignal,
    }),
    onEngineEvent: createLarkBusEngineEventHandler(input, normalized, {
      locale,
      source: "crew",
      workspaceOverride: resolveInstanceWorkspacePath(cfg),
    }),
  };

  return await handleCrewTelegramWorkflow({
    stateDir: input.stateDir,
    startedAt: Date.now(),
    locale,
    cfg: {
      budgetUsd: cfg.budgetUsd,
      resume: cfg.resume,
    },
    normalized: toDelegationTelegramMessage(normalized, prompt),
    context,
    loadBusConfig: input.runtime.busRuntime?.loadBusConfig,
    delegateToInstance: input.runtime.busRuntime?.delegateToInstance,
  });
}

function larkCommandReplyOptions(normalized: LarkNormalizedBridgeMessage): { replyTo: string; replyInThread: boolean } {
  return {
    replyTo: normalized.messageId,
    replyInThread: Boolean(normalized.threadId),
  };
}

function createLarkBusEngineEventHandler(
  input: LarkBusCommandInput,
  normalized: LarkNormalizedBridgeMessage,
  options: {
    locale: "en" | "zh";
    source: string;
    workspaceOverride?: string;
  },
): (event: EngineStreamEvent) => Promise<void> {
  return async (event) => {
    await appendLarkTimelineEvent(input.stateDir, normalized, {
      type: "engine.event",
      detail: event.type,
      metadata: {
        source: options.source,
        ...engineEventTimelineMetadata(event),
      },
    });

    if (event.type !== "task_notification" || event.settlesCurrentTurn) {
      return;
    }

    const notificationText = [
      renderLarkBackgroundTaskHeader(options.locale, event.status),
      event.text.trim(),
    ].filter(Boolean).join("\n");

    try {
      await deliverLarkResponse({
        channel: input.channel,
        runtime: input.runtime,
        chatId: normalized.chatId,
        replyTo: normalized.messageId,
        replyInThread: Boolean(normalized.threadId),
        text: notificationText,
        stateDir: input.stateDir,
        workspaceOverride: options.workspaceOverride,
        conversationKey: normalized.conversationKey,
        bridgeChatType: normalized.bridgeChatType,
        bridgeChatId: normalized.bridgeChatId,
        bridgeUserId: normalized.bridgeUserId,
        larkThreadId: normalized.threadId,
        larkMessageId: normalized.messageId,
        instanceName: input.instanceName,
      });
    } catch (error) {
      await appendLarkTimelineEvent(input.stateDir, normalized, {
        type: "engine.event.delivery_failed",
        outcome: "error",
        detail: redactLarkErrorDetail(error),
        metadata: {
          source: options.source,
          eventType: event.type,
        },
      });
    }
  };
}

function toDelegationTelegramMessage(
  normalized: LarkNormalizedBridgeMessage,
  commandText: string,
): NormalizedTelegramMessage {
  return {
    chatId: normalized.bridgeChatId,
    userId: normalized.bridgeUserId,
    chatType: normalized.bridgeChatType,
    conversationKey: normalized.conversationKey,
    text: commandText,
    attachments: [],
  };
}
