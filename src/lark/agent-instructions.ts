import { existsSync } from "node:fs";
import path from "node:path";

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
export function localAsrAgentInstruction(): string | undefined {
  if (!isLocalAsrAvailable()) {
    return undefined;
  }
  const httpUrl = (process.env.ASR_HTTP_URL ?? "").trim() || "http://127.0.0.1:8412/transcribe";
  return `Local speech-to-text is installed on this machine. When YOU need to transcribe audio/video (a voice or video file, including ones you download or extract from a link), use it FIRST — do NOT default to whisper/mlx_whisper/parakeet, and do NOT conclude "no ASR available". Fast path: curl -s -X POST ${httpUrl} -H 'Content-Type: application/json' -d '{"path":"<absolute file path>"}'. Fall back to video frames / OCR only if transcription genuinely fails.`;
}

export function larkAgentInstructions(): string {
  const lines = [
    "Lark via TaroCub; <lark_context>/<lark_comment_context> are routing only; no secrets.",
    "Default: concise text reply; no progress placeholder cards. Ask if auth/scopes/tools missing.",
    "Use `lark-cli` for Lark-native work: Docs/IM/Calendar/Drive/Sheets/OAuth; basic chat transport can still work without it. Sheets: start `sheets +info`; use structured Sheets values; do not treat Sheets as Docs/Base. OAuth private only.",
    "Bridge tags: [send-file:/absolute/path], [send-image:/absolute/path], send.file/send.image/send.audio/send.video/send.batch; lark.choice or `request_user_input`; Claude `AskUserQuestion` => Feishu card. Do not call `lark-cli` just to send choice cards. Small text: fenced `file:name.ext`.",
    "File/image send is workspace-sandboxed: to send one from elsewhere (e.g. ~/.codex/generated_images/), copy it into your workspace first, then send that path — an outside path is refused (a path restriction, not a failure).",
    "Image titles: put an image's title on the line directly before its [send-image:…] tag — each image is delivered as its own card (title + image), so a titled series (e.g. 小红书 P1/P2) stays paired, not a bare pile.",
    "Service ops: use `node dist/src/index.js lark service restart --all`; no manual Lark restart loops. CLI defers current.",
    "Reminders: only explicit reminder/schedule requests; cron.add one of `in`/`at`/`cron`, no `chatId`/`userId`; `at` ISO timezone; manage cron.list/cron.remove/cron.toggle; list first if ambiguous; let bridge confirm.",
    "Exact URLs: read directly with `web_extract`/browser; use `web_search` for discovery/current facts/fallback. Treat <forwarded_lark_messages> as task context.",
  ];
  const asr = localAsrAgentInstruction();
  if (asr) {
    lines.push(asr);
  }
  return lines.join("\n");
}
