import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseAuditEvents } from "../src/state/audit-log.js";
import { handleCrewTelegramWorkflow } from "../src/telegram/crew-workflow.js";
import type { NormalizedTelegramMessage } from "../src/telegram/update-normalizer.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function createNormalizedMessage(text: string): NormalizedTelegramMessage {
  return {
    chatId: 123,
    userId: 456,
    chatType: "private",
    text,
    attachments: [],
  };
}

function createCrewConfig(overrides?: {
  peers?: "*";
  maxDepth?: number;
  port?: number;
  secret?: string;
  parallel?: string[];
  chain?: string[];
  verifier?: string | null;
  crew?: Partial<ReturnType<typeof createCrewConfigBase>["crew"]> & {
    roles?: Partial<ReturnType<typeof createCrewConfigBase>["crew"]["roles"]>;
  };
}) {
  return {
    ...createCrewConfigBase(),
    ...overrides,
    crew: {
      ...createCrewConfigBase().crew,
      ...(overrides?.crew ?? {}),
      roles: {
        ...createCrewConfigBase().crew.roles,
        ...(overrides?.crew?.roles ?? {}),
      },
    },
  };
}

function createCrewConfigBase() {
  return {
    peers: "*",
    maxDepth: 3,
    port: 0,
    secret: "secret",
    parallel: [],
    chain: [],
    verifier: null,
    crew: {
      enabled: true,
      workflow: "research-report" as const,
      coordinator: "coordinator",
      roles: {
        researcher: "researcher",
        analyst: "analyst",
        writer: "writer",
        reviewer: "reviewer",
      },
      maxResearchQuestions: 4,
      maxRevisionRounds: 1,
    },
  };
}

describe("handleCrewTelegramWorkflow", () => {
  it("runs the fixed research-report workflow through the coordinator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValueOnce({
        text: "1. Which industries are changing fastest?\n2. What measurable impact is already visible?",
      }),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ text: "Research findings A" })
      .mockResolvedValueOnce({ text: "Research findings B" })
      .mockResolvedValueOnce({ text: "Analysis summary" })
      .mockResolvedValueOnce({ text: "Draft report" })
      .mockResolvedValueOnce({ text: "VERDICT: PASS\nISSUES:\n- none" });

    try {
      const handled = await handleCrewTelegramWorkflow({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Analyze how AI is changing major industries."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 90,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: delegateToInstance as never,
      });

      expect(handled).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      const coordinatorInput = bridge.handleAuthorizedMessage.mock.calls[0]?.[0];
      expect(coordinatorInput?.chatId).toBeLessThan(-9_000_000_000_000);
      expect(delegateToInstance).toHaveBeenNthCalledWith(1, expect.objectContaining({
        fromInstance: "coordinator",
        targetInstance: "researcher",
        prompt: expect.stringContaining("Your only job is to find accurate"),
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(3, expect.objectContaining({
        targetInstance: "analyst",
        prompt: expect.stringContaining("Research findings A"),
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(4, expect.objectContaining({
        targetInstance: "writer",
        prompt: expect.stringContaining("Analysis summary"),
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(5, expect.objectContaining({
        targetInstance: "reviewer",
        prompt: expect.stringContaining("Draft report"),
      }));
      expect(sendMessage).toHaveBeenCalledWith(123, "Running research-report crew...");
      expect(sendMessage).toHaveBeenCalledWith(123, "Draft report");

      const audit = parseAuditEvents(await readFile(path.join(root, "audit.log.jsonl"), "utf8"));
      expect(audit).toContainEqual(expect.objectContaining({
        type: "update.handle",
        outcome: "success",
        metadata: expect.objectContaining({
          command: "crew",
          workflow: "research-report",
          coordinator: "coordinator",
          reviewerVerdict: "pass",
        }),
      }));

      const runFiles = await readdir(path.join(root, "crew-runs"));
      expect(runFiles).toHaveLength(1);
      const crewRun = JSON.parse(
        await readFile(path.join(root, "crew-runs", runFiles[0]!), "utf8"),
      ) as Record<string, unknown>;
      expect(crewRun).toEqual(expect.objectContaining({
        workflow: "research-report",
        status: "completed",
        currentStage: "completed",
        coordinator: "coordinator",
        originalPrompt: "Analyze how AI is changing major industries.",
        finalOutput: "Draft report",
        stages: expect.objectContaining({
          decomposition: expect.objectContaining({
            status: "completed",
            subQuestions: [
              "Which industries are changing fastest?",
              "What measurable impact is already visible?",
            ],
          }),
          research: expect.objectContaining({
            status: "completed",
            findings: ["Research findings A", "Research findings B"],
          }),
          analysis: expect.objectContaining({
            status: "completed",
            output: "Analysis summary",
          }),
          writing: expect.objectContaining({
            status: "completed",
            draft: "Draft report",
            revisionCount: 0,
          }),
          review: expect.objectContaining({
            status: "completed",
            verdict: "pass",
            issues: "- none",
          }),
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes reviewer issues back to the writer for one revision round", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValueOnce({
        text: "1. What happened?\n2. Why does it matter?",
      }),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ text: "Research X" })
      .mockResolvedValueOnce({ text: "Research Y" })
      .mockResolvedValueOnce({ text: "Analysis Z" })
      .mockResolvedValueOnce({ text: "Initial draft" })
      .mockResolvedValueOnce({ text: "VERDICT: REVISE\nISSUES:\n- Add concrete numbers." })
      .mockResolvedValueOnce({ text: "Revised draft with numbers" })
      .mockResolvedValueOnce({ text: "VERDICT: PASS\nISSUES:\n- none" });

    try {
      const handled = await handleCrewTelegramWorkflow({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Explain the business impact of AI."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 91,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: delegateToInstance as never,
      });

      expect(handled).toBe(true);
      expect(delegateToInstance).toHaveBeenNthCalledWith(6, expect.objectContaining({
        targetInstance: "writer",
        prompt: expect.stringContaining("Add concrete numbers."),
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(7, expect.objectContaining({
        targetInstance: "reviewer",
        prompt: expect.stringContaining("Revised draft with numbers"),
      }));
      expect(sendMessage).toHaveBeenCalledWith(123, "Revised draft with numbers");

      const runFiles = await readdir(path.join(root, "crew-runs"));
      expect(runFiles).toHaveLength(1);
      const crewRun = JSON.parse(
        await readFile(path.join(root, "crew-runs", runFiles[0]!), "utf8"),
      ) as Record<string, unknown>;
      expect(crewRun).toEqual(expect.objectContaining({
        status: "completed",
        currentStage: "completed",
        finalOutput: "Revised draft with numbers",
        stages: expect.objectContaining({
          writing: expect.objectContaining({
            status: "completed",
            draft: "Revised draft with numbers",
            revisionCount: 1,
          }),
          review: expect.objectContaining({
            status: "completed",
            verdict: "pass",
            issues: "- none",
          }),
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports more than one revision round when maxRevisionRounds allows it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValueOnce({
        text: "1. What happened?\n2. Why does it matter?",
      }),
    };
    const delegateToInstance = vi.fn()
      .mockResolvedValueOnce({ text: "Research X" })
      .mockResolvedValueOnce({ text: "Research Y" })
      .mockResolvedValueOnce({ text: "Analysis Z" })
      .mockResolvedValueOnce({ text: "Initial draft" })
      .mockResolvedValueOnce({ text: "VERDICT: REVISE\nISSUES:\n- Add concrete numbers." })
      .mockResolvedValueOnce({ text: "Revised draft with numbers" })
      .mockResolvedValueOnce({ text: "VERDICT: PASS\nISSUES:\n- none" });

    try {
      const handled = await handleCrewTelegramWorkflow({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Explain the business impact of AI."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 92,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig({
          crew: { maxRevisionRounds: 2 },
        })),
        delegateToInstance: delegateToInstance as never,
      });

      expect(handled).toBe(true);
      expect(delegateToInstance).toHaveBeenNthCalledWith(6, expect.objectContaining({
        targetInstance: "writer",
        prompt: expect.stringContaining("Add concrete numbers."),
      }));
      expect(delegateToInstance).toHaveBeenNthCalledWith(7, expect.objectContaining({
        targetInstance: "reviewer",
        prompt: expect.stringContaining("Revised draft with numbers"),
      }));
      expect(sendMessage).toHaveBeenCalledWith(123, "Revised draft with numbers");

      const runFiles = await readdir(path.join(root, "crew-runs"));
      const crewRun = JSON.parse(
        await readFile(path.join(root, "crew-runs", runFiles[0]!), "utf8"),
      ) as Record<string, unknown>;
      expect(crewRun).toEqual(expect.objectContaining({
        status: "completed",
        finalOutput: "Revised draft with numbers",
        stages: expect.objectContaining({
          writing: expect.objectContaining({
            revisionCount: 1,
          }),
          review: expect.objectContaining({
            verdict: "pass",
          }),
        }),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a second crew run for the same chat while one is already active", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const bridgeGate = createDeferred<{ text: string }>();
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockReturnValueOnce(bridgeGate.promise),
    };

    try {
      const firstRun = handleCrewTelegramWorkflow({
        stateDir: root,
        startedAt: Date.now(),
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Analyze adoption trends."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 93,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: vi.fn() as never,
      });

      await Promise.resolve();

      const handledSecond = await handleCrewTelegramWorkflow({
        stateDir: root,
        startedAt: Date.now(),
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Analyze adoption trends."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 94,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: vi.fn() as never,
      });

      expect(handledSecond).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(123, "A crew run is already active for this chat.");

      bridgeGate.resolve({
        text: "1. Which industries are changing fastest?\n2. What measurable impact is already visible?",
      });
      await firstRun;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs research sub-questions in parallel and continues when one specialist fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-crew-workflow-"));
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 11 });
    const bridge = {
      handleAuthorizedMessage: vi.fn().mockResolvedValueOnce({
        text: "1. What changed first?\n2. What is measurable now?",
      }),
    };
    const firstResearch = createDeferred<{ text: string }>();
    const secondResearch = createDeferred<{ text: string }>();
    const researchCalls: string[] = [];
    const delegateToInstance = vi.fn().mockImplementation(async (input: { targetInstance: string; prompt: string }) => {
      if (input.targetInstance === "researcher") {
        researchCalls.push(input.prompt);
        if (researchCalls.length === 1) {
          return await firstResearch.promise;
        }
        return await secondResearch.promise;
      }
      if (input.targetInstance === "analyst") {
        return { text: "Analysis summary" };
      }
      if (input.targetInstance === "writer") {
        return { text: "Draft report" };
      }
      if (input.targetInstance === "reviewer") {
        return { text: "VERDICT: PASS\nISSUES:\n- none" };
      }
      throw new Error(`unexpected target ${input.targetInstance}`);
    });

    try {
      const runPromise = handleCrewTelegramWorkflow({
        stateDir: root,
        startedAt: Date.now() - 10,
        locale: "en",
        cfg: {},
        normalized: createNormalizedMessage("Explain the impact of AI."),
        context: {
          api: { sendMessage } as never,
          bridge: bridge as never,
          instanceName: "coordinator",
          updateId: 95,
        },
        loadBusConfig: vi.fn().mockResolvedValue(createCrewConfig()),
        delegateToInstance: delegateToInstance as never,
      });

      for (let attempt = 0; attempt < 20 && researchCalls.length < 2; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(researchCalls).toHaveLength(2);

      firstResearch.resolve({ text: "Research findings A" });
      secondResearch.reject(new Error("research timeout"));

      const handled = await runPromise;
      expect(handled).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(123, "Research stage completed with 1 failed sub-question.");
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({
        targetInstance: "analyst",
        prompt: expect.stringContaining("Research findings A"),
      }));
      expect(delegateToInstance).toHaveBeenCalledWith(expect.objectContaining({
        targetInstance: "analyst",
        prompt: expect.stringContaining("RESEARCH FAILED: research timeout"),
      }));
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await rm(root, { recursive: true, force: true });
    }
  });
});
