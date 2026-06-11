import { describe, expect, it } from "vitest";

import { parseInstanceProcessGroup } from "../src/runtime/background-processes.js";

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
});
