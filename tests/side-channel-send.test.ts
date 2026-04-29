import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createStableCctbCommandHelper,
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

  it("surfaces structured rejected receipts as readable CLI errors", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        ok: false,
        error: "1 file not delivered by side-channel send",
        rejected: [
          {
            path: "/tmp/missing.pdf",
            reason: "not-found",
            source: "side-channel",
          },
        ],
      }),
    });

    await expect(
      runSideChannelSendCommand(
        ["--file", "/tmp/missing.pdf"],
        {
          env: {
            CCTB_SEND_URL: "http://127.0.0.1:1234/send/token",
            CCTB_SEND_TOKEN: "token",
          },
          fetchFn,
        },
      ),
    ).rejects.toThrow("1 file not delivered by side-channel send: /tmp/missing.pdf — not-found");
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

  it("locks down helper directories that contain turn-scoped tokens", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "side-channel-send-"));

    try {
      const helperRoot = path.join(root, ".cctb-send", "request-1");
      await chmod(root, 0o755);
      const helperPath = await createSideChannelSendHelper(
        helperRoot,
        ["/usr/bin/node", "/tmp/cctb.js", "send"],
        {
          CCTB_SEND_URL: "http://127.0.0.1:1234/send/token",
          CCTB_SEND_TOKEN: "token",
        },
      );

      expect((await stat(path.dirname(helperRoot))).mode & 0o777).toBe(0o700);
      expect((await stat(helperRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(helperPath)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates a stable cctb command shim that forwards arguments to the bridge CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "side-channel-send-"));

    try {
      const helperPath = await createStableCctbCommandHelper(root, ["/usr/bin/node", "/tmp/cctb.js"]);
      const helper = await readFile(helperPath, "utf8");

      expect(path.basename(helperPath)).toBe(process.platform === "win32" ? "cctb.cmd" : "cctb");
      expect(helper).toContain("exec '/usr/bin/node' '/tmp/cctb.js' \"$@\"");
      expect(helper).not.toContain("'send' \"$@\"");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not rewrite the stable cctb command shim when contents are unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "side-channel-send-"));

    try {
      const helperPath = await createStableCctbCommandHelper(root, ["/usr/bin/node", "/tmp/cctb.js"]);
      const oldTime = new Date("2001-01-01T00:00:00.000Z");
      await utimes(helperPath, oldTime, oldTime);

      await createStableCctbCommandHelper(root, ["/usr/bin/node", "/tmp/cctb.js"]);

      const metadata = await stat(helperPath);
      expect(Math.abs(metadata.mtimeMs - oldTime.getTime())).toBeLessThan(1000);
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

  it("sends explicit side-channel images via Telegram photo delivery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "side-channel-send-"));
    const imagePath = path.join(root, "chart.png");
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
      await writeFile(imagePath, "small png bytes", "utf8");

      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({
          images: [imagePath],
          files: [],
        }),
      });

      expect(response.status).toBe(200);
      expect(api.sendPhoto).toHaveBeenCalledWith(123, "chart.png", expect.any(Uint8Array), "chart.png");
      expect(api.sendDocument).not.toHaveBeenCalled();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sends mixed image and file batches with distinct Telegram methods", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "side-channel-send-"));
    const imageOne = path.join(root, "one.png");
    const imageTwo = path.join(root, "two.jpg");
    const filePath = path.join(root, "report.pdf");
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
      await writeFile(imageOne, "png", "utf8");
      await writeFile(imageTwo, "jpg", "utf8");
      await writeFile(filePath, "pdf", "utf8");

      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({
          message: "batch ready",
          images: [imageOne, imageTwo],
          files: [filePath],
        }),
      });

      expect(response.status).toBe(200);
      expect(api.sendMessage).toHaveBeenCalledWith(123, "batch ready", { parseMode: "Markdown" });
      expect(api.sendPhoto).toHaveBeenCalledTimes(2);
      expect(api.sendPhoto).toHaveBeenNthCalledWith(1, 123, "one.png", expect.any(Uint8Array), "one.png");
      expect(api.sendPhoto).toHaveBeenNthCalledWith(2, 123, "two.jpg", expect.any(Uint8Array), "two.jpg");
      expect(api.sendDocument).toHaveBeenCalledWith(123, "report.pdf", expect.any(Uint8Array));
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        ok: true,
        accepted: expect.arrayContaining([
          expect.objectContaining({ path: imageOne }),
          expect.objectContaining({ path: imageTwo }),
          expect.objectContaining({ path: filePath }),
        ]),
      }));
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records rejected receipts when Telegram upload fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "side-channel-send-"));
    const filePath = path.join(root, "report.pdf");
    const api = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      sendDocument: vi.fn().mockRejectedValue(new Error("Telegram API request failed for sendDocument: 500")),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 3 }),
    };
    const server = await startSideChannelSendServer({
      api,
      chatId: 123,
      inboxDir: path.join(root, "instance", "inbox"),
      locale: "en",
    });

    try {
      await writeFile(filePath, "pdf", "utf8");

      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({
          images: [],
          files: [filePath],
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual(expect.objectContaining({
        ok: false,
        rejected: [
          expect.objectContaining({
            path: filePath,
            reason: "send-error",
            source: "side-channel",
          }),
        ],
      }));
      expect(server.getDeliveryReceipts().rejected).toEqual([
        expect.objectContaining({
          path: filePath,
          reason: "send-error",
          source: "side-channel",
        }),
      ]);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects sends after the active side-channel server is closed", async () => {
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
      await server.close();
      await expect(fetch(server.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({
          message: "late",
          images: [],
          files: [],
        }),
      })).rejects.toThrow();
    } finally {
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
