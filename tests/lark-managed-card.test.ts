import { describe, expect, it, vi } from "vitest";

import { sendManagedCard, settleThenUpdateManagedCard, updateManagedCard, type ManagedCardHandle } from "../src/lark/managed-card.js";

function fakeCardKitChannel(overrides: Record<string, unknown> = {}) {
  const create = vi.fn(async () => ({ data: { card_id: "card_abc" } }));
  const update = vi.fn(async () => ({ data: {} }));
  const messageCreate = vi.fn(async () => ({ data: { message_id: "om_new" } }));
  const messageReply = vi.fn(async () => ({ data: { message_id: "om_reply" } }));
  const channel = {
    rawClient: {
      cardkit: { v1: { card: { create, update } } },
      im: { v1: { message: { create: messageCreate, reply: messageReply } } },
    },
    ...overrides,
  };
  return { channel, create, update, messageCreate, messageReply };
}

describe("lark managed card (CardKit)", () => {
  it("creates a card instance and sends it by reference", async () => {
    const { channel, create, messageCreate } = fakeCardKitChannel();
    const handle = await sendManagedCard(channel, "oc_chat", { schema: "2.0", body: {} });

    expect(create).toHaveBeenCalledWith({ data: { type: "card_json", data: expect.stringContaining("2.0") } });
    expect(messageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: "oc_chat", msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: "card_abc" } }) },
    });
    expect(handle).toEqual({ messageId: "om_new", cardId: "card_abc", sequence: 0 });
  });

  it("replies in-thread when replyTo is given", async () => {
    const { channel, messageReply, messageCreate } = fakeCardKitChannel();
    const handle = await sendManagedCard(channel, "oc_chat", { schema: "2.0" }, { replyTo: "om_src", replyInThread: true });

    expect(messageReply).toHaveBeenCalledWith({
      path: { message_id: "om_src" },
      data: { content: expect.stringContaining("card_abc"), msg_type: "interactive", reply_in_thread: true },
    });
    expect(messageCreate).not.toHaveBeenCalled();
    expect(handle?.messageId).toBe("om_reply");
  });

  it("updates the whole card in place with a monotonically increasing sequence", async () => {
    const { channel, update } = fakeCardKitChannel();
    const handle: ManagedCardHandle = { messageId: "om_new", cardId: "card_abc", sequence: 0 };

    expect(await updateManagedCard(channel, handle, { schema: "2.0", v: 1 })).toBe(true);
    expect(handle.sequence).toBe(1);
    expect(await updateManagedCard(channel, handle, { schema: "2.0", v: 2 })).toBe(true);
    expect(handle.sequence).toBe(2);

    expect(update).toHaveBeenLastCalledWith({
      path: { card_id: "card_abc" },
      data: { card: { type: "card_json", data: expect.stringContaining("\"v\":2") }, sequence: 2, uuid: "c_card_abc_2" },
    });
  });

  it("advances the sequence even when an update attempt fails (no uuid reuse on retry)", async () => {
    const { channel, update } = fakeCardKitChannel();
    update.mockRejectedValueOnce(new Error("card too big")).mockResolvedValueOnce({ data: {} });
    const handle: ManagedCardHandle = { messageId: "om", cardId: "card_x", sequence: 0 };

    expect(await updateManagedCard(channel, handle, { v: "full" })).toBe(false); // rejected
    expect(handle.sequence).toBe(1); // advanced despite the failure
    expect(await updateManagedCard(channel, handle, { v: "compact" })).toBe(true); // retry
    expect(handle.sequence).toBe(2);
    // The retry used a DISTINCT sequence/uuid, so Feishu can't dedupe it against
    // the failed attempt (which is what the run card's full→compact retry needs).
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sequence: 2, uuid: "c_card_x_2" }),
    }));
  });

  it("returns undefined/false (so callers fall back) when CardKit is unavailable", async () => {
    const noRaw = {};
    expect(await sendManagedCard(noRaw, "oc_chat", { schema: "2.0" })).toBeUndefined();
    const handle: ManagedCardHandle = { messageId: "om", cardId: "card", sequence: 5 };
    expect(await updateManagedCard(noRaw, handle, { schema: "2.0" })).toBe(false);
    expect(handle.sequence).toBe(5); // unchanged on failure
  });

  it("returns undefined when the card create or send fails", async () => {
    const { channel, create } = fakeCardKitChannel();
    create.mockRejectedValueOnce(new Error("cardkit down"));
    expect(await sendManagedCard(channel, "oc_chat", { schema: "2.0" })).toBeUndefined();
  });
});

describe("settleThenUpdateManagedCard (post-interaction in-place update)", () => {
  it("returns synchronously, then updates after the settle delay; no failure callback on success", async () => {
    const { channel, update } = fakeCardKitChannel();
    const handle: ManagedCardHandle = { messageId: "om", cardId: "card_s", sequence: 0 };
    const onFailure = vi.fn(async () => undefined);

    // A small settle delay keeps the test fast while still deferring the update:
    // it must NOT have fired by the time this synchronous call returns.
    settleThenUpdateManagedCard(channel, handle, { v: 1 }, onFailure, 50);
    expect(update).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("runs the failure callback when the settled update fails", async () => {
    const { channel, update } = fakeCardKitChannel();
    update.mockRejectedValue(new Error("rejected"));
    const handle: ManagedCardHandle = { messageId: "om", cardId: "card_s", sequence: 0 };
    const onFailure = vi.fn(async () => undefined);

    settleThenUpdateManagedCard(channel, handle, { v: 1 }, onFailure, 0);
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
  });
});
