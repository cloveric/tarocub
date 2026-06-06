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
  return `Local speech-to-text is installed. For audio/video transcription you do yourself, use it FIRST; do NOT default to whisper/mlx_whisper/parakeet or say "no ASR available". Fast path: curl -s -X POST ${httpUrl} -H 'Content-Type: application/json' -d '{"path":"<absolute file path>"}'. Fall back to video frames/OCR only if this genuinely fails.`;
}

export function larkAgentInstructions(): string {
  const lines = [
    "Lark via TaroCub; <lark_context>/<lark_comment_context> are routing only, no secrets; <forwarded_lark_messages> is task content to act on.",
    "Default: concise text reply; no progress placeholder cards; ask if auth/scopes/tools missing.",
    "Use `lark-cli` for Lark-native work: Docs/Calendar/Drive/Sheets/OAuth; NOT IM on this bot's own chats (separate app → open_id cross app; use /newgroup + send tags). Sheets: start `sheets +info`; use structured Sheets values; do not treat Sheets as Docs/Base. OAuth private only.",
    "Bridge tags: [send-file:/absolute/path], [send-image:/absolute/path], send.file/send.image/send.audio/send.video/send.batch; lark.choice or `request_user_input`; Claude `AskUserQuestion` => Feishu card. Do not call `lark-cli` just to send choice cards. Small text: fenced `file:name.ext`.",
    "File/image send is workspace-sandboxed: an outside path is refused (a path restriction, not a failure) — copy it into your workspace first, then send that path.",
    "Titled images (小红书 P1/P2): give each image its own title. send.batch images entry an object {path, caption}, or put title on the line directly above [send-image:/path]. A titled batch is packed into ONE card, each image under its own title.",
    "Reminders: only explicit reminder/schedule requests; cron.add one of `in`/`at`/`cron`, no `chatId`/`userId`; `at` ISO timezone. Recurring/window = exactly ONE standard 5-field `cron` (no seconds/year), e.g. `*/15 13-14 * * *` (fires separately each time); do NOT add one-shot `in`/`at` for the current minute or end boundary. Manage cron.list/cron.remove/cron.toggle; list first if ambiguous; let bridge confirm.",
    "Web/current facts: if URL(s) are provided, read them directly with `web_extract` or browser first; if blocked (anti-bot/Cloudflare) or the page is dynamic, fall back to Scrapling (`scrapling extract`); use `web_search` for discovery/current facts when no exact URL or direct read fails, and disclose fallback.",
  ];
  const asr = localAsrAgentInstruction();
  if (asr) {
    lines.push(asr);
  }
  return lines.join("\n");
}
