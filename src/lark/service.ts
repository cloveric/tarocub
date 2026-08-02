import {
  createLarkChannel,
  type LarkChannelOptions,
} from "@larksuiteoapi/node-sdk";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { stripGeneratedTelegramTransportSection } from "../commands/access.js";
import { createBridgeDependencies } from "../service.js";
import { appendServiceLifecycleEventSync, type ServiceLifecycleEvent } from "../runtime/service-lifecycle-log.js";
import { CronScheduler } from "../runtime/cron-scheduler.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { loadTelemetryAdapterFromEnv } from "../runtime/telemetry.js";
import { CronStore } from "../state/cron-store.js";
import { DEFAULT_ROTATE_OPTIONS } from "../state/log-rotation.js";
import { parseTimelineEvents, resolveTimelineLogPath, type TimelineEvent } from "../state/timeline-log.js";
import { loadInstanceConfig } from "../telegram/instance-config.js";
import { larkAgentInstructions } from "./agent-instructions.js";
import { handleLarkCardAction, requestLarkApproval } from "./card-actions.js";
import { handleLarkComment, normalizeLarkCommentFileType } from "./comment-handler.js";
import { createLarkCommentClient } from "./comment-client.js";
import { resolveLarkInstanceName, resolveLarkRuntimeConfig, type LarkRuntimeConfig, type LarkRuntimeEnv } from "./config.js";
import { buildLarkCronExecutor, sendLarkCronFailureNotification } from "./cron.js";
import { deliverLarkResponse } from "./delivery.js";
import { startLarkHealthMonitor, type LarkHealthMonitor } from "./health.js";
import { larkOperatorRawId } from "./identity.js";
import { resolveLarkLocale } from "./locale.js";
import { createLarkRunCardController, handleLarkMessage } from "./message-handler.js";
import { buildLarkConversationKey, larkChatIsTopicForm, larkSessionThreadIdForMessage, stableLarkNumericId } from "./message-normalizer.js";
import { resolveLarkReactionSettings } from "./reactions.js";
import { redactLarkErrorDetail } from "./redaction.js";
import { renderLarkUserFacingError } from "./errors.js";
import {
  createLarkServiceRuntime,
  type LarkServiceRuntime,
} from "./runtime.js";
import { acquireLarkServiceLock } from "./service-lifecycle.js";
import type {
  LarkBridgeLike,
  LarkRuntimeChannelLike,
  LarkServiceLogger,
} from "./types.js";

export { createLarkDocumentWithCli } from "./document-client.js";
export type { LarkDocumentCreateInput, LarkDocumentCreateResult } from "./document-client.js";
export { createLarkChatWithCli } from "./chat-client.js";
export type { LarkChatCreateInput, LarkChatCreateResult } from "./chat-client.js";
export { buildLarkCronExecutor, sendLarkCronFailureNotification } from "./cron.js";
export { handleLarkCardAction, requestLarkApproval } from "./card-actions.js";
export { handleLarkComment } from "./comment-handler.js";
export { handleLarkMessage } from "./message-handler.js";
export { resolveLarkInstanceName, resolveLarkRuntimeConfig } from "./config.js";
export type { LarkRuntimeConfig, LarkRuntimeEnv } from "./config.js";
export { createLarkServiceRuntime } from "./runtime.js";
export { resolveLarkServiceLockDir, resolveLarkServiceLockPath } from "./service-lifecycle.js";
export { cleanupLarkMessageArtifacts } from "./files.js";
export type {
  LarkBridgeLike,
  LarkChannelLike,
  LarkRuntimeChannelLike,
  LarkSendOptions,
  LarkServiceLogger,
  LarkStreamControllerLike,
} from "./types.js";

/** Minimal shape of the SDK channel's raw client used to read a chat's form. */
interface LarkRawChatClient {
  im: { v1: { chat: { get(args: { path: { chat_id: string } }): Promise<{ data?: Record<string, unknown> }> } } };
}

/**
 * Timestamp every SDK log line. The SDK's ws lifecycle logs ("ws client
 * ready", "reconnect", "closed manually") carry no timestamps, which made it
 * impossible to correlate a transient WS disconnect with a failed card
 * callback (the stop-button 108002 incident: the tap died inside a reconnect
 * window nobody could date). Exported for tests.
 */
export function createTimestampedSdkLogger(logger: LarkServiceLogger): {
  error: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  debug: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
} {
  const stamp = (level: string, msg: unknown[]): unknown[] => [`${new Date().toISOString()} [lark-sdk:${level}]`, ...msg];
  return {
    error: (...msg: unknown[]) => logger.error(...stamp("error", msg)),
    warn: (...msg: unknown[]) => logger.log(...stamp("warn", msg)),
    info: (...msg: unknown[]) => logger.log(...stamp("info", msg)),
    debug: (...msg: unknown[]) => logger.log(...stamp("debug", msg)),
    trace: (...msg: unknown[]) => logger.log(...stamp("trace", msg)),
  };
}

export async function runLarkService(
  env: LarkRuntimeEnv = process.env,
  options: {
    createChannel?: (options: LarkChannelOptions) => LarkRuntimeChannelLike;
    createBridge?: (env: LarkRuntimeEnv, config: LarkRuntimeConfig) => Promise<{ stateDir: string; bridge: LarkBridgeLike }>;
    runtime?: LarkServiceRuntime;
    signal?: AbortSignal;
    logger?: LarkServiceLogger;
  } = {},
): Promise<void> {
  const logger = options.logger ?? console;
  const config = resolveLarkRuntimeConfig(env);
  const instanceName = resolveLarkInstanceName(env);
  const debugLogging = isLarkDebugEnabled(env.CCTB_LARK_DEBUG);
  const reactionSettings = resolveLarkReactionSettings(env);
  let lifecycleStateDir = config.stateDir;
  const logLifecycleEvent = (event: Omit<ServiceLifecycleEvent, "instanceName">): void => {
    appendServiceLifecycleEventSync(lifecycleStateDir, {
      ...event,
      instanceName,
    });
  };
  // The `lark run` bootstrap returns before index.ts installs its global
  // unhandledRejection handler, so register one here too: a stray rejection must
  // not silently kill the long-running Lark service.
  const unhandledRejectionHandler = (reason: unknown): void => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logLifecycleEvent({
      type: "process.unhandled_rejection",
      outcome: "error",
      detail: error.message,
      metadata: { channel: "lark", stack: error.stack },
    });
  };
  process.on("unhandledRejection", unhandledRejectionHandler);
  options.signal?.addEventListener("abort", () => {
    process.removeListener("unhandledRejection", unhandledRejectionHandler);
  }, { once: true });
  logLifecycleEvent({
    type: "service.starting",
    metadata: {
      channel: "lark",
      stateDir: config.stateDir,
    },
  });
  const uncaughtExceptionMonitor = (error: Error, origin: string): void => {
    logLifecycleEvent({
      type: "process.uncaught_exception",
      outcome: "error",
      detail: redactLarkErrorDetail(error),
      metadata: {
        origin,
        stack: error.stack ? redactLarkErrorDetail(error.stack) : undefined,
      },
    });
  };
  process.on("uncaughtExceptionMonitor", uncaughtExceptionMonitor);
  const bridgeEnv = {
    ...env,
    TAROCUB_INSTANCE: instanceName,
    CODEX_TELEGRAM_STATE_DIR: config.stateDir,
    CODEX_TELEGRAM_INSTANCE: instanceName,
  };
  await removeGeneratedTelegramTransportFromLarkAgent(config.stateDir, logger);
  const { stateDir, bridge } = options.createBridge
    ? await options.createBridge(bridgeEnv, config)
    : await createDefaultLarkBridge(bridgeEnv);
  lifecycleStateDir = stateDir;
  const runtime = options.runtime ?? createLarkServiceRuntime({
    queuePolicy: resolveLarkQueuePolicy(env),
  });
  const telemetry = await loadTelemetryAdapterFromEnv(bridgeEnv);
  runtime.commentClient ??= createLarkCommentClient(config);
  runtime.appInfo ??= {
    appId: config.appId,
    appSecret: config.appSecret,
    ...(config.domain !== undefined ? { domain: String(config.domain) } : {}),
  };
  const serviceLock = await acquireLarkServiceLock(stateDir);
  let channel: LarkRuntimeChannelLike | undefined;
  let connected = false;
  let cronScheduler: CronScheduler | undefined;
  let healthMonitor: LarkHealthMonitor | undefined;
  let stopOutcome: "success" | "error" = "success";
  try {
    try {
      const recoveredTurns = await recoverInterruptedLarkTurns(stateDir, instanceName);
      if (recoveredTurns > 0) {
        logLifecycleEvent({
          type: "service.startup_maintenance",
          outcome: "success",
          detail: `marked ${recoveredTurns} interrupted Lark turn${recoveredTurns === 1 ? "" : "s"}`,
          metadata: {
            recoveredTurns,
          },
        });
      }
    } catch (error) {
      logLifecycleEvent({
        type: "service.startup_maintenance",
        outcome: "error",
        detail: `recover interrupted Lark turns: ${redactLarkErrorDetail(error)}`,
      });
    }

    const channelOptions: LarkChannelOptions = {
      appId: config.appId,
      appSecret: config.appSecret,
      transport: "websocket",
      source: "tarocub",
      logger: createTimestampedSdkLogger(logger),
      // The SDK's normalizeCardAction drops action.form_value, so AskUserQuestion
      // form submits (select/dropdown picks) would otherwise arrive empty. Keep
      // the raw event body on every normalized event so the card-action handler
      // can recover form_value from evt.raw.
      includeRawEvent: true,
      policy: {
        dmMode: "open",
        requireMention: false,
        respondToMentionAll: false,
      },
      safety: {
        chatQueue: {
          enabled: false,
        },
      },
      ...(config.domain !== undefined ? { domain: config.domain } : {}),
    };
    channel = options.createChannel
      ? options.createChannel(channelOptions)
      : createLarkChannel(channelOptions) as LarkRuntimeChannelLike;

    // The SDK channel only exposes chat_mode via getChatMode, but topic
    // isolation also depends on group_message_type (a conversation group can be
    // switched to the topic message form). Read both off the raw client so each
    // topic in a topic-form chat gets its own session, while a conversation-form
    // group keeps sharing one. Attached only when the SDK exposes rawClient.
    if (!channel.getChatTopicForm) {
      const rawClient = (channel as { rawClient?: unknown }).rawClient as LarkRawChatClient | undefined;
      if (typeof rawClient?.im?.v1?.chat?.get === "function") {
        channel.getChatTopicForm = async (chatId: string): Promise<boolean> => {
          const response = await rawClient.im.v1.chat.get({ path: { chat_id: chatId } });
          return larkChatIsTopicForm(response?.data ?? {});
        };
      }
    }

    channel.on("message", async (message) => {
      try {
        if (debugLogging) {
          logger.log("Lark raw message event", JSON.stringify({
            chatId: message.chatId,
            chatType: message.chatType,
            messageId: message.messageId,
            mentionedBot: message.mentionedBot === true,
            mentionAll: message.mentionAll === true,
            contentLength: typeof message.content === "string" ? message.content.length : 0,
            rawContentType: message.rawContentType,
            resources: Array.isArray(message.resources) ? message.resources.length : 0,
          }));
        }
        await handleLarkMessage({
          channel: channel!,
          bridge,
          runtime,
          stateDir,
          instanceName,
          message,
          requireMentionInGroup: config.requireMentionInGroup,
          reactionSettings,
        });
      } catch (error) {
        logLarkServiceError(logger, "Lark message handling failed", error);
        await appendLarkServiceMessageErrorTimelineEvent(stateDir, message);
        const locale = await resolveLarkLocale(stateDir);
        await channel!.send(message.chatId, {
          text: renderLarkUserFacingError(error, "engine", locale),
        }, {
          replyTo: message.messageId,
          ...((message as { threadId?: string }).threadId ? { replyInThread: true } : {}),
        }).catch(() => undefined);
      }
    });
    channel.on("reject", (event) => {
      if (debugLogging) {
        logger.log("Lark SDK rejected message", JSON.stringify({
          chatId: event.chatId,
          messageId: event.messageId,
          reason: event.reason,
        }));
      }
    });
    channel.on("cardAction", (event) => {
      // Feishu gives a card-button callback only ~3s to be acknowledged; if we
      // haven't responded by then the user sees "出错了，请稍后重试" (e.g. pressing
      // the stop button while a tool call keeps the process busy). So ack
      // IMMEDIATELY — return synchronously so the SDK sends its {} ack now — and
      // run the real handler detached, exactly how inbound messages are
      // dispatched (`void dispatchHandler`). Card updates happen out-of-band via
      // the CardKit API, never through the callback response, so nothing depends
      // on us blocking the ack. This makes the stop button as reliable as the
      // /stop text command (both ultimately call the same abortController.abort()).
      void (async () => {
        try {
          await handleLarkCardAction({ channel: channel!, bridge, runtime, stateDir, instanceName, event });
        } catch (error) {
          logLarkServiceError(logger, "Lark card action handling failed", error);
          await appendLarkServiceCardActionErrorTimelineEvent(stateDir, event);
          const locale = await resolveLarkLocale(stateDir);
          await channel!.send(event.chatId, {
            text: renderLarkUserFacingError(error, "engine", locale),
          }, {
            replyTo: event.messageId,
            ...getCardActionReplyInThreadOption(event),
          }).catch(() => undefined);
        }
      })();
    });
    channel.on("comment", async (event) => {
      try {
        await handleLarkComment({ bridge, runtime, stateDir, event });
      } catch (error) {
        logLarkServiceError(logger, "Lark comment handling failed", error);
        await appendLarkServiceCommentErrorTimelineEvent(stateDir, event);
        if (event.mentionedBot && runtime.commentClient) {
          const locale = await resolveLarkLocale(stateDir);
          await runtime.commentClient.createReply({
            fileToken: event.fileToken,
            fileType: normalizeLarkCommentFileType(event.fileType),
            commentId: event.commentId,
            text: renderLarkUserFacingError(error, "engine", locale),
          }).catch(() => undefined);
        }
      }
    });
    channel.on("error", async (error) => {
      logLarkServiceError(logger, "Lark channel error", error);
      await appendLarkChannelErrorTimelineEvent(stateDir, error);
    });

    await channel.connect();
    connected = true;
    healthMonitor = startLarkHealthMonitor({
      stateDir,
      instanceName,
      channel,
      domain: config.domain,
      intervalMs: parsePositiveIntegerEnv(env.CCTB_LARK_HEALTH_INTERVAL_MS),
      failureThreshold: parsePositiveIntegerEnv(env.CCTB_LARK_HEALTH_FAILURE_THRESHOLD),
      telemetry,
    });
    if (!runtime.cronRuntime) {
      // Schedule recurring jobs in the operator-configured instance timezone
      // (config.json `timezone`), matching the Telegram boot — otherwise Lark
      // cron jobs silently run in the host timezone.
      const instanceConfig = await loadInstanceConfig(stateDir);
      const cronStore = new CronStore(stateDir, { defaultTimezone: instanceConfig.timezone });
      cronScheduler = new CronScheduler({
        store: cronStore,
        executor: buildLarkCronExecutor({
          channel,
          bridge,
          runtime,
          stateDir,
          agentInstructions: larkAgentInstructions,
          deliverResponse: deliverLarkResponse,
          createRunCard: createLarkRunCardController,
          requestApproval: requestLarkApproval,
        }),
        stateDir,
        instanceName,
        onJobFailure: async (job, detail) => {
          await sendLarkCronFailureNotification(channel!, job, detail);
        },
      });
      await cronScheduler.start();
      runtime.cronRuntime = { store: cronStore, scheduler: cronScheduler };
    }
    logger.log(`${new Date().toISOString()} Lark channel connected; stateDir=${stateDir}; lock=${serviceLock.filePath}`);
    logLifecycleEvent({
      type: "service.started",
      outcome: "success",
      metadata: {
        channel: "lark",
        lockPath: serviceLock.filePath,
      },
    });
    await waitForAbort(options.signal);
  } catch (error) {
    stopOutcome = "error";
    logLifecycleEvent({
      type: "service.fatal",
      outcome: "error",
      detail: redactLarkErrorDetail(error),
      metadata: {
        channel: "lark",
      },
    });
    throw error;
  } finally {
    try {
      healthMonitor?.stop();
      if (cronScheduler) {
        await cronScheduler.stop();
      }
      try {
        await bridge.destroy?.();
      } catch (error) {
        logLifecycleEvent({
          type: "service.shutdown_cleanup",
          outcome: "error",
          detail: `bridge destroy: ${redactLarkErrorDetail(error)}`,
          metadata: {
            channel: "lark",
          },
        });
      }
      if (connected && channel) {
        await channel.disconnect();
      }
    } finally {
      await serviceLock.release();
      logLifecycleEvent({
        type: "service.stopped",
        outcome: stopOutcome,
        metadata: buildLarkServiceStoppedMetadata(options.signal),
      });
      process.removeListener("uncaughtExceptionMonitor", uncaughtExceptionMonitor);
      process.removeListener("unhandledRejection", unhandledRejectionHandler);
    }
  }
}

function buildLarkServiceStoppedMetadata(signal: AbortSignal | undefined): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    channel: "lark",
  };
  if (signal?.aborted) {
    metadata.abortReason = formatLarkAbortReason(signal.reason);
  }
  return metadata;
}

function formatLarkAbortReason(reason: unknown): string {
  if (typeof reason === "string") {
    return reason;
  }
  if (reason instanceof Error) {
    return redactLarkErrorDetail(reason);
  }
  if (reason === undefined) {
    return "abort";
  }
  try {
    return JSON.stringify(reason) ?? String(reason);
  } catch {
    return String(reason);
  }
}

function resolveLarkQueuePolicy(env: LarkRuntimeEnv): { preempt: boolean; batchWindowMs: number } {
  const mode = (env.CCTB_LARK_QUEUE_MODE ?? env.TAROCUB_LARK_QUEUE_MODE ?? "queue").trim().toLowerCase();
  const batchWindowMs = parseNonNegativeIntegerEnv(env.CCTB_LARK_BATCH_WINDOW_MS ?? env.TAROCUB_LARK_BATCH_WINDOW_MS);
  return {
    preempt: mode === "preempt" || mode === "preempt-batch" || mode === "preempt_batch",
    batchWindowMs: mode === "batch" || mode === "preempt-batch" || mode === "preempt_batch"
      ? batchWindowMs ?? 750
      : batchWindowMs ?? 0,
  };
}

function parseNonNegativeIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  if (/^(?:off|false|no)$/i.test(value.trim())) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Default byte budget for the tail-oriented rotation readers. One rotation is
 * 10 MB, so this covers the current file plus the previous one — enough to pair
 * any in-flight turn across a rotation boundary, without parsing the 60+ MB of
 * history that `readRotatedLogFile` (unbounded) would hand back.
 */
export const ROTATED_LOG_TAIL_DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function rotationCandidatesOldestFirst(filePath: string): string[] {
  return [
    ...Array.from({ length: DEFAULT_ROTATE_OPTIONS.keepCount }, (_value, index) =>
      `${filePath}.${DEFAULT_ROTATE_OPTIONS.keepCount - index}`),
    filePath,
  ];
}

/**
 * Read a rotated structured log (`<path>` plus `<path>.1`…`<path>.N`)
 * oldest-first. Returns null when no file exists yet. Shared by the Lark
 * timeline reader and by the CLI's `timeline` / `audit` readers, which
 * otherwise showed "(empty)" right after a rotation while tens of MB sat in the
 * retained files.
 */
export async function readRotatedLogFile(filePath: string): Promise<string | null> {
  const rawParts: string[] = [];
  for (const candidate of rotationCandidatesOldestFirst(filePath)) {
    const content = await readFileOrNull(candidate);
    if (content !== null) {
      rawParts.push(content);
    }
  }
  return rawParts.length > 0 ? rawParts.join("\n") : null;
}

/**
 * Bounded variant of {@link readRotatedLogFile}: walks the rotations
 * NEWEST-first and stops as soon as `maxBytes` is covered (or, with
 * `sinceMs`, as soon as the accumulated files reach back past that instant).
 * Still returns the text oldest-first so parsers see chronological order.
 *
 * Callers that only care about recent activity (the restart guard's in-flight
 * turns, boot recovery) must use this: the unbounded reader parsed all
 * retained rotations — 62 MB / ~165k events on a busy instance — to answer a
 * question about the last few hours.
 */
export async function readRotatedLogFileTail(filePath: string, options: {
  maxBytes?: number;
  sinceMs?: number;
  /**
   * Minimum number of existing files to read before any stop rule applies.
   * Defaults to 2 (current + newest rotation) so a turn whose start rotated out
   * is still paired with its terminal event — the whole reason the unbounded
   * reader existed.
   */
  minFiles?: number;
} = {}): Promise<string | null> {
  const maxBytes = options.maxBytes ?? ROTATED_LOG_TAIL_DEFAULT_MAX_BYTES;
  const minFiles = options.minFiles ?? 2;
  const newestFirst = [...rotationCandidatesOldestFirst(filePath)].reverse();
  const parts: string[] = [];
  let bytes = 0;
  for (const candidate of newestFirst) {
    const content = await readFileOrNull(candidate);
    if (content === null) {
      continue;
    }
    parts.push(content);
    bytes += Buffer.byteLength(content, "utf8");
    if (parts.length < minFiles) {
      continue;
    }
    // Coverage BEFORE budget: stopping on bytes first meant a busy instance could
    // return a window shorter than `sinceMs`, so a long turn whose start record
    // had rotated into .2+ looked idle and `restart --all` killed it mid-run.
    // The byte budget only applies once the caller's window is actually covered
    // (or when no window was requested).
    if (options.sinceMs !== undefined) {
      if (reachesBack(content, options.sinceMs)) {
        break;
      }
      continue;
    }
    if (bytes >= maxBytes) {
      break;
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.reverse().join("\n");
}

/** True when this log chunk's earliest event is at or before `sinceMs`. */
function reachesBack(content: string, sinceMs: number): boolean {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { timestamp?: unknown };
      if (typeof parsed.timestamp === "string") {
        const parsedMs = new Date(parsed.timestamp).getTime();
        return Number.isFinite(parsedMs) && parsedMs <= sinceMs;
      }
    } catch {
      // Not a parsable event line — keep looking.
    }
    return false;
  }
  return false;
}

/**
 * Read the instance timeline including retained rotations, oldest-first
 * (`.5` → `.1` → current). A turn accepted just before a 10 MB rotation has its
 * input.received in a rotated file while its terminal event (if any) lands in
 * the current file, so any pairing pass must see the concatenation. Returns
 * null when no timeline file exists yet. Shared with the CLI restart guard.
 */
export async function readLarkTimelineLogWithRotations(stateDir: string): Promise<string | null> {
  return await readRotatedLogFile(resolveTimelineLogPath(stateDir));
}

/**
 * Recent-window variant used by boot recovery and the CLI restart guard: both
 * only need to pair turns that are still plausibly in flight.
 */
export async function readLarkTimelineLogTail(stateDir: string, options: {
  maxBytes?: number;
  sinceMs?: number;
} = {}): Promise<string | null> {
  return await readRotatedLogFileTail(resolveTimelineLogPath(stateDir), options);
}

/** How far back boot recovery / the restart guard look for unpaired turns. */
export const LARK_PENDING_TURN_LOOKBACK_MS = 6 * 60 * 60_000;

async function recoverInterruptedLarkTurns(stateDir: string, instanceName: string): Promise<number> {
  const raw = await readLarkTimelineLogTail(stateDir, {
    sinceMs: Date.now() - LARK_PENDING_TURN_LOOKBACK_MS,
  });
  if (raw === null) {
    return 0;
  }

  const pendingByConversationKey = new Map<string, TimelineEvent[]>();
  const terminalMessageIds = new Set<string>();
  const events = parseTimelineEvents(raw);
  for (const event of events) {
    if (event.channel !== "lark") {
      continue;
    }

    const messageId = getTimelineLarkMessageId(event);
    if (event.type === "input.received" && messageId) {
      const conversationKey = event.conversationKey ?? "";
      const pending = pendingByConversationKey.get(conversationKey) ?? [];
      pending.push(event);
      pendingByConversationKey.set(conversationKey, pending);
      continue;
    }

    if (!isLarkTerminalTimelineEvent(event)) {
      continue;
    }

    if (messageId) {
      terminalMessageIds.add(messageId);
      removePendingLarkTimelineEvent(pendingByConversationKey, event.conversationKey, messageId);
      continue;
    }

    // Older command timeline events did not include larkMessageId. They still
    // complete the oldest pending input in the same conversation.
    const pending = pendingByConversationKey.get(event.conversationKey ?? "");
    const matched = pending?.shift();
    const matchedMessageId = matched ? getTimelineLarkMessageId(matched) : undefined;
    if (matchedMessageId) {
      terminalMessageIds.add(matchedMessageId);
    }
    if (pending && pending.length === 0) {
      pendingByConversationKey.delete(event.conversationKey ?? "");
    }
  }

  let recovered = 0;
  const recoveredMessageIds = new Set<string>();
  const interruptedInputs = [...pendingByConversationKey.values()].flat();
  for (const event of interruptedInputs) {
    const messageId = getTimelineLarkMessageId(event);
    if (!messageId || terminalMessageIds.has(messageId) || recoveredMessageIds.has(messageId)) {
      continue;
    }
    recoveredMessageIds.add(messageId);
    recovered += 1;
    await appendTimelineEventBestEffort(stateDir, {
      type: "turn.completed",
      instanceName,
      channel: "lark",
      chatId: event.chatId,
      userId: event.userId,
      conversationKey: event.conversationKey,
      outcome: "interrupted",
      detail: "service restarted before accepted Lark turn reached a terminal state",
      metadata: {
        ...copyLarkTimelineMetadata(event.metadata),
        phase: "startup-recovery",
        acceptedAt: event.timestamp,
      },
    }, "Lark interrupted turn recovery timeline event");
  }
  return recovered;
}

function isLarkTerminalTimelineEvent(event: TimelineEvent): boolean {
  return event.type === "turn.completed" || event.type === "command.handled";
}

function removePendingLarkTimelineEvent(
  pendingByConversationKey: Map<string, TimelineEvent[]>,
  conversationKey: string | undefined,
  messageId: string,
): void {
  const key = conversationKey ?? "";
  const pending = pendingByConversationKey.get(key);
  if (!pending) {
    return;
  }
  const index = pending.findIndex((event) => getTimelineLarkMessageId(event) === messageId);
  if (index >= 0) {
    pending.splice(index, 1);
  }
  if (pending.length === 0) {
    pendingByConversationKey.delete(key);
  }
}

function getTimelineLarkMessageId(event: TimelineEvent): string | undefined {
  const value = event.metadata?.larkMessageId ?? event.metadata?.messageId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function copyLarkTimelineMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["larkChatId", "larkMessageId", "bridgeChatType", "messageId", "attachments"]) {
    const value = metadata?.[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function logLarkServiceError(logger: LarkServiceLogger, label: string, error: unknown): void {
  logger.error(`${label}: ${redactLarkErrorDetail(error)}`);
}

async function appendLarkChannelErrorTimelineEvent(stateDir: string, error: unknown): Promise<void> {
  const conversationKey = "lark:service";
  await appendTimelineEventBestEffort(stateDir, {
    type: "service.error",
    channel: "lark",
    chatId: stableLarkNumericId(conversationKey),
    conversationKey,
    outcome: "error",
    detail: redactLarkErrorDetail(error),
    metadata: {
      phase: "channel",
    },
  }, "Lark channel error timeline event");
}

async function appendLarkServiceCommentErrorTimelineEvent(
  stateDir: string,
  event: {
    fileToken: string;
    fileType: string;
    commentId: string;
    operator?: {
      openId?: string;
      userId?: string;
    };
    mentionedBot?: boolean;
  },
): Promise<void> {
  const conversationKey = `lark-comment:${event.fileToken}`;
  const operatorRawId = larkOperatorRawId(event.operator);
  await appendTimelineEventBestEffort(stateDir, {
    type: "turn.completed",
    channel: "lark",
    chatId: stableLarkNumericId(conversationKey),
    userId: stableLarkNumericId(`user:${operatorRawId}`),
    conversationKey,
    outcome: "error",
    detail: "service-level comment handling failed",
    metadata: {
      phase: "service-comment",
      larkSurface: "comment",
      fileToken: event.fileToken,
      fileType: normalizeLarkCommentFileType(event.fileType),
      commentId: event.commentId,
      mentionedBot: event.mentionedBot === true,
    },
  }, "Lark service comment error timeline event");
}

async function appendLarkServiceCardActionErrorTimelineEvent(
  stateDir: string,
  event: {
    messageId: string;
    chatId: string;
    operator?: {
      openId?: string;
      userId?: string;
    };
    action?: {
      value?: unknown;
    };
  },
): Promise<void> {
  const value = getCardActionValue(event);
  const conversationKey = typeof value?.conversationKey === "string" ? value.conversationKey : `lark:${event.chatId}`;
  const operatorRawId = event.operator?.openId ?? event.operator?.userId ?? "unknown";
  await appendTimelineEventBestEffort(stateDir, {
    type: "turn.completed",
    channel: "lark",
    chatId: stableLarkNumericId(conversationKey),
    userId: stableLarkNumericId(`user:${operatorRawId}`),
    conversationKey,
    outcome: "error",
    detail: "service-level card action handling failed",
    metadata: {
      phase: "service-card-action",
      larkChatId: event.chatId,
      larkMessageId: event.messageId,
      bridgeChatType: value?.bridgeChatType === "group" ? "group" : "private",
    },
  }, "Lark service card action error timeline event");
}

async function appendLarkServiceMessageErrorTimelineEvent(
  stateDir: string,
  message: {
    messageId: string;
    chatId: string;
    chatType: string;
    chatMode?: "p2p" | "group" | "topic";
    senderId?: string;
    threadId?: string;
  },
): Promise<void> {
  const conversationKey = buildLarkConversationKey(
    message.chatId,
    larkSessionThreadIdForMessage(message.chatType, message.threadId, message.chatMode),
  );
  await appendTimelineEventBestEffort(stateDir, {
    type: "turn.completed",
    channel: "lark",
    chatId: stableLarkNumericId(conversationKey),
    userId: stableLarkNumericId(`user:${message.senderId ?? "unknown"}`),
    conversationKey,
    outcome: "error",
    detail: "service-level message handling failed",
    metadata: {
      phase: "service-message",
      larkChatId: message.chatId,
      larkMessageId: message.messageId,
      bridgeChatType: message.chatType === "p2p" ? "private" : "group",
    },
  }, "Lark service message error timeline event");
}

function getCardActionReplyInThreadOption(event: {
  action?: {
    value?: unknown;
  };
}): { replyInThread: true } | Record<string, never> {
  const value = getCardActionValue(event);
  return value?.replyInThread === true ? { replyInThread: true } : {};
}

function getCardActionValue(event: {
  action?: {
    value?: unknown;
  };
}): Record<string, unknown> | null {
  const value = event.action?.value;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isLarkDebugEnabled(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return /^(?:1|true|yes|on)$/i.test(value.trim());
}

function parsePositiveIntegerEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function removeGeneratedTelegramTransportFromLarkAgent(
  stateDir: string,
  logger: LarkServiceLogger,
): Promise<void> {
  const agentPath = path.join(stateDir, "agent.md");
  try {
    const original = await readFile(agentPath, "utf8");
    const stripped = stripGeneratedTelegramTransportSection(original);
    if (!stripped.removed) {
      return;
    }
    await writeFile(agentPath, stripped.content, { encoding: "utf8", mode: 0o600 });
    logger.log("Removed generated Telegram Transport instructions from Lark agent.md; Lark transport is injected per turn.");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function createDefaultLarkBridge(env: LarkRuntimeEnv): Promise<{ stateDir: string; bridge: LarkBridgeLike }> {
  const { config, bridge } = await createBridgeDependencies({
    HOME: env.HOME,
    APPDATA: env.APPDATA,
    USERPROFILE: env.USERPROFILE,
    CODEX_HOME: env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
    TAROCUB_INSTANCE: env.TAROCUB_INSTANCE,
    CODEX_TELEGRAM_INSTANCE: env.CODEX_TELEGRAM_INSTANCE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_EXECUTABLE: env.CODEX_EXECUTABLE,
    CLAUDE_EXECUTABLE: env.CLAUDE_EXECUTABLE,
    KIMI_EXECUTABLE: env.KIMI_EXECUTABLE,
    KIMI_CODE_HOME: env.KIMI_CODE_HOME,
    ANTIGRAVITY_EXECUTABLE: env.ANTIGRAVITY_EXECUTABLE,
    TAROCUB_MAX_CONCURRENT_TURNS: env.TAROCUB_MAX_CONCURRENT_TURNS,
    CODEX_TELEGRAM_MAX_CONCURRENT_TURNS: env.CODEX_TELEGRAM_MAX_CONCURRENT_TURNS,
    TAROCUB_TURN_POOL_PATH: env.TAROCUB_TURN_POOL_PATH,
    TAROCUB_TELEMETRY_MODULE: env.TAROCUB_TELEMETRY_MODULE,
    LARK_CHANNEL_TELEMETRY_MODULE: env.LARK_CHANNEL_TELEMETRY_MODULE,
  }, { transport: "lark" });
  return {
    stateDir: config.stateDir,
    bridge,
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    return new Promise(() => undefined);
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
