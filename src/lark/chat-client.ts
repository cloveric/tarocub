import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { buildLarkCliChannelEnv } from "./cli-env.js";

const execFile = promisify(execFileCallback);

export interface LarkChatCreateInput {
  name: string;
  mode: "group" | "topic";
  operatorOpenId?: string;
}

export interface LarkChatCreateResult {
  chatId: string;
  name?: string;
  shareLink?: string;
  /** Set when the chat was created but a follow-up step (e.g. pulling the bot into
   * a topic group) failed — surfaced to the operator so they can act (e.g. enable a
   * missing scope). The chat itself was created regardless. */
  warning?: string;
}

export async function createLarkChatWithCli(input: LarkChatCreateInput): Promise<LarkChatCreateResult> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("lark chat creation requires a group name");
  }

  const actor = resolveDefaultLarkChatCreateActor();
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
    error?: { message?: string };
  };

  if (parsed.ok === false) {
    throw new Error(parsed.error?.message ?? "lark-cli im +chat-create failed");
  }
  const data = parsed.data ?? {};
  const chat = data.chat ?? {};
  const chatId = chat.chat_id ?? chat.chatId ?? data.chat_id ?? data.chatId;
  if (!chatId) {
    throw new Error("lark-cli im +chat-create did not return chat_id");
  }
  // A topic chat doesn't retain the creating bot as a member the way a normal group
  // does (set_bot_manager doesn't stick for topic mode), so the bot ends up outside
  // the group it just made. Explicitly pull it back in. Best-effort: this needs the
  // im:chat.members:write_only scope — if it is missing (or the add otherwise fails)
  // the chat is still created and we surface the reason rather than throwing.
  const botAddWarning = input.mode === "topic" && actor === "bot"
    ? await addBotToLarkTopicChat(chatId)
    : undefined;
  return {
    chatId,
    name: chat.name ?? data.name ?? name,
    shareLink: chat.share_link ?? chat.shareLink ?? data.share_link ?? data.shareLink,
    ...(botAddWarning ? { warning: botAddWarning } : {}),
  };
}

/**
 * Pull the bot (its App ID) into a chat it created. Returns undefined on success, or
 * a human-readable reason on failure (e.g. the im:chat.members:write_only scope is
 * not enabled). Never throws — the chat was already created.
 */
async function addBotToLarkTopicChat(chatId: string): Promise<string | undefined> {
  const appId = (process.env.LARK_APP_ID ?? "").trim();
  if (!appId.startsWith("cli_")) {
    return "could not add the bot to the topic group: bot App ID (cli_…) not found in env";
  }
  try {
    const { stdout } = await execFile("lark-cli", [
      "im",
      "chat.members",
      "create",
      "--as",
      "bot",
      "--params",
      JSON.stringify({ chat_id: chatId, member_id_type: "app_id" }),
      "--data",
      JSON.stringify({ id_list: [appId] }),
      "--format",
      "json",
    ], {
      env: buildLarkCliChannelEnv(),
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = parseLarkCliJson(stdout) as { ok?: boolean; error?: { message?: string } };
    if (parsed.ok === false) {
      return `could not add the bot to the topic group: ${parsed.error?.message ?? "unknown error"}`;
    }
    return undefined;
  } catch (error) {
    return `could not add the bot to the topic group: ${error instanceof Error ? error.message : String(error)}`;
  }
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
