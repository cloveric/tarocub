import { extractDeliveryTagMatches } from "../telegram/delivery-tags.js";
import {
  extractTelegramToolTagMatches,
  parseTelegramToolTagPayload,
} from "../telegram/tool-tags.js";
import {
  extractWholeResponseFileBlock,
  isLarkSendToolName,
  normalizeLarkSendTool,
  preflightLarkDeliveryPath,
  preflightLarkInlineFile,
  resolveLarkDeliveryRoots,
  type LarkDeliveryPreflightInput,
} from "./delivery-preflight.js";

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

async function hasCurrentTurnDeliveryDirective(
  text: string,
  context?: string | LarkDeliveryPreflightInput,
): Promise<boolean> {
  const wholeFileBlock = extractWholeResponseFileBlock(text);
  if (wholeFileBlock) {
    return preflightLarkInlineFile(wholeFileBlock).ok;
  }

  // Collect every artifact across BOTH legacy and structured syntax before
  // deciding. Returning after the first valid group let a good file conceal a
  // second missing file in another tag family.
  const artifactPaths = extractDeliveryTagMatches(text).map((match) => match.path);
  let sawDeliveryDirective = artifactPaths.length > 0;

  for (const match of extractTelegramToolTagMatches(text)) {
    try {
      const { name, payload } = parseTelegramToolTagPayload(match.payload);
      if (!isLarkSendToolName(name)) {
        continue;
      }
      sawDeliveryDirective = true;
      const normalized = normalizeLarkSendTool(name, payload);
      // An invalid send.* payload, or a message-only batch, delivers no artifact.
      if (!normalized.ok || normalized.artifacts.length === 0) {
        return false;
      }
      artifactPaths.push(...normalized.artifacts.map((artifact) => artifact.path));
    } catch {
      // The real sender emits a parse error for malformed tool JSON. If it was
      // intended as a send tool, it cannot prove delivery even when another tag
      // in the same response is valid.
      if (/send\.(?:file|image|audio|video|batch)/u.test(match.payload)) {
        return false;
      }
    }
  }

  if (!sawDeliveryDirective || artifactPaths.length === 0) {
    return false;
  }
  const preflightInput: LarkDeliveryPreflightInput = typeof context === "string"
    ? { explicitAllowedRoots: [context] }
    : context ?? {};
  const roots = await resolveLarkDeliveryRoots(preflightInput);
  for (const artifactPath of artifactPaths) {
    if (!(await preflightLarkDeliveryPath(artifactPath, roots)).ok) {
      return false;
    }
  }
  return true;
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

export async function shouldRepairLarkDeliveryFollowup(
  requestText: string,
  responseText: string,
  context?: string | LarkDeliveryPreflightInput,
): Promise<boolean> {
  if (!isLarkDeliveryFollowupRequest(requestText) || !claimsHistoricalDelivery(responseText)) {
    return false;
  }
  return !(await hasCurrentTurnDeliveryDirective(responseText, context));
}

export function larkDeliveryFollowupRepairPrompt(): string {
  return "Delivery verification retry: your previous answer claimed that prior files/images were already sent, but this current response contained no executable delivery tags. Do not repeat that claim or tell the user to scroll up. Locate and verify the intended artifacts now, then respond with every exact [send-image:/absolute/path], [send-file:/absolute/path], or send.* tag in THIS response. If any artifact is unfinished or missing, state that exact status instead.";
}

export function renderUnverifiedLarkDeliveryClaim(locale: "en" | "zh"): string {
  return locale === "zh"
    ? "交付未确认：引擎声称文件或图片已经发送，但本轮没有提供任何可执行的发送指令，因此该说法已被拦截。请明确要求重新生成或重新发送。"
    : "Delivery was not confirmed: the engine claimed the files or images were sent, but this turn contained no executable delivery directive. The claim was blocked; ask it to regenerate or resend.";
}
