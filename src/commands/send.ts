import path from "node:path";

import { resolveInstanceName, resolveInstanceStateDir, type EnvSource } from "../config.js";
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
  | "HOME"
  | "USERPROFILE"
  | "CODEX_TELEGRAM_STATE_DIR"
  | "TELEGRAM_BOT_TOKEN"
  | "TAROCUB_INSTANCE"
  | "CODEX_TELEGRAM_INSTANCE"
> {
  /** Turn-scoped side-channel endpoint; only an active turn has it. */
  CCTB_SEND_URL?: string;
  /** Turn-scoped side-channel bearer token. */
  CCTB_SEND_TOKEN?: string;
}

export interface ConfiguredSendDeps {
  cwd?: string;
  readConfiguredBotToken?: typeof readConfiguredBotToken;
  createTelegramApi?: (botToken: string) => Pick<TelegramApi, "sendMessage" | "sendDocument" | "sendPhoto" | "sendVoice">;
  deliverTelegramResponse?: typeof deliverTelegramResponse;
  readStdin?: () => Promise<string>;
}

export interface ConfiguredSendResult {
  chatId: number;
  filesSent: number;
}

interface ParsedConfiguredSendArgs {
  /** Only set when the caller passed `--instance` explicitly. */
  instanceName?: string;
  chatId?: number;
  sendArgs: string[];
}

/**
 * `cctb send` exists so the engine can push a file/message into the chat it is
 * currently answering. It is NOT a general-purpose sender: without the
 * turn-scoped side channel a prompt-injected engine could aim `--instance` at
 * another bot's token on disk and `--chat` at any chat id, turning one
 * compromised turn into a cross-instance exfiltration channel. The operator
 * never runs `cctb send` by hand, so the unscoped path is refused outright.
 */
export const TURN_SCOPED_SEND_REQUIRED_MESSAGE =
  "cctb send requires the turn-scoped side channel; it cannot target an arbitrary instance or chat.";

function parseChatId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid chat id: ${value}`);
  }
  return parsed;
}

function parseConfiguredSendArgs(argv: string[]): ParsedConfiguredSendArgs {
  let instanceName: string | undefined;
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

function resolveTurnInstanceName(env: SendCommandEnv): string {
  return resolveInstanceName({
    TAROCUB_INSTANCE: env.TAROCUB_INSTANCE,
    CODEX_TELEGRAM_INSTANCE: env.CODEX_TELEGRAM_INSTANCE,
  });
}

/**
 * Reject routing overrides that would aim the send somewhere other than the
 * turn's own instance/chat. `--instance` is tolerated only when it names the
 * instance this process already belongs to; `--chat` is never honoured because
 * the turn's chat is implicit (and is the only chat the caller is entitled to).
 */
export function assertTurnScopedSendTarget(env: SendCommandEnv, argv: string[]): void {
  const parsed = parseConfiguredSendArgs(argv);
  const turnInstanceName = resolveTurnInstanceName(env);
  if (parsed.instanceName !== undefined && parsed.instanceName !== turnInstanceName) {
    throw new Error(
      `cctb send cannot target instance "${parsed.instanceName}": it only sends to the current turn's instance ("${turnInstanceName}").`,
    );
  }
  if (parsed.chatId !== undefined) {
    throw new Error("cctb send cannot target another chat: it only replies in the current turn's chat.");
  }
}

/** Fail closed when there is no active turn behind this invocation. */
export function assertTurnScopedSendContext(env: SendCommandEnv): void {
  if (!env.CCTB_SEND_URL || !env.CCTB_SEND_TOKEN) {
    throw new Error(TURN_SCOPED_SEND_REQUIRED_MESSAGE);
  }
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

async function resolveTurnChatId(stateDir: string): Promise<number> {
  const { state, warning } = await new SessionStore(path.join(stateDir, "session.json")).inspect();
  if (warning) {
    throw new Error(`${warning}; cctb send cannot choose a chat outside the active turn.`);
  }
  if (state.chats.length === 0) {
    throw new Error("No Telegram session found for this instance; cctb send has no chat to reply in.");
  }
  if (state.chats.length > 1) {
    throw new Error("Multiple Telegram sessions found for this instance; cctb send cannot choose one outside the active turn.");
  }
  return state.chats[0]!.telegramChatId;
}

/**
 * Direct delivery through the instance's own bot, for the turn-scoped context
 * only. The CLI's live path is the HTTP side channel (`runSideChannelSendCommand`);
 * this entry point stays fail-closed on its own so it can never be re-wired into
 * a universal sender: no turn context → refuse before reading any bot token, no
 * cross-instance/cross-chat targeting, and files must pass the normal workspace
 * sandbox (no `allowAnyAbsolutePath`).
 */
export async function runConfiguredSendCommand(
  argv: string[],
  env: SendCommandEnv,
  deps: ConfiguredSendDeps = {},
): Promise<ConfiguredSendResult> {
  assertTurnScopedSendContext(env);
  assertTurnScopedSendTarget(env, argv);

  const parsed = parseConfiguredSendArgs(argv);
  const instanceName = resolveTurnInstanceName(env);
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

  const chatId = await resolveTurnChatId(stateDir);
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
