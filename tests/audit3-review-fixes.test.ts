import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readRotatedLogFileTail } from "../src/lark/service.js";
import { isCloudAsrCancelledError } from "../src/runtime/asr-cloud.js";

class FakeCodexStream extends EventEmitter {
  emitData(chunk: string): void {
    this.emit("data", chunk);
  }
}

class FakeCodexChild extends EventEmitter {
  stdin = {
    lines: [] as string[],
    write(chunk: string): boolean {
      this.lines.push(chunk.trim());
      return true;
    },
  };
  stdout = new FakeCodexStream();
  stderr = new FakeCodexStream();

  kill(): void {
    // No process exists in protocol tests.
  }
}

async function waitForCodexWrites(child: FakeCodexChild, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.stdin.lines.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${count} Codex protocol writes`);
}

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
      const child = new FakeCodexChild();
      const adapter = new CodexAppServerAdapter(
        // turnTimeout / inactivity / threadRead are MILLISECONDS — generous here
        // so the watchdogs never fire during the ordering this test exercises.
        "codex", process.cwd(), undefined, (() => child) as never,
        undefined, undefined, undefined, 60 * 60_000, 10 * 60_000, 60_000,
      );
      // A /goal pursuit owns this thread. Its turn is NOT a pendingTurn, so an
      // "is this turn id taken?" check can never see it — the earlier guard was
      // therefore inert and the user's turn adopted the goal's events.
      (adapter as unknown as { goalWatchers: Map<string, unknown> }).goalWatchers.set("T", {
        resolve: () => undefined, reject: () => undefined,
      });

      const turn = adapter.sendUserMessage("telegram-1", { text: "user question", files: [] });
      await waitForCodexWrites(child, 1);
      child.stdout.emitData('{"id":1,"result":{"platformOs":"darwin"}}\n');
      await waitForCodexWrites(child, 2);
      child.stdout.emitData('{"id":2,"result":{"thread":{"id":"T"}}}\n');
      await waitForCodexWrites(child, 3);

      // The goal's output arrives BEFORE the user's turn/start response — the
      // exact window Codex reproduced against v0.1.186.
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"T","turnId":"goal-turn","item":{"type":"agentMessage","text":"GOAL PROGRESS"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"T","turn":{"id":"goal-turn","status":"completed","items":[],"usage":{"input_tokens":9999,"output_tokens":9999}}}}\n');

      const pendingMarker = { text: "(still pending)" };
      const afterGoalEvents = await Promise.race([
        turn.then((value) => ({ resolved: value }), (error) => ({ rejected: String(error?.message ?? error) })),
        new Promise((resolve) => setTimeout(() => resolve(pendingMarker), 300)),
      ]);
      // The goal's events must not settle the user's turn at all.
      expect(afterGoalEvents).toBe(pendingMarker);

      // ...and the turn must still be able to COMPLETE normally afterwards. Its
      // own turn/start response identifies it, which replays any of ITS events
      // that arrived during the unidentified window (dropping them used to leave
      // a finished turn hanging until it timed out).
      const startLine = child.stdin.lines.find((line) => line.includes('"turn/start"'));
      const startId = JSON.parse(startLine ?? "{}").id as number;
      // The user's own completion arrives BEFORE the turn/start response — the
      // ordering that exposed the drop window.
      child.stdout.emitData('{"method":"item/completed","params":{"threadId":"T","turnId":"user-turn","item":{"type":"agentMessage","text":"USER ANSWER"}}}\n');
      child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"T","turn":{"id":"user-turn","status":"completed","items":[],"usage":{"input_tokens":5,"output_tokens":7}}}}\n');
      child.stdout.emitData(`{"id":${startId},"result":{"turn":{"id":"user-turn"}}}\n`);

      const result = await turn;
      expect(result.text).toContain("USER ANSWER");
      expect(result.text).not.toContain("GOAL PROGRESS");
      expect(result.usage?.inputTokens).toBe(5);
      adapter.destroy();
    }, 20_000);

    it("cancels a buffered approval request that belongs to the concurrent goal turn", async () => {
      const { CodexAppServerAdapter } = await import("../src/codex/app-server-adapter.js");
      const child = new FakeCodexChild();
      const adapter = new CodexAppServerAdapter(
        "codex", process.cwd(), undefined, (() => child) as never,
        undefined, undefined, undefined, 60 * 60_000, 10 * 60_000, 60_000,
      );
      (adapter as unknown as { goalWatchers: Map<string, unknown> }).goalWatchers.set("T", {
        resolve: () => undefined, reject: () => undefined,
      });

      const turn = adapter.sendUserMessage("telegram-approval", { text: "user question", files: [] });
      try {
        await waitForCodexWrites(child, 1);
        child.stdout.emitData('{"id":1,"result":{"platformOs":"darwin"}}\n');
        await waitForCodexWrites(child, 2);
        child.stdout.emitData('{"id":2,"result":{"thread":{"id":"T"}}}\n');
        await waitForCodexWrites(child, 3);

        child.stdout.emitData('{"id":99,"method":"item/commandExecution/requestApproval","params":{"threadId":"T","turnId":"goal-turn","command":"echo goal"}}\n');
        expect(child.stdin.lines.some((line) => JSON.parse(line).id === 99)).toBe(false);

        const startLine = child.stdin.lines.find((line) => line.includes('"turn/start"'));
        const startId = JSON.parse(startLine ?? "{}").id as number;
        child.stdout.emitData(`{"id":${startId},"result":{"turn":{"id":"user-turn"}}}\n`);
        await waitForCodexWrites(child, 4);

        const approvalResponse = child.stdin.lines
          .map((line) => JSON.parse(line) as { id?: number; result?: unknown })
          .find((entry) => entry.id === 99);
        expect(approvalResponse?.result).toEqual({ decision: "cancel" });

        child.stdout.emitData('{"method":"item/completed","params":{"threadId":"T","turnId":"user-turn","item":{"type":"agentMessage","text":"USER ANSWER"}}}\n');
        child.stdout.emitData('{"method":"turn/completed","params":{"threadId":"T","turn":{"id":"user-turn","status":"completed","items":[]}}}\n');
        await expect(turn).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("USER ANSWER") }));
      } finally {
        adapter.destroy();
        await turn.catch(() => undefined);
      }
    }, 20_000);

    it("settles a still-buffered approval request when the holding turn is evicted", async () => {
      const { CodexAppServerAdapter } = await import("../src/codex/app-server-adapter.js");
      const child = new FakeCodexChild();
      const adapter = new CodexAppServerAdapter(
        "codex", process.cwd(), undefined, (() => child) as never,
        undefined, undefined, undefined, 60 * 60_000, 10 * 60_000, 60_000,
      );
      (adapter as unknown as { goalWatchers: Map<string, unknown> }).goalWatchers.set("T", {
        resolve: () => undefined, reject: () => undefined,
      });

      const turn = adapter.sendUserMessage("telegram-evicted", { text: "user question", files: [] });
      try {
        await waitForCodexWrites(child, 1);
        child.stdout.emitData('{"id":1,"result":{"platformOs":"darwin"}}\n');
        await waitForCodexWrites(child, 2);
        child.stdout.emitData('{"id":2,"result":{"thread":{"id":"T"}}}\n');
        await waitForCodexWrites(child, 3);

        // The goal's approval is buffered: its owner cannot be known until the
        // user turn's own turn/start response lands.
        child.stdout.emitData('{"id":99,"method":"item/commandExecution/requestApproval","params":{"threadId":"T","turnId":"goal-turn","command":"echo goal"}}\n');

        // The holding turn dies first (here: an unsupported request faults the
        // thread). The buffer must not vanish with it — the app-server is still
        // blocked on a response to id 99, which would wedge the pursuit.
        child.stdout.emitData('{"id":100,"method":"thread/unsupportedRequest","params":{"threadId":"T"}}\n');
        await expect(turn).rejects.toThrow(/Unsupported Codex app-server request/);

        const approvalResponse = child.stdin.lines
          .map((line) => JSON.parse(line) as { id?: number; result?: unknown })
          .find((entry) => entry.id === 99);
        expect(approvalResponse?.result).toEqual({ decision: "cancel" });
      } finally {
        adapter.destroy();
        await turn.catch(() => undefined);
      }
    }, 20_000);

    it("fails safely when unidentified turn events exceed the byte budget", async () => {
      const { CodexAppServerAdapter } = await import("../src/codex/app-server-adapter.js");
      const child = new FakeCodexChild();
      const adapter = new CodexAppServerAdapter(
        "codex", process.cwd(), undefined, (() => child) as never,
        undefined, undefined, undefined, 60 * 60_000, 10 * 60_000, 60_000,
      );
      (adapter as unknown as { goalWatchers: Map<string, unknown> }).goalWatchers.set("T", {
        resolve: () => undefined, reject: () => undefined,
      });

      const turn = adapter.sendUserMessage("telegram-buffer", { text: "user question", files: [] });
      try {
        await waitForCodexWrites(child, 1);
        child.stdout.emitData('{"id":1,"result":{"platformOs":"darwin"}}\n');
        await waitForCodexWrites(child, 2);
        child.stdout.emitData('{"id":2,"result":{"thread":{"id":"T"}}}\n');
        await waitForCodexWrites(child, 3);

        const largeDelta = "x".repeat(700 * 1024);
        for (let index = 0; index < 3; index += 1) {
          child.stdout.emitData(`${JSON.stringify({
            method: "item/agentMessage/delta",
            params: { threadId: "T", turnId: `unknown-${index}`, delta: largeDelta },
          })}\n`);
        }

        const outcome = await Promise.race([
          turn.then(
            () => ({ kind: "resolved" as const, message: "" }),
            (error) => ({ kind: "rejected" as const, message: String(error?.message ?? error) }),
          ),
          new Promise<{ kind: "timeout"; message: string }>((resolve) => {
            setTimeout(() => resolve({ kind: "timeout", message: "" }), 500);
          }),
        ]);
        expect(outcome.kind).toBe("rejected");
        expect(outcome.message).toContain("unidentified turn event buffer exceeded");
      } finally {
        adapter.destroy();
        await turn.catch(() => undefined);
      }
    }, 20_000);
  });

  describe("unicode-escaped callback keys (P0, re-fix)", () => {
    it("sanitizes a callback whose key is JSON-escaped as cctb\\u005flark", async () => {
      const { deliverLarkResponse } = await import("../src/lark/delivery.js");
      const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-esc-"));
      await mkdir(path.join(stateDir, "workspace"), { recursive: true });
      const sent: unknown[] = [];
      const channel = { send: vi.fn(async (_c: string, payload: unknown) => { sent.push(payload); return { messageId: "m" }; }) };
      // A plaintext substring test never sees this key, but JSON.parse — which
      // is exactly what the click handler does — yields `cctb_lark`.
      const escaped = '{"cctb\\u005flark":"stop","conversationKey":"lark:oc_victim","taskId":"t1"}';
      const card = {
        schema: "2.0",
        body: { elements: [{
          tag: "interactive_container",
          text: { tag: "plain_text", content: "详情" },
          behaviors: [{ type: "callback", value: escaped }],
        }] },
      };
      try {
        await deliverLarkResponse({
          channel: channel as never, runtime: {} as never, chatId: "oc_chat",
          text: `[tool:${JSON.stringify({ name: "lark.card", payload: { card } })}]`,
          stateDir, conversationKey: "lark:oc_chat", bridgeChatType: "private",
        });
        const rendered = JSON.stringify(sent);
        expect(rendered).not.toContain("oc_victim");
        expect(rendered).not.toContain("stop");
        expect(rendered).toContain("choice");
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    }, 20_000);
  });
});
