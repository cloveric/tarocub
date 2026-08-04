// Feishu VC in-meeting activity parsing — ported from zara's
// lark-coding-agent-bridge (src/meeting/types.ts), adapted to TaroCub's vc-api
// base layer.
//
// The `vc.bot.meeting_activity_v1` wire format nests two levels deep: an outer
// activity item carries an `activity_event_type` plus a *per-type* array field
// (`transcript_received_items`, `chat_received_items`, …). Which field is
// populated depends on the type, the field can also live under a `payload`
// wrapper, and the type key itself drifts (`activity_event_type` vs
// `event_type`) across API revisions. {@link unpackActivity} flattens all of
// that into the normalized {@link MeetingActivityItem} union below.
//
// This module is pure: it has no timers, no I/O and no bridge/channel imports.

/** Raw activity item as it arrives on the wire (push) or from the events poll. */
export interface RawActivityItem {
  /** Server-assigned id; the intended dedup key, but not always present. */
  event_id?: string;
  /** Discriminator on current revisions. */
  activity_event_type?: string;
  /** Discriminator on older/alternate revisions. */
  event_type?: string;
  /** Which meeting this item belongs to; the manager routes on `meeting.id`. */
  meeting?: { id?: string; meeting_no?: string };
  /** Some revisions nest the per-type `_items` array under here. */
  payload?: Record<string, unknown>;
  /** The per-type `*_items` arrays and any other fields. */
  [key: string]: unknown;
}

/** A speaker / sender / participant, however the wire wrapped their identity. */
export interface MeetingActor {
  id?: string;
  name?: string;
}

export interface TranscriptActivity {
  kind: "transcript";
  speaker: MeetingActor;
  text: string;
  /** Stable per sentence — later items with the same id supersede earlier ones. */
  sentenceId: string;
  startMs?: number;
  endMs?: number;
  language?: string;
  /** True when the speaker is our own bot (its speech is transcribed back). */
  selfEcho: boolean;
}

export interface ChatActivity {
  kind: "chat";
  from: MeetingActor;
  content: string;
  /** Feishu's in-meeting message type; `3` is a reaction rather than text. */
  messageType?: number;
}

export interface ParticipantActivity {
  kind: "participant";
  action: "joined" | "left";
  user: MeetingActor;
  leaveReason?: string;
}

export interface ShareActivity {
  kind: "share";
  action: "started" | "ended";
  url?: string;
  title?: string;
}

/** Normalized in-meeting activity — one of transcript / chat / participant / share. */
export type MeetingActivityItem =
  | TranscriptActivity
  | ChatActivity
  | ParticipantActivity
  | ShareActivity;

/** `activity_event_type` → the array field carrying its items (doc 3.4). */
const ARRAY_FIELD: Record<string, string> = {
  transcript_received: "transcript_received_items",
  chat_received: "chat_received_items",
  participant_joined: "participant_joined_items",
  participant_left: "participant_left_items",
  magic_share_started: "magic_share_started_items",
  magic_share_ended: "magic_share_ended_items",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pull the actor out of an item. The wire format is inconsistent about the
 * wrapper key (`speaker` / `user` / `operator` / `sender` / flat), so probe the
 * given keys in order, then fall back to flat fields.
 */
function actor(item: Record<string, unknown>, ...keys: string[]): MeetingActor {
  for (const key of keys) {
    const wrapped = asRecord(item[key]);
    const id = str(wrapped.open_id) ?? str(wrapped.user_id) ?? str(wrapped.id);
    const name = str(wrapped.name) ?? str(wrapped.user_name);
    if (id || name) return { ...(id ? { id } : {}), ...(name ? { name } : {}) };
  }
  const id = str(item.open_id) ?? str(item.user_id);
  const name = str(item.name) ?? str(item.user_name) ?? str(item.speaker_name);
  return { ...(id ? { id } : {}), ...(name ? { name } : {}) };
}

/** Read the item's discriminator, tolerating either revision's key. */
export function activityType(item: RawActivityItem): string | undefined {
  return item.activity_event_type ?? item.event_type;
}

/**
 * Flatten one raw activity item into normalized {@link MeetingActivityItem}s
 * (the second unpack layer). A single push can carry dozens of transcript
 * lines, so this returns an array — taking only the first would silently drop
 * data. Returns `[]` for unknown types or shapes we can't read; the caller
 * distinguishes that from a handled-but-empty item.
 */
export function unpackActivity(item: RawActivityItem, botOpenId?: string): MeetingActivityItem[] {
  const type = activityType(item);
  if (!type) return [];
  const field = ARRAY_FIELD[type];
  if (!field) return [];
  // The push payload carries the items flat on the activity object, while the
  // structured/CLI shape nests them under `payload`. Accept either.
  const raw = item[field] ?? asRecord(item.payload)[field];
  const arr = Array.isArray(raw) ? raw : [];
  const out: MeetingActivityItem[] = [];

  for (const entry of arr) {
    const it = asRecord(entry);
    switch (type) {
      case "transcript_received": {
        const text = str(it.text) ?? str(it.content) ?? "";
        const sentenceId = String(it.sentence_id ?? it.sentenceId ?? "");
        if (!text || !sentenceId) break;
        const speaker = actor(it, "speaker", "user", "sender");
        const startMs = num(it.start_time_ms ?? it.start_ms);
        const endMs = num(it.end_time_ms ?? it.end_ms);
        out.push({
          kind: "transcript",
          speaker,
          text,
          sentenceId,
          ...(startMs !== undefined ? { startMs } : {}),
          ...(endMs !== undefined ? { endMs } : {}),
          ...(str(it.language) ? { language: str(it.language) } : {}),
          selfEcho: Boolean(botOpenId && speaker.id === botOpenId),
        });
        break;
      }
      case "chat_received": {
        const content = str(it.content) ?? str(it.text) ?? "";
        if (!content) break;
        const messageType = num(it.message_type);
        out.push({
          kind: "chat",
          from: actor(it, "sender", "user", "from"),
          content,
          ...(messageType !== undefined ? { messageType } : {}),
        });
        break;
      }
      case "participant_joined":
      case "participant_left":
        out.push({
          kind: "participant",
          action: type === "participant_joined" ? "joined" : "left",
          user: actor(it, "user", "participant"),
          ...(str(it.leave_reason) ? { leaveReason: str(it.leave_reason) } : {}),
        });
        break;
      case "magic_share_started":
      case "magic_share_ended":
        out.push({
          kind: "share",
          action: type === "magic_share_started" ? "started" : "ended",
          ...(str(it.url) ? { url: str(it.url) } : {}),
          ...(str(it.title) ? { title: str(it.title) } : {}),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Stable dedup key for an item that carries no `event_id`. Built from the type
 * plus the identity-bearing fields of its items, so the same event arriving
 * over both the push and poll lanes collapses to one delivery. Without this a
 * duplicate chat item would fire a second orchestrator run.
 */
export function contentDedupKey(item: RawActivityItem): string | undefined {
  const type = activityType(item);
  if (!type) return undefined;
  const payload = item as Record<string, unknown>;
  const nested = asRecord(payload.payload);
  const arr = Object.entries({ ...payload, ...nested }).find(
    ([k, v]) => k.endsWith("_items") && Array.isArray(v),
  )?.[1] as unknown[] | undefined;
  if (!arr || arr.length === 0) return undefined;
  const parts = arr.map((entry) => {
    const it = asRecord(entry);
    // sentence_id / message_id + content identify a line or message; the
    // timestamp disambiguates repeated identical text; the sender disambiguates
    // two people saying the same thing.
    return [
      it.sentence_id ?? it.message_id ?? "",
      it.content ?? it.text ?? "",
      it.start_time_ms ?? it.create_time ?? it.time ?? "",
      it.open_id ?? asRecord(it.sender).open_id ?? "",
    ].join("|");
  });
  return `${type}#${parts.join("~")}`;
}
