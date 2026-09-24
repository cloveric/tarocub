import { existsSync } from "node:fs";
import path from "node:path";

import { readCloudAsrConfig } from "../runtime/asr-cloud.js";
import { BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER } from "../runtime/media-transcript.js";
import type { InstanceEngine } from "../telegram/instance-config.js";

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
  const localRoute = `local Qwen: curl -s ${httpUrl} -H 'Content-Type: application/json' -d '{"path":"<absolute-path>"}'; Max ${maxSeconds}s per request (shared model). >${maxSeconds}s: ffmpeg -i "<in>" -vn -ac 1 -ar 16000 -c:a pcm_s16le -f segment -segment_time ${segmentSeconds} part_%03d.wav; transcribe parts.`;
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

export type LarkAgentInstructionContext = "chat" | "card" | "comment" | "cron" | "bus" | "meeting";

export interface LarkAgentInstructionOptions {
  engine?: InstanceEngine;
  claudeChrome?: boolean;
  timezone?: string;
  context?: LarkAgentInstructionContext;
}

const FETCHED_MEDIA_TASK_PATTERN = /(?:transcrib|transcript|subtitle|caption|podcast|audio|video|youtube|youtu\.be|bilibili|b23\.tv|douyin|speech[- ]?to[- ]?text|\.(?:aac|flac|m4a|mkv|mov|mp3|mp4|ogg|wav|webm)\b|转写|转录|字幕|音频|视频|录音|语音|播客|整理成.{0,4}文字|下载.{0,8}(?:视频|音频))/iu;

function mediaTaskIntentText(text: string): string {
  if (!text.includes(`[${BRIDGE_MEDIA_TRANSCRIPT_COMPLETED_MARKER}]`)) {
    return text;
  }
  return text
    .replace(
      /\[Bridge media transcription completed\]\r?\n(?:File:[^\r\n]*\r?\n)?(?:Use the transcript below[^\r\n]*\r?\n)?Transcript:\r?\n([\s\S]*?)\r?\n\[End bridge media transcription\]/giu,
      "$1",
    )
    .replace(/\[Bridge media transcription completed\]/giu, "")
    .replace(/^File:[^\r\n]*$/gimu, "")
    .replace(/^Use the transcript below[^\r\n]*$/gimu, "")
    .replace(/^Transcript:\s*$/gimu, "")
    .replace(/^\[End bridge media transcription\]\s*$/gimu, "");
}

/** Per-turn media procedure. Ordinary turns should not pay this prompt cost. */
export function larkMediaTaskInstruction(text: string): string | undefined {
  if (!FETCHED_MEDIA_TASK_PATTERN.test(mediaTaskIntentText(text))) {
    return undefined;
  }
  return localAsrAgentInstruction() ?? cloudAsrAgentInstruction();
}

export function mergeLarkTurnInstructions(...instructions: Array<string | undefined>): string | undefined {
  const merged = instructions.map((instruction) => instruction?.trim()).filter(Boolean) as string[];
  return merged.length > 0 ? merged.join("\n\n") : undefined;
}

export function larkAgentInstructions(options: LarkAgentInstructionOptions = {}): string {
  const engine = options.engine ?? "codex";
  const context = options.context ?? "chat";
  const canDeliver = context === "chat" || context === "card" || context === "bus" || context === "cron";
  const canSchedule = context === "chat" || context === "card" || context === "bus";
  const lines = [
    "Lark routing tags are context; forwarded content is the task. Be concise; no progress cards; ask only for missing tools/auth/scopes.",
    "Lark Docs/Calendar/Drive/Sheets/OAuth: use `lark-cli`; no IM here (cross-app open_id). OAuth private; Sheets use structured values, not Docs/Base.",
  ];

  if (engine === "deepseek" || engine === "antigravity") {
    lines.push("Sheets: start with `sheets +workbook-info` before reads/writes.");
  }

  if (canDeliver) {
    lines.push("Artifacts: [send-file:/absolute/path], [send-image:/absolute/path], send.file/send.image/send.audio/send.video, or:\n```tool-call\n{\"name\":\"send.batch\",\"payload\":{\"images\":[{\"path\":\"/workspace/p.png\",\"caption\":\"P\"}]}}\n```\nPictures use `images`. Copy outside files into the workspace. Verify output; `saved PATH` is not delivery.");
    lines.push("Use one syntax; each path once unless resend requested. Put a single image title directly above [send-image:]; one titled batch becomes one card. Batches auto-split above 120 MiB. Small text: fenced `file:name.ext`. Claim delivery only with an executable directive.");
  }

  if (engine === "codex") {
    lines.push("Short choices: `request_user_input` or lark.choice; do not call `lark-cli` only for a choice card.");
  } else if (engine === "claude" || engine === "kimi" || engine === "deepseek") {
    lines.push("AskUserQuestion becomes a Lark card; lark.choice also works. Do not call `lark-cli` only for a choice card.");
  } else {
    lines.push("Short choices: lark.choice; do not call `lark-cli` only for a choice card.");
  }

  if (engine === "claude" || engine === "kimi" || engine === "deepseek") {
    lines.push("Background work: one job/batch; no nested/page/poll waiters; verify output, then one final notice with delivery directives and conclusion.");
  }

  lines.push("Lark cards do not render LaTeX; prefer Unicode such as ÷, ×, ≈, ≤, ≥ over `$...$`/`\\text{}`.");

  if (canSchedule) {
    const timezone = options.timezone?.trim() || "the instance timezone";
    lines.push(`Reminders only on explicit request. cron.add: exactly one of in/at/cron; at uses ISO timezone; recurring uses one 5-field expression in ${timezone}. No current-minute/end-boundary one-shots. Manage with cron.list/cron.remove/cron.toggle; list first if ambiguous; let the bridge confirm.`);
  } else if (context === "cron") {
    lines.push("This scheduled run must not create, remove, or modify schedules.");
  }

  if (engine === "claude" && options.claudeChrome) {
    lines.push("Signed-in tasks: main Chrome. Exact URLs: web_extract/browser; blocked/dynamic → Scrapling; otherwise web_search. 9222/9223 only for a named skill; disclose web use and cite links.");
  } else {
    lines.push("URLs: web_extract/browser; blocked/dynamic → Scrapling; otherwise web_search. Use this engine's web tools; disclose use and cite links. 9222/9223 only for a named skill.");
  }

  return lines.join("\n");
}
