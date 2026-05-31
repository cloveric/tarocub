// CardKit managed cards: create a card instance (card_id), reference it from a
// message, and update the WHOLE card in place by card_id + a monotonic sequence.
// Unlike im.message.patch (channel.updateCard), CardKit updates land reliably
// even after the user has interacted with the card (form submit / button click),
// where Feishu otherwise reverts an async patch back to the pre-click content.
//
// Every function is defensive: if the channel can't reach CardKit (no rawClient,
// SDK shape mismatch, or an API error), it returns undefined/false so the caller
// can fall back to the existing send/updateCard path — nothing breaks.

/** The slice of the SDK raw client we need for managed cards. */
interface CardKitRawClient {
  cardkit?: {
    v1?: {
      card?: {
        create?: (req: { data: { type: string; data: string } }) => Promise<{ data?: { card_id?: string } }>;
        update?: (req: {
          path: { card_id: string };
          data: { card: { type: string; data: string }; sequence: number; uuid?: string };
        }) => Promise<unknown>;
      };
    };
  };
  im?: {
    v1?: {
      message?: {
        create?: (req: {
          params: { receive_id_type: string };
          data: { receive_id: string; msg_type: string; content: string };
        }) => Promise<{ data?: { message_id?: string } }>;
        reply?: (req: {
          path: { message_id: string };
          data: { content: string; msg_type: string; reply_in_thread?: boolean };
        }) => Promise<{ data?: { message_id?: string } }>;
      };
    };
  };
}

/** A live managed card: the message that carries it, the card instance, and the
 * next update sequence. Pass the same handle to every updateManagedCard call. */
export interface ManagedCardHandle {
  messageId: string;
  cardId: string;
  sequence: number;
  /** Internal: serializes update delivery per card. Set by updateManagedCard;
   * callers should not touch it. */
  updateChain?: Promise<void>;
}

export interface ManagedCardSendOptions {
  replyTo?: string;
  replyInThread?: boolean;
}

function cardKitRawClient(channel: unknown): CardKitRawClient | undefined {
  const raw = (channel as { rawClient?: CardKitRawClient } | undefined)?.rawClient;
  return raw && typeof raw === "object" ? raw : undefined;
}

/**
 * Create a CardKit card instance from `cardSpec`, send a message referencing it,
 * and return a handle for in-place updates. Returns undefined if CardKit is
 * unavailable or any step fails — the caller should then fall back to a normal
 * card send + channel.updateCard.
 */
export async function sendManagedCard(
  channel: unknown,
  chatId: string,
  cardSpec: object,
  options: ManagedCardSendOptions = {},
): Promise<ManagedCardHandle | undefined> {
  const raw = cardKitRawClient(channel);
  const create = raw?.cardkit?.v1?.card?.create;
  if (!create) {
    return undefined;
  }
  try {
    const created = await create({ data: { type: "card_json", data: JSON.stringify(cardSpec) } });
    const cardId = created?.data?.card_id;
    if (!cardId) {
      return undefined;
    }
    const content = JSON.stringify({ type: "card", data: { card_id: cardId } });
    let messageId: string | undefined;
    if (options.replyTo && raw?.im?.v1?.message?.reply) {
      const replied = await raw.im.v1.message.reply({
        path: { message_id: options.replyTo },
        data: { content, msg_type: "interactive", ...(options.replyInThread ? { reply_in_thread: true } : {}) },
      });
      messageId = replied?.data?.message_id;
    } else if (raw?.im?.v1?.message?.create) {
      const sent = await raw.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "interactive", content },
      });
      messageId = sent?.data?.message_id;
    }
    if (!messageId) {
      return undefined;
    }
    return { messageId, cardId, sequence: 0 };
  } catch {
    return undefined;
  }
}

/**
 * Lark's client locks a just-submitted form / just-tapped card for a short
 * window and reverts ANY async update issued during it — CardKit included — so
 * the card snaps back to its pre-interaction content. Confirmed by the peer
 * feishu-claude-code-bridge (same stack), whose FORM_SETTLE_MS works around it.
 * To make a terminal in-place update stick after an interaction, the cardAction
 * handler must (1) return immediately so the client releases the lock, and (2)
 * wait out this window before updating. ~1s is enough empirically.
 */
export const MANAGED_CARD_SETTLE_MS = 1000;

/**
 * Schedule a terminal in-place update of a just-interacted managed card: returns
 * synchronously (so the caller can return from the cardAction handler and let
 * Lark release the card's post-interaction lock), then after MANAGED_CARD_SETTLE_MS
 * runs updateManagedCard. If the update doesn't land, runs `onFailure` (e.g. post
 * a fresh notice + recall the stale card). See MANAGED_CARD_SETTLE_MS for why.
 */
export function settleThenUpdateManagedCard(
  channel: unknown,
  handle: ManagedCardHandle,
  cardSpec: object,
  onFailure?: () => Promise<void>,
  settleMs: number = MANAGED_CARD_SETTLE_MS,
): void {
  void (async () => {
    if (settleMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, settleMs);
        timer.unref?.();
      });
    }
    const updated = await updateManagedCard(channel, handle, cardSpec);
    if (!updated && onFailure) {
      await onFailure();
    }
  })().catch(() => {
    // Best-effort terminal card update — onFailure itself can reject (e.g. the
    // fallback channel.send fails). Swallow so a transient Lark API hiccup during
    // this detached, fire-and-forget update can't become an unhandled rejection.
  });
}

/**
 * Replace the whole card in place by card_id, bumping the handle's sequence.
 * Returns true on success, false if CardKit is unavailable or the update failed
 * (the caller may then post a fresh card/message as a fallback).
 *
 * NOTE: when the update follows a user interaction on the SAME card (form submit
 * / button tap), call settleThenUpdateManagedCard instead — an immediate update
 * is reverted by the client's post-interaction lock.
 */
export async function updateManagedCard(
  channel: unknown,
  handle: ManagedCardHandle,
  cardSpec: object,
): Promise<boolean> {
  const update = cardKitRawClient(channel)?.cardkit?.v1?.card?.update;
  if (!update) {
    return false;
  }
  // Serialize all updates to this card through a per-handle chain. The run card
  // streams updates via one path (patchChain) while a card-action terminal update
  // can fire from another (settleThenUpdateManagedCard) on the SAME handle. Without
  // serialization their network calls can land out of order — a higher sequence
  // arriving before a lower one makes Lark reject the lower update (sequence must
  // increase), and a late lower-sequence update can revert the card. Allocating the
  // sequence AND awaiting delivery inside the chain keeps both in order, so the
  // last-intended state always wins.
  const deliver = async (): Promise<boolean> => {
    // Advance the sequence on every attempt, not only on success. A card that
    // streams many updates (the run card) retries a rejected full render with a
    // compact one; reusing the same sequence/uuid could be deduped or rejected
    // server-side. Feishu only requires the sequence to increase — gaps are fine.
    const sequence = (handle.sequence += 1);
    try {
      await update({
        path: { card_id: handle.cardId },
        data: {
          card: { type: "card_json", data: JSON.stringify(cardSpec) },
          sequence,
          uuid: `c_${handle.cardId}_${sequence}`,
        },
      });
      return true;
    } catch {
      return false;
    }
  };
  const prior = handle.updateChain ?? Promise.resolve();
  let result = false;
  const next = prior.then(async () => {
    result = await deliver();
  });
  // Keep the chain alive even if a link rejects so one failure can't wedge every
  // later update to the card. deliver() already swallows its own errors, so this
  // is belt-and-suspenders.
  handle.updateChain = next.catch(() => {});
  await next;
  return result;
}
