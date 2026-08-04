// One live Feishu VC meeting — the session/transcript/dedup logic. Ported from
// zara's lark-coding-agent-bridge (src/meeting/session.ts), adapted to
// TaroCub's vc-api base layer and MeetingConfig field names.
//
// A session owns the transcript buffer, de-duplication, the poll loop and the
// end-of-life cleanup for a *single* meeting; the manager owns routing across
// meetings. It deliberately has no knowledge of the orchestrator/bridge — the
// orchestrator subscribes via the typed EventEmitter (`session.on('chat'|…)`).
//
// Pure logic: the only I/O is through the injected {@link LarkVcRequestClient}
// (poll + send text). Nothing self-starts — the caller invokes startPolling().

import { EventEmitter } from "node:events";

import type { MeetingConfig } from "../../telegram/instance-config.js";
import {
  leaveMeeting,
  pullMeetingEvents,
  sendMeetingText,
  type LarkVcRequestClient,
} from "./vc-api.js";
import {
  activityType,
  contentDedupKey,
  unpackActivity,
  type ChatActivity,
  type MeetingActivityItem,
  type ParticipantActivity,
  type RawActivityItem,
  type ShareActivity,
  type TranscriptActivity,
} from "./types.js";

export type MeetingEventSourceKind = "push" | "poll";

export interface MeetingSessionStatus {
  meetingId: string;
  meetingNo: string;
  startedAt: string;
  /** Where in-meeting content is currently coming from. */
  source: MeetingEventSourceKind;
  transcriptLines: number;
  participants: number;
  /** Activity items ingested (post-dedup) — a quick health signal. */
  ingested: number;
  /**
   * Count of raw activity items per `activity_event_type`, including types that
   * yielded nothing (prefixed `?`). This is what distinguishes "Feishu never
   * sent transcripts" from "it sent them and we failed to parse" — without it
   * the only symptom is a silent zero.
   */
  eventCounts: Record<string, number>;
  ended: boolean;
}

export interface MeetingSessionDeps {
  client: LarkVcRequestClient;
  /** The long meeting id required by every bot call. */
  meetingId: string;
  /** The 9-digit meeting number (for display / dedup by the manager). */
  meetingNo: string;
  /** Bot's own open_id, used to drop self-echo transcript lines. */
  botOpenId?: string;
  config: MeetingConfig;
  /** Injectable clock so `startedAt` is deterministic under test. */
  now?: () => number;
}

/** Typed event map for the session's EventEmitter surface. */
export interface MeetingSessionEventMap {
  /** An in-meeting chat message arrived. */
  chat: [ChatActivity];
  /** A transcript sentence was committed/updated. */
  transcript: [TranscriptActivity];
  /** A participant joined or left. */
  participant: [ParticipantActivity];
  /** A screen/magic share started or ended. */
  share: [ShareActivity];
}

type EventKey = keyof MeetingSessionEventMap;

// Declaration-merge typed on/once/off/emit over the runtime EventEmitter.
export interface MeetingSession {
  on<K extends EventKey>(event: K, listener: (...args: MeetingSessionEventMap[K]) => void): this;
  once<K extends EventKey>(event: K, listener: (...args: MeetingSessionEventMap[K]) => void): this;
  off<K extends EventKey>(event: K, listener: (...args: MeetingSessionEventMap[K]) => void): this;
  emit<K extends EventKey>(event: K, ...args: MeetingSessionEventMap[K]): boolean;
}

export class MeetingSession extends EventEmitter {
  readonly meetingId: string;
  readonly meetingNo: string;
  readonly startedAt: string;

  private readonly client: LarkVcRequestClient;
  private readonly config: MeetingConfig;
  private readonly botOpenId?: string;
  private readonly now: () => number;

  /** Rolling transcript kept structurally so a re-sent sentence replaces in place. */
  private transcript: { sentenceId: string; speaker: string; text: string }[] = [];
  /** sentence_id → latest text, so a re-sent sentence overwrites rather than appends. */
  private sentences = new Map<string, string>();
  /** dedup keys (event_id, or a synthesized content key) already ingested. */
  private seenEvents = new Set<string>();
  private participantIds = new Set<string>();

  private source: MeetingEventSourceKind = "poll";
  private ingested = 0;
  private eventCounts: Record<string, number> = {};
  private cursor?: string;
  private poller?: ReturnType<typeof setTimeout>;
  private idleRounds = 0;
  private stopped = false;
  private leaving = false;
  private _ended = false;

  constructor(deps: MeetingSessionDeps) {
    super();
    this.client = deps.client;
    this.meetingId = deps.meetingId;
    this.meetingNo = deps.meetingNo;
    if (deps.botOpenId) this.botOpenId = deps.botOpenId;
    this.config = deps.config;
    this.now = deps.now ?? (() => Date.now());
    this.startedAt = new Date(this.now()).toISOString();
  }

  get ended(): boolean {
    return this._ended;
  }

  status(): MeetingSessionStatus {
    return {
      meetingId: this.meetingId,
      meetingNo: this.meetingNo,
      startedAt: this.startedAt,
      source: this.source,
      transcriptLines: this.transcript.length,
      participants: this.participantIds.size,
      ingested: this.ingested,
      eventCounts: { ...this.eventCounts },
      ended: this._ended,
    };
  }

  /**
   * Latest transcript as `说话人: 内容` lines, oldest first — orchestrator
   * context. `keep` bounds to the most recent N lines; omit for all buffered.
   */
  recentTranscript(keep?: number): string[] {
    const slice =
      !keep || keep >= this.transcript.length ? this.transcript : this.transcript.slice(-keep);
    return slice.map((l) => `${l.speaker}: ${l.text}`);
  }

  /**
   * Events are arriving via push. Polling was the primary lane until now; if we
   * kept both, every event would be delivered twice, so hand over and stop the
   * poller. The push lane is what the protocol intends; the events poll stays
   * available for an explicit gap-fill (a caller can startPolling() again).
   */
  markPushActive(): void {
    if (this.source === "push") return;
    this.source = "push";
    this.stopPolling();
  }

  /**
   * Ingest a batch of raw activity items — used by both the poll loop and the
   * push router. Each item is idempotent per dedup key, so replayed pushes and
   * poll/push overlap collapse to one delivery.
   */
  handleActivity(items: readonly RawActivityItem[]): void {
    for (const item of items) this.ingest(item);
  }

  private ingest(item: RawActivityItem): void {
    if (this._ended) return;
    // Push and poll deliver the *same* content by design (poll is the gap-fill
    // lane), so an item can arrive twice. `event_id` is the intended dedup key,
    // but it isn't always present — without a fallback a duplicate chat item
    // fires a second orchestrator run.
    const dedupKey = item.event_id ?? contentDedupKey(item);
    if (dedupKey) {
      if (this.seenEvents.has(dedupKey)) return;
      this.seenEvents.add(dedupKey);
      // Bound the dedup set; meetings are long-lived and ids never repeat once
      // they've scrolled far enough out of the window.
      if (this.seenEvents.size > 5000) {
        for (const id of this.seenEvents) {
          this.seenEvents.delete(id);
          if (this.seenEvents.size <= 4000) break;
        }
      }
    }
    this.ingested += 1;
    const rawType = activityType(item) ?? "unknown";
    const events = unpackActivity(item, this.botOpenId);
    // An item that yields nothing is either an unhandled type or a shape we
    // failed to read; mark it with `?` so status() shows it instead of
    // silently dropping it.
    const key = events.length === 0 ? `?${rawType}` : rawType;
    this.eventCounts[key] = (this.eventCounts[key] ?? 0) + 1;
    for (const event of events) this.handle(event);
  }

  private handle(event: MeetingActivityItem): void {
    switch (event.kind) {
      case "transcript":
        this.handleTranscript(event);
        return;
      case "participant": {
        const id = event.user.id;
        if (id) {
          if (event.action === "joined") this.participantIds.add(id);
          else this.participantIds.delete(id);
        }
        this.dispatch("participant", event);
        return;
      }
      case "chat":
        this.dispatch("chat", event);
        return;
      case "share":
        this.dispatch("share", event);
        return;
    }
  }

  private handleTranscript(event: TranscriptActivity): void {
    // The bot's own speech comes back through the meeting's transcription; not
    // filtering it here would let "answer whatever you hear" self-trigger.
    if (event.selfEcho) return;
    if (this.sentences.get(event.sentenceId) === event.text) return; // exact repeat
    this.sentences.set(event.sentenceId, event.text);

    const line = {
      sentenceId: event.sentenceId,
      speaker: event.speaker.name ?? event.speaker.id ?? "?",
      text: event.text,
    };
    // Same sentence growing → replace in place, so the buffer holds one entry
    // per sentence instead of every intermediate prefix.
    const idx = this.transcript.findIndex((l) => l.sentenceId === event.sentenceId);
    if (idx >= 0) this.transcript[idx] = line;
    else this.transcript.push(line);
    const keep = this.config.transcriptKeep;
    if (this.transcript.length > keep) this.transcript = this.transcript.slice(-keep);
    this.dispatch("transcript", event);
  }

  /**
   * Fan an event out to subscribers with per-listener isolation — one throwing
   * orchestrator handler must not break ingestion or starve the other handlers.
   */
  private dispatch<K extends EventKey>(event: K, arg: MeetingSessionEventMap[K][0]): void {
    for (const listener of this.listeners(event)) {
      try {
        (listener as (payload: MeetingSessionEventMap[K][0]) => void)(arg);
      } catch {
        // swallow: a subscriber's failure is not the session's problem.
      }
    }
  }

  /** Send a text message (弹幕) into the meeting chat. Idempotent after end. */
  async sendMessage(text: string): Promise<void> {
    if (this._ended) return;
    await sendMeetingText(this.client, this.meetingId, text);
  }

  /**
   * Start the events poller. Used as the primary source until push is proven,
   * and as gap-fill afterwards. Idle rounds back off base×2, capped at 10s;
   * `has_more` polls again immediately. No-op if already polling or stopped.
   */
  startPolling(): void {
    if (this.poller || this.stopped || this._ended) return;
    const tick = async (): Promise<void> => {
      if (this.stopped || this._ended) return;
      try {
        const page = await pullMeetingEvents(this.client, this.meetingId, this.cursor);
        if (page.pageToken) this.cursor = page.pageToken;
        this.handleActivity(page.items as RawActivityItem[]);
        this.idleRounds = page.items.length > 0 ? 0 : Math.min(this.idleRounds + 1, 3);
        // More pages queued → come back immediately instead of sleeping.
        if (page.hasMore) this.idleRounds = -1;
      } catch {
        this.idleRounds = Math.min(this.idleRounds + 1, 3);
      }
      if (this.stopped || this._ended) return;
      const base = this.config.pollIntervalMs;
      const delay = this.idleRounds < 0 ? 0 : Math.min(base * 2 ** this.idleRounds, 10_000);
      this.poller = setTimeout(() => void tick(), delay);
    };
    this.poller = setTimeout(() => void tick(), 0);
  }

  private stopPolling(): void {
    if (this.poller) clearTimeout(this.poller);
    this.poller = undefined;
  }

  /** Called when the meeting ends server-side: stop work, keep the transcript. */
  markEnded(): void {
    this._ended = true;
    this.stopTimers();
  }

  private stopTimers(): void {
    this.stopped = true;
    this.stopPolling();
  }

  /** Leave the meeting via the API. Idempotent — safe after the meeting ended. */
  async leave(): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    this.stopTimers();
    if (this._ended) return; // already over; nothing to leave
    this._ended = true;
    await leaveMeeting(this.client, this.meetingId).catch(() => {
      // best-effort; the manager has already dropped us from its map.
    });
  }

  /** Tear down local timers WITHOUT calling the API (reconnect / shutdown). */
  dispose(): void {
    this.stopTimers();
    this.removeAllListeners();
  }
}
