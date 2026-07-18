import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { LarkGoalRunController, claimLarkRunSlot } from "../src/lark/bus.js";
import { buildLarkCronExecutor } from "../src/lark/cron.js";
import { stableLarkNumericId } from "../src/lark/message-normalizer.js";
import { createLarkServiceRuntime, handleLarkMessage } from "../src/lark/service.js";
import { BoardStore } from "../src/state/board-store.js";
import { CronStore } from "../src/state/cron-store.js";
import { FileWorkflowStore } from "../src/state/file-workflow-store.js";
import { MiniBusStore } from "../src/state/mini-bus-store.js";
import { removeTempRoot } from "./helpers/temp-files.js";

async function cleanupTempRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await removeTempRoot(root);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  await removeTempRoot(root).catch(() => undefined);
}

function fakeLarkMessage(overrides: Partial<{
  messageId: string;
  chatId: string;
  chatType: string;
  content: string;
  mentionedBot: boolean;
}> = {}) {
  return {
    messageId: overrides.messageId ?? "om_1",
    chatId: overrides.chatId ?? "oc_chat",
    chatType: overrides.chatType ?? "p2p",
    senderId: "ou_user",
    content: overrides.content ?? "hello",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: overrides.mentionedBot ?? false,
    createTime: Date.now(),
  };
}

function fakeChannel() {
  return {
    send: vi.fn(async (_to: string, _payload: unknown, _options?: unknown) => ({ messageId: "sent_1" })),
    stream: vi.fn(async (_to: string, input: {
      card: {
        initial: object;
        producer: (controller: { messageId: string; current: object; update: () => Promise<void> }) => Promise<void>;
      };
    }) => {
      await input.card.producer({
        messageId: "stream_1",
        current: input.card.initial,
        update: async () => undefined,
      });
      return { messageId: "stream_1" };
    }),
    updateCard: vi.fn(async (_messageId: string, _card?: unknown) => undefined),
    recallMessage: vi.fn(async () => undefined),
    downloadResource: vi.fn(async () => Buffer.from("")),
    addReaction: vi.fn(async (_messageId: string, _emojiType: string) => "reaction-1"),
  };
}

const allowAccess = () => vi.fn(async () => ({ kind: "allow" as const }));

/** An engine-turn mock that hangs until its abortSignal fires, then resolves. */
function hangingTurn() {
  return vi.fn(async (turnInput: { abortSignal?: AbortSignal }) => {
    if (!turnInput.abortSignal?.aborted) {
      await new Promise<void>((resolve) => {
        turnInput.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return { text: "interrupted midway" };
  });
}

describe("LarkGoalRunController stop routing (finding 1)", () => {
  it("routes abort() to a live attached ordinary turn and keeps the pursuit alive", () => {
    const goal = new LarkGoalRunController();
    const turn = { abortController: new AbortController() };
    goal.attachConcurrentTurn(turn);

    goal.abort();

    expect(turn.abortController.signal.aborted).toBe(true);
    expect(goal.signal.aborted).toBe(false);
  });

  it("abort() stops the pursuit itself once no attached turn is live", () => {
    const goal = new LarkGoalRunController();
    const turn = { abortController: new AbortController() };
    goal.attachConcurrentTurn(turn);

    goal.abort(); // first stop: the ordinary turn
    goal.abort(); // second stop: nothing else runs → the pursuit

    expect(goal.signal.aborted).toBe(true);
  });

  it("abortGoal() always ends the pursuit without touching the attached turn", () => {
    const goal = new LarkGoalRunController();
    const turn = { abortController: new AbortController() };
    goal.attachConcurrentTurn(turn);

    goal.abortGoal();

    expect(goal.signal.aborted).toBe(true);
    expect(turn.abortController.signal.aborted).toBe(false);
  });

  it("abortAll() ends the pursuit and the attached turn (replacing /goal)", () => {
    const goal = new LarkGoalRunController();
    const turn = { abortController: new AbortController() };
    goal.attachConcurrentTurn(turn);

    goal.abortAll();

    expect(goal.signal.aborted).toBe(true);
    expect(turn.abortController.signal.aborted).toBe(true);
  });

  it("a stale detach never clobbers a newer attachment", () => {
    const goal = new LarkGoalRunController();
    const oldTurn = { abortController: new AbortController() };
    const detachOld = goal.attachConcurrentTurn(oldTurn);
    const newTurn = { abortController: new AbortController() };
    goal.attachConcurrentTurn(newTurn);

    detachOld();
    goal.abort();

    expect(newTurn.abortController.signal.aborted).toBe(true);
    expect(goal.signal.aborted).toBe(false);
  });
});

describe("claimLarkRunSlot (finding 1)", () => {
  it("claims an empty slot and the guarded release deletes only its own claim", () => {
    const runtime = createLarkServiceRuntime();
    const run = { abortController: new AbortController(), startedAt: Date.now() };

    const release = claimLarkRunSlot(runtime, "lark:k", run);
    expect(runtime.activeRuns.get("lark:k")).toBe(run);

    const newer = { abortController: new AbortController() };
    runtime.activeRuns.set("lark:k", newer);
    release();
    expect(runtime.activeRuns.get("lark:k")).toBe(newer); // not clobbered
  });

  it("attaches to a routing-capable goal pursuit instead of stealing its slot", () => {
    const runtime = createLarkServiceRuntime();
    const goal = new LarkGoalRunController();
    const goalRun = { abortController: goal, goalWatch: true as const };
    runtime.activeRuns.set("lark:k", goalRun);
    const run = { abortController: new AbortController(), startedAt: Date.now() };

    const release = claimLarkRunSlot(runtime, "lark:k", run);
    expect(runtime.activeRuns.get("lark:k")).toBe(goalRun); // pursuit keeps the slot
    expect(goal.liveConcurrentTurn()).toBe(run);

    release();
    expect(goal.liveConcurrentTurn()).toBeNull();
    expect(runtime.activeRuns.get("lark:k")).toBe(goalRun); // still the pursuit's
  });

  it("leaves a non-routing goalWatch holder untouched (the turn runs unslotted)", () => {
    const runtime = createLarkServiceRuntime();
    const goalRun = { abortController: new AbortController(), goalWatch: true as const };
    runtime.activeRuns.set("lark:k", goalRun);
    const run = { abortController: new AbortController() };

    const release = claimLarkRunSlot(runtime, "lark:k", run);
    expect(runtime.activeRuns.get("lark:k")).toBe(goalRun);
    expect(goalRun.abortController.signal.aborted).toBe(false);

    release();
    expect(runtime.activeRuns.get("lark:k")).toBe(goalRun);
  });

  it("onOccupied \"leave\" keeps a live non-goal occupant (speculative bus-command claims)", () => {
    const runtime = createLarkServiceRuntime();
    const occupant = { abortController: new AbortController() };
    runtime.activeRuns.set("lark:k", occupant);
    const run = { abortController: new AbortController(), startedAt: Date.now() };

    const release = claimLarkRunSlot(runtime, "lark:k", run, { onOccupied: "leave" });
    expect(runtime.activeRuns.get("lark:k")).toBe(occupant); // not clobbered

    release();
    expect(runtime.activeRuns.get("lark:k")).toBe(occupant);
    expect(occupant.abortController.signal.aborted).toBe(false);
  });

  it("cleans up a slot the attached turn was promoted into after the pursuit ended", () => {
    const runtime = createLarkServiceRuntime();
    const goal = new LarkGoalRunController();
    runtime.activeRuns.set("lark:k", { abortController: goal, goalWatch: true });
    const run = { abortController: new AbortController(), startedAt: Date.now() };
    const release = claimLarkRunSlot(runtime, "lark:k", run);

    // The /goal watcher's finally promotes the still-live attached turn.
    runtime.activeRuns.set("lark:k", run);

    release();
    expect(runtime.activeRuns.has("lark:k")).toBe(false);
  });
});

describe("goal pursuit survives ordinary traffic (finding 1)", () => {
  it("an ordinary message runs its own turn while the pursuit keeps its slot and stays alive", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-goalflow-msg-"));
    const runtime = createLarkServiceRuntime();
    const goal = new LarkGoalRunController();
    runtime.activeRuns.set("lark:oc_chat", { abortController: goal, hasRunCard: true, goalWatch: true, startedAt: Date.now() });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: allowAccess(),
      handleAuthorizedMessage: vi.fn(async (turnInput: { abortSignal?: AbortSignal }) => {
        expect(turnInput.abortSignal).toBeDefined();
        expect(turnInput.abortSignal).not.toBe(goal.signal); // own controller
        return { text: "ordinary answer" };
      }),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_during_goal", content: "进展如何？" }),
      });

      expect(goal.signal.aborted).toBe(false);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(runtime.activeRuns.get("lark:oc_chat")?.abortController).toBe(goal);
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("/stop stops the concurrent ordinary turn first, then the pursuit when nothing else runs", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-goalflow-stop-"));
    const runtime = createLarkServiceRuntime();
    const goal = new LarkGoalRunController();
    runtime.activeRuns.set("lark:oc_chat", { abortController: goal, hasRunCard: true, goalWatch: true, startedAt: Date.now() });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: allowAccess(),
      handleAuthorizedMessage: hangingTurn(),
    };

    try {
      const ordinary = handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_hanging", content: "帮我算一下" }),
      });
      await vi.waitFor(() => expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1));
      expect(goal.liveConcurrentTurn()).not.toBeNull();

      // First /stop: stops the ORDINARY turn; the pursuit survives.
      await handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_stop_1", content: "/stop" }),
      });
      await ordinary;
      const turnSignal = (bridge.handleAuthorizedMessage.mock.calls[0]![0] as { abortSignal?: AbortSignal }).abortSignal;
      expect(turnSignal?.aborted).toBe(true);
      expect(goal.signal.aborted).toBe(false);
      expect(runtime.activeRuns.get("lark:oc_chat")?.abortController).toBe(goal);

      // Second /stop with nothing else running: stops the pursuit itself.
      await handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_stop_2", content: "/stop" }),
      });
      expect(goal.signal.aborted).toBe(true);
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("a same-conversation cron firing leaves the pursuit alive and slotted", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-goalflow-cron-"));
    const runtime = createLarkServiceRuntime();
    const goal = new LarkGoalRunController();
    runtime.activeRuns.set("lark:oc_cron", { abortController: goal, hasRunCard: true, goalWatch: true, startedAt: Date.now() });
    const channel = { send: vi.fn().mockResolvedValue({ messageId: "om_cron" }) };
    const bridge = {
      checkAccess: allowAccess(),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "cron done" })),
    };

    try {
      const store = new CronStore(stateDir);
      const job = await store.add({
        channel: "lark",
        chatId: 1,
        userId: 2,
        chatType: "private",
        cronExpr: "0 9 * * *",
        prompt: "daily brief",
        larkChatId: "oc_cron",
        conversationKey: "lark:oc_cron",
        locale: "en",
      });
      const executor = buildLarkCronExecutor({
        channel: channel as never,
        bridge: bridge as never,
        runtime,
        stateDir,
      });
      await executor(job);

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(goal.signal.aborted).toBe(false);
      expect(runtime.activeRuns.get("lark:oc_cron")?.abortController).toBe(goal);
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("/goal clear ends the pursuit without killing a concurrently running ordinary turn", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-goalflow-clear-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex" }) + "\n");
    const runtime = createLarkServiceRuntime();
    const goal = new LarkGoalRunController();
    const concurrent = { abortController: new AbortController() };
    goal.attachConcurrentTurn(concurrent);
    runtime.activeRuns.set("lark:oc_chat", { abortController: goal, hasRunCard: true, goalWatch: true, startedAt: Date.now() });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: allowAccess(),
      clearThreadGoal: vi.fn(async () => ({ cleared: true })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_goal_clear", content: "/goal clear" }),
      });

      expect(goal.signal.aborted).toBe(true); // the pursuit is gone
      expect(concurrent.abortController.signal.aborted).toBe(false); // the turn is not
      // Its own abort path clears the engine-side goal; no double clear here.
      expect(bridge.clearThreadGoal).not.toHaveBeenCalled();
      expect(JSON.stringify(channel.send.mock.calls)).toContain("已清除");
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });
});

describe("preempt authorization gate (finding 3)", () => {
  it("an unauthorized sender in preempt mode does not abort the active run", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-preempt-denied-"));
    const runtime = createLarkServiceRuntime({ queuePolicy: { preempt: true } });
    const active = { abortController: new AbortController(), startedAt: Date.now() };
    runtime.activeRuns.set("lark:oc_chat", active);
    const channel = fakeChannel();
    const bridge = {
      checkAccess: vi.fn(async () => ({ kind: "deny" as const, text: "denied" })),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_preempt_deny", content: "kill the turn" }),
      });

      expect(active.abortController.signal.aborted).toBe(false);
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("an authorized sender in preempt mode still replaces the active run", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-preempt-allow-"));
    const runtime = createLarkServiceRuntime({ queuePolicy: { preempt: true } });
    const active = { abortController: new AbortController(), startedAt: Date.now() };
    runtime.activeRuns.set("lark:oc_chat", active);
    const channel = fakeChannel();
    const bridge = {
      checkAccess: allowAccess(),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "replacement answer" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_preempt_allow", content: "new task" }),
      });

      expect(active.abortController.signal.aborted).toBe(true);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("preempt mode never kills a pursued /goal (only its concurrent ordinary turn)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-preempt-goal-"));
    const runtime = createLarkServiceRuntime({ queuePolicy: { preempt: true } });
    const goal = new LarkGoalRunController();
    runtime.activeRuns.set("lark:oc_chat", { abortController: goal, hasRunCard: true, goalWatch: true, startedAt: Date.now() });
    const channel = fakeChannel();
    const bridge = {
      checkAccess: allowAccess(),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "still answered" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_preempt_goal", content: "hello there" }),
      });

      expect(goal.signal.aborted).toBe(false);
      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      expect(runtime.activeRuns.get("lark:oc_chat")?.abortController).toBe(goal);
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });
});

describe("board/mini/ask turns are stoppable (finding 4)", () => {
  it("a running /mini ask turn is registered in activeRuns and abortable via its handle", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-mini-stop-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: allowAccess(),
      handleAuthorizedMessage: hangingTurn(),
    };

    try {
      await new MiniBusStore(stateDir).upsertPeer({
        chatId: stableLarkNumericId("lark-group:oc_group"),
        name: "peer1",
        conversationKey: "lark:oc_peer",
      });

      const ask = handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({
          messageId: "om_mini_ask",
          chatId: "oc_group",
          chatType: "group",
          content: "/mini ask peer1 think about it for a long time",
        }),
      });

      await vi.waitFor(() => expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1));
      const run = runtime.activeRuns.get("lark:oc_group");
      expect(run).toBeDefined();
      expect(run!.startedAt).toBeDefined();

      run!.abortController.abort();
      await ask;

      const turnSignal = (bridge.handleAuthorizedMessage.mock.calls[0]![0] as { abortSignal?: AbortSignal }).abortSignal;
      expect(turnSignal?.aborted).toBe(true);
      // Guarded cleanup released the slot after the command finished.
      expect(runtime.activeRuns.has("lark:oc_group")).toBe(false);
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("a running /board run turn is registered in activeRuns and abortable via its handle", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-board-stop-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: allowAccess(),
      handleAuthorizedMessage: hangingTurn(),
    };

    try {
      const board = new BoardStore(stateDir);
      const task = await board.createTask({
        title: "long task",
        assignee: "peer1",
        createdBy: {
          chatId: stableLarkNumericId("lark:oc_chat"),
          userId: stableLarkNumericId("user:ou_user"),
          conversationKey: "lark:oc_chat",
        },
      });
      await board.markReady(task.id);
      await new MiniBusStore(stateDir).upsertPeer({
        chatId: stableLarkNumericId("lark:oc_chat"),
        name: "peer1",
        conversationKey: "lark:oc_peer",
      });

      const run = handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_board_run", content: `/board run ${task.id}` }),
      });

      await vi.waitFor(() => expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1));
      const active = runtime.activeRuns.get("lark:oc_chat");
      expect(active).toBeDefined();
      expect(active!.startedAt).toBeDefined();

      active!.abortController.abort();
      await run;

      const turnSignal = (bridge.handleAuthorizedMessage.mock.calls[0]![0] as { abortSignal?: AbortSignal }).abortSignal;
      expect(turnSignal?.aborted).toBe(true);
      expect(runtime.activeRuns.has("lark:oc_chat")).toBe(false);
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });
});

describe("/steer 0s means unlimited (finding 6)", () => {
  it("accepts 0 with a unit suffix as unlimited instead of erroring", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-steer-zero-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: allowAccess(),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "done" })),
    };
    const send = async (content: string, messageId: string) => {
      await handleLarkMessage({ channel, bridge: bridge as never, runtime, stateDir, message: fakeLarkMessage({ messageId, content }) });
    };

    try {
      await send("/steer 0s", "om_steer_0s");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("不限时");
      channel.send.mockClear();

      await send("/steer 0分钟", "om_steer_0min");
      expect(JSON.stringify(channel.send.mock.calls)).toContain("不限时");
      expect(JSON.stringify(channel.send.mock.calls)).not.toContain("窗口需在");
      // Commands never reach the engine.
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });
});

describe("leaked file-workflow records (finding 7)", () => {
  it("marks the workflow record failed when the /continue turn errors out", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-workflow-fail-"));
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: allowAccess(),
      handleAuthorizedMessage: vi.fn(async () => {
        throw new Error("engine exploded");
      }),
    };

    try {
      const store = new FileWorkflowStore(stateDir);
      await store.append({
        uploadId: "arch-1",
        chatId: stableLarkNumericId("lark:oc_chat"),
        userId: stableLarkNumericId("user:ou_user"),
        kind: "archive",
        status: "awaiting_continue",
        sourceFiles: [],
        derivedFiles: [],
        summary: "waiting archive",
        createdAt: new Date("2026-07-01T00:00:00.000Z").toISOString(),
        updatedAt: new Date("2026-07-01T00:00:00.000Z").toISOString(),
      });

      await handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_continue", content: "/continue" }),
      });

      expect(bridge.handleAuthorizedMessage).toHaveBeenCalledTimes(1);
      // /continue flipped the record to "processing"; the turn error must not
      // leave it stuck there (it would count against the active-task cap forever).
      expect((await store.find("arch-1"))?.status).toBe("failed");
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("boot recovery fails interrupted processing records (the store call the Lark boot path now wires)", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-workflow-boot-"));
    try {
      const store = new FileWorkflowStore(stateDir);
      await store.append({
        uploadId: "leak-1",
        chatId: 1,
        userId: 2,
        kind: "archive",
        status: "processing",
        sourceFiles: [],
        derivedFiles: [],
        summary: "interrupted by crash",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const failed = await store.failInterruptedProcessing();

      expect(failed).toBe(1);
      expect((await store.find("leak-1"))?.status).toBe("failed");
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });
});

describe("budget note for non-Claude engines (finding 8)", () => {
  it("/usage on a codex-engine config with a budget includes the honest note", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-budget-note-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "codex", budgetUsd: 5 }) + "\n");
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: allowAccess(),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_usage", content: "/usage" }),
      });

      expect(JSON.stringify(channel.send.mock.calls)).toContain("Codex/Antigravity 引擎不上报美元成本");
      expect(bridge.handleAuthorizedMessage).not.toHaveBeenCalled();
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });

  it("/usage on a claude-engine config stays note-free", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "cctb-lark-budget-note-claude-"));
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", budgetUsd: 5 }) + "\n");
    const runtime = createLarkServiceRuntime();
    const channel = fakeChannel();
    const bridge = {
      checkAccess: allowAccess(),
      handleAuthorizedMessage: vi.fn(async () => ({ text: "should not run" })),
    };

    try {
      await handleLarkMessage({
        channel,
        bridge: bridge as never,
        runtime,
        stateDir,
        message: fakeLarkMessage({ messageId: "om_usage_claude", content: "/usage" }),
      });

      expect(JSON.stringify(channel.send.mock.calls)).not.toContain("不上报美元成本");
    } finally {
      await cleanupTempRoot(stateDir);
    }
  });
});
