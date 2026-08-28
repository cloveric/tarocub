import { describe, expect, it, vi } from "vitest";

import { registerBotCommands } from "../src/service.js";

describe("registerBotCommands", () => {
  it("exposes current engine capabilities in the Telegram command menu", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerBotCommands({ setMyCommands } as never);

    expect(setMyCommands).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          command: "goal",
          description: expect.stringContaining("engine goal"),
        }),
        expect.objectContaining({
          command: "compact",
          description: expect.stringContaining("DeepSeek"),
        }),
        expect.objectContaining({
          command: "context",
          description: expect.stringContaining("DeepSeek"),
        }),
        expect.objectContaining({
          command: "resume",
          description: expect.stringContaining("DeepSeek"),
        }),
      ]),
    );
  });
});
