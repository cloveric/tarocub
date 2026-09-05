import { describe, expect, it, vi } from "vitest";

import { consumeUiToken } from "../web/src/ui-token.js";

describe("UI bearer token bootstrap", () => {
  it("stores the token for this tab and removes it from the visible URL", () => {
    const replaceState = vi.fn();
    const setItem = vi.fn();

    const token = consumeUiToken({
      href: "http://127.0.0.1:8123/console?token=top-secret&view=instances#active",
      storage: {
        getItem: vi.fn(() => null),
        setItem,
      },
      history: { state: { page: 1 }, replaceState },
    });

    expect(token).toBe("top-secret");
    expect(setItem).toHaveBeenCalledWith("tarocub.ui.token", "top-secret");
    expect(replaceState).toHaveBeenCalledWith(
      { page: 1 },
      "",
      "/console?view=instances#active",
    );
  });
});
