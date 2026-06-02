import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { buildLarkCliChannelEnv } from "./cli-env.js";
import { LarkCliError, type LarkCliErrorEnvelope } from "./lark-cli-error.js";
import type { LarkChannelLike } from "./types.js";

const execFile = promisify(execFileCallback);

export interface LarkChatCreateInput {
  name: string;
  mode: "group" | "topic";
  operatorOpenId?: string;
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

  // Bot path: create through the instance's own SDK so the acting app matches the
  // sender open_id's namespace (avoids "open_id cross app"). Falls back to lark-cli
  // only when no channel/rawClient is available. The user-identity path stays on
  // lark-cli (it creates under the authorizing user's OAuth).
  if (actor === "bot" && larkChannelHasChatCreate(input.channel)) {
    return await createLarkChatViaSdk(input.channel!, name, input);
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

  if (input.operatorOpenId?.startsWith("ou_")) {
    args.push("--users", input.operatorOpenId);
  }
  if (actor === "bot") {
    // The bot creates the chat (so it is a member of the group), but hand
    // OWNERSHIP to the human operator — otherwise they are only a plain member
    // and cannot change group settings such as the message form (话题/对话).
    // The bot stays a manager via --set-bot-manager. operatorOpenId is the
    // sender open_id in the bot app's namespace, so it matches an --as bot
    // creation. (On the --as user path the owner already defaults to the
    // authorizing user, and operatorOpenId would be the wrong namespace.)
    if (input.operatorOpenId?.startsWith("ou_")) {
      args.push("--owner", input.operatorOpenId);
    }
    args.push("--set-bot-manager");
    // A topic chat does NOT retain the creating bot the way a normal group does
    // (set_bot_manager alone leaves the bot outside the topic group). Invite the bot
    // explicitly at creation via bot_id_list (--bots): it rides in the create request
    // body, so it needs only the chat-create permission — no im:chat.members scope.
    const botAppId = (process.env.LARK_APP_ID ?? "").trim();
    if (input.mode === "topic" && botAppId.startsWith("cli_")) {
      args.push("--bots", botAppId);
    }
  }

  const { stdout } = await execFile("lark-cli", args, {
    env: buildLarkCliChannelEnv(),
    maxBuffer: 10 * 1024 * 1024,
  });
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
    const botAppId = (process.env.LARK_APP_ID ?? "").trim();
    if (botAppId.startsWith("cli_")) {
      data.bot_id_list = [botAppId];
    }
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
