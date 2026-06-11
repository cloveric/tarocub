import { describe, expect, it } from "vitest";

import {
  PS_MAX_BUFFER_BYTES,
  parseEtimeSeconds,
  parseInstanceProcessGroup,
} from "../src/runtime/background-processes.js";

const SERVICE_PID = 64997;

// Mirrors the real leak we caught live: the service leads its own process
// group; a live engine worker (66606) is its direct child; the worker's tool
// shell and mcp are grandchildren; and a leaked ugrep whose worker already
// died sits in the group re-parented to pid 1.
const PS_FIXTURE = `
64997 64997     1  39000 05:12 node dist/src/index.js lark run -
66606 64997 64997 124000 40:36 claude -p --verbose --input-format stream-json
66614 64997 66606  15000 40:30 node mcp-helper
66646 64997 66614   5000 40:29 chrome-devtools-mcp
69560 64997     1 2914000 02:10 ugrep -G -aoE .{0,60}评估
12345 12345     1 500000 99:00 some-unrelated-process-in-its-own-group
`;

describe("parseInstanceProcessGroup", () => {
  it("classifies engine workers, their children, and orphans within the service group only", () => {
    const group = parseInstanceProcessGroup(PS_FIXTURE, SERVICE_PID);

    const byPid = new Map(group.map((proc) => [proc.pid, proc]));
    expect(byPid.get(66606)?.role).toBe("engine");
    expect(byPid.get(66614)?.role).toBe("child");
    expect(byPid.get(66646)?.role).toBe("child");
    expect(byPid.get(69560)?.role).toBe("orphan");
    // The service itself and foreign process groups are never listed.
    expect(byPid.has(64997)).toBe(false);
    expect(byPid.has(12345)).toBe(false);
  });

  it("sorts by memory and reports MB", () => {
    const group = parseInstanceProcessGroup(PS_FIXTURE, SERVICE_PID);
    expect(group[0].pid).toBe(69560);
    expect(group[0].rssMb).toBe(2846);
  });

  it("returns empty when the service pid is not present in the listing", () => {
    expect(parseInstanceProcessGroup(PS_FIXTURE, 99999)).toEqual([]);
  });

  it("parses a >8MB synthetic ps listing without choking (long command lines)", () => {
    // The real bug: full `command=` output across a busy host is ~27MB, far past
    // the old 8MB execFile buffer. The PARSER itself must handle that volume; the
    // buffer bound is asserted separately below. Build a listing well over 8MB.
    const longArg = "x".repeat(4096);
    const lines = [`64997 64997     1  39000 05:12 node dist/src/index.js lark run -`];
    for (let pid = 70000; lines.join("\n").length < 9 * 1024 * 1024; pid += 1) {
      lines.push(`${pid} 64997 64997  5000 00:30 ugrep -aoE ${longArg}-${pid}`);
    }
    const psOutput = lines.join("\n");
    expect(psOutput.length).toBeGreaterThan(8 * 1024 * 1024);

    const group = parseInstanceProcessGroup(psOutput, SERVICE_PID);
    expect(group.length).toBe(lines.length - 1);
    // Long command lines are truncated to 120 chars for display, never dropped.
    expect(group.every((proc) => proc.command.length <= 120)).toBe(true);
  });

  it("uses a buffer large enough for real-host ps output (64MB, well over the ~27MB seen live)", () => {
    expect(PS_MAX_BUFFER_BYTES).toBe(64 * 1024 * 1024);
    expect(PS_MAX_BUFFER_BYTES).toBeGreaterThanOrEqual(27 * 1024 * 1024);
  });
});

describe("parseEtimeSeconds", () => {
  it("parses MM:SS, HH:MM:SS, and DD-HH:MM:SS", () => {
    expect(parseEtimeSeconds("02:10")).toBe(130);
    expect(parseEtimeSeconds("01:02:10")).toBe(3730);
    expect(parseEtimeSeconds("2-01:02:10")).toBe(176530);
  });

  it("returns null for an unparseable etime", () => {
    expect(parseEtimeSeconds("garbage")).toBeNull();
    expect(parseEtimeSeconds("")).toBeNull();
  });
});

describe("parseInstanceProcessGroup orphan-class guards", () => {
  // The service was launched in the foreground by a shell + npm wrapper that
  // SHARE its process group (dev/foreground launch). Those wrappers reach the
  // service neither as its child nor through live descent, so the naive orphan
  // rule would sweep the service's OWN parent chain on /bg killall. They must be
  // shielded out of the orphan class.
  const WRAPPER_FIXTURE = `
5000 64997     1  20000 10:00 -zsh
5001 64997  5000  30000 09:30 npm run dev
64997 64997  5001  39000 05:12 node dist/src/index.js lark run -
66606 64997 64997 124000 04:00 claude -p --verbose
69560 64997     1 100000 02:10 ugrep -aoE leaked-turn-storm
`;

  it("never classifies the service's own ancestor wrappers as orphan", () => {
    const group = parseInstanceProcessGroup(WRAPPER_FIXTURE, 64997);
    const byPid = new Map(group.map((proc) => [proc.pid, proc]));
    // The zsh + npm wrappers are the service's ancestors in the same pgid.
    expect(byPid.get(5000)?.role).not.toBe("orphan");
    expect(byPid.get(5001)?.role).not.toBe("orphan");
    // A real leaked worker (younger than the service, no live ancestry) is still
    // an orphan and remains sweepable.
    expect(byPid.get(69560)?.role).toBe("orphan");
    // The live engine worker is still an engine.
    expect(byPid.get(66606)?.role).toBe("engine");
  });

  it("does not classify a process older than the service as orphan", () => {
    // A same-pgid sibling that predates the service (etime 30:00 vs service 05:12)
    // cannot be background work this instance started.
    const fixture = `
64997 64997  5001  39000 05:12 node dist/src/index.js lark run -
4242 64997     1 100000 30:00 some-older-sibling-in-the-group
69560 64997     1 100000 02:10 ugrep -aoE younger-leak
`;
    const group = parseInstanceProcessGroup(fixture, 64997);
    const byPid = new Map(group.map((proc) => [proc.pid, proc]));
    expect(byPid.get(4242)?.role).not.toBe("orphan");
    expect(byPid.get(69560)?.role).toBe("orphan");
  });
});
