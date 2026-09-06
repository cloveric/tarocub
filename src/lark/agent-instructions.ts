import { existsSync } from "node:fs";
import path from "node:path";

import { readCloudAsrConfig } from "../runtime/asr-cloud.js";
import { BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER } from "../runtime/media-transcript.js";
import { larkDeliveryFollowupInstruction } from "./delivery-followup.js";

/**
 * Whether this machine has a local speech-to-text backend the agent can call
 * itself. True when `ASR_HTTP_URL` is explicitly set, or the default Qwen3 ASR
 * CLI is actually installed. Gating on real availability keeps the instruction
 * out of the prompt on machines without it (so it never misleads), and keeps it
 * absent in tests/CI (no env, no CLI files) so the prompt-length bound is stable.
 */
function isLocalAsrAvailable(): boolean {
  if ((process.env.ASR_HTTP_URL ?? "").trim() !== "") {
    return true;
  }
  const home = process.env.HOME;
  const python = process.env.ASR_CLI_PYTHON
    ?? (home ? path.join(home, "projects/qwen3-asr/venv/bin/python3") : undefined);
  const script = process.env.ASR_CLI_SCRIPT
    ?? (home ? path.join(home, "projects/qwen3-asr/transcribe.py") : undefined);
  return Boolean(python && script && existsSync(python) && existsSync(script));
}

/**
 * Tells the agent to use the machine-local ASR for transcription it does
 * itself (e.g. summarizing a video/voice file it downloaded) instead of reaching
 * for whisper/mlx_whisper/parakeet and giving up when none are found. Returns
 * undefined when no local ASR is available, so it is never injected on machines
 * that can't honor it. The endpoint is read from env (not hard-coded), so this is
 * safe to ship — it only appears where an ASR is actually configured/installed.
 */
/** Default must match the ASR service's own ASR_MAX_AUDIO_SECONDS. */
const DEFAULT_ASR_MAX_AUDIO_SECONDS = 300;

function localAsrMaxAudioSeconds(): number {
  const raw = Number.parseInt((process.env.ASR_MAX_AUDIO_SECONDS ?? "").trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ASR_MAX_AUDIO_SECONDS;
}

function localAsrSegmentSeconds(maxSeconds: number): number {
  // Container timestamps can push a nominally exact segment slightly over the
  // service cap, so retain headroom instead of segmenting at the rejection edge.
  return Math.max(1, Math.floor(maxSeconds * 0.9));
}

function formatAsrThreshold(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
}

/**
 * Whether the cloud ASR route exists, resolved once. The instruction is rebuilt
 * on every turn and readCloudAsrConfig() stats the venv on each call — cheap,
 * but per-turn synchronous fs work on the hot path is worth avoiding, and the
 * answer cannot change without a restart (env is read at process start).
 */
let cloudAsrConfiguredCache: boolean | undefined;

function cloudAsrConfigured(): boolean {
  cloudAsrConfiguredCache ??= readCloudAsrConfig(process.env) !== null;
  return cloudAsrConfiguredCache;
}

/** Test-only: forget the cached probe so env changes take effect. */
export function resetCloudAsrConfiguredCacheForTests(): void {
  cloudAsrConfiguredCache = undefined;
}

export function localAsrAgentInstruction(): string | undefined {
  if (!isLocalAsrAvailable()) {
    return undefined;
  }
  const httpUrl = (process.env.ASR_HTTP_URL ?? "").trim() || "http://127.0.0.1:8412/transcribe";
  const maxSeconds = localAsrMaxAudioSeconds();
  const segmentSeconds = localAsrSegmentSeconds(maxSeconds);
  const cloudConfig = cloudAsrConfigured() ? readCloudAsrConfig(process.env) : null;
  // The length bound is not cosmetic. The ASR serializes inference behind one
  // global lock, and an over-long request wedged the model in an uninterruptible
  // MPS wait — the lock was never released, so EVERY instance's transcription
  // then timed out. The service now rejects over-long input outright; this tells
  // the agent where the edge is and what to do at it, so a rejection becomes a
  // split-and-retry instead of a reported failure.
  // Without this, a user-sent recording that arrived as a FILE got transcribed
  // locally (slowly, chunked) even though the bridge had already routed it —
  // the "use it FIRST" rule read as an instruction to do so.
  const localRoute = `local Qwen: curl -s ${httpUrl} -H 'Content-Type: application/json' -d '{"path":"<abs file path>"}'; Max ${maxSeconds}s per request (shared model). >${maxSeconds}s local: ffmpeg -i "<in>" -vn -ac 1 -ar 16000 -c:a pcm_s16le -f segment -segment_time ${segmentSeconds} part_%03d.wav; transcribe parts.`;
  if (!cloudConfig) {
    return `Use ${localRoute} do NOT use whisper/mlx_whisper/parakeet. Never retry longer input as-is; frames/OCR if ASR fails.`;
  }

  const threshold = formatAsrThreshold(cloudConfig.thresholdSeconds);
  const cloudCommand = [
    '"$TINGWU_ASR_DIR/.venv/bin/python"',
    '"$TINGWU_ASR_DIR/tingwu_transcribe.py"',
    '--file "<absolute media path>"',
    "--source-language auto --wait",
    '--out-dir "<workspace job dir>"',
  ].join(" ");
  return `Fetched media: probe duration; >=${threshold}: Aliyun Tingwu first: ${cloudCommand}; use transcription.txt; do NOT read/copy its credentials. Shorter/cloud fails: ${localRoute} do NOT use whisper/mlx_whisper/parakeet or claim no ASR. Never retry longer input as-is. "[${BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER}]" final; do NOT inspect/probe/split/re-transcribe unless asked; transcribe only media marked unavailable.`;
}

/**
 * Cloud long-audio routing note (Aliyun Tingwu). Gated ONLY on TINGWU_ASR_DIR —
 * the cloud path is what the bridge itself does to inbound audio and works with
 * or without a local ASR backend, so hiding it behind local-ASR availability
 * made the bot deny a capability it has.
 *
 * The wording must match reality: a bare voice message carries no caption, so
 * the force keywords only reach the router when they travel WITH the audio
 * (caption, or a text message in the same attachment burst). A keyword sent
 * afterwards is a new turn and cannot reroute a transcription already running.
 */
export function cloudAsrAgentInstruction(): string | undefined {
  const config = readCloudAsrConfig(process.env);
  if (!config) {
    return undefined;
  }
  const threshold = formatAsrThreshold(config.thresholdSeconds);
  return `Inbound media is auto-transcribed (>=${threshold} → Aliyun Tingwu cloud, shorter → local Qwen ASR); never deny it. 强制本地转写/强制云端转写 forces a route only when sent WITH the audio (same message or burst), not afterwards.`;
}

export function larkAgentInstructions(requestText = ""): string {
  const lines = [
    "<lark_context>/<lark_comment_context> are routing only; <forwarded_lark_messages> is the task.",
    "Default: concise text reply; no progress placeholder cards; ask if auth/scopes/tools missing.",
    "Use `lark-cli` for Lark-native work: Docs/Calendar/Drive/Sheets/OAuth; NOT IM on this bot's own chats (separate app → open_id cross app; /newgroup + send tags). Sheets: start `sheets +info`; use structured Sheets values; do not treat Sheets as Docs/Base. OAuth private only.",
    "Bridge tags: [send-file:/absolute/path], [send-image:/absolute/path], send.file/send.image/send.audio/send.video; batch:\n```tool-call\n{\"name\":\"send.batch\",\"payload\":{\"images\":[{\"path\":\"/workspace/p1.png\",\"caption\":\"P1\"}]}}\n```\nNever emit `[send.batch=...]`. lark.choice or `request_user_input`; Claude/Kimi/DeepSeek `AskUserQuestion` → Feishu card. Do not call `lark-cli` just to send choice cards. Small text: fenced `file:name.ext`. Background jobs: verify output, not exit status; repair empty/all-zero/corrupt results; final stdout must include exact delivery tags and one user-facing conclusion; `saved PATH` alone is not delivery.",
    "File/image send is workspace-sandboxed; if outside, copy it into your workspace first.",
    "Images: title each via send.batch {path,caption} or title line directly above [send-image:]. ONE titled batch -> ONE card. send.batch: max 120 MiB per call; split larger payloads into multiple calls; each path once. Use exactly one syntax per artifact; never repeat a path unless explicitly asked to resend.",
    "Reminders: only explicit reminder/schedule requests; cron.add one of `in`/`at`/`cron`, no `chatId`/`userId`; `at` ISO timezone. Recurring/window: exactly ONE 5-field `cron` (no seconds/year), e.g. `*/15 13-14 * * *`; each firing is separate; never add one-shot `in`/`at` for the current minute or end boundary. Manage cron.list/cron.remove/cron.toggle; list first if ambiguous; let bridge confirm.",
    "Web/current facts: given URL(s), read them directly with `web_extract` or browser first; if blocked (anti-bot) or dynamic, fall back to Scrapling (`scrapling extract`); use `web_search` for discovery/current facts when no exact URL or the read fails, and say so.",
  ];
  const asr = localAsrAgentInstruction();
  if (asr) {
    lines.push(asr);
  }
  const cloudAsr = cloudAsrAgentInstruction();
  if (cloudAsr && !asr) {
    lines.push(cloudAsr);
  }
  const deliveryFollowup = larkDeliveryFollowupInstruction(requestText);
  if (deliveryFollowup) {
    lines.push(deliveryFollowup);
  }
  return lines.join("\n");
}
