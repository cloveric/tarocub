import { loadBusConfig as defaultLoadBusConfig, type BusConfig } from "../bus/bus-config.js";
import { delegateToInstance as defaultDelegateToInstance } from "../bus/bus-client.js";
import {
  appendUpdateHandleAuditEventBestEffort,
  maybeReplyWithBudgetExhausted,
  recordTurnUsageAndBudgetAudit,
  type TelegramTurnContext,
} from "./turn-bookkeeping.js";
import { chunkTelegramMessage, type Locale } from "./message-renderer.js";
import type { NormalizedTelegramMessage } from "./update-normalizer.js";

function parseBtwCommand(text: string): { prompt: string } | null {
  const match = text.trim().match(/^\/btw(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return null;
  return { prompt: match[1]!.trim() };
}

function parseAskCommand(text: string): { targetInstance: string; prompt: string } | null {
  const match = text.trim().match(/^\/ask(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) return null;
  return { targetInstance: match[1]!, prompt: match[2]!.trim() };
}

function parseFanCommand(text: string): { prompt: string } | null {
  const match = text.trim().match(/^\/fan(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return null;
  return { prompt: match[1]!.trim() };
}

function parseVerifyCommand(text: string): { prompt: string } | null {
  const match = text.trim().match(/^\/verify(?:@\w+)?\s+([\s\S]+)$/i);
  if (!match) return null;
  return { prompt: match[1]!.trim() };
}

export interface DelegationCommandContext extends TelegramTurnContext {
  abortSignal?: AbortSignal;
}

export interface DelegationCommandBridge {
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
}

export async function handleDelegationTelegramCommand(input: {
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
  context: DelegationCommandContext;
  bridge: DelegationCommandBridge;
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
    bridge,
    loadBusConfig = defaultLoadBusConfig,
    delegateToInstance = defaultDelegateToInstance,
  } = input;

  const btwCmd = parseBtwCommand(normalized.text);
  if (btwCmd) {
    try {
      if (await maybeReplyWithBudgetExhausted(stateDir, cfg.budgetUsd, locale, context, normalized)) {
        return true;
      }
      const btwChatId = -(2_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
      const result = await bridge.handleAuthorizedMessage({
        chatId: btwChatId,
        userId: normalized.userId,
        chatType: "bus",
        locale,
        text: btwCmd.prompt,
        files: [],
      });
      await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);
      const chunks = chunkTelegramMessage(result.text);
      await context.api.sendMessage(normalized.chatId, chunks[0]!);
      for (const chunk of chunks.slice(1)) {
        await context.api.sendMessage(normalized.chatId, chunk);
      }
      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "btw",
          responseChars: result.text.length,
          chunkCount: chunks.length,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const msg = locale === "zh" ? `旁问失败：${detail}` : `Side question failed: ${detail}`;
      await context.api.sendMessage(normalized.chatId, msg);
      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: "error",
        detail,
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "btw",
        },
      });
    }
    return true;
  }

  const askCommand = parseAskCommand(normalized.text);
  if (askCommand) {
    const currentInstance = context.instanceName ?? "default";
    if (askCommand.targetInstance === currentInstance) {
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? "不能委托给自己。" : "Cannot delegate to yourself.",
      );
      return true;
    }

    const askLabel = locale === "zh"
      ? `正在转发给 ${askCommand.targetInstance}...`
      : `Delegating to ${askCommand.targetInstance}...`;
    await context.api.sendMessage(normalized.chatId, askLabel);

    try {
      const result = await delegateToInstance({
        fromInstance: currentInstance,
        targetInstance: askCommand.targetInstance,
        prompt: askCommand.prompt,
        depth: 0,
        stateDir,
      });

      const askResponse = locale === "zh"
        ? `[来自 ${askCommand.targetInstance}]\n\n${result.text}`
        : `[From ${askCommand.targetInstance}]\n\n${result.text}`;
      const chunks = chunkTelegramMessage(askResponse);
      await context.api.sendMessage(normalized.chatId, chunks[0]!);
      for (const chunk of chunks.slice(1)) {
        await context.api.sendMessage(normalized.chatId, chunk);
      }

      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: "success",
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "ask",
          delegatedTo: askCommand.targetInstance,
          responseChars: askResponse.length,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const errorMsg = locale === "zh"
        ? `委托给 ${askCommand.targetInstance} 失败：${detail}`
        : `Delegation to ${askCommand.targetInstance} failed: ${detail}`;
      await context.api.sendMessage(normalized.chatId, errorMsg);
      await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
        outcome: "error",
        detail,
        metadata: {
          durationMs: Date.now() - startedAt,
          command: "ask",
          delegatedTo: askCommand.targetInstance,
        },
      });
    }
    return true;
  }

  const fanCommand = parseFanCommand(normalized.text);
  if (fanCommand) {
    const busConfig = await loadBusConfig(stateDir);
    const targets = busConfig?.parallel ?? [];
    if (targets.length === 0) {
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh"
          ? "未配置 parallel bot。在 config.json 的 bus.parallel 中添加实例名。"
          : "No parallel bots configured. Add instance names to bus.parallel in config.json.",
      );
      return true;
    }

    const currentInstance = context.instanceName ?? "default";
    if (await maybeReplyWithBudgetExhausted(stateDir, cfg.budgetUsd, locale, context, normalized)) {
      return true;
    }
    await context.api.sendMessage(
      normalized.chatId,
      locale === "zh" ? `正在并行查询 ${targets.length + 1} 个 bot...` : `Querying ${targets.length + 1} bots in parallel...`,
    );

    let fanOutcome: "success" | "error" = "success";
    let fanErrorCount = 0;
    let fanResponseLength = 0;
    let fanChunkCount = 0;
    try {
      const selfPromise = bridge.handleAuthorizedMessage({
        chatId: normalized.chatId,
        userId: normalized.userId,
        chatType: normalized.chatType,
        locale,
        text: fanCommand.prompt,
        files: [],
        workspaceOverride: cfg.resume?.workspacePath,
      })
        .then(async (r) => {
          await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, r.usage);
          return { name: currentInstance, text: r.text, error: null as string | null };
        })
        .catch((e) => ({ name: currentInstance, text: "", error: e instanceof Error ? e.message : String(e) }));

      const peerPromises = targets.map((target) =>
        delegateToInstance({ fromInstance: currentInstance, targetInstance: target, prompt: fanCommand.prompt, depth: 0, stateDir })
          .then((r) => ({ name: target, text: r.text, error: null as string | null }))
          .catch((e) => ({ name: target, text: "", error: e instanceof Error ? e.message : String(e) })),
      );

      const results = await Promise.all([selfPromise, ...peerPromises]);
      const sections: string[] = [];
      for (const r of results) {
        sections.push(r.error ? `[${r.name}] Error: ${r.error}` : `[${r.name}]\n${r.text}`);
      }
      fanErrorCount = results.filter((r) => r.error).length;

      const fanResponse = sections.join("\n\n---\n\n");
      const chunks = chunkTelegramMessage(fanResponse);
      fanResponseLength = fanResponse.length;
      fanChunkCount = chunks.length;
      await context.api.sendMessage(normalized.chatId, chunks[0]!);
      for (const chunk of chunks.slice(1)) {
        await context.api.sendMessage(normalized.chatId, chunk);
      }
    } catch (error) {
      fanOutcome = "error";
      const detail = error instanceof Error ? error.message : String(error);
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? `并行执行失败：${detail}` : `Parallel execution failed: ${detail}`,
      );
    }

    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: fanOutcome,
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "fan",
        fanTargets: targets,
        errorCount: fanErrorCount,
        responseChars: fanResponseLength || undefined,
        chunkCount: fanChunkCount || undefined,
      },
    });
    return true;
  }

  const verifyCommand = parseVerifyCommand(normalized.text);
  if (verifyCommand) {
    const busConfig = await loadBusConfig(stateDir);
    const verifier = busConfig?.verifier;
    if (!verifier) {
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh"
          ? "未配置验证 bot。在 config.json 的 bus.verifier 中设置实例名。"
          : "No verifier configured. Set bus.verifier in config.json.",
      );
      return true;
    }

    const currentInstance = context.instanceName ?? "default";
    if (verifier === currentInstance) {
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? "验证 bot 不能是自己。" : "Verifier cannot be the same instance.",
      );
      return true;
    }

    if (await maybeReplyWithBudgetExhausted(stateDir, cfg.budgetUsd, locale, context, normalized)) {
      return true;
    }
    await context.api.sendMessage(normalized.chatId, locale === "zh" ? "正在执行..." : "Executing...");

    let verifyOutcome: "success" | "error" = "success";
    let verifyResponseLength = 0;
    let verifyChunkCount = 0;
    try {
      const result = await bridge.handleAuthorizedMessage({
        chatId: normalized.chatId,
        userId: normalized.userId,
        chatType: normalized.chatType,
        locale,
        text: verifyCommand.prompt,
        files: [],
        workspaceOverride: cfg.resume?.workspacePath,
      });
      await recordTurnUsageAndBudgetAudit(stateDir, cfg.budgetUsd, context, normalized, result.usage);

      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? `正在让 ${verifier} 验证...` : `Sending to ${verifier} for verification...`,
      );

      const verifyResult = await delegateToInstance({
        fromInstance: currentInstance,
        targetInstance: verifier,
        prompt: locale === "zh"
          ? `请验证以下回复的正确性和质量：\n\n原始问题：${verifyCommand.prompt}\n\n回复：${result.text}`
          : `Please verify the correctness and quality of this response:\n\nOriginal question: ${verifyCommand.prompt}\n\nResponse: ${result.text}`,
        depth: 0,
        stateDir,
      });

      const verifyResponse = [
        locale === "zh" ? `[${currentInstance} 的回复]` : `[Response from ${currentInstance}]`,
        result.text,
        "",
        "---",
        "",
        locale === "zh" ? `[${verifier} 的验证]` : `[Verification by ${verifier}]`,
        verifyResult.text,
      ].join("\n");

      const chunks = chunkTelegramMessage(verifyResponse);
      verifyResponseLength = verifyResponse.length;
      verifyChunkCount = chunks.length;
      await context.api.sendMessage(normalized.chatId, chunks[0]!);
      for (const chunk of chunks.slice(1)) {
        await context.api.sendMessage(normalized.chatId, chunk);
      }
    } catch (error) {
      verifyOutcome = "error";
      const detail = error instanceof Error ? error.message : String(error);
      await context.api.sendMessage(
        normalized.chatId,
        locale === "zh" ? `验证流程失败：${detail}` : `Verification failed: ${detail}`,
      );
    }

    await appendUpdateHandleAuditEventBestEffort(stateDir, context, normalized, {
      outcome: verifyOutcome,
      metadata: {
        durationMs: Date.now() - startedAt,
        command: "verify",
        verifier,
        responseChars: verifyResponseLength || undefined,
        chunkCount: verifyChunkCount || undefined,
      },
    });
    return true;
  }

  return false;
}
