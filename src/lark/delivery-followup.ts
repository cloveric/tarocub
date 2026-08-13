import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { isCredentialStylePath } from "../runtime/credential-files.js";

import { extractDeliveryTagMatches } from "../telegram/delivery-tags.js";
import {
  extractTelegramToolTagMatches,
  parseTelegramToolTagPayload,
} from "../telegram/tool-tags.js";

const DELIVERY_FOLLOWUP_MAX_CHARS = 160;

/**
 * A short user turn that checks or disputes a prior file/image delivery. Keep
 * this deliberately narrow: ordinary discussions that quote delivery wording
 * must not trigger an extra engine turn.
 */
export function isLarkDeliveryFollowupRequest(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > DELIVERY_FOLLOWUP_MAX_CHARS) {
    return false;
  }

  return DELIVERY_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(normalized));
}

// Kept STRICTLY whole-message (every pattern is anchored). An unanchored
// "没收到|没看到" matched any sentence containing those words — "我没看到
// config.json 里有这个字段" then triggered the guard, suppressed the streamed
// answer, and could replace a correct reply with a blocked-claim notice.
// Widening happens only inside the anchors: which NOUNS count as an artifact,
// and which modifiers may sit next to them.
const DELIVERY_NOUN = "(?:图片|图|照片|截图|文件|附件|结果|报告|文档|资料|表格|压缩包|视频|音频|录音|它|它们"
  + "|\\S*\\.(?:docx?|xlsx?|pptx?|pdf|png|jpe?g|gif|webp|zip|csv|md|txt|mp4|mp3|m4a|wav)"
  + "|docx?|xlsx?|pptx?|pdf|png|jpe?g|zip|csv)";
const DELIVERY_MODIFIER = "(?:那个|这个|那份|这份|那张|这张|刚才|刚刚|之前|上面|新|你(?:刚)?(?:发|发来|发过来)|我要的|说的)的? ?";
const NEGATION = "(?:还)?(?:没|没有|未)(?:收到|看到|看见)";
const SUBJECT = "(?:我(?:这边)?|这边|咱们)?";
const TAIL = "(?:了|啊|呀|呢|吧)?[？?!！。.]?";

const DELIVERY_FOLLOWUP_PATTERNS: RegExp[] = [
  // Bare status questions: 好了吗 / 图呢 / 再发一次
  /^(?:好了吗|好了没|完成了吗|完成了没|发了吗|发了没|发出来了吗|发出来没|图片呢|图呢|文件呢|附件呢|结果呢|再发(?:一次|一遍|一下)?|重新发(?:一次|一遍|一下)?)[？?!！。.]?$/u,
  // Negation first: (怎么)(我)没收到(那个)(文件) — noun optional, so "我没有收到" still matches.
  new RegExp(`^(?:怎么|为什么|为啥)?${SUBJECT}${NEGATION}(?:${DELIVERY_MODIFIER})*(?:${DELIVERY_NOUN})?${TAIL}$`, "u"),
  // Noun first: (刚才的)(图)(我)没收到 — the other common word order.
  new RegExp(`^(?:怎么|为什么|为啥)?(?:${DELIVERY_MODIFIER})*${DELIVERY_NOUN}${SUBJECT}${NEGATION}${TAIL}$`, "u"),
  // Noun + explicit complaint: 图片在哪 / 文件没发
  new RegExp(`^(?:${DELIVERY_MODIFIER})*${DELIVERY_NOUN}.{0,6}(?:在哪|在哪里|没发|没发出来|没收到|没看到|没看见)${TAIL}$`, "u"),
  // English parity with the Chinese patterns: same artifact nouns, same
  // optional modifiers. Still whole-message anchored, so "i did not see the
  // error in the log" stays out.
  /^(?:is it done|done yet|sent yet|any luck)[?!.]?$/i,
  /^(?:did|didn't) you (?:send|upload|share) (?:it|them|the )?(?:file|files|image|images|photo|photos|attachment|attachments|report|doc|document|documents)?[?!.]?$/i,
  /^where (?:is|are) (?:the |my |that |those )?(?:file|files|image|images|photo|photos|attachment|attachments|report|doc|document|documents)[?!.]?$/i,
  /^(?:i |we )?(?:did not|didn't|haven't|have not|never) (?:receive|receive[d]?|see|seen|get|got) (?:it|them|any of them|the |that |those |your )?(?:file|files|image|images|photo|photos|attachment|attachments|report|doc|document|documents)?[?!.]?$/i,
  /^(?:the |that )?(?:file|files|image|images|attachment|attachments|report)\s+(?:never (?:arrived|came)|(?:did not|didn't) (?:arrive|come|show up)|(?:is|are) missing)[?!.]?$/i,
];

export function larkDeliveryFollowupInstruction(text: string): string | undefined {
  if (!isLarkDeliveryFollowupRequest(text)) {
    return undefined;
  }
  return "Delivery follow-up for THIS turn: verify platform delivery, not session memory. Never say prior files/images were sent and never tell the user to scroll up unless this response itself repeats every intended artifact using exact [send-image:/absolute/path], [send-file:/absolute/path], or send.* tags after checking each path exists. If work is unfinished or files are missing, state the exact status instead.";
}

function hasCurrentTurnDeliveryDirective(text: string, workspaceRoot?: string): boolean {
  // The instruction handed to the engine says to verify each path EXISTS before
  // claiming delivery. Only checking that a tag is present let an invented path
  // satisfy the guard: the claim passed, the send then failed downstream, and
  // the operator got a delivery error instead of the file. Hold the guard to
  // the promise it makes.
  // EVERY artifact named must be deliverable. Accepting a response because ONE
  // of several paths exists cleared claims that then half-failed, which is the
  // same "you said you sent it" complaint from the user's side.
  const tagged = extractDeliveryTagMatches(text);
  if (tagged.length > 0 && tagged.every((match) => pathExistsForDelivery(match.path, workspaceRoot))) {
    return true;
  }
  if (isWholeResponseFileBlock(text)) {
    // A fenced file: block is uploaded ONLY when it is the entire response —
    // surrounded by prose the sender treats it as an example and posts plain
    // markdown, so accepting it anywhere cleared claims that delivered nothing.
    return true;
  }
  for (const match of extractTelegramToolTagMatches(text)) {
    try {
      const { name, payload } = parseTelegramToolTagPayload(match.payload);
      if (!["send.file", "send.image", "send.audio", "send.video", "send.batch"].includes(name)) {
        continue;
      }
      // A send.* tag with no resolvable path delivers nothing; the tool name
      // alone used to satisfy the guard.
      const paths = structuredSendPaths(name, payload);
      if (paths && paths.every((candidate) => pathExistsForDelivery(candidate, workspaceRoot))) {
        return true;
      }
    } catch {
      // Malformed tags are handled by normal delivery; they are not evidence.
    }
  }
  return false;
}

/** The sender's rule: a fenced file: block uploads only when it IS the reply. */
function isWholeResponseFileBlock(text: string): boolean {
  const match = text.match(/```file:([^\n`]+)\n([\s\S]*?)```/u);
  if (!match?.[1]?.trim() || !(match[2] ?? "").trim()) {
    return false;
  }
  return text.replace(match[0], "").trim().length === 0;
}

/** True when a tagged path points at something the delivery layer can send. */
/**
 * Whether the send layer could actually deliver this path. Mirrors the checks
 * the sender performs — regular file, not a credential file, inside the
 * workspace after symlink resolution — so the guard never clears a claim that
 * is certain to fail downstream. It stays deliberately CONSERVATIVE: when the
 * workspace root is unknown, an outside path is rejected rather than assumed
 * fine, because the sender's default is to refuse it.
 */
function pathExistsForDelivery(rawPath: string | undefined, workspaceRoot?: string): boolean {
  const candidate = (rawPath ?? "").trim();
  if (!candidate) {
    return false;
  }
  let real: string;
  try {
    // realpath first: the sender resolves symlinks before its sandbox check,
    // so a link pointing outside the workspace must not pass here either.
    real = realpathSync(candidate);
    if (!statSync(real).isFile()) {
      return false;
    }
  } catch {
    // Missing or unreadable is not evidence of delivery either.
    return false;
  }
  if (isCredentialStylePath(candidate, real)) {
    return false;
  }
  if (!workspaceRoot) {
    // Without a known root the sender still sandboxes to the instance
    // workspace; treating an arbitrary path as deliverable would clear claims
    // that cannot deliver. Only a path under the process CWD-independent
    // temp-free heuristic is impossible to verify, so refuse.
    return false;
  }
  let root: string;
  try {
    root = realpathSync(workspaceRoot);
  } catch {
    root = path.resolve(workspaceRoot);
  }
  return real === root || real.startsWith(`${root}${path.sep}`);
}

/**
 * Paths a structured send.* tool tag would ACTUALLY deliver, using the same
 * shape the send tool itself parses: single-path tools read `path`, and
 * send.batch reads `images[]` and `files[]`. An earlier version invented
 * `items`/`paths` keys the sender never reads (so an invalid batch passed
 * review) while missing nothing it does read — maintaining a second protocol
 * is exactly how the guard and the sender drift apart.
 */
function structuredSendPaths(name: string, payload: unknown): string[] | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const asPath = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  if (name === "send.batch") {
    const collected: string[] = [];
    for (const key of ["images", "files"]) {
      const value = record[key];
      if (value === undefined) continue;
      if (!Array.isArray(value)) return null; // the sender throws on this
      for (const entry of value) {
        const resolved = asPath(entry);
        if (!resolved) return null;
        collected.push(resolved);
      }
    }
    // A batch with only a message delivers no artifact — not proof of a file.
    return collected.length > 0 ? collected : null;
  }

  const single = asPath(record.path);
  return single ? [single] : null;
}

function claimsHistoricalDelivery(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return false;
  }

  // Explicit failures/statuses are honest outcomes, not false confirmations.
  if (/(?:未|没有|没|尚未|还没|无法|不能)(?:成功)?(?:发|发送|上传|交付)|(?:发送|上传|交付).{0,6}(?:失败|未完成)|(?:文件|图片|路径).{0,8}(?:不存在|找不到|缺失)|(?:仍在|还在|正在).{0,8}(?:生成|处理|上传|发送)/u.test(normalized)
    || /\b(?:not sent|wasn't sent|were not sent|haven't sent|have not sent|failed to (?:send|upload)|still (?:working|generating|uploading)|cannot (?:send|find)|can't (?:send|find))\b/i.test(normalized)) {
    return false;
  }

  return /(?:已|已经|刚|刚刚|之前).{0,12}(?:发|发送|上传|交付)|(?:发|发送|上传|交付).{0,10}(?:了|过|上面|前面)|往上翻|上面.{0,10}(?:能看到|可以看到|有)|前面.{0,10}(?:能看到|可以看到|有)/u.test(normalized)
    || /\b(?:already|just|previously) (?:sent|uploaded|delivered)\b|\b(?:sent|uploaded|delivered) (?:it|them|the files?|the images?)?\s*(?:already|above|earlier)\b|\bscroll up\b/i.test(normalized);
}

export function shouldRepairLarkDeliveryFollowup(
  requestText: string,
  responseText: string,
  workspaceRoot?: string,
): boolean {
  return isLarkDeliveryFollowupRequest(requestText)
    && claimsHistoricalDelivery(responseText)
    && !hasCurrentTurnDeliveryDirective(responseText, workspaceRoot);
}

export function larkDeliveryFollowupRepairPrompt(): string {
  return "Delivery verification retry: your previous answer claimed that prior files/images were already sent, but this current response contained no executable delivery tags. Do not repeat that claim or tell the user to scroll up. Locate and verify the intended artifacts now, then respond with every exact [send-image:/absolute/path], [send-file:/absolute/path], or send.* tag in THIS response. If any artifact is unfinished or missing, state that exact status instead.";
}

export function renderUnverifiedLarkDeliveryClaim(locale: "en" | "zh"): string {
  return locale === "zh"
    ? "交付未确认：引擎声称文件或图片已经发送，但本轮没有提供任何可执行的发送指令，因此该说法已被拦截。请明确要求重新生成或重新发送。"
    : "Delivery was not confirmed: the engine claimed the files or images were sent, but this turn contained no executable delivery directive. The claim was blocked; ask it to regenerate or resend.";
}
