const TOKEN_STORAGE_KEY = "tarocub.ui.token";

interface UiTokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface UiTokenHistory {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export function consumeUiToken(input: {
  href: string;
  storage: UiTokenStorage;
  history: UiTokenHistory;
}): string {
  const url = new URL(input.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try {
      input.storage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    } catch {
      // The in-memory token still works when session storage is unavailable.
    }
    url.searchParams.delete("token");
    input.history.replaceState(
      input.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    return fromUrl;
  }

  try {
    return input.storage.getItem(TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}
