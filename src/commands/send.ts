import path from "node:path";

import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import { TelegramApi } from "../telegram/api.js";
import { loadInstanceConfig } from "../telegram/instance-config.js";
import type { DeliveryRejectedReceipt } from "../telegram/delivery-ledger.js";
import { deliverTelegramResponse } from "../telegram/response-delivery.js";
import {
  formatRejectedDeliverySummary,
  parseSideChannelSendArgs,
  renderSideChannelDeliveryText,
  type SideChannelSendPayload,
} from "../telegram/side-channel-send.js";
import { readConfiguredBotToken } from "../service.js";
import { SessionStore } from "../state/session-store.js";

export interface SendCommandEnv extends Pick<
  EnvSource,
  "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR" | "TELEGRAM_BOT_TOKEN"
> {}

export interface ConfiguredSendDeps {
  cwd?: string;
  readConfiguredBotToken?: typeof readConfiguredBotToken;
  createTelegramApi?: (botToken: string) => Pick<TelegramApi, "sendMessage" | "sendDocument" | "sendPhoto">;
  deliverTelegramResponse?: typeof deliverTelegramResponse;
  readStdin?: () => Promise<string>;
}

export interface ConfiguredSendResult {
  chatId: number;
  filesSent: number;
}

interface ParsedConfiguredSendArgs {
  instanceName: string;
  chatId?: number;
  sendArgs: string[];
}

function parseChatId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid chat id: ${value}`);
  }
  return parsed;
}

function parseConfiguredSendArgs(argv: string[]): ParsedConfiguredSendArgs {
  let instanceName = "default";
  let chatId: number | undefined;
  const sendArgs: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--instance") {
      const value = argv[++index];
      if (!value) {
        throw new Error("Invalid instance name");
      }
      instanceName = normalizeInstanceName(value);
      continue;
    }
    if (argument.startsWith("--instance=")) {
      instanceName = normalizeInstanceName(argument.slice("--instance=".length));
      continue;
    }
    if (argument === "--chat" || argument === "--chat-id") {
      const value = argv[++index];
      if (!value) {
        throw new Error(`${argument} requires a chat id`);
      }
      chatId = parseChatId(value);
      continue;
    }
    if (argument.startsWith("--chat=")) {
      chatId = parseChatId(argument.slice("--chat=".length));
      continue;
    }
    if (argument.startsWith("--chat-id=")) {
      chatId = parseChatId(argument.slice("--chat-id=".length));
      continue;
    }
    sendArgs.push(argument);
  }

  return { instanceName, chatId, sendArgs };
}

export function stripSendRoutingArgs(argv: string[]): string[] {
  return parseConfiguredSendArgs(argv).sendArgs;
}

async function readStdinText(deps: ConfiguredSendDeps): Promise<string> {
  const readStdin = deps.readStdin ?? (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  });
  return (await readStdin()).trim();
}

async function buildPayload(argv: string[], deps: ConfiguredSendDeps): Promise<SideChannelSendPayload> {
  const stdinIndex = argv.indexOf("--stdin");
  if (stdinIndex === -1) {
    return parseSideChannelSendArgs(argv);
  }

  const stdinText = await readStdinText(deps);
  const nextArgs = [
    ...argv.slice(0, stdinIndex),
    ...argv.slice(stdinIndex + 1),
    stdinText,
  ].filter(Boolean);
  return parseSideChannelSendArgs(nextArgs);
}

async function resolveChatId(stateDir: string, explicitChatId?: number): Promise<number> {
  if (explicitChatId !== undefined) {
    return explicitChatId;
  }

  const { state, warning } = await new SessionStore(path.join(stateDir, "session.json")).inspect();
  if (warning) {
    throw new Error(`${warning}; pass --chat <id> to choose the target chat explicitly.`);
  }
  if (state.chats.length === 0) {
    throw new Error("No Telegram session found; pass --chat <id>.");
  }
  if (state.chats.length > 1) {
    throw new Error("Multiple Telegram sessions found; pass --chat <id>.");
  }
  return state.chats[0]!.telegramChatId;
}

export async function runConfiguredSendCommand(
  argv: string[],
  env: SendCommandEnv,
  deps: ConfiguredSendDeps = {},
): Promise<ConfiguredSendResult> {
  const parsed = parseConfiguredSendArgs(argv);
  const instanceName = normalizeInstanceName(parsed.instanceName);
  const payload = await buildPayload(parsed.sendArgs, deps);
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: instanceName,
  });
  const botToken = await (deps.readConfiguredBotToken ?? readConfiguredBotToken)({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: instanceName,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
  }, instanceName);
  if (!botToken) {
    throw new Error(`No Telegram bot token configured for instance "${instanceName}".`);
  }

  const chatId = await resolveChatId(stateDir, parsed.chatId);
  const config = await loadInstanceConfig(stateDir);
  const api = (deps.createTelegramApi ?? ((token: string) => new TelegramApi(token)))(botToken);
  const requestedFileCount = new Set([...payload.images, ...payload.files]).size;
  const rejectedReceipts: DeliveryRejectedReceipt[] = [];
  const filesSent = await (deps.deliverTelegramResponse ?? deliverTelegramResponse)(
    api,
    chatId,
    renderSideChannelDeliveryText(payload),
    path.join(stateDir, "inbox"),
    config.resume?.workspacePath ?? deps.cwd ?? process.cwd(),
    undefined,
    config.locale,
    {
      allowAnyAbsolutePath: true,
      onDeliveryRejected: (receipt) => {
        rejectedReceipts.push(receipt);
      },
    },
  );

  if (filesSent < requestedFileCount) {
    const missingCount = requestedFileCount - filesSent;
    const rejected = formatRejectedDeliverySummary(rejectedReceipts);
    const message = `${missingCount} file${missingCount === 1 ? "" : "s"} not delivered`;
    throw new Error(rejected ? `${message}: ${rejected}` : `${message}.`);
  }

  return { chatId, filesSent };
}
