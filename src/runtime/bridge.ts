import type { CodexAdapter, EngineApprovalDecision, EngineApprovalRequest, EngineStreamEvent } from "../codex/adapter.js";
import { findConflictingLockedChatId } from "../state/access-store.js";
import {
  type Locale,
  renderPairingMessage,
  renderPrivateChatRequiredMessage,
  renderSingleChatLockedMessage,
  renderUnauthorizedMessage,
} from "../telegram/message-renderer.js";

export interface AccessStoreLike {
  load(): Promise<{
    multiChat: boolean;
    policy: "pairing" | "allowlist";
    allowlist: number[];
    pendingPairs: unknown[];
    pairedUsers: Array<{
      telegramUserId: number;
      telegramChatId: number;
    }>;
  }>;
  issuePairingCode(input: {
    telegramUserId: number;
    telegramChatId: number;
    now: Date;
  }): Promise<{
    code: string;
  }>;
}

export interface SessionManagerLike {
  getOrCreateSession(chatId: number): Promise<{ sessionId: string }>;
  bindSession(chatId: number, sessionId: string): Promise<void>;
}

export interface BridgeAccessInput {
  chatId: number;
  userId: number;
  chatType: string;
  locale?: Locale;
}

export interface BridgeAccessDecision {
  kind: "allow" | "reply" | "deny";
  text?: string;
}

function quoteShellCommand(value: string): string {
  if (!/[\s'"\\]/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderTelegramBridgeCapabilities(sideChannelCommand?: string, sideChannelEnvAvailable = false): string {
  const sendCommand = sideChannelEnvAvailable ? '"$CCTB_SEND_COMMAND"' : (sideChannelCommand ? quoteShellCommand(sideChannelCommand) : "");
  const fileDeliveryMethod = sideChannelCommand
    ? "deliver them with the side-channel send command shown in these instructions; use [send-file:] tags only as fallback if the command is unavailable or fails"
    : "send those files with [send-file:] tags";
  const criticalFileDeliveryRule = sideChannelCommand
    ? [
        "CRITICAL FILE DELIVERY RULE:",
        "You CANNOT send files by mentioning their name or path in chat text. The user CANNOT see or click filenames you type.",
        "The required delivery method is the side-channel send command shown above.",
        "After generating/saving ANY file the user should receive, run the side-channel send command with the real absolute path of that saved file.",
        "If the side-channel command is unavailable or fails, then include a [send-file:] fallback tag with the real absolute path.",
        "Examples:",
        `  Generated a PPT -> run ${sendCommand} --file /absolute/path/to/deck.pptx`,
        `  Generated images -> run ${sendCommand} --image /absolute/path/to/image.png for each actual image file you saved.`,
        `  Generated a PDF -> run ${sendCommand} --file /absolute/path/to/report.pdf`,
        "If you wrote 'the file is here: filename.pptx' WITHOUT using the send command or a [send-file:] fallback tag, the user received NOTHING.",
      ]
    : [
        "CRITICAL FILE DELIVERY RULE:",
        "You CANNOT send files by mentioning their name or path in chat text. The user CANNOT see or click filenames you type. The ONLY way to deliver a file to the user is the [send-file:] tag.",
        "After generating/saving ANY file the user should receive, you MUST include a [send-file:] tag with the real absolute path of that saved file.",
        "Examples:",
        "  Generated a PPT -> include one [send-file:] tag pointing at the actual .pptx you saved.",
        "  Generated images -> include one [send-file:] tag per actual image file you saved.",
        "  Generated a PDF -> include one [send-file:] tag pointing at the actual .pdf you saved.",
        "If you wrote 'the file is here: filename.pptx' WITHOUT a [send-file:] tag, the user received NOTHING. Always include the tag. No exceptions.",
      ];

  return [
    "You are running inside a Telegram chat bridge. The bridge supports delivering files to the user.",
    ...(sideChannelCommand
      ? [
          "",
          "Preferred file delivery: this turn has an active side-channel send command.",
          "When you generate a local image or file that should be sent to the user, prefer running:",
          `  ${sendCommand} --image /absolute/path/to/image.png`,
          `  ${sendCommand} --file /absolute/path/to/report.pdf`,
          `  ${sendCommand} --message "Done" --file /absolute/path/to/report.pdf`,
          sideChannelEnvAvailable
            ? `Current CCTB_SEND_COMMAND: ${sideChannelCommand}`
            : `Current side-channel send command: ${sendCommand}`,
          "Wait for the command to exit before continuing; never run it in the background.",
          "Use this immediately after the requested deliverable set is ready. Keep [send-file:] tags as fallback only if the command is unavailable or fails.",
        ]
      : []),
    "",
    "When the user asks you to generate, create, or send a file, include exactly one fenced code block in your reply using this format:",
    "",
    "```file:example.py",
    "print('hello')",
    "```",
    "",
    "The bridge will automatically extract the block and deliver it as a Telegram document attachment.",
    "Use this for small text or code files only.",
    "",
    "To send an existing file from disk (images, PDFs, binaries, or any file already saved to the workspace), use this tag anywhere in your reply:",
    "  [send-file:<real absolute path to the file>]",
    "The bridge will read the file from disk and deliver it to the user. You can include multiple [send-file:...] tags. For images, the bridge automatically compresses them for Telegram. This is the ONLY way to send binary files — do NOT put binary content in ```file:``` blocks.",
    "The [send-file:...] tag must contain ONLY the absolute file path and nothing else.",
    "Never copy placeholder paths such as /absolute/path, /absolute/path/to/file.png, or /path/to/file.ext. If you do not have a real saved file path, do not emit a [send-file:] tag.",
    "Do NOT include XML/HTML tags, quotes, punctuation, explanations, or trailing text inside the tag.",
    "Wrong: [send-file:/path/to/file.png</content>]",
    "Wrong: [send-file:'/path/to/file.png']",
    "Wrong: [send-file:/path/to/file.png.]",
    "Right: [send-file:<the exact absolute path of an existing saved file>]",
    "",
    "IMPORTANT: Telegram is a plain-text chat environment. Do NOT use interactive UI elements such as HTML forms, checkboxes, radio buttons, dropdowns, accordions, tabs, or embedded widgets — they will not render. For multiple-choice questions, use numbered plain-text lists and ask the user to reply with a number or letter. For structured data, use simple text tables or bullet lists. Only basic Markdown (bold, italic, code, links) is supported.",
    "",
    "DO NOT call interactive MCP tools like AskUserQuestion, prompt_user, ask_user, or any tool whose only purpose is to block waiting for user input — you run in a headless CLI and those tools terminate the turn without ever receiving an answer, which makes the bot appear to freeze. When you need the user to choose between options, put the options directly in your Telegram reply as a numbered list and wait for the next user message.",
    `Telegram turn boundary protocol: when the requested deliverable set for the current step is ready, finish the current Telegram turn. If that deliverable set includes files, ${fileDeliveryMethod}. For batch file outputs, send the whole requested batch together unless the user explicitly asked for incremental delivery. Do not hold the turn open for optional monitoring, sleeping, polling, post-delivery QA, or background follow-up. If more work remains, tell the user the current status and wait for the next message to continue.`,
    "",
    ...criticalFileDeliveryRule,
  ].join("\n");
}

function renderCodexTelegramOutInstructions(requestOutputDir: string): string {
  return [
    "[Codex Telegram-Out Contract]",
    "For small text or code files, prefer returning exactly one fenced block in this format:",
    "",
    "```file:example.txt",
    "hello",
    "```",
    "",
    "The bridge will extract that block and deliver it as a Telegram attachment.",
    "Use the output directory below only when the file must exist on disk, is large, or is not suitable for an inline file block.",
    `If you need to return a file to the user, write the final file into: ${requestOutputDir}`,
    "Only place files intended for Telegram delivery in that directory.",
    "Do not place scratch or temporary files there.",
    "Files written there will be returned to the user after the task completes.",
  ].join("\n");
}

function combineInstructions(...values: Array<string | undefined>): string | undefined {
  const parts = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function shouldDisableRuntimeTimeout(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "不设超时",
    "无超时",
    "不要超时",
  ].some((keyword) => text.includes(keyword)) || [
    "no timeout",
    "disable timeout",
    "without timeout",
  ].some((keyword) => normalized.includes(keyword));
}

export class Bridge {
  private readonly bridgeInstructionMode: "generic-file-blocks" | "telegram-out-only";
  readonly supportsTurnScopedEnv: boolean;

  constructor(
    private readonly accessStore: AccessStoreLike,
    private readonly sessionManager: SessionManagerLike,
    private readonly adapter: CodexAdapter,
  ) {
    this.bridgeInstructionMode = adapter.bridgeInstructionMode ?? "generic-file-blocks";
    this.supportsTurnScopedEnv = adapter.supportsTurnScopedEnv !== false;
  }

  async validateCodexThread(threadId: string): Promise<void> {
    if (!this.adapter.validateExternalSession) {
      throw new Error("codex thread validation unsupported");
    }

    await this.adapter.validateExternalSession(threadId);
  }

  async checkAccess(input: BridgeAccessInput): Promise<BridgeAccessDecision> {
    if (input.chatType === "bus") {
      return { kind: "allow" };
    }

    let accessState: Awaited<ReturnType<AccessStoreLike["load"]>>;
    try {
      accessState = await this.accessStore.load();
    } catch (error) {
      console.error(
        "Failed to load access state; denying access:",
        error instanceof Error ? error.message : error,
      );
      return { kind: "deny", text: renderUnauthorizedMessage(input.locale) };
    }

    if (input.chatType !== "private") {
      return {
        kind: "reply",
        text: renderPrivateChatRequiredMessage(input.locale),
      };
    }

    const conflictingChatId = findConflictingLockedChatId(accessState as Parameters<typeof findConflictingLockedChatId>[0], input.chatId);

    if (accessState.policy === "allowlist" && !accessState.allowlist.includes(input.chatId)) {
      return {
        kind: conflictingChatId === null ? "deny" : "reply",
        text:
          conflictingChatId === null
            ? renderUnauthorizedMessage(input.locale)
            : renderSingleChatLockedMessage(input.locale),
      };
    }

    if (
      accessState.policy === "pairing" &&
      !accessState.pairedUsers.some(
        (user) => user.telegramChatId === input.chatId && user.telegramUserId === input.userId,
      )
    ) {
      if (conflictingChatId !== null) {
        return {
          kind: "reply",
          text: renderSingleChatLockedMessage(input.locale),
        };
      }

      const pendingPair = await this.accessStore.issuePairingCode({
        telegramUserId: input.userId,
        telegramChatId: input.chatId,
        now: new Date(),
      });

      return {
        kind: "reply",
        text: renderPairingMessage(pendingPair.code, input.locale),
      };
    }

    return { kind: "allow" };
  }

  async handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    locale?: Locale;
    text: string;
    replyContext?: {
      messageId: number;
      text: string;
    };
    files: string[];
    onProgress?: (partialText: string) => void;
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    requestOutputDir?: string;
    workspaceOverride?: string;
    sideChannelCommand?: string;
    extraEnv?: Record<string, string>;
    abortSignal?: AbortSignal;
  }) {
    const decision = await this.checkAccess(input);
    if (decision.kind === "deny") {
      throw new Error(decision.text ?? renderUnauthorizedMessage(input.locale));
    }
    if (decision.kind === "reply") {
      return {
        text: decision.text ?? renderUnauthorizedMessage(input.locale),
      };
    }

    const session = await this.sessionManager.getOrCreateSession(input.chatId);
    const baseText = input.replyContext
      ? `${input.text}\n\n[Quoted message #${input.replyContext.messageId}]\n${input.replyContext.text || "(no text content)"}`
      : input.text;
    const text = baseText;
    const turnEnvSupported = this.adapter.supportsTurnScopedEnv !== false;
    const instructions = combineInstructions(
      renderTelegramBridgeCapabilities(input.sideChannelCommand, turnEnvSupported),
      this.bridgeInstructionMode === "telegram-out-only" && input.requestOutputDir
        ? renderCodexTelegramOutInstructions(input.requestOutputDir)
        : undefined,
    );
    const disableRuntimeTimeout = shouldDisableRuntimeTimeout(input.text);
    const response = await this.adapter.sendUserMessage(session.sessionId, {
      text,
      files: input.files,
      instructions,
      onProgress: input.onProgress,
      onApprovalRequest: input.onApprovalRequest,
      onEngineEvent: input.onEngineEvent,
      requestOutputDir: input.requestOutputDir,
      workspaceOverride: input.workspaceOverride,
      extraEnv: turnEnvSupported ? input.extraEnv : undefined,
      abortSignal: input.abortSignal,
      disableRuntimeTimeout: disableRuntimeTimeout || undefined,
    });

    if (response.sessionId && response.sessionId !== session.sessionId) {
      await this.sessionManager.bindSession(input.chatId, response.sessionId);
    }

    return response;
  }
}
