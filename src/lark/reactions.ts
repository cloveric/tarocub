import type { LarkChannelLike } from "./types.js";

export interface LarkReactionSettings {
  processingEmoji: string | null;
  doneEmoji: string | null;
  failureEmoji: string | null;
}

export interface LarkReactionEnv {
  CCTB_LARK_REACTION_EMOJI?: string;
  LARK_REACTION_EMOJI?: string;
  CCTB_LARK_DONE_EMOJI?: string;
  LARK_DONE_EMOJI?: string;
  CCTB_LARK_FAILURE_EMOJI?: string;
  LARK_FAILURE_EMOJI?: string;
}

export function resolveLarkReactionSettings(env: LarkReactionEnv): LarkReactionSettings {
  return {
    // Off by default: a turn already pops an in-progress run card, so a separate
    // "received/processing" reaction on the user's message is redundant noise. Set
    // CCTB_LARK_REACTION_EMOJI (e.g. "OnIt") to re-enable it. The DONE reaction stays
    // on — it's a useful completion signal (the card is finished).
    processingEmoji: parseEmojiSetting(env.CCTB_LARK_REACTION_EMOJI ?? env.LARK_REACTION_EMOJI, null),
    doneEmoji: parseEmojiSetting(env.CCTB_LARK_DONE_EMOJI ?? env.LARK_DONE_EMOJI, "DONE"),
    failureEmoji: parseEmojiSetting(env.CCTB_LARK_FAILURE_EMOJI ?? env.LARK_FAILURE_EMOJI, "ERROR"),
  };
}

export async function withLarkMessageReactions<T>(input: {
  channel: Pick<LarkChannelLike, "addReaction" | "removeReaction">;
  messageId: string;
  settings: LarkReactionSettings;
  isFailure?: (error: unknown) => boolean;
  run: () => Promise<T>;
}): Promise<T> {
  const reactionId = input.settings.processingEmoji
    ? await addReactionBestEffort(input.channel, input.messageId, input.settings.processingEmoji)
    : null;
  try {
    const result = await input.run();
    if (reactionId) {
      await removeReactionBestEffort(input.channel, input.messageId, reactionId);
    }
    if (input.settings.doneEmoji) {
      await addReactionBestEffort(input.channel, input.messageId, input.settings.doneEmoji);
    }
    return result;
  } catch (error) {
    if (reactionId) {
      await removeReactionBestEffort(input.channel, input.messageId, reactionId);
    }
    if ((input.isFailure?.(error) ?? true) && input.settings.failureEmoji) {
      await addReactionBestEffort(input.channel, input.messageId, input.settings.failureEmoji);
    }
    throw error;
  }
}

async function addReactionBestEffort(
  channel: Pick<LarkChannelLike, "addReaction">,
  messageId: string,
  emojiType: string,
): Promise<string | null> {
  if (!channel.addReaction) {
    return null;
  }
  try {
    return await channel.addReaction(messageId, emojiType);
  } catch {
    return null;
  }
}

async function removeReactionBestEffort(
  channel: Pick<LarkChannelLike, "removeReaction">,
  messageId: string,
  reactionId: string,
): Promise<void> {
  if (!channel.removeReaction) {
    return;
  }
  try {
    await channel.removeReaction(messageId, reactionId);
  } catch {
    // Reactions are a presence signal only; never fail the bridge turn.
  }
}

function parseEmojiSetting(value: string | undefined, fallback: string | null): string | null {
  if (value === undefined) {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed || /^(?:0|false|no|off|none)$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}
