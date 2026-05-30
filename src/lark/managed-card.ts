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
 * Replace the whole card in place by card_id, bumping the handle's sequence.
 * Returns true on success, false if CardKit is unavailable or the update failed
 * (the caller may then post a fresh card/message as a fallback).
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
}
