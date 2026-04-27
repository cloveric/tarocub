import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createSideChannelSendHelper,
  parseSideChannelSendArgs,
  runSideChannelSendCommand,
  startSideChannelSendServer,
} from "../src/telegram/side-channel-send.js";

describe("side-channel send command", () => {
  it("parses message, image, and file arguments", () => {
    expect(parseSideChannelSendArgs([
      "--message",
      "ready",
      "--image",
      "/tmp/a.png",
      "--file",
      "/tmp/report.pdf",
    ])).toEqual({
      message: "ready",
      images: ["/tmp/a.png"],
      files: ["/tmp/report.pdf"],
    });
  });

  it("rejects relative file paths before posting to the turn endpoint", () => {
    expect(() => parseSideChannelSendArgs(["--file", "report.pdf"])).toThrow("File paths must be absolute");
  });

  it("posts paths to the active turn endpoint without reading file contents", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, filesSent: 2 }),
    });

    await runSideChannelSendCommand(
      ["--image", "/tmp/a.png", "--file", "/tmp/b.pdf", "done"],
      {
        env: {
          CCTB_SEND_URL: "http://127.0.0.1:1234/send/token",
          CCTB_SEND_TOKEN: "token",
        },
        fetchFn,
      },
    );

    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/send/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          authorization: "Bearer token",
        }),
        body: JSON.stringify({
          message: "done",
          images: ["/tmp/a.png"],
          files: ["/tmp/b.pdf"],
        }),
      }),
    );
  });

  it("can embed the active turn endpoint into the generated helper", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "side-channel-send-"));

    try {
      const helperPath = await createSideChannelSendHelper(
        root,
        ["/usr/bin/node", "/tmp/cctb.js", "send"],
        {
          CCTB_SEND_URL: "http://127.0.0.1:1234/send/token",
          CCTB_SEND_TOKEN: "token",
        },
      );
      const helper = await readFile(helperPath, "utf8");

      expect(helper).toContain("CCTB_SEND_URL=");
      expect(helper).toContain("http://127.0.0.1:1234/send/token");
      expect(helper).toContain("CCTB_SEND_TOKEN=");
      expect(helper).toContain("token");
      expect(helper).toContain("exec '/usr/bin/node' '/tmp/cctb.js' 'send' \"$@\"");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sends explicit side-channel files from arbitrary absolute paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "side-channel-send-"));
    const inboxDir = path.join(root, "instance", "inbox");
    const outsideFile = path.join(root, "outside.txt");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    };
    const server = await startSideChannelSendServer({
      api,
      chatId: 123,
      inboxDir,
      locale: "en",
    });

    try {
      await writeFile(outsideFile, "secret", "utf8");

      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({
          images: [],
          files: [outsideFile],
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        ok: true,
        accepted: [
          expect.objectContaining({
            path: outsideFile,
            source: "side-channel",
          }),
        ],
      }));
      expect(api.sendDocument).toHaveBeenCalledWith(123, "outside.txt", expect.any(Uint8Array));
      expect(server.getSentFilePaths()).toEqual([outsideFile]);
      expect(server.getDeliveryReceipts()).toEqual(expect.objectContaining({
        accepted: [
          expect.objectContaining({
            path: outsideFile,
            source: "side-channel",
          }),
        ],
        rejected: [],
      }));
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects side-channel requests without the bearer token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "side-channel-send-"));
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 2 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    };
    const server = await startSideChannelSendServer({
      api,
      chatId: 123,
      inboxDir: path.join(root, "instance", "inbox"),
      locale: "en",
    });

    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: "done",
          images: [],
          files: [],
        }),
      });

      expect(response.status).toBe(404);
      expect(api.sendMessage).not.toHaveBeenCalled();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
