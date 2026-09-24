import path from "node:path";

import {
  extractDeliveryTagMatches,
  extractInvalidDeliveryPseudoTagMatches,
  stripDeliveryTags,
  stripInvalidDeliveryPseudoTags,
} from "../telegram/delivery-tags.js";
import {
  extractTelegramToolTagMatches,
  parseTelegramToolTagPayload,
  stripTelegramToolTags,
} from "../telegram/tool-tags.js";
import {
  extractWholeResponseFileBlock,
  isLarkSendToolName,
  normalizeLarkSendTool,
  preflightLarkDeliveryPath,
  preflightLarkInlineFile,
  resolveLarkDeliveryRoots,
  type LarkFileRejectReason,
  type LarkDeliveryPreflightInput,
  type LarkSendArtifact,
  type LarkSendPathKind,
} from "./delivery-preflight.js";
import { captionForLarkImage } from "./delivery.js";

const DELIVERY_FOLLOWUP_MAX_CHARS = 160;

export interface LarkDeliveryDirectiveIssue {
  path: string;
  kind?: LarkSendPathKind;
  caption?: string;
  reason: Exclude<LarkFileRejectReason, "upload-failed"> | "invalid-directive";
  realPath?: string;
  workspaceRoot?: string;
}

export interface LarkDeliveryDirectivePreflight {
  sawDirective: boolean;
  artifactCount: number;
  issues: LarkDeliveryDirectiveIssue[];
  acceptedArtifacts: LarkSendArtifact[];
  deliveryMessages: string[];
}

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
  // Direct artifact requests: 图给我看看 / 把文件发我 / 给我看看图片.
  // These are delivery follow-ups even without an explicit "没收到" phrase.
  new RegExp(`^(?:把|将)?(?:${DELIVERY_MODIFIER})*${DELIVERY_NOUN}(?:给我|让我)(?:看(?:看|一下)?|瞧瞧)${TAIL}$`, "u"),
  new RegExp(`^(?:把|将)?(?:${DELIVERY_MODIFIER})*${DELIVERY_NOUN}(?:发|传)(?:给)?我(?:看(?:看|一下)?|瞧瞧)?${TAIL}$`, "u"),
  new RegExp(`^(?:给我|让我)(?:看(?:看|一下)?|瞧瞧)(?:${DELIVERY_MODIFIER})*${DELIVERY_NOUN}${TAIL}$`, "u"),
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

export async function preflightLarkResponseDeliveryDirectives(
  text: string,
  context?: string | LarkDeliveryPreflightInput,
): Promise<LarkDeliveryDirectivePreflight> {
  const wholeFileBlock = extractWholeResponseFileBlock(text);
  if (wholeFileBlock) {
    const inlinePreflight = preflightLarkInlineFile(wholeFileBlock);
    return {
      sawDirective: true,
      artifactCount: 1,
      acceptedArtifacts: [],
      deliveryMessages: [],
      issues: inlinePreflight.ok
        ? []
        : [{
            path: wholeFileBlock.fileName,
            kind: "file",
            reason: inlinePreflight.reason,
          }],
    };
  }

  // Collect every artifact across BOTH legacy and structured syntax before
  // deciding. Returning after the first valid group let a good file conceal a
  // second missing file in another tag family.
  const artifacts: LarkSendArtifact[] = extractDeliveryTagMatches(text).map((match) => {
    const caption = match.preferPhoto ? captionForLarkImage(text, match.index) : undefined;
    return {
      path: match.path,
      kind: match.preferPhoto ? "image" as const : "file" as const,
      ...(caption ? { caption } : {}),
    };
  });
  const issues: LarkDeliveryDirectiveIssue[] = [];
  const deliveryMessages: string[] = [];
  let sawDeliveryDirective = artifacts.length > 0;

  for (const match of extractInvalidDeliveryPseudoTagMatches(text)) {
    sawDeliveryDirective = true;
    issues.push({ path: match.tag, reason: "invalid-directive" });
  }

  for (const match of extractTelegramToolTagMatches(text)) {
    try {
      const { name, payload } = parseTelegramToolTagPayload(match.payload);
      if (!isLarkSendToolName(name)) {
        continue;
      }
      sawDeliveryDirective = true;
      const normalized = normalizeLarkSendTool(name, payload);
      if (!normalized.ok || (normalized.artifacts.length === 0 && !normalized.message.trim())) {
        issues.push({ path: name, reason: "invalid-directive" });
        continue;
      }
      if (normalized.message.trim()) {
        deliveryMessages.push(normalized.message.trim());
      }
      artifacts.push(...normalized.artifacts.map((artifact) => ({
        path: artifact.path,
        kind: artifact.kind,
        ...(artifact.caption ? { caption: artifact.caption } : {}),
      })));
    } catch {
      // The real sender emits a parse error for malformed tool JSON. If it was
      // intended as a send tool, it cannot prove delivery even when another tag
      // in the same response is valid.
      if (/send\.(?:file|image|audio|video|batch)/u.test(match.payload)) {
        sawDeliveryDirective = true;
        issues.push({ path: "send.*", reason: "invalid-directive" });
      }
    }
  }

  if (artifacts.length === 0) {
    return {
      sawDirective: sawDeliveryDirective,
      artifactCount: 0,
      issues,
      acceptedArtifacts: [],
      deliveryMessages,
    };
  }

  const preflightInput: LarkDeliveryPreflightInput = typeof context === "string"
    ? { explicitAllowedRoots: [context] }
    : context ?? {};
  const roots = await resolveLarkDeliveryRoots(preflightInput);
  const acceptedArtifacts: LarkSendArtifact[] = [];
  for (const artifact of artifacts) {
    const checked = await preflightLarkDeliveryPath(artifact.path, roots);
    if (!checked.ok) {
      issues.push({
        path: artifact.path,
        kind: artifact.kind,
        ...(artifact.caption ? { caption: artifact.caption } : {}),
        reason: checked.reason,
        ...(checked.realPath ? { realPath: checked.realPath } : {}),
        ...(checked.workspaceRoot ? { workspaceRoot: checked.workspaceRoot } : {}),
      });
      continue;
    }
    acceptedArtifacts.push(artifact);
  }
  return {
    sawDirective: sawDeliveryDirective,
    artifactCount: artifacts.length,
    issues,
    acceptedArtifacts,
    deliveryMessages,
  };
}

/**
 * Preserve the first answer while a second turn repairs only rejected
 * artifacts. Send directives are rebuilt from paths that already passed the
 * exact sender preflight; non-delivery tools remain untouched.
 */
export function buildLarkDeliveryRepairBase(
  text: string,
  preflight: LarkDeliveryDirectivePreflight,
): string {
  const sendToolMatches = extractTelegramToolTagMatches(text).filter((match) => {
    try {
      return isLarkSendToolName(parseTelegramToolTagPayload(match.payload).name);
    } catch {
      return /send\.(?:file|image|audio|video|batch)/u.test(match.payload);
    }
  });
  const strippedText = stripInvalidDeliveryPseudoTags(
    stripDeliveryTags(stripTelegramToolTags(text, sendToolMatches)),
  );
  const preservedText = preflight.issues.length > 0
    ? stripUnverifiedDeliveryClaimLines(strippedText)
    : strippedText;
  return preservedText.trim();
}

export function renderLarkMergedDeliveryRepairDirectives(
  initial: LarkDeliveryDirectivePreflight,
  repaired: LarkDeliveryDirectivePreflight,
): string {
  const pendingIssues = [...initial.issues];
  const replacements = repaired.acceptedArtifacts.map((artifact) => {
    const issueIndex = pendingIssues.findIndex((issue) => issue.kind === artifact.kind);
    const issue = issueIndex >= 0 ? pendingIssues.splice(issueIndex, 1)[0] : undefined;
    return !artifact.caption && issue?.caption
      ? { ...artifact, caption: issue.caption }
      : artifact;
  });
  return renderLarkAcceptedDeliveryDirectives({
    sawDirective: true,
    artifactCount: initial.acceptedArtifacts.length + replacements.length,
    issues: [],
    acceptedArtifacts: [...initial.acceptedArtifacts, ...replacements],
    deliveryMessages: [],
  }, { includeMessages: false });
}

export function renderLarkAcceptedDeliveryDirectives(
  preflight: LarkDeliveryDirectivePreflight,
  options: { includeMessages?: boolean } = {},
): string {
  const artifacts = dedupeArtifacts(preflight.acceptedArtifacts);
  const messages = options.includeMessages === false
    ? []
    : [...new Set(preflight.deliveryMessages.map((message) => message.trim()).filter(Boolean))];
  if (artifacts.length === 0) {
    return messages.join("\n\n");
  }

  const payload: Record<string, unknown> = {};
  const entries = (kind: LarkSendPathKind): LarkSendArtifact[] =>
    artifacts.filter((artifact) => artifact.kind === kind);
  const withCaptions = (items: LarkSendArtifact[]): Array<string | { path: string; caption: string }> =>
    items.map((artifact) => artifact.caption
      ? { path: artifact.path, caption: artifact.caption }
      : artifact.path);

  const images = withCaptions(entries("image"));
  const files = withCaptions(entries("file"));
  const audios = entries("audio").map((artifact) => artifact.path);
  const videos = entries("video").map((artifact) => artifact.path);
  if (images.length > 0) payload.images = images;
  if (files.length > 0) payload.files = files;
  if (audios.length > 0) payload.audios = audios;
  if (videos.length > 0) payload.videos = videos;
  if (messages.length > 0) payload.message = messages.join("\n\n");
  return `\`\`\`tool-call\n${JSON.stringify({ name: "send.batch", payload })}\n\`\`\``;
}

function stripUnverifiedDeliveryClaimLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^(?:done|completed|ready|好了|完成了|已完成)[.!。！]?$/iu.test(trimmed)) return false;
      return !claimsHistoricalDelivery(trimmed);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function dedupeArtifacts(artifacts: readonly LarkSendArtifact[]): LarkSendArtifact[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.kind}\u0000${artifact.path}\u0000${artifact.caption ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function hasCurrentTurnDeliveryDirective(
  text: string,
  context?: string | LarkDeliveryPreflightInput,
): Promise<boolean> {
  const preflight = await preflightLarkResponseDeliveryDirectives(text, context);
  return preflight.sawDirective && preflight.artifactCount > 0 && preflight.issues.length === 0;
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

  // Keep aspect markers in the same clause as the delivery verb. Crossing a
  // full stop turned a future promise such as "通过后发你。好了我主动发" into
  // a past claim, while "发过来" uses 过 as a direction complement, not past
  // tense. `发(?!送)` prevents backtracking into the first character of 发送.
  return /(?:已|已经|刚|刚刚|之前)[^，。；！？!?\n]{0,12}(?:发送|上传|交付|发(?!送))|(?:发送|上传|交付|发(?!送))(?!过[来去])[^，。；！？!?\n]{0,10}(?:了|过(?![来去])|上面|前面)|往上翻|上面.{0,10}(?:能看到|可以看到|有)|前面.{0,10}(?:能看到|可以看到|有)/u.test(normalized)
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

export function larkDeliveryPreflightRepairPrompt(
  preflight: LarkDeliveryDirectivePreflight,
): string {
  const issues = preflight.issues.slice(0, 20);
  const workspaceRoot = issues.find((issue) => issue.workspaceRoot)?.workspaceRoot;
  const rejected = issues
    .map((issue) => `- ${JSON.stringify(issue.path)} (${issue.reason})`)
    .join("\n");
  return [
    "Delivery preflight retry: your previous response referenced artifact paths that cannot be delivered.",
    rejected ? `Rejected artifacts:\n${rejected}` : "No executable artifact directive was found.",
    workspaceRoot ? `Allowed workspace: ${JSON.stringify(workspaceRoot)}` : undefined,
    "Repair ONLY the rejected artifacts: copy each non-secret existing artifact into the allowed workspace, verify it exists and is non-empty, then return only the corrected [send-image:/absolute/path], [send-file:/absolute/path], or send.* tags.",
    "Do not repeat the previous prose, valid sibling artifacts, or non-delivery tool actions; the bridge preserves them. Never copy credentials or secret files. If an artifact cannot be repaired safely, state that exact failure instead of claiming it was sent.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function renderLarkDeliveryPreflightFailure(
  locale: "en" | "zh",
  preflight: LarkDeliveryDirectivePreflight,
  originalPreflight?: LarkDeliveryDirectivePreflight,
): string {
  const issue = preflight.issues[0] ?? originalPreflight?.issues[0];
  if (!issue) {
    return locale === "zh"
      ? "交付失败：自动修复没有生成可执行的文件或图片发送指令。请重新生成后再试。"
      : "Delivery failed: the automatic repair did not produce an executable file or image directive. Regenerate the artifact and try again.";
  }
  const fileName = path.basename(issue.path) || issue.path;
  if (issue.reason === "outside-workspace") {
    const workspace = issue.workspaceRoot
      ? (locale === "zh" ? `允许发送目录：${issue.workspaceRoot}。` : `Allowed workspace: ${issue.workspaceRoot}.`)
      : "";
    return locale === "zh"
      ? `交付失败：${fileName} 仍不在允许发送的目录内，自动修复没有成功。${workspace}`
      : `Delivery failed: ${fileName} is still outside the allowed workspace and automatic repair did not succeed. ${workspace}`.trim();
  }
  return locale === "zh"
    ? `交付失败：${fileName} 仍未通过发送前检查（${issue.reason}），自动修复没有成功。`
    : `Delivery failed: ${fileName} still failed preflight (${issue.reason}) after automatic repair.`;
}

export function renderUnverifiedLarkDeliveryClaim(locale: "en" | "zh"): string {
  return locale === "zh"
    ? "交付未确认：引擎声称文件或图片已经发送，但本轮没有提供任何可执行的发送指令，因此该说法已被拦截。请明确要求重新生成或重新发送。"
    : "Delivery was not confirmed: the engine claimed the files or images were sent, but this turn contained no executable delivery directive. The claim was blocked; ask it to regenerate or resend.";
}
