import { extractDeliveryTagMatches } from "../telegram/delivery-tags.js";
import { extractTelegramToolTagMatches } from "../telegram/tool-tags.js";
import {
  deliveryLedgerEnabled,
  readDeliveryObligations,
} from "../state/delivery-obligation-store.js";

const STALE_RESPONSE_MIN_CHARS = 10;
const STALE_RESPONSE_MAX_CHARS = 160;
const RECENT_DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60_000;

function normalizeComparableResponse(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[，,。.!！?？:：;；、…]+$/gu, "")
    .toLocaleLowerCase();
}

function hasDeliveryDirective(text: string): boolean {
  return (
    extractDeliveryTagMatches(text).length > 0
    || extractTelegramToolTagMatches(text).length > 0
    || /```file:[^\n`]+\n[\s\S]*?```/u.test(text)
  );
}

export function isTruncatedPreviousLarkResponse(currentText: string, previousText: string): boolean {
  const current = normalizeComparableResponse(currentText);
  const previous = normalizeComparableResponse(previousText);
  if (
    current.length < STALE_RESPONSE_MIN_CHARS
    || current.length > STALE_RESPONSE_MAX_CHARS
    || previous.length < current.length + Math.max(24, Math.ceil(current.length / 2))
    || !previous.startsWith(current)
  ) {
    return false;
  }

  // A real truncation ends at a sentence boundary in the old answer. Requiring
  // that boundary avoids treating an ordinary shared phrase as a stale reply.
  const boundary = previous.slice(current.length, current.length + 1);
  return /^[\s，,。.!！?？:：;；、…\-–—]/u.test(boundary);
}

export async function shouldRetryLarkStaleResponse(input: {
  stateDir: string;
  conversationKey: string;
  replyTo: string;
  responseText: string;
  sawToolActivity: boolean;
}): Promise<boolean> {
  if (!deliveryLedgerEnabled() || !input.sawToolActivity || hasDeliveryDirective(input.responseText)) {
    return false;
  }

  const now = Date.now();
  const rows = await readDeliveryObligations(input.stateDir);
  return rows
    .filter((row) => (
      row.channel === "lark"
      && row.state === "delivered"
      && row.conversationKey === input.conversationKey
      && row.replyTo !== input.replyTo
      && row.updatedAt >= now - RECENT_DELIVERY_WINDOW_MS
    ))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20)
    .some((row) => isTruncatedPreviousLarkResponse(input.responseText, row.content));
}
