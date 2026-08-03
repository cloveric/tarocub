import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { buildLarkCliChannelEnv } from "./cli-env.js";
import { LarkCliError, larkCliErrorFromExec, type LarkCliErrorEnvelope } from "./lark-cli-error.js";
import type { LarkChannelLike } from "./types.js";

const execFile = promisify(execFileCallback);

export interface LarkChatCreateInput {
  name: string;
  mode: "group" | "topic";
  operatorOpenId?: string;
  /** The current bridge instance's app id. Needed when the bot must be invited. */
  botAppId?: string;
  // The instance's own Lark channel. The bot path creates the chat through this
  // channel's SDK client (the instance's app) instead of lark-cli, because lark-cli
  // authenticates as its own separate app — so a sender open_id captured by THIS
  // instance's app would be rejected as "open_id cross app" by lark-cli's app. Creating
  // via the instance SDK keeps the acting app and the open_id in the same namespace.
  channel?: LarkChannelLike;
}

export interface LarkChatCreateResult {
  chatId: string;
  name?: string;
  shareLink?: string;
}

export async function createLarkChatWithCli(input: LarkChatCreateInput): Promise<LarkChatCreateResult> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("lark chat creation requires a group name");
  }

  const actor = resolveDefaultLarkChatCreateActor();
  const botAppId = (input.botAppId ?? process.env.LARK_APP_ID ?? "").trim();

  // Bot path: create through the instance's own SDK so the acting app matches the
  // sender open_id's namespace (avoids "open_id cross app"). Never fall back to
  // lark-cli's bot identity: it belongs to a separate app, so the requester open_id
  // is invalid there and a successfully created chat may omit this instance's bot.
  if (actor === "bot") {
    if (!larkChannelHasChatCreate(input.channel)) {
      throw new Error("Lark bot chat creation requires the current instance SDK channel; cross-app lark-cli fallback is disabled");
    }
    if (input.mode === "topic" && !botAppId.startsWith("cli_")) {
      throw new Error("Lark chat creation requires the instance bot app id so the bot can join the new chat");
    }
    return await createLarkChatViaSdk(input.channel!, name, input);
  }

  // User-identity creation is an explicit OAuth path. The authorizing user owns
  // the group, and the current instance bot must be invited in the same request.
  if (!botAppId.startsWith("cli_")) {
    throw new Error("Lark chat creation requires the instance bot app id so the bot can join the new chat");
  }

  const args = [
    "im",
    "+chat-create",
    "--name",
    name,
    "--chat-mode",
    input.mode,
    "--as",
    actor,
    "--format",
    "json",
  ];

  // operatorOpenId was captured by the instance bot app and cannot be reused by
  // lark-cli's separate OAuth app. The OAuth user is already the creator/owner.
  // User-identity creation never makes the instance bot a member implicitly.
  args.push("--bots", botAppId);

  let stdout: string;
  try {
    // lark-cli exits nonzero + writes its typed envelope to stderr, so execFile REJECTS on a
    // real failure; recover the typed LarkCliError from the rejection rather than letting a
    // raw ExecFileException (with its process exit code) propagate.
    ({ stdout } = await execFile("lark-cli", args, {
      env: buildLarkCliChannelEnv(),
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (error) {
    throw larkCliErrorFromExec(error, "lark-cli im +chat-create failed");
  }
  const parsed = parseLarkCliJson(stdout) as {
    ok?: boolean;
    data?: {
      chat?: {
        chat_id?: string;
        chatId?: string;
        name?: string;
        share_link?: string;
        shareLink?: string;
      };
      chat_id?: string;
      chatId?: string;
      name?: string;
      share_link?: string;
      shareLink?: string;
    };
    error?: LarkCliErrorEnvelope;
  };

  if (parsed.ok === false) {
    throw new LarkCliError(parsed.error, "lark-cli im +chat-create failed");
  }
  const data = parsed.data ?? {};
  const chat = data.chat ?? {};
  const chatId = chat.chat_id ?? chat.chatId ?? data.chat_id ?? data.chatId;
  if (!chatId) {
    throw new Error("lark-cli im +chat-create did not return chat_id");
  }
  return {
    chatId,
    name: chat.name ?? data.name ?? name,
    shareLink: chat.share_link ?? chat.shareLink ?? data.share_link ?? data.shareLink,
  };
}

function parseLarkCliJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("lark-cli im +chat-create returned empty output");
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Some lark-cli commands print human-readable banners before JSON.
  }

  const jsonStart = trimmed.lastIndexOf("\n{");
  if (jsonStart !== -1) {
    return JSON.parse(trimmed.slice(jsonStart + 1)) as unknown;
  }

  const firstBrace = trimmed.indexOf("{");
  if (firstBrace !== -1) {
    return JSON.parse(trimmed.slice(firstBrace)) as unknown;
  }

  throw new Error("lark-cli im +chat-create did not return JSON output");
}

function resolveDefaultLarkChatCreateActor(): "user" | "bot" {
  const value = process.env.CCTB_LARK_CHAT_CREATE_AS ?? process.env.LARK_CHAT_CREATE_AS;
  return value?.trim().toLowerCase() === "user" ? "user" : "bot";
}

interface LarkRawChatCreate {
  im?: {
    v1?: {
      chat?: {
        create?: (req: {
          params?: { user_id_type?: string; set_bot_manager?: boolean };
          data?: Record<string, unknown>;
        }) => Promise<{ code?: number; msg?: string; data?: { chat_id?: string; name?: string } }>;
      };
    };
  };
}

function larkChannelHasChatCreate(channel: LarkChannelLike | undefined): boolean {
  const create = (channel as { rawClient?: LarkRawChatCreate } | undefined)?.rawClient?.im?.v1?.chat?.create;
  return typeof create === "function";
}

/**
 * Creates the chat via the instance's own SDK client (the instance's bot app). Because
 * the acting app is the same app that captured the sender open_id, the open_id is in
 * the right namespace — so handing ownership to the operator no longer trips
 * "open_id cross app" the way the shared lark-cli (a different app) did.
 */
async function createLarkChatViaSdk(
  channel: LarkChannelLike,
  name: string,
  input: LarkChatCreateInput,
): Promise<LarkChatCreateResult> {
  const create = (channel as { rawClient?: LarkRawChatCreate }).rawClient?.im?.v1?.chat?.create;
  if (typeof create !== "function") {
    throw new Error("lark channel rawClient does not expose im.v1.chat.create");
  }
  const owner = input.operatorOpenId?.startsWith("ou_") ? input.operatorOpenId : undefined;
  const botAppId = (input.botAppId ?? process.env.LARK_APP_ID ?? "").trim();
  const data: Record<string, unknown> = {
    name,
    chat_mode: input.mode === "topic" ? "topic" : "group",
  };
  if (owner) {
    // Hand ownership to the human operator (same app namespace → no cross-app) and add
    // them to the chat. The creating bot is a member by virtue of creating the chat.
    data.owner_id = owner;
    data.user_id_list = [owner];
  }
  if (input.mode === "topic") {
    // A topic chat does not retain the creating bot via set_bot_manager alone — invite
    // it explicitly via bot_id_list (the SDK equivalent of lark-cli --bots).
    data.bot_id_list = [botAppId];
  }
  const res = await create({
    params: { user_id_type: "open_id", set_bot_manager: true },
    data,
  });
  if (typeof res?.code === "number" && res.code !== 0) {
    throw new Error(res.msg ?? `lark chat.create failed (code ${res.code})`);
  }
  const chatId = res?.data?.chat_id;
  if (!chatId) {
    throw new Error("lark chat.create returned no chat_id");
  }
  return { chatId, name: res.data?.name ?? name };
}
