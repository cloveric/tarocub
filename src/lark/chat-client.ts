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
