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
