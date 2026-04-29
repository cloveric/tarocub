import { describe, expect, it, vi } from "vitest";

import { runCronCli, type CronCliIo } from "../src/cron-cli.js";

function makeIo(): CronCliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? (status >= 200 && status < 300);
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => text,
  } as unknown as Response;
}

const ENV = {
  CCTB_CRON_URL: "http://127.0.0.1:9999/cron/test-token",
  CCTB_CRON_TOKEN: "test-token",
};

describe("runCronCli", () => {
  it("prints usage and exits 0 when --help is the first arg", async () => {
    const io = makeIo();
    const result = await runCronCli(["--help"], { env: {}, fetchFn: vi.fn(), io });
    expect(result.exitCode).toBe(0);
    expect(io.stdout.join("\n")).toContain("Usage: cctb cron");
  });

  it("prints usage and exits 1 with no arguments", async () => {
    const io = makeIo();
    const result = await runCronCli([], { env: ENV, fetchFn: vi.fn(), io });
    expect(result.exitCode).toBe(1);
    expect(io.stdout.join("\n")).toContain("Usage: cctb cron");
  });

  it("rejects unknown commands", async () => {
    const io = makeIo();
    const result = await runCronCli(["frobnicate"], { env: ENV, fetchFn: vi.fn(), io });
    expect(result.exitCode).toBe(1);
    expect(io.stderr.join("\n")).toContain("unknown command: frobnicate");
  });

  it("errors when CCTB_CRON_URL is missing", async () => {
    const io = makeIo();
    const result = await runCronCli(["list"], { env: {}, fetchFn: vi.fn(), io });
    expect(result.exitCode).toBe(1);
    expect(io.stderr.join("\n")).toContain("CCTB_CRON_URL");
  });

  it("errors when only the token is missing", async () => {
    const io = makeIo();
    const result = await runCronCli(["list"], {
      env: { CCTB_CRON_URL: ENV.CCTB_CRON_URL },
      fetchFn: vi.fn(),
      io,
    });
    expect(result.exitCode).toBe(1);
    expect(io.stderr.join("\n")).toContain("CCTB_CRON_URL");
  });

  it("posts add with the correct URL, headers, and body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        job: {
          id: "abcd1234",
          chatId: 1,
          userId: 2,
          cronExpr: "0 9 * * *",
          prompt: "morning summary",
          enabled: true,
          sessionMode: "reuse",
          mute: false,
          silent: false,
          timeoutMins: 30,
          createdAt: "2026-04-29T00:00:00.000Z",
          updatedAt: "2026-04-29T00:00:00.000Z",
        },
      }),
    );
    const io = makeIo();
    const result = await runCronCli(
      [
        "add",
        "--cron",
        "0 9 * * *",
        "--prompt",
        "morning summary",
        "--description",
        "daily",
      ],
      { env: ENV, fetchFn, io },
    );
    expect(result.exitCode).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchFn.mock.calls[0]!;
    expect(calledUrl).toBe("http://127.0.0.1:9999/cron/test-token/add");
    expect(calledInit.method).toBe("POST");
    expect(calledInit.headers["content-type"]).toBe("application/json");
    expect(calledInit.headers.authorization).toBe("Bearer test-token");
    expect(JSON.parse(calledInit.body)).toEqual({
      cronExpr: "0 9 * * *",
      prompt: "morning summary",
      description: "daily",
    });
    expect(io.stdout.join("\n")).toContain("added abcd1234");
  });

  it("supports one-shot reminders with --in", async () => {
    const before = Date.now();
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        job: {
          id: "22223333",
          chatId: 1,
          userId: 2,
          cronExpr: "0 9 * * *",
          prompt: "drink water",
          enabled: true,
          runOnce: true,
          targetAt: new Date(before + 10 * 60_000).toISOString(),
          sessionMode: "reuse",
          mute: false,
          silent: false,
          timeoutMins: 30,
          createdAt: "2026-04-29T00:00:00.000Z",
          updatedAt: "2026-04-29T00:00:00.000Z",
        },
      }),
    );
    const io = makeIo();
    const result = await runCronCli(
      ["add", "--in", "10m", "--prompt", "drink water"],
      { env: ENV, fetchFn, io },
    );

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);
    expect(body.prompt).toBe("drink water");
    expect(body.cronExpr).toBeUndefined();
    expect(typeof body.runAt).toBe("string");
    const runAt = new Date(body.runAt).getTime();
    const after = Date.now();
    expect(runAt).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect(runAt).toBeLessThanOrEqual(after + 10 * 60_000);
  });

  it("supports positional cron expression and prompt", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        job: {
          id: "11112222",
          chatId: 1,
          userId: 2,
          cronExpr: "0 9 * * *",
          prompt: "good morning",
          enabled: true,
          sessionMode: "reuse",
          mute: false,
          silent: false,
          timeoutMins: 30,
          createdAt: "2026-04-29T00:00:00.000Z",
          updatedAt: "2026-04-29T00:00:00.000Z",
        },
      }),
    );
    const io = makeIo();
    const result = await runCronCli(
      ["add", "0", "9", "*", "*", "*", "good", "morning"],
      { env: ENV, fetchFn, io },
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body);
    expect(body.cronExpr).toBe("0 9 * * *");
    expect(body.prompt).toBe("good morning");
  });

  it("returns non-zero on validation errors before posting", async () => {
    const fetchFn = vi.fn();
    const io = makeIo();
    const result = await runCronCli(["add", "--cron", "* * * * *"], {
      env: ENV,
      fetchFn,
      io,
    });
    expect(result.exitCode).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(io.stderr.join("\n")).toContain("--prompt is required");
  });

  it("returns non-zero on HTTP error from add", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error: "invalid cron expression" }, { status: 400, ok: false }),
    );
    const io = makeIo();
    const result = await runCronCli(["add", "--cron", "0 9 * * *", "--prompt", "x"], {
      env: ENV,
      fetchFn,
      io,
    });
    expect(result.exitCode).toBe(1);
    expect(io.stderr.join("\n")).toContain("invalid cron expression");
  });

  it("formats list output with one job per line", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        jobs: [
          {
            id: "aaaa1111",
            chatId: 1,
            userId: 2,
            cronExpr: "0 9 * * *",
            prompt: "morning",
            description: "daily",
            enabled: true,
            sessionMode: "reuse",
            mute: false,
            silent: false,
            timeoutMins: 30,
            createdAt: "2026-04-29T00:00:00.000Z",
            updatedAt: "2026-04-29T00:00:00.000Z",
          },
          {
            id: "bbbb2222",
            chatId: 1,
            userId: 2,
            cronExpr: "*/5 * * * *",
            prompt: "frequent",
            enabled: false,
            runOnce: true,
            targetAt: "2026-04-29T00:05:00.000Z",
            sessionMode: "new_per_run",
            mute: true,
            silent: false,
            timeoutMins: 30,
            createdAt: "2026-04-29T00:00:00.000Z",
            updatedAt: "2026-04-29T00:00:00.000Z",
          },
        ],
      }),
    );
    const io = makeIo();
    const result = await runCronCli(["list"], { env: ENV, fetchFn, io });
    expect(result.exitCode).toBe(0);
    expect(io.stdout).toHaveLength(2);
    expect(io.stdout[0]).toContain("aaaa1111");
    expect(io.stdout[0]).toContain("on");
    expect(io.stdout[1]).toContain("bbbb2222");
    expect(io.stdout[1]).toContain("off");
    expect(io.stdout[1]).toContain("once=2026-04-29T00:05:00.000Z");
  });

  it("prints '(no cron jobs)' when list is empty", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, jobs: [] }));
    const io = makeIo();
    const result = await runCronCli(["list"], { env: ENV, fetchFn, io });
    expect(result.exitCode).toBe(0);
    expect(io.stdout).toEqual(["(no cron jobs)"]);
  });

  it("does not expose destructive commands to agent-facing CLI", async () => {
    const fetchFn = vi.fn();
    const io = makeIo();
    const deleteResult = await runCronCli(["delete", "abcd1234"], { env: ENV, fetchFn, io });
    const toggleResult = await runCronCli(["toggle", "abcd1234"], { env: ENV, fetchFn, io });
    expect(deleteResult.exitCode).toBe(1);
    expect(toggleResult.exitCode).toBe(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(io.stderr.join("\n")).toContain("unknown command: delete");
    expect(io.stderr.join("\n")).toContain("unknown command: toggle");
  });

  it("surfaces network errors with non-zero exit", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const io = makeIo();
    const result = await runCronCli(["list"], { env: ENV, fetchFn, io });
    expect(result.exitCode).toBe(1);
    expect(io.stderr.join("\n")).toContain("ECONNREFUSED");
  });
});
