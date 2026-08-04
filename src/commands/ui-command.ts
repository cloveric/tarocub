// `cctb ui` — launch the machine-level web configuration console. It is a
// cross-instance surface (it lists every ~/.cctb/<instance>), so it lives at the
// top level rather than under a channel. Loopback + token protected; see
// ui-server.ts.

import { execFile } from "node:child_process";

import { startUiServer } from "../ui/ui-server.js";
import type { UiApiEnv } from "../ui/ui-api.js";

export interface UiConsoleDeps {
  /** Injectable so tests don't spawn a browser. */
  openBrowser?: (url: string) => void;
  /** Resolves when the console should shut down (default: SIGINT/SIGTERM). */
  keepAlive?: () => Promise<void>;
  port?: number;
}

function defaultOpenBrowser(url: string): void {
  const platform = process.platform;
  const { command, args } =
    platform === "win32" ? { command: "cmd", args: ["/c", "start", "", url] }
    : platform === "darwin" ? { command: "open", args: [url] }
    : { command: "xdg-open", args: [url] };
  execFile(command, args, () => {});
}

function defaultKeepAlive(): Promise<void> {
  return new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

export async function runUiConsoleCommand(
  env: UiApiEnv,
  logger: { log: (message: string) => void },
  deps: UiConsoleDeps = {},
): Promise<boolean> {
  const server = await startUiServer(env, { ...(deps.port !== undefined ? { port: deps.port } : {}) });
  logger.log(`TaroCub configuration console: ${server.url}`);
  logger.log("Loopback + token protected. Press Ctrl-C to stop.");
  (deps.openBrowser ?? defaultOpenBrowser)(server.url);
  await (deps.keepAlive ?? defaultKeepAlive)();
  await server.close();
  return true;
}
