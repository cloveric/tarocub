import { describe, expect, it, vi } from "vitest";

import { registerBotCommands } from "../src/service.js";

describe("registerBotCommands", () => {
  it("exposes engine goals in the Telegram command menu", async () => {
    const setMyCommands = vi.fn().mockResolvedValue(undefined);

    await registerBotCommands({ setMyCommands } as never);

    expect(setMyCommands).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          command: "goal",
          description: expect.stringContaining("engine goal"),
        }),
      ]),
    );
  });
});
