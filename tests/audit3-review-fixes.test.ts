import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readRotatedLogFileTail } from "../src/lark/service.js";
import { isCloudAsrCancelledError } from "../src/runtime/asr-cloud.js";

// Findings from Codex's review of the audit-3 release (v0.1.185). Each test
// fails without its fix.
describe("audit-3 review fixes", () => {
  describe("string-encoded engine card callbacks (P0)", () => {
    it("sanitizes a privileged callback that was encoded as a JSON STRING", async () => {
      const { deliverLarkResponse } = await import("../src/lark/delivery.js");
      const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-strcb-"));
      await mkdir(path.join(stateDir, "workspace"), { recursive: true });
      const sent: unknown[] = [];
      const channel = {
        send: vi.fn(async (_chat: string, payload: unknown) => { sent.push(payload); return { messageId: "om_1" }; }),
      };
      // The engine ships a card whose button value is a STRING — the click
      // handler JSON.parses it, so an object-only sanitizer was fully bypassed.
      // NOT a button: the button path rebuilds `value` into `behaviors` and
      // incidentally drops a raw string, so the real bypass lives on the
      // elements that keep their callback verbatim (container/select/img).
      const card = {
        schema: "2.0",
        body: {
          elements: [{
            tag: "interactive_container",
            text: { tag: "plain_text", content: "查看完整报告" },
            behaviors: [{
              type: "callback",
              value: JSON.stringify({ cctb_lark: "config", action: "yolo", value: "unsafe", conversationKey: "lark:oc_victim" }),
            }],
          }],
        },
      };
      try {
        await deliverLarkResponse({
          channel: channel as never,
          runtime: { appInfo: undefined } as never,
          chatId: "oc_chat",
          text: `[tool:${JSON.stringify({ name: "lark.card", payload: { card } })}]`,
          stateDir,
          conversationKey: "lark:oc_chat",
          bridgeChatType: "private",
        });
        const rendered = JSON.stringify(sent);
        // No privileged action survives, in any encoding.
        expect(rendered).not.toContain("\\\"action\\\":\\\"yolo\\\"");
        expect(rendered).not.toContain("oc_victim");
        expect(rendered).toContain("choice");
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    }, 20_000);
  });

  describe("rotated-log tail coverage (P1)", () => {
    it("keeps reading older rotations until the time window is covered, past the byte budget", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "cctb-tail-"));
      const file = path.join(dir, "timeline.log.jsonl");
      const now = Date.now();
      const line = (ms: number) => JSON.stringify({ timestamp: new Date(ms).toISOString(), type: "engine.event" });
      // Current + .1 are recent and BIG; the turn start lives in .2, older than
      // the byte budget would ever reach if bytes were checked first.
      const filler = (ms: number, n: number) => Array.from({ length: n }, () => line(ms)).join("\n");
      await writeFile(file, filler(now - 60_000, 400), "utf8");
      await writeFile(`${file}.1`, filler(now - 120_000, 400), "utf8");
      await writeFile(`${file}.2`, `${JSON.stringify({ timestamp: new Date(now - 5 * 60 * 60 * 1000).toISOString(), type: "input.received", detail: "OLD_TURN_START" })}`, "utf8");

      // A tiny budget: coverage of the 6h window must still win.
      const tail = await readRotatedLogFileTail(file, { sinceMs: now - 6 * 60 * 60 * 1000, maxBytes: 1024 });
      expect(tail).toContain("OLD_TURN_START");
      await rm(dir, { recursive: true, force: true });
    });
  });

  describe("cloud ASR cancellation (P1)", () => {
    it("marks an aborted cloud job as cancelled (so callers must not fall back to local)", async () => {
      const { runCloudAsrProcess } = await import("../src/runtime/asr-cloud.js");
      const jobDir = await mkdtemp(path.join(os.tmpdir(), "cctb-asr-cancel-"));
      const controller = new AbortController();
      controller.abort();
      await expect(runCloudAsrProcess({
        pythonPath: process.execPath,
        scriptPath: path.join(jobDir, "noop.py"),
        args: [],
        jobDir,
        wallClockSeconds: 5,
        abortSignal: controller.signal,
      } as never)).rejects.toSatisfy((error: unknown) => isCloudAsrCancelledError(error));
      await rm(jobDir, { recursive: true, force: true });
    });
  });

  describe("goal cross-talk during the unknown-turnId window (P1, re-fix)", () => {
    it("does not settle a user turn with a goal's events while its own turnId is unregistered", async () => {
      const { CodexAppServerAdapter } = await import("../src/codex/app-server-adapter.js");
      const { EventEmitter } = await import("node:events");

      class FakeStream extends EventEmitter {
        emitData(chunk: string) { this.emit("data", chunk); }
      }
      class FakeChild extends EventEmitter {
        stdin = { lines: [] as string[], write(chunk: string) { this.lines.push(chunk.trim()); return true; } };
        stdout = new FakeStream();
        stderr = new FakeStream();
        kill() { /* no-op */ }
      }
      const child = new FakeChild();
      const adapter = new CodexAppServerAdapter(
        "codex", process.cwd(), undefined, (() => child) as never,
        undefined, undefined, undefined, 60 * 60_000, 30, 60,
      );
      // A /goal pursuit owns this thread. Its turn is NOT a pendingTurn, so an
      // "is this turn id taken?" check can never see it — the earlier guard was
      // therefore inert and the user's turn adopted the goal's events.
      (adapter as unknown as { goalWatchers: Map<string, unknown> }).goalWatchers.set("T", {
        resolve: () => undefined, reject: () => undefined,
      });

      const turn = adapter.sendUserMessage("telegram-1", { text: "user question", files: [] });
      const waitForLines = async (n: number) => {
        for (let i = 0; i < 200; i += 1) {
          if (child.stdin.lines.length >= n) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      await waitForLines(1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"darwin"}}\n');
      await waitForLines(2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"T"}}}\n');
      await waitForLines(3);

      // The goal's output arrives BEFORE the user's turn/start response — the
      // exact window Codex reproduced against v0.1.186.
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"T","turnId":"goal-turn","item":{"type":"agentMessage","text":"GOAL PROGRESS"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"T","turnId":"goal-turn","turn":{"id":"goal-turn","status":"completed","items":[],"usage":{"input_tokens":9999,"output_tokens":9999}}}}\n');

      const pendingMarker = { text: "(still pending)" };
      const settled = await Promise.race([
        turn.then((value) => ({ resolved: value }), (error) => ({ rejected: String(error?.message ?? error) })),
        new Promise((resolve) => setTimeout(() => resolve(pendingMarker), 400)),
      ]);
      // The user's turn must never be SETTLED WITH THE GOAL'S OUTPUT. Staying
      // pending is ideal; a rejection is acceptable only if it is not the goal's
      // result masquerading as this turn's answer.
      const asRecord = settled as { resolved?: { text?: string; usage?: { inputTokens?: number } }; rejected?: string };
      expect(asRecord.resolved?.text).not.toBe("GOAL PROGRESS");
      expect(asRecord.resolved?.usage?.inputTokens).not.toBe(9999);
      if (asRecord.rejected !== undefined) {
        // Diagnostic breadcrumb if the rejection path ever changes shape.
        expect(asRecord.rejected).toEqual(expect.any(String));
      }
      adapter.destroy();
      await turn.catch(() => undefined);
    }, 20_000);
  });
});
