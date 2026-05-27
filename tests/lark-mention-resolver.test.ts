import { describe, expect, it, vi } from "vitest";

import { resolveLarkMentionsInText } from "../src/lark/mention-resolver.js";

describe("Lark mention resolver", () => {
  it("does nothing when mention resolution is disabled", async () => {
    const channel = {
      rawClient: {
        im: {
          v1: {
            chatMembers: {
              get: vi.fn(),
            },
          },
        },
      },
    };

    await expect(resolveLarkMentionsInText({
      enabled: false,
      channel,
      chatId: "oc_chat",
      text: "@张三 看一下",
    })).resolves.toBe("@张三 看一下");
    expect(channel.rawClient.im.v1.chatMembers.get).not.toHaveBeenCalled();
  });

  it("resolves longest matching chat member names to native text at tags", async () => {
    const get = vi.fn(async () => ({
      data: {
        items: [
          { name: "张三", member_id: "ou_zhangsan" },
          { name: "张三丰", member_id: "ou_zhangsanfeng" },
          { name: "李四", member_id: "ou_lisi" },
        ],
        has_more: false,
      },
    }));
    const channel = {
      rawClient: {
        im: {
          v1: {
            chatMembers: { get },
          },
        },
      },
    };

    const resolved = await resolveLarkMentionsInText({
      enabled: true,
      channel,
      chatId: "oc_chat",
      text: "@张三丰 和 @李四 处理，@王五 旁观",
    });

    expect(resolved).toBe('<at user_id="ou_zhangsanfeng">张三丰</at> 和 <at user_id="ou_lisi">李四</at> 处理，@王五 旁观');
    expect(get).toHaveBeenCalledWith({
      path: { chat_id: "oc_chat" },
      params: { member_id_type: "open_id", page_size: 100 },
    });
  });

  it("leaves ambiguous duplicate member names unresolved", async () => {
    const channel = {
      rawClient: {
        im: {
          v1: {
            chatMembers: {
              get: vi.fn(async () => ({
                data: {
                  items: [
                    { name: "张三", member_id: "ou_a" },
                    { name: "张三", member_id: "ou_b" },
                  ],
                  has_more: false,
                },
              })),
            },
          },
        },
      },
    };

    await expect(resolveLarkMentionsInText({
      enabled: true,
      channel,
      chatId: "oc_ambiguous",
      text: "@张三 看一下",
    })).resolves.toBe("@张三 看一下");
  });

  it("leaves text untouched when member lookup fails", async () => {
    const get = vi.fn(async () => {
      throw new Error("missing im:chat.members:read");
    });
    const channel = {
      rawClient: {
        im: {
          v1: {
            chatMembers: { get },
          },
        },
      },
    };

    await expect(resolveLarkMentionsInText({
      enabled: true,
      channel,
      chatId: "oc_no_scope",
      text: "@张三 看一下",
    })).resolves.toBe("@张三 看一下");
    expect(get).toHaveBeenCalledOnce();
  });
});
