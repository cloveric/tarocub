// Feature 2 final stage — wire the VC meeting core (manager + orchestrator) into
// the running Lark service. GATED: attachLarkMeetingSupport returns null unless
// config.meeting.enabled, so an ordinary instance never constructs a manager,
// never joins a meeting, and this file is entirely inert. The current service
// wiring is poll-only; MeetingManager also exposes a public dispatcher hook for
// a future push subscription. `/meeting join` remains the explicit entry.

import type { MeetingConfig } from "../../telegram/instance-config.js";
import { MeetingManager } from "./manager.js";
import type { MeetingSession } from "./session.js";
import type { LarkVcRequestClient } from "./vc-api.js";
import { isMeetingNo } from "./vc-api.js";
import { classifyVcMeetingError, renderVcMeetingPreflight } from "./preflight.js";
import {
  attachMeetingAgent,
  answerInMeeting,
  summarizeEndedMeeting,
  type MeetingImSender,
  type MeetingRunBridge,
} from "./orchestrator.js";

export interface LarkMeetingSupportDeps {
  /** channel.rawClient — the SDK Client whose request() matches LarkVcRequestClient. */
  rawClient: LarkVcRequestClient;
  bridge: MeetingRunBridge;
  im?: MeetingImSender;
  config: () => MeetingConfig;
  botOpenId?: () => string | undefined;
  botName?: () => string | undefined;
  locale?: () => "en" | "zh";
  /** Stable numeric conversation key for a meeting's agent run. */
  meetingChatId: (session: MeetingSession) => number;
  log?: (message: string) => void;
}

export interface LarkMeetingSupport {
  manager: MeetingManager;
  /** Handle a `/meeting …` command; returns the reply text, or null if not a meeting command. */
  handleMeetingCommand(
    text: string,
    locale: "en" | "zh",
    context?: { mentionOpenIds?: readonly string[] },
  ): Promise<string | null>;
  dispose(): Promise<void>;
}

export function attachLarkMeetingSupport(deps: LarkMeetingSupportDeps): LarkMeetingSupport | null {
  if (!deps.config().enabled) {
    return null;
  }

  const orchestratorDeps = {
    bridge: deps.bridge,
    ...(deps.im ? { im: deps.im } : {}),
    config: deps.config,
    ...(deps.botName ? { botName: deps.botName } : {}),
    meetingChatId: deps.meetingChatId,
    ...(deps.locale ? { locale: deps.locale } : {}),
  };

  const manager = new MeetingManager({
    client: deps.rawClient,
    config: deps.config,
    ...(deps.botOpenId ? { botOpenId: deps.botOpenId } : {}),
    onSession: (session) => {
      attachMeetingAgent(session, orchestratorDeps);
    },
    onEnded: (_meetingId, session) => {
      void summarizeEndedMeeting(session, orchestratorDeps).catch(() => undefined);
    },
  });

  const handleMeetingCommand = async (
    text: string,
    locale: "en" | "zh",
    context: { mentionOpenIds?: readonly string[] } = {},
  ): Promise<string | null> => {
    const trimmed = text.trim();
    if (!/^\/meeting\b/i.test(trimmed)) {
      return null;
    }
    const rest = trimmed.replace(/^\/meeting\b/i, "").trim();
    const [sub, ...args] = rest.split(/\s+/);
    const zh = locale === "zh";

    switch ((sub ?? "").toLowerCase()) {
      case "":
      case "status": {
        const statuses = manager.list();
        if (statuses.length === 0) {
          return zh ? "当前没有进行中的会议。用 `/meeting join <9位会议号>` 加入。" : "No active meetings. Use `/meeting join <9-digit no.>`.";
        }
        const health = manager.pushHealth();
        const lines = statuses.map((st) => {
          return zh
            ? `会议 ${st.meetingNo}：来源 ${st.source}，字幕 ${st.transcriptLines} 行，参会 ${st.participants} 人`
            : `Meeting ${st.meetingNo}: source ${st.source}, ${st.transcriptLines} transcript lines, ${st.participants} participants`;
        });
        lines.push(zh ? `事件推送：${health.hooked ? "已连接" : `轮询模式${health.reason ? `（${health.reason}）` : ""}`}` : `Push: ${health.hooked ? "connected" : `poll-only${health.reason ? ` (${health.reason})` : ""}`}`);
        return lines.join("\n");
      }
      case "join": {
        const meetingNo = args[0] ?? "";
        if (!isMeetingNo(meetingNo)) {
          return zh ? "用法：`/meeting join <9位会议号> [密码]`" : "Usage: `/meeting join <9-digit no.> [password]`";
        }
        try {
          const session = await manager.join(meetingNo, args[1]);
          return zh ? `已加入会议 ${session.meetingNo}。@我 或以「${deps.config().trigger}」开头即可在会中提问。`
            : `Joined meeting ${session.meetingNo}. Address me with @ or the "${deps.config().trigger}" prefix to ask in-meeting.`;
        } catch (error) {
          // Surface the beta-gate / scope guidance instead of a raw error.
          return renderVcMeetingPreflight(classifyVcMeetingError(error), locale);
        }
      }
      case "leave": {
        const sessions = manager.all();
        if (sessions.length === 0) {
          return zh ? "当前没有进行中的会议。" : "No active meetings.";
        }
        // With one meeting, leave it; with several, require the number.
        if (args[0] && isMeetingNo(args[0])) {
          const target = manager.byMeetingNo(args[0]);
          if (!target) {
            return zh ? `未加入会议 ${args[0]}。` : `Not in meeting ${args[0]}.`;
          }
          await manager.leave(target.meetingId);
          return zh ? `已离开会议 ${args[0]}。` : `Left meeting ${args[0]}.`;
        }
        if (sessions.length > 1) {
          return zh ? "有多个会议，请指定：`/meeting leave <9位会议号>`" : "Multiple meetings; specify: `/meeting leave <9-digit no.>`";
        }
        await manager.leave(sessions[0]!.meetingId);
        return zh ? `已离开会议 ${sessions[0]!.meetingNo}。` : `Left meeting ${sessions[0]!.meetingNo}.`;
      }
      case "invite": {
        const sessions = manager.all();
        if (sessions.length === 0) {
          return zh ? "当前没有进行中的会议。" : "No active meetings.";
        }
        const inviteArgs = [...args];
        const explicitMeetingNo = inviteArgs[0] && isMeetingNo(inviteArgs[0]) ? inviteArgs.shift() : undefined;
        const target = explicitMeetingNo ? manager.byMeetingNo(explicitMeetingNo) : sessions.length === 1 ? sessions[0] : undefined;
        if (!target) {
          return zh
            ? "有多个会议，请指定：`/meeting invite <9位会议号> all` 或 `/meeting invite <9位会议号> <ou_open_id...>`"
            : "Multiple meetings; specify: `/meeting invite <9-digit no.> all` or `/meeting invite <9-digit no.> <ou_open_id...>`.";
        }
        if (inviteArgs.length === 0 && (context.mentionOpenIds?.length ?? 0) === 0) {
          return zh
            ? "用法：`/meeting invite [9位会议号] all|<ou_open_id...>`"
            : "Usage: `/meeting invite [9-digit no.] all|<ou_open_id...>`.";
        }
        try {
          const result = inviteArgs.length === 1 && inviteArgs[0]!.toLowerCase() === "all"
            ? await manager.invite(target.meetingId, { type: "all-suggested" })
            : await manager.invite(target.meetingId, {
                type: "selected",
                openIds: [
                  ...inviteArgs.filter((value) => !value.startsWith("@")),
                  ...(context.mentionOpenIds ?? []),
                ],
              });
          if (!result) {
            return zh ? "该会议已不在当前 Bot 的活动会话中。" : "That meeting is no longer active for this bot.";
          }
          const more = result.hasMore
            ? (zh ? "；候选人超过单次 200 人上限，部分未邀请" : "; some candidates exceeded the 200-person service limit")
            : "";
          return zh
            ? `已邀请 ${result.invitedCount} 人，失败 ${result.failedCount} 人${more}。`
            : `Invited ${result.invitedCount}; failed ${result.failedCount}${more}.`;
        } catch (error) {
          return renderVcMeetingPreflight(classifyVcMeetingError(error), locale);
        }
      }
      case "end": {
        const sessions = manager.all();
        if (sessions.length === 0) {
          return zh ? "当前没有进行中的会议。" : "No active meetings.";
        }
        const confirmed = args.at(-1)?.toLowerCase() === "confirm";
        const targetArgs = confirmed ? args.slice(0, -1) : args;
        const explicitMeetingNo = targetArgs[0] && isMeetingNo(targetArgs[0]) ? targetArgs[0] : undefined;
        const target = explicitMeetingNo ? manager.byMeetingNo(explicitMeetingNo) : sessions.length === 1 ? sessions[0] : undefined;
        if (!target) {
          return zh
            ? "有多个会议，请指定：`/meeting end <9位会议号> confirm`"
            : "Multiple meetings; specify: `/meeting end <9-digit no.> confirm`.";
        }
        if (!confirmed || targetArgs.length > (explicitMeetingNo ? 1 : 0)) {
          const command = explicitMeetingNo
            ? `/meeting end ${explicitMeetingNo} confirm`
            : "/meeting end confirm";
          return zh
            ? `这会为所有参会者结束会议 ${target.meetingNo}。如确认，请发送 \`${command}\`。`
            : `This ends meeting ${target.meetingNo} for everyone. To confirm, send \`${command}\`.`;
        }
        try {
          await manager.end(target.meetingId);
          return zh ? `已结束会议 ${target.meetingNo}。` : `Ended meeting ${target.meetingNo}.`;
        } catch (error) {
          return renderVcMeetingPreflight(classifyVcMeetingError(error), locale);
        }
      }
      case "ask": {
        const question = args.join(" ").trim();
        if (!question) {
          return zh ? "用法：`/meeting ask <问题>`" : "Usage: `/meeting ask <question>`";
        }
        const sessions = manager.all();
        if (sessions.length !== 1) {
          return sessions.length === 0
            ? (zh ? "当前没有进行中的会议。" : "No active meetings.")
            : (zh ? "有多个会议，暂不支持 ask 消歧。" : "Multiple meetings; ask disambiguation not supported.");
        }
        const answer = await answerInMeeting(sessions[0]!, question, orchestratorDeps, { deliver: "caller" });
        return answer || (zh ? "（无回复）" : "(no answer)");
      }
      default:
        return zh
          ? "未知子命令。可用：status / join / leave / invite / end / ask"
          : "Unknown subcommand. Available: status / join / leave / invite / end / ask";
    }
  };

  deps.log?.("Lark VC meeting support attached (poll-only, gated on meeting.enabled).");
  return { manager, handleMeetingCommand, dispose: () => manager.leaveAll() };
}
