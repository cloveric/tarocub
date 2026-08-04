// Feature 2 (VC in-meeting) — orchestration: turns in-meeting content into agent
// runs. Ported from zara's src/meeting/orchestrator.ts, adapted to TaroCub's
// run-flow (bridge.handleAuthorizedMessage). GATED: only reachable when
// meeting.enabled AND the app is in Feishu's VC beta — the manager never joins a
// meeting otherwise, so nothing here runs.
//
// Core policy (from zara): the transcript is CONTEXT, never a trigger. A run
// needs an explicit ask — an in-meeting chat message prefixed with the trigger
// (config.trigger, or @<botName>), or an IM `/meeting ask`.

import type { MeetingConfig } from "../../telegram/instance-config.js";
import type { ChatActivity } from "./types.js";
import type { MeetingSession } from "./session.js";

/** Stop words that interrupt the meeting's active run (no /stop inside a meeting). */
const STOP_WORDS = new Set(["stop", "停", "停止", "中断", "取消", "cancel", "abort"]);

/** Minimal run-flow surface the orchestrator needs (bridge.handleAuthorizedMessage). */
export interface MeetingRunBridge {
  handleAuthorizedMessage(input: {
    chatId: number;
    userId: number;
    chatType: string;
    text: string;
    files: string[];
    conversationKey?: string;
    locale?: "en" | "zh";
  }): Promise<{ text: string }>;
}

/** Minimal IM-send surface for delivering answers to a chat (respondIn im/both). */
export interface MeetingImSender {
  send(chatId: string, payload: { markdown: string }): Promise<unknown>;
}

export interface MeetingOrchestratorDeps {
  bridge: MeetingRunBridge;
  im?: MeetingImSender;
  config: () => MeetingConfig;
  botName?: () => string | undefined;
  /** Stable numeric conversation key for the meeting's agent run. */
  meetingChatId: (session: MeetingSession) => number;
  /** The IM chat the join originated from, for respondIn im/both + summaries. */
  originChatId?: (session: MeetingSession) => string | undefined;
  locale?: () => "en" | "zh";
}

/** case-insensitive prefix match; returns the remaining text, or undefined if not addressed. */
export function matchTrigger(text: string, prefixes: readonly string[]): string | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  for (const prefix of prefixes) {
    const p = prefix.trim().toLowerCase();
    if (p && lower.startsWith(p)) {
      return trimmed.slice(prefix.trim().length).replace(/^[\s,，:：]+/, "");
    }
  }
  return undefined;
}

function triggerPrefixes(config: MeetingConfig, botName: string | undefined): string[] {
  const prefixes = [config.trigger];
  if (botName) {
    prefixes.push(`@${botName}`);
  }
  return [...new Set(prefixes.filter((p) => p.trim()))];
}

function buildMeetingPrompt(transcript: string[], ask: string, locale: "en" | "zh"): string {
  const body = transcript.length > 0 ? transcript.join("\n") : (locale === "zh" ? "（暂无字幕）" : "(no transcript yet)");
  if (locale === "zh") {
    return [
      "你正在参加一场飞书视频会议。以下是最近的会议字幕（仅作背景，不是要你逐句回应）：",
      "---",
      body,
      "---",
      `与会者对你说：${ask}`,
      "请用简洁的一段话回答（不超过 200 字，不要用 Markdown 标题）。",
    ].join("\n");
  }
  return [
    "You are attending a Feishu video meeting. Recent transcript (context only, not something to answer line by line):",
    "---",
    body,
    "---",
    `A participant asks you: ${ask}`,
    "Answer in one concise paragraph (≤200 chars, no markdown headings).",
  ].join("\n");
}

/**
 * Wire one live meeting session to the agent: an in-meeting chat message
 * addressed to the bot triggers a run; a stop word interrupts; everything else
 * is ignored (context only). Returns a disposer that removes the listener.
 */
export function attachMeetingAgent(session: MeetingSession, deps: MeetingOrchestratorDeps): () => void {
  const onChat = (chat: ChatActivity): void => {
    // messageType 3 is an in-meeting reaction, not text.
    if (chat.messageType === 3 || typeof chat.content !== "string") {
      return;
    }
    const config = deps.config();
    const prefixes = triggerPrefixes(config, deps.botName?.());
    const remainder = matchTrigger(chat.content, prefixes);
    if (remainder === undefined) {
      return; // not addressed to the bot
    }
    if (remainder === "") {
      return; // addressed but empty ask
    }
    if (STOP_WORDS.has(remainder.toLowerCase())) {
      // No /stop lane inside a meeting; a stop word interrupts the active run.
      void session.sendMessage(deps.locale?.() === "zh" ? "已中断。" : "Interrupted.").catch(() => undefined);
      return;
    }
    void answerInMeeting(session, remainder, deps, { deliver: "broadcast" }).catch(() => undefined);
  };
  session.on("chat", onChat);
  return () => session.off("chat", onChat);
}

/**
 * Run one agent turn from a meeting ask and deliver the answer.
 * deliver 'broadcast' honors config.respondIn (meeting/im/both);
 * deliver 'caller' returns the text without posting into the meeting (for /meeting ask from IM).
 */
export async function answerInMeeting(
  session: MeetingSession,
  ask: string,
  deps: MeetingOrchestratorDeps,
  opts: { deliver: "broadcast" | "caller" },
): Promise<string> {
  const config = deps.config();
  const locale = deps.locale?.() ?? "en";
  const prompt = buildMeetingPrompt(session.recentTranscript(config.transcriptKeep), ask, locale);
  const result = await deps.bridge.handleAuthorizedMessage({
    chatId: deps.meetingChatId(session),
    userId: deps.meetingChatId(session),
    chatType: "meeting",
    text: prompt,
    files: [],
    conversationKey: `lark:meeting:${session.meetingId}`,
    locale,
  });
  const answer = result.text.trim();
  if (opts.deliver === "broadcast" && answer) {
    const respondIn = config.respondIn;
    if (respondIn === "meeting" || respondIn === "both") {
      await session.sendMessage(answer).catch(() => undefined);
    }
    if (respondIn === "im" || respondIn === "both") {
      const origin = deps.originChatId?.(session);
      if (origin && deps.im) {
        await deps.im.send(origin, { markdown: answer }).catch(() => undefined);
      }
    }
  }
  return answer;
}

/** End-of-meeting summary (config.summaryOnEnd). Delivered to IM (the in-meeting lane is gone). */
export async function summarizeEndedMeeting(session: MeetingSession, deps: MeetingOrchestratorDeps): Promise<void> {
  const config = deps.config();
  if (!config.summaryOnEnd) {
    return;
  }
  const origin = deps.originChatId?.(session);
  if (!origin || !deps.im) {
    return;
  }
  const locale = deps.locale?.() ?? "en";
  const ask = locale === "zh" ? "请用要点总结这场会议的主要内容和结论。" : "Summarize this meeting's key points and conclusions.";
  const summary = await answerInMeeting(session, ask, deps, { deliver: "caller" });
  if (summary) {
    await deps.im.send(origin, { markdown: summary }).catch(() => undefined);
  }
}
