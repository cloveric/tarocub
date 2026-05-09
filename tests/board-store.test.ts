import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempRoot } from "./helpers/temp-files.js";

import { describe, expect, it } from "vitest";

import { BoardStore } from "../src/state/board-store.js";

describe("BoardStore", () => {
  it("creates durable board tasks with stable sequential ids", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const store = new BoardStore(root);

      const first = await store.createTask({
        title: "Draft launch plan",
        createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123:topic:7", messageThreadId: 7 },
      });
      const second = await store.createTask({
        title: "Review launch plan",
        createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123:topic:8", messageThreadId: 8 },
      });

      expect(first.id).toBe("B1");
      expect(second.id).toBe("B2");

      const reloaded = new BoardStore(root);
      await expect(reloaded.listTasks()).resolves.toEqual([
        expect.objectContaining({ id: "B1", title: "Draft launch plan", status: "todo" }),
        expect.objectContaining({ id: "B2", title: "Review launch plan", status: "todo" }),
      ]);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("promotes dependent tasks when their dependencies are completed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const store = new BoardStore(root);
      const design = await store.createTask({
        title: "Design API",
        createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
      });
      const build = await store.createTask({
        title: "Build API",
        createdBy: { chatId: -100123, userId: 42, conversationKey: "chat:-100123" },
      });

      await store.addDependency(build.id, design.id);
      await expect(store.getTask(build.id)).resolves.toMatchObject({
        id: "B2",
        status: "todo",
        dependencies: ["B1"],
      });

      const result = await store.completeTask(design.id, "API design accepted");

      expect(result.promotedTaskIds).toEqual(["B2"]);
      await expect(store.getTask(design.id)).resolves.toMatchObject({
        status: "done",
        summary: "API design accepted",
      });
      await expect(store.getTask(build.id)).resolves.toMatchObject({
        status: "ready",
        dependencies: ["B1"],
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("serializes concurrent writes across separate store instances", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      const [first, second] = await Promise.all([
        new BoardStore(root).createTask({ title: "Task A", createdBy: actor }),
        new BoardStore(root).createTask({ title: "Task B", createdBy: actor }),
      ]);

      expect(new Set([first.id, second.id])).toEqual(new Set(["B1", "B2"]));
      await expect(new BoardStore(root).listTasks()).resolves.toHaveLength(2);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not start a task while dependencies are still incomplete", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      await new BoardStore(root).createTask({ title: "Design", createdBy: actor });
      await new BoardStore(root).createTask({ title: "Build", createdBy: actor });
      const store = new BoardStore(root);
      await store.addDependency("B2", "B1");

      await expect(store.startTask("B2")).rejects.toThrow("unmet dependencies");
      await expect(store.getTask("B2")).resolves.toMatchObject({ status: "todo" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects dependency cycles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      const store = new BoardStore(root);
      await store.createTask({ title: "Task A", createdBy: actor });
      await store.createTask({ title: "Task B", createdBy: actor });
      await store.createTask({ title: "Task C", createdBy: actor });

      await store.addDependency("B1", "B2");
      await store.addDependency("B2", "B3");

      await expect(store.addDependency("B3", "B1")).rejects.toThrow("dependency cycle");
      await expect(store.getTask("B3")).resolves.toMatchObject({ dependencies: [] });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("rejects dependency cycles in planner-created task graphs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      const store = new BoardStore(root);

      await expect(store.createPlan({
        createdBy: actor,
        tasks: [
          { key: "design", title: "Design API", dependsOn: ["build"] },
          { key: "build", title: "Build API", dependsOn: ["design"] },
        ],
      })).rejects.toThrow("dependency cycle");

      await expect(store.listTasks()).resolves.toEqual([]);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("keeps task state separate from run attempt history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      const store = new BoardStore(root);
      await store.createTask({ title: "Build worker", createdBy: actor });

      const firstRunTask = await store.startTask("B1");
      expect(firstRunTask).toMatchObject({
        status: "running",
        runs: [expect.objectContaining({ id: "R1", status: "running" })],
      });
      await expect(store.startTask("B1")).rejects.toThrow("already running");

      const failed = await store.failTask("B1", "test failed");
      expect(failed).toMatchObject({
        status: "blocked",
        blockedReason: "test failed",
        runs: [expect.objectContaining({ id: "R1", status: "failed", error: "test failed" })],
      });

      await store.unblockTask("B1");
      await store.startTask("B1");
      await store.completeTask("B1", "worker shipped");

      await expect(store.getTask("B1")).resolves.toMatchObject({
        status: "done",
        summary: "worker shipped",
        runs: [
          expect.objectContaining({ id: "R1", status: "failed", error: "test failed" }),
          expect.objectContaining({ id: "R2", status: "done", summary: "worker shipped" }),
        ],
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("stores richer task card metadata for planner-generated work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      const store = new BoardStore(root);
      await store.createTask({ title: "Ship docs", createdBy: actor });

      const updated = await store.updateTaskCard("B1", {
        description: "Document the Board workflow",
        acceptanceCriteria: ["README updated", "state model documented"],
        priority: "high",
        labels: ["docs", "board"],
        checklist: ["Update README", "Update state model"],
        artifacts: [{ kind: "summary", value: "Initial planning note" }],
      });

      expect(updated).toMatchObject({
        description: "Document the Board workflow",
        acceptanceCriteria: ["README updated", "state model documented"],
        priority: "high",
        labels: ["docs", "board"],
        checklist: [
          expect.objectContaining({ id: "C1", text: "Update README", done: false }),
          expect.objectContaining({ id: "C2", text: "Update state model", done: false }),
        ],
        artifacts: [expect.objectContaining({ kind: "summary", value: "Initial planning note" })],
      });

      const checked = await store.setChecklistItemDone("B1", "C1", true);
      expect(checked.checklist[0]).toMatchObject({ id: "C1", done: true });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("enforces WIP limits before starting a run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123:topic:1" };
      const store = new BoardStore(root);
      await store.setLimits({ global: 2, perAssignee: 1, perConversation: 1 });
      await store.createTask({ title: "Task A", createdBy: actor });
      await store.createTask({ title: "Task B", createdBy: actor });
      await store.assignTask("B1", "writer");
      await store.assignTask("B2", "writer");

      await store.startTask("B1");

      await expect(store.startTask("B2")).rejects.toThrow("assignee WIP limit");
    } finally {
      await removeTempRoot(root);
    }
  });

  it("starts ready tasks atomically when execution requires ready state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      const store = new BoardStore(root);
      await store.createTask({ title: "Task A", createdBy: actor });

      await expect(store.startReadyTask("B1")).rejects.toThrow("must be ready");
      await expect(store.getTask("B1")).resolves.toMatchObject({ status: "todo", runs: [] });

      await store.markReady("B1");
      await expect(store.startReadyTask("B1")).resolves.toMatchObject({
        status: "running",
        runs: [expect.objectContaining({ id: "R1", status: "running" })],
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not mark blocked or review tasks ready directly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      const store = new BoardStore(root);
      await store.createTask({ title: "Blocked task", createdBy: actor });
      await store.blockTask("B1", "waiting on API");

      await expect(store.markReady("B1")).rejects.toThrow("cannot be marked ready from blocked");
      await expect(store.getTask("B1")).resolves.toMatchObject({
        status: "blocked",
        blockedReason: "waiting on API",
      });

      await store.createTask({ title: "Review task", createdBy: actor });
      await store.setReviewGate("B2", { required: true });
      await store.startTask("B2");
      await store.completeTask("B2", "ready for review");

      await expect(store.markReady("B2")).rejects.toThrow("cannot be marked ready from review");
      await expect(store.getTask("B2")).resolves.toMatchObject({ status: "review" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("does not start blocked or review tasks directly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      const store = new BoardStore(root);
      await store.createTask({ title: "Blocked task", createdBy: actor });
      await store.blockTask("B1", "waiting on API");

      await expect(store.startTask("B1")).rejects.toThrow("cannot be started from blocked");
      await expect(store.getTask("B1")).resolves.toMatchObject({
        status: "blocked",
        blockedReason: "waiting on API",
        runs: [],
      });

      await store.createTask({ title: "Review task", createdBy: actor });
      await store.setReviewGate("B2", { required: true });
      await store.startTask("B2");
      await store.completeTask("B2", "ready for review");

      await expect(store.startTask("B2")).rejects.toThrow("cannot be started from review");
      await expect(store.getTask("B2")).resolves.toMatchObject({
        status: "review",
        runs: [expect.objectContaining({ id: "R1", status: "done" })],
      });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("holds completed work in review until approved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      const store = new BoardStore(root);
      await store.createTask({ title: "Implement worker", createdBy: actor });
      await store.createTask({ title: "Document worker", createdBy: actor });
      await store.addDependency("B2", "B1");
      await store.setReviewGate("B1", { required: true, reviewer: "reviewer" });
      await store.startTask("B1");

      const completed = await store.completeTask("B1", "worker implemented");
      expect(completed.promotedTaskIds).toEqual([]);
      await expect(store.getTask("B1")).resolves.toMatchObject({
        status: "review",
        summary: "worker implemented",
        review: { required: true, reviewer: "reviewer" },
      });
      await expect(store.getTask("B2")).resolves.toMatchObject({ status: "todo" });

      const approved = await store.approveTask("B1");
      expect(approved.promotedTaskIds).toEqual(["B2"]);
      await expect(store.getTask("B1")).resolves.toMatchObject({ status: "done" });
      await expect(store.getTask("B2")).resolves.toMatchObject({ status: "ready" });
    } finally {
      await removeTempRoot(root);
    }
  });

  it("bounds stored completion summaries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      const store = new BoardStore(root);
      await store.createTask({ title: "Summarize output", createdBy: actor });
      await store.startTask("B1");

      await store.completeTask("B1", "x".repeat(5000));

      const task = await store.getTask("B1");
      expect(task?.summary).toHaveLength(4000);
      expect(task?.summary?.endsWith("...")).toBe(true);
      expect(task?.runs[0]?.summary).toBe(task?.summary);
    } finally {
      await removeTempRoot(root);
    }
  });

  it("creates a planner task graph with dependencies and card metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "telegram-board-store-"));

    try {
      const actor = { chatId: -100123, userId: 42, conversationKey: "chat:-100123" };
      const store = new BoardStore(root);
      const result = await store.createPlan({
        createdBy: actor,
        tasks: [
          {
            key: "design",
            title: "Design API",
            assignee: "planner",
            priority: "high",
            acceptanceCriteria: ["API shape agreed"],
          },
          {
            key: "build",
            title: "Build API",
            assignee: "writer",
            dependsOn: ["design"],
            labels: ["implementation"],
          },
        ],
      });

      expect(result.tasks.map((task) => task.id)).toEqual(["B1", "B2"]);
      await expect(store.getTask("B2")).resolves.toMatchObject({
        assignee: "writer",
        dependencies: ["B1"],
        labels: ["implementation"],
      });
    } finally {
      await removeTempRoot(root);
    }
  });
});
