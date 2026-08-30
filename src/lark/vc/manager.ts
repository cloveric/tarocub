// Routes Feishu VC in-meeting activity across the meetings this process is in.
// Ported from zara's lark-coding-agent-bridge (src/meeting/manager.ts), adapted
// to TaroCub's vc-api base layer.
//
// Feishu pushes `vc.bot.meeting_activity_v1` at the *application* level: every
// meeting this app is in arrives on one stream, keyed by `meeting.id`. This
// manager owns that routing plus each meeting's lifecycle, so the rest of the
// bridge deals in individual {@link MeetingSession}s.
//
// It is free of bridge/delivery knowledge — the orchestrator wires its concerns
// through the callbacks (onSession / onEnded / onInvited) and, optionally, a
// push dispatcher via attachPush(). Nothing self-starts.

import type { MeetingConfig } from "../../telegram/instance-config.js";
import {
  endMeeting,
  inviteMeetingParticipants,
  joinMeeting,
  type LarkVcRequestClient,
  type MeetingInviteInput,
  type MeetingInviteResult,
} from "./vc-api.js";
import { MeetingSession, type MeetingSessionStatus } from "./session.js";
import { activityType, type RawActivityItem } from "./types.js";

/** The three `vc.bot.*` events, as they appear on the wire. */
export const VC_BOT_EVENTS = {
  invited: "vc.bot.meeting_invited_v1",
  activity: "vc.bot.meeting_activity_v1",
  ended: "vc.bot.meeting_ended_v1",
} as const;

/**
 * Minimal shape of node-sdk's EventDispatcher (`register(handles)`). We accept
 * this as a parameter to attachPush rather than reaching into any private SDK
 * field, so the Lark channel decides whether and how to wire it.
 */
export interface VcEventDispatcher {
  register(handles: Record<string, (data: unknown) => Promise<unknown> | unknown>): unknown;
}

export interface MeetingPushHealth {
  /** Whether the dispatcher hook was installed successfully. */
  hooked: boolean;
  /** Why the hook could not be installed (dispatcher absent/unusable). */
  reason?: string;
  /** Count of `vc.bot.*` pushes observed — proves the console subscription works. */
  received: number;
  lastAt?: string;
}

export interface MeetingManagerDeps {
  client: LarkVcRequestClient;
  /** Live config accessor — re-read per use so `/config` edits apply. */
  config: () => MeetingConfig;
  /** Late-bound: the bot's identity is only known after the channel connects. */
  botOpenId?: () => string | undefined;
  /** Notified when a session is created, so the orchestrator can subscribe. */
  onSession?: (session: MeetingSession) => void;
  /** Meeting ended (push, or observed by the poller). */
  onEnded?: (meetingId: string, session: MeetingSession) => void;
  /** Bot was invited to a meeting (push only) — orchestrator decides to join. */
  onInvited?: (meetingNo: string, inviterId?: string) => void;
  /** Injectable clock, forwarded to each session for deterministic timestamps. */
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class MeetingManager {
  private sessions = new Map<string, MeetingSession>();
  private push: MeetingPushHealth = { hooked: false, received: 0 };
  private disposed = false;

  constructor(private readonly deps: MeetingManagerDeps) {}

  pushHealth(): MeetingPushHealth {
    return { ...this.push };
  }

  list(): MeetingSessionStatus[] {
    return [...this.sessions.values()].map((s) => s.status());
  }

  get(meetingId: string): MeetingSession | undefined {
    return this.sessions.get(meetingId);
  }

  /** Find a session by its 9-digit meeting number. */
  byMeetingNo(meetingNo: string): MeetingSession | undefined {
    const wanted = meetingNo.trim();
    return [...this.sessions.values()].find((s) => s.meetingNo === wanted);
  }

  /** Sessions in the order they were joined. */
  all(): MeetingSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Join a meeting by 9-digit number and start a session. Polling starts
   * regardless of push: it is the primary source until a push arrives, and the
   * gap-fill path afterwards. Dedups a live session for the same number.
   */
  async join(meetingNo: string, password?: string): Promise<MeetingSession> {
    const existing = this.byMeetingNo(meetingNo);
    if (existing && !existing.ended) return existing;

    const config = this.deps.config();
    const { meetingId } = await joinMeeting(this.deps.client, meetingNo, password);
    const botOpenId = this.deps.botOpenId?.();
    const session = new MeetingSession({
      client: this.deps.client,
      meetingId,
      meetingNo: meetingNo.trim(),
      config,
      ...(botOpenId ? { botOpenId } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    this.sessions.set(session.meetingId, session);
    this.deps.onSession?.(session);
    session.startPolling();
    return session;
  }

  /**
   * Route a batch of push activity items to their sessions by `meeting.id`.
   * Items for meetings this process does not manage are ignored.
   */
  handleActivity(pushItems: readonly RawActivityItem[]): void {
    if (!Array.isArray(pushItems)) return;
    for (const raw of pushItems) {
      const item = raw as RawActivityItem;
      const meetingId = item?.meeting?.id;
      if (!meetingId) continue;
      const session = this.sessions.get(meetingId);
      if (!session) continue; // not managed here → ignore
      session.markPushActive();
      session.handleActivity([item]);
    }
  }

  /** Meeting ended server-side: stop the session, drop it, notify. Idempotent. */
  handleEnded(meetingId: string): boolean {
    const session = this.sessions.get(meetingId);
    if (!session) return false;
    session.markEnded();
    this.sessions.delete(meetingId);
    this.deps.onEnded?.(meetingId, session);
    return true;
  }

  /** Leave a meeting and drop its session. Idempotent. */
  async leave(meetingId: string): Promise<boolean> {
    const session = this.sessions.get(meetingId);
    if (!session) return false;
    this.sessions.delete(meetingId);
    await session.leave();
    return true;
  }

  /** Invite participants through a session this process currently owns. */
  async invite(meetingId: string, input: MeetingInviteInput): Promise<MeetingInviteResult | null> {
    if (!this.sessions.has(meetingId)) return null;
    return inviteMeetingParticipants(this.deps.client, meetingId, input);
  }

  /** End a meeting as host. Keep the session intact when the API rejects it. */
  async end(meetingId: string): Promise<boolean> {
    if (!this.sessions.has(meetingId)) return false;
    await endMeeting(this.deps.client, meetingId);
    this.handleEnded(meetingId);
    return true;
  }

  /** Leave every meeting — used on shutdown / an explicit exit. */
  async leaveAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => s.leave()));
  }

  /**
   * Register the three `vc.bot.*` handlers on a channel-provided dispatcher.
   * OPTIONAL: if the dispatcher is absent or unusable, health.hooked is set
   * false with a reason and the manager stays poll-only (each session's poller
   * is the fallback). Never throws.
   */
  attachPush(dispatcher: unknown): MeetingPushHealth {
    const candidate = dispatcher as VcEventDispatcher | undefined;
    if (!candidate || typeof candidate.register !== "function") {
      this.push = {
        hooked: false,
        reason: "no usable event dispatcher provided; falling back to polling",
        received: this.push.received,
      };
      return this.pushHealth();
    }
    try {
      candidate.register({
        [VC_BOT_EVENTS.invited]: (data: unknown) => {
          this.notePush();
          this.dispatchInvited(data);
        },
        [VC_BOT_EVENTS.activity]: (data: unknown) => {
          this.notePush();
          this.handleActivity(extractActivityItems(data));
        },
        [VC_BOT_EVENTS.ended]: (data: unknown) => {
          this.notePush();
          const meetingId = asRecord(asRecord(data).meeting).id;
          if (typeof meetingId === "string") this.handleEnded(meetingId);
        },
      });
      this.push = { hooked: true, received: this.push.received };
    } catch (err) {
      this.push = {
        hooked: false,
        reason: `event registration failed: ${String(err)}`,
        received: this.push.received,
      };
    }
    return this.pushHealth();
  }

  /** Increment the push counter — call sites are the registered handlers. */
  notePush(): void {
    this.push.received += 1;
    this.push.lastAt = new Date(this.deps.now?.() ?? Date.now()).toISOString();
  }

  private dispatchInvited(data: unknown): void {
    const meeting = asRecord(asRecord(data).meeting);
    const meetingNo = typeof meeting.meeting_no === "string" ? meeting.meeting_no : undefined;
    if (!meetingNo) return;
    const inviter = asRecord(asRecord(data).operator ?? asRecord(data).inviter);
    const inviterId = typeof inviter.open_id === "string" ? inviter.open_id : undefined;
    this.deps.onInvited?.(meetingNo, inviterId);
  }

  /**
   * Stop local work WITHOUT leaving the meetings — used on reconnect, where the
   * channel is torn down and rebuilt and leaving every meeting would be
   * surprising.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}

/**
 * Pull the activity item array out of a raw `vc.bot.meeting_activity_v1`
 * payload. The array field name drifts (`meeting_activity_items` vs `events`)
 * across revisions, so accept either; keep only items that look like activity.
 */
export function extractActivityItems(data: unknown): RawActivityItem[] {
  const d = asRecord(data);
  const raw = Array.isArray(d.meeting_activity_items)
    ? d.meeting_activity_items
    : Array.isArray(d.events)
      ? d.events
      : [];
  return raw
    .map((entry) => entry as RawActivityItem)
    .filter((item) => item && typeof item === "object" && activityType(item) !== undefined);
}
