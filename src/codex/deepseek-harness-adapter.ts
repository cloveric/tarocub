import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AdapterUsage,
  CodexAdapter,
  CodexAdapterResponse,
  CodexThreadGoal,
  CodexThreadGoalResponse,
  CodexUserMessageInput,
  EngineContextUsage,
  EngineApprovalDecision,
  EngineApprovalRequest,
  EngineStreamEvent,
  ExternalSessionInfo,
} from "./adapter.js";
import {
  DeepSeekHarnessRpcError,
  type DeepSeekHarnessProtocolHandlers,
  type DeepSeekHarnessReconnectInfo,
  type DeepSeekHarnessServerRequest,
} from "./deepseek-harness-protocol.js";
import { ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS } from "./engine-timeouts.js";
import { DEFAULT_APPROVAL_MODE, normalizeApprovalMode } from "../state/approval-mode.js";
import { readValidatedConfigFile } from "../telegram/instance-config.js";

export const DEEPSEEK_HARNESS_TURN_TIMEOUT_MS = 6 * 60 * 60_000;
export const DEEPSEEK_HARNESS_INACTIVITY_TIMEOUT_MS = ENGINE_DEFAULT_INACTIVITY_TIMEOUT_MS;

export interface DeepSeekHarnessGateway {
  connect(handlers: DeepSeekHarnessProtocolHandlers): Promise<void>;
  request(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
  respond(rpcId: string, value: unknown, signal?: AbortSignal): Promise<{ accepted: boolean; reason?: string }>;
  respondError(
    rpcId: string,
    error: { code: string; message: string; details?: unknown },
    signal?: AbortSignal,
  ): Promise<{ accepted: boolean; reason?: string }>;
  close(): Promise<void>;
}

export type DeepSeekHarnessPermissionPreset =
  | "read-only"
  | "workspace-write"
  | "full-auto"
  | "danger-full-access";

export interface DeepSeekHarnessModelSelection {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface DeepSeekHarnessAdapterOptions {
  gateway: DeepSeekHarnessGateway;
  workspacePath: string;
  permissionPreset?: DeepSeekHarnessPermissionPreset;
  model?: DeepSeekHarnessModelSelection;
  configPath?: string;
  goalStatePath?: string;
  clientTimeZone?: string;
  turnSettleDelayMs?: number;
  backgroundReviewGraceMs?: number;
  turnTimeoutMs?: number | null;
  inactivityTimeoutMs?: number | null;
}

type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type ToolCall = {
  name: string;
  input: unknown;
};

type Job = {
  id: string;
  kind: string;
  label: string;
  status: "running" | "stopping" | "completed" | "killed" | "failed";
  detail?: string;
  startedAt: number;
  finishedAt?: number;
};

type GoalProjection = {
  goal: {
    id: string;
    revision: number;
    objective: string;
    phase: "active" | "paused" | "blocked" | "complete";
    maxGoalRounds: number;
    blockedReason?: { code: string; message: string };
  };
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
};

type GoalBudgetState = {
  goalId: string;
  tokenBudget: number | null;
  baselineTokens: number;
};

type PendingTurn = {
  claimId: string;
  sessionId: string;
  input: CodexUserMessageInput;
  workspace: string;
  resolve: (response: CodexAdapterResponse) => void;
  reject: (error: unknown) => void;
  promise: Promise<CodexAdapterResponse>;
  text: string;
  lastSeq: number;
  emittedSession: boolean;
  turnsStarted: number;
  turnsEnded: Set<number>;
  activeTurns: Set<number>;
  chunkedSteps: Set<string>;
  reasoningChunkedSteps: Set<string>;
  usageByStep: Map<string, Usage>;
  toolCalls: Map<string, ToolCall>;
  outstandingToolCalls: Set<string>;
  liveJobs: Set<string>;
  sawBackground: boolean;
  awaitingReview: boolean;
  settling: boolean;
  settled: boolean;
  settleTimer?: ReturnType<typeof setTimeout>;
  backgroundTimer?: ReturnType<typeof setTimeout>;
  abortController: AbortController;
  abortListener?: () => void;
  hardTimeout?: ReturnType<typeof setTimeout>;
  inactivityTimeout?: ReturnType<typeof setTimeout>;
  lastActivityAt: number;
  timeoutsDisabled: boolean;
};

type SessionTurnOwner = "foreground" | "goal";

type SessionTurnClaim = {
  owner: SessionTurnOwner;
  claimId: string;
};

type SessionTurnRouting = {
  openTurn?: number;
  owners: Map<number, SessionTurnOwner>;
  claims: Map<number, SessionTurnClaim>;
  pendingStarts: Map<number, Record<string, unknown>>;
};

type TransportRecoveryBarrier = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type GoalWatcher = {
  claimId: string;
  sessionId: string;
  workspace: string;
  goalId?: string;
  onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
  onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
  resolve: (response: CodexThreadGoalResponse) => void;
  reject: (error: unknown) => void;
  promise: Promise<CodexThreadGoalResponse>;
  latestGoal: CodexThreadGoal | null;
  settled: boolean;
  abortController: AbortController;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
  pollTimer?: ReturnType<typeof setTimeout>;
  chunkedSteps: Set<string>;
  reasoningChunkedSteps: Set<string>;
  toolCalls: Map<string, ToolCall>;
};

type HistoryResponse = {
  events?: unknown[];
  hasMore?: boolean;
  projections?: {
    asOfSeq?: number;
    values?: Record<string, unknown>;
  };
};

type SessionListItem = {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  projections?: {
    asOfSeq?: number;
    values?: Record<string, unknown>;
  };
};

export class DeepSeekHarnessAdapter implements CodexAdapter {
  readonly bridgeInstructionMode = "generic-file-blocks" as const;
  readonly supportsTurnScopedEnv = false;

  private readonly gateway: DeepSeekHarnessGateway;
  private readonly workspacePath: string;
  private readonly permissionPreset: DeepSeekHarnessPermissionPreset;
  private readonly model?: DeepSeekHarnessModelSelection;
  private readonly configPath?: string;
  private readonly goalStatePath?: string;
  private readonly clientTimeZone: string;
  private readonly turnSettleDelayMs: number;
  private readonly backgroundReviewGraceMs: number;
  private readonly turnTimeoutMs: number | null;
  private readonly inactivityTimeoutMs: number | null;
  private readonly knownSessionWorkspaces = new Map<string, string>();
  private readonly configuredSessions = new Map<string, string>();
  private readonly activeSessionClaims = new Set<string>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly goalWatchers = new Map<string, GoalWatcher>();
  private readonly turnRouting = new Map<string, SessionTurnRouting>();
  private readonly sessionEventSeqs = new Map<string, number>();
  private readonly jobsBySession = new Map<string, Map<string, Job>>();
  private readonly jobOwnersBySession = new Map<string, Map<string, SessionTurnClaim>>();
  private readonly sessionApprovalGrants = new Map<string, Set<string>>();
  private readonly projectionValues = new Map<string, Record<string, unknown>>();
  private readonly projectionWatermarks = new Map<string, Map<string, number>>();
  private readonly goalBudgetStates = new Map<string, GoalBudgetState>();
  private readonly goalBudgetPausePromises = new Map<string, Promise<void>>();
  private readonly eventChains = new Map<string, Promise<void>>();
  private readonly bufferedFrames: DeepSeekHarnessServerRequest[] = [];
  private connectPromise: Promise<void> | undefined;
  private hostDefaultModel: DeepSeekHarnessModelSelection | undefined;
  private hostDefaultModelPromise: Promise<DeepSeekHarnessModelSelection> | undefined;
  private goalStateLoadPromise: Promise<void> | undefined;
  private goalStateWriteChain: Promise<void> = Promise.resolve();
  private transportRecoveryBarrier: TransportRecoveryBarrier | undefined;
  private recoveringTransport = false;
  private destroyed = false;

  constructor(options: DeepSeekHarnessAdapterOptions) {
    this.gateway = options.gateway;
    this.workspacePath = path.resolve(options.workspacePath);
    this.permissionPreset = options.permissionPreset ?? "workspace-write";
    this.model = options.model;
    this.configPath = options.configPath;
    this.goalStatePath = options.goalStatePath ? path.resolve(options.goalStatePath) : undefined;
    this.clientTimeZone = options.clientTimeZone
      ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      ?? "UTC";
    this.turnSettleDelayMs = options.turnSettleDelayMs ?? 50;
    this.backgroundReviewGraceMs = options.backgroundReviewGraceMs ?? 15_000;
    this.turnTimeoutMs = options.turnTimeoutMs === undefined
      ? DEEPSEEK_HARNESS_TURN_TIMEOUT_MS
      : options.turnTimeoutMs;
    this.inactivityTimeoutMs = options.inactivityTimeoutMs === undefined
      ? DEEPSEEK_HARNESS_INACTIVITY_TIMEOUT_MS
      : options.inactivityTimeoutMs;
  }

  async createSession(_chatId: number): Promise<{ sessionId: string }> {
    await this.ensureOperational();
    const sessionId = `session-${randomUUID()}`;
    await this.createOrAttachSession(sessionId, this.workspacePath);
    return { sessionId };
  }

  async sendUserMessage(sessionId: string, input: CodexUserMessageInput): Promise<CodexAdapterResponse> {
    this.assertUsable();
    if (this.activeSessionClaims.has(sessionId)) {
      throw new Error(`DeepSeek Harness session ${sessionId} already has an active turn`);
    }
    this.activeSessionClaims.add(sessionId);

    try {
      if (input.abortSignal?.aborted) {
        throw abortError();
      }
      await this.ensureOperational(input.abortSignal);
      const workspace = path.resolve(input.workspaceOverride ?? this.workspacePath);
      await this.createOrAttachSession(sessionId, workspace);
      await this.configureSession(sessionId, input.abortSignal);
      if (input.files.length === 0 && input.text.trim() === "/compact") {
        return {
          sessionId,
          text: await this.executeHarnessCommand(sessionId, "/compact", input.abortSignal),
        };
      }
      const content = await this.buildPromptContent(input);
      if (input.abortSignal?.aborted) {
        throw abortError();
      }
      const pending = this.createPendingTurn(sessionId, input, workspace);
      this.pendingTurns.set(sessionId, pending);
      this.armTurnTimeouts(pending);

      try {
        await this.emit(pending, { type: "session", sessionId });
        const response = asRecord(await this.gateway.request("session.prompt", {
          sessionId,
          mode: "queue",
          content,
          clientTimeZone: this.clientTimeZone,
        }, pending.abortController.signal));
        const command = asRecord(response?.command);
        if (command?.kind === "success") {
          const text = typeof command.text === "string" ? command.text : "";
          this.settleSuccess(pending, text);
        }
      } catch (error) {
        this.settleFailure(pending, error);
      }

      return await pending.promise;
    } finally {
      this.activeSessionClaims.delete(sessionId);
    }
  }

  async steerActiveTurn(sessionId: string, input: { text: string }): Promise<boolean> {
    this.assertUsable();
    if (!this.pendingTurns.has(sessionId) || this.recoveringTransport) {
      return false;
    }
    try {
      const response = asRecord(await this.gateway.request("session.prompt", {
        sessionId,
        mode: "steer",
        content: [{ type: "text", text: input.text }],
        clientTimeZone: this.clientTimeZone,
      }));
      return response?.accepted === true;
    } catch (error) {
      if (error instanceof DeepSeekHarnessRpcError && [
        "agent-not-running",
        "agent-idle",
        "queue-no-active",
        "session-not-found",
      ].includes(error.code)) {
        return false;
      }
      throw error;
    }
  }

  async validateExternalSession(
    sessionId: string,
    input: { workspaceOverride?: string } = {},
  ): Promise<ExternalSessionInfo> {
    await this.ensureOperational();
    const sessions = await this.listSessionRows();
    const row = sessions.find((item) => item.sessionId === sessionId);
    if (!row) {
      throw new Error(`DeepSeek Harness session ${sessionId} is not present in session.list`);
    }
    if (!row.cwd) {
      throw new Error(`DeepSeek Harness session ${sessionId} has no verifiable workspace`);
    }
    const info = this.externalSessionInfo(row);
    if (input.workspaceOverride && path.resolve(input.workspaceOverride) !== path.resolve(info.cwd)) {
      throw new Error(`DeepSeek Harness session ${sessionId} belongs to ${info.cwd}, not ${input.workspaceOverride}`);
    }
    this.knownSessionWorkspaces.set(sessionId, path.resolve(info.cwd));
    return info;
  }

  async listExternalSessions(input: { cwd?: string; limit?: number } = {}): Promise<ExternalSessionInfo[]> {
    await this.ensureOperational();
    const expectedCwd = input.cwd ? path.resolve(input.cwd) : undefined;
    const limit = Math.max(0, input.limit ?? 50);
    return (await this.listSessionRows())
      .filter((row) => !row.blank && row.cwd)
      .filter((row) => !expectedCwd || path.resolve(row.cwd!) === expectedCwd)
      .slice(0, limit)
      .map((row) => this.externalSessionInfo(row));
  }

  async getContextUsage(
    sessionId: string,
    _input: { workspaceOverride?: string } = {},
  ): Promise<EngineContextUsage | null> {
    await this.ensureOperational();
    const values = await this.readProjectionValues(sessionId);
    const pressure = asRecord(values.contextPressure);
    if (!pressure) {
      return null;
    }
    const pressureTokens = numberValue(pressure.pressureTokens);
    const projectedTokens = numberValue(pressure.projectedTokens);
    const contextWindow = numberValue(pressure.contextWindow);
    const result: EngineContextUsage = {
      ...(pressureTokens !== undefined ? { pressureTokens } : {}),
      ...(projectedTokens !== undefined ? { projectedTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
    return Object.keys(result).length > 0 ? result : null;
  }

  async getThreadGoal(
    sessionId: string,
    _input: { workspaceOverride?: string } = {},
  ): Promise<CodexThreadGoalResponse> {
    await this.ensureOperational();
    await this.ensureGoalStateLoaded();
    const values = await this.readProjectionValues(sessionId);
    const projection = parseGoalProjection(values.goal);
    if (projection) {
      await this.ensureObservedGoalBudgetState(sessionId, projection, values);
      await this.reconcileGoalState(sessionId, { throwOnPauseFailure: true });
    }
    return {
      goal: projection ? this.codexGoal(sessionId, projection, values) : null,
      sessionId,
    };
  }

  async setThreadGoal(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
  }): Promise<CodexThreadGoalResponse> {
    await this.ensureOperational();
    await this.ensureGoalStateLoaded();
    await this.createOrAttachSession(
      sessionId,
      path.resolve(input.workspaceOverride ?? this.workspacePath),
    );
    await this.configureSession(sessionId);
    const goalId = await this.createFreshGoal(sessionId, input.objective, input.tokenBudget ?? null);
    const values = await this.readProjectionValues(sessionId);
    const projection = parseGoalProjection(values.goal);
    if (projection?.goal.id === goalId) {
      await this.reconcileGoalState(sessionId, { throwOnPauseFailure: true });
      return { goal: this.codexGoal(sessionId, projection, values), sessionId };
    }
    const now = Math.floor(Date.now() / 1_000);
    return {
      goal: {
        threadId: sessionId,
        objective: input.objective,
        status: "active",
        tokenBudget: input.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
      },
      sessionId,
    };
  }

  async watchThreadGoal(sessionId: string, input: {
    objective: string;
    tokenBudget?: number | null;
    workspaceOverride?: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    abortSignal?: AbortSignal;
  }): Promise<CodexThreadGoalResponse> {
    await this.ensureOperational(input.abortSignal);
    await this.ensureGoalStateLoaded();
    const workspace = path.resolve(input.workspaceOverride ?? this.workspacePath);
    await this.createOrAttachSession(
      sessionId,
      workspace,
    );
    await this.configureSession(sessionId, input.abortSignal);

    const previous = this.goalWatchers.get(sessionId);
    if (previous) {
      previous.abortController.abort();
      this.resolveGoalWatcher(previous, previous.latestGoal);
    }

    const watcher = this.createGoalWatcher(sessionId, { ...input, workspace });
    this.goalWatchers.set(sessionId, watcher);
    const abort = () => {
      watcher.abortController.abort();
      this.resolveGoalWatcher(watcher, watcher.latestGoal);
    };
    watcher.abortListener = abort;
    if (input.abortSignal?.aborted) {
      abort();
    } else {
      input.abortSignal?.addEventListener("abort", abort, { once: true });
    }

    try {
      if (!watcher.settled) {
        const goalId = await this.createFreshGoal(
          sessionId,
          input.objective,
          input.tokenBudget ?? null,
          watcher.abortController.signal,
        );
        watcher.goalId = goalId;
        const now = Math.floor(Date.now() / 1_000);
        watcher.latestGoal = {
          threadId: sessionId,
          objective: input.objective,
          status: "active",
          tokenBudget: input.tokenBudget ?? null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now,
        };
        await this.reconcileGoalState(sessionId);
        this.scheduleGoalPoll(watcher, 0);
      }
      return await watcher.promise;
    } catch (error) {
      this.rejectGoalWatcher(watcher, error);
      return await watcher.promise;
    } finally {
      this.cleanupGoalWatcher(watcher);
    }
  }

  async clearThreadGoal(
    sessionId: string,
    _input: { workspaceOverride?: string } = {},
  ): Promise<{ cleared: boolean; sessionId?: string }> {
    await this.ensureOperational();
    await this.ensureGoalStateLoaded();
    const values = await this.readProjectionValues(sessionId);
    const projection = parseGoalProjection(values.goal);
    if (!projection) {
      await this.deleteGoalBudgetState(sessionId);
      return { cleared: false, sessionId };
    }
    const response = asRecord(await this.gateway.request("goal.clear", {
      sessionId,
      ref: { id: projection.goal.id, revision: projection.goal.revision },
    }));
    const cleared = response?.cleared === true;
    if (cleared) {
      await this.deleteGoalBudgetState(sessionId);
    }
    const watcher = this.goalWatchers.get(sessionId);
    if (watcher) {
      watcher.abortController.abort();
      this.resolveGoalWatcher(watcher, watcher.latestGoal);
    }
    return { cleared, sessionId };
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    const recoveryBarrier = this.transportRecoveryBarrier;
    this.transportRecoveryBarrier = undefined;
    recoveryBarrier?.reject(new Error("DeepSeek Harness adapter was destroyed"));
    for (const pending of [...this.pendingTurns.values()]) {
      this.settleFailure(pending, new Error("DeepSeek Harness adapter was destroyed"));
    }
    for (const watcher of [...this.goalWatchers.values()]) {
      this.rejectGoalWatcher(watcher, new Error("DeepSeek Harness adapter was destroyed"));
      this.cleanupGoalWatcher(watcher);
    }
    await this.gateway.close();
  }

  private assertUsable(): void {
    if (this.destroyed) {
      throw new Error("DeepSeek Harness adapter is destroyed");
    }
  }

  private async ensureOperational(signal?: AbortSignal): Promise<void> {
    this.assertUsable();
    await this.ensureConnected();
    const barrier = this.transportRecoveryBarrier;
    if (barrier) {
      if (signal) {
        await waitForOperationOrAbort(barrier.promise, signal);
      } else {
        await barrier.promise;
      }
    }
    this.assertUsable();
  }

  private beginTransportRecovery(): TransportRecoveryBarrier {
    this.recoveringTransport = true;
    this.configuredSessions.clear();
    this.hostDefaultModel = undefined;
    this.hostDefaultModelPromise = undefined;
    if (!this.transportRecoveryBarrier) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      // A reconnect callback can fail before another caller starts waiting on
      // the barrier. Keep that failure observable to waiters without producing
      // a process-level unhandled rejection in the meantime.
      void promise.catch(() => {});
      this.transportRecoveryBarrier = { promise, resolve, reject };
    }
    return this.transportRecoveryBarrier;
  }

  private ensureConnected(): Promise<void> {
    this.connectPromise ??= this.gateway.connect({
      onMuxFrame: (frame) => this.enqueueFrame(frame),
      onHostFrame: (frame) => this.enqueueFrame(frame),
      onDisconnect: () => {
        this.beginTransportRecovery();
      },
      onReconnect: (info) => this.recoverTransport(info),
    }).catch((error) => {
      this.connectPromise = undefined;
      throw error;
    });
    return this.connectPromise;
  }

  private enqueueFrame(frame: DeepSeekHarnessServerRequest): Promise<void> {
    if (this.recoveringTransport) {
      this.bufferedFrames.push(frame);
      return Promise.resolve();
    }
    return this.enqueueFrameNow(frame);
  }

  private enqueueFrameNow(frame: DeepSeekHarnessServerRequest): Promise<void> {
    const sessionId = typeof frame.payload.sessionId === "string"
      ? frame.payload.sessionId
      : "__host__";
    const previous = this.eventChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(() => this.handleFrame(frame))
      .catch((error) => {
        const pending = this.pendingTurns.get(sessionId);
        if (pending) {
          this.settleFailure(pending, error);
        }
        const watcher = this.goalWatchers.get(sessionId);
        if (watcher) {
          this.rejectGoalWatcher(watcher, error);
        }
      })
      .finally(() => {
        if (this.eventChains.get(sessionId) === next) {
          this.eventChains.delete(sessionId);
        }
      });
    this.eventChains.set(sessionId, next);
    return next;
  }

  private async handleFrame(frame: DeepSeekHarnessServerRequest): Promise<void> {
    switch (frame.payload.type) {
      case "session/event":
        await this.handleSessionEvent(frame.payload);
        return;
      case "session/jobs":
        await this.handleJobs(frame.payload);
        return;
      case "approval/requested":
        await this.handleApproval(frame);
        return;
      case "question/requested":
        await this.handleQuestion(frame);
        return;
      case "session/projection":
        await this.handleProjection(frame.payload);
        return;
      case "stream/error":
        this.handleStreamError(frame.payload);
        return;
      case "host/agent-error":
        this.handleHostAgentError(frame.payload);
        return;
      case "host/session-removed":
        await this.handleHostSessionRemoved(frame.payload);
        return;
      default:
        return;
    }
  }

  private async handleSessionEvent(payload: Record<string, unknown>): Promise<void> {
    const sessionId = stringValue(payload.sessionId);
    const event = asRecord(payload.event);
    if (!sessionId || !event) {
      return;
    }
    const type = stringValue(event.type);
    const data = asRecord(event.data) ?? {};
    const seq = numberValue(event.seq);
    if (seq !== undefined) {
      const priorSeq = this.sessionEventSeqs.get(sessionId) ?? -1;
      if (seq <= priorSeq) {
        return;
      }
      this.sessionEventSeqs.set(sessionId, seq);
    }

    if (type === "turn/start") {
      const turn = numberValue(data.turn);
      if (turn !== undefined) {
        const routing = this.routingFor(sessionId);
        routing.openTurn = turn;
        routing.owners.delete(turn);
        routing.claims.delete(turn);
        routing.pendingStarts.set(turn, data);
        const inferred = this.inferCurrentClaim(sessionId);
        if (inferred) {
          routing.owners.set(turn, inferred.owner);
          this.handleRoutedTurnStart(sessionId, turn, inferred.owner);
        }
      }
      return;
    }

    if (type === "user/message") {
      const routing = this.routingFor(sessionId);
      const turn = routing.openTurn;
      const source = asRecord(data.source);
      const sourceKind = stringValue(source?.kind);
      const goalRound = numberValue(source?.round);
      const owner: SessionTurnOwner | undefined = sourceKind === "goal" && (goalRound ?? 0) > 0
        ? "goal"
        : sourceKind === "user"
          ? "foreground"
          : undefined;
      if (turn !== undefined && owner && !routing.owners.has(turn)) {
        routing.owners.set(turn, owner);
        this.handleRoutedTurnStart(sessionId, turn, owner);
      }
      return;
    }

    const turn = numberValue(data.turn);
    if (turn !== undefined) {
      this.ownerForTurn(sessionId, turn);
    }
    const claim = turn === undefined ? undefined : this.routingFor(sessionId).claims.get(turn);
    if (!claim) {
      return;
    }
    const pending = this.pendingForClaim(sessionId, claim);
    const watcher = this.watcherForClaim(sessionId, claim);
    if (pending) {
      if (seq !== undefined) {
        pending.lastSeq = Math.max(pending.lastSeq, seq);
      }
      this.noteTurnActivity(pending);
    }

    if (type === "tool/call") {
      const callId = stringValue(data.callId);
      const name = stringValue(data.name);
      if (callId && name) {
        const call = { name, input: parseJsonValue(data.arguments) };
        if (pending) {
          pending.toolCalls.set(callId, call);
          pending.outstandingToolCalls.add(callId);
          this.noteTurnActivity(pending);
          await this.emit(pending, {
            type: "tool_use",
            toolName: name,
            toolInput: call.input,
            toolUseId: callId,
            sessionId,
          });
        } else if (watcher) {
          watcher.toolCalls.set(callId, call);
          await this.emitGoal(watcher, {
            type: "tool_use",
            toolName: name,
            toolInput: call.input,
            toolUseId: callId,
            sessionId,
          });
        }
      }
      return;
    }

    if (pending) {
      switch (type) {
      case "assistant/chunk":
        await this.handleAssistantChunk(pending, data);
        return;
      case "assistant/message":
        await this.handleAssistantMessage(pending, data);
        return;
      case "tool/result":
        await this.handleToolResult(pending, data);
        return;
      case "turn/end":
        this.handleTurnEnd(pending, data);
        this.finishRoutedTurn(sessionId, turn);
        return;
      default:
        return;
      }
    }

    if (watcher) {
      await this.handleGoalTurnEvent(watcher, type, data);
    }
    if (type === "turn/end") {
      this.finishRoutedTurn(sessionId, turn);
    }
  }

  private routingFor(sessionId: string): SessionTurnRouting {
    const existing = this.turnRouting.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: SessionTurnRouting = {
      owners: new Map(),
      claims: new Map(),
      pendingStarts: new Map(),
    };
    this.turnRouting.set(sessionId, created);
    return created;
  }

  private ownerForTurn(sessionId: string, turn: number): SessionTurnOwner | undefined {
    const routing = this.routingFor(sessionId);
    const known = routing.owners.get(turn);
    if (known) {
      return known;
    }
    const inferred = this.inferCurrentClaim(sessionId);
    if (inferred) {
      routing.owners.set(turn, inferred.owner);
      this.handleRoutedTurnStart(sessionId, turn, inferred.owner);
    }
    return inferred?.owner;
  }

  private activeClaimForSession(sessionId: string): SessionTurnClaim | undefined {
    const routing = this.turnRouting.get(sessionId);
    if (routing?.openTurn !== undefined) {
      const claim = routing.claims.get(routing.openTurn);
      if (claim) {
        return claim;
      }
      if (routing.owners.has(routing.openTurn)) {
        // The turn is known but could not be bound. Do not guess and route a
        // late request into a newer task in the same session.
        return undefined;
      }
    }
    return this.inferCurrentClaim(sessionId);
  }

  private inferCurrentClaim(sessionId: string): SessionTurnClaim | undefined {
    const pending = this.pendingTurns.get(sessionId);
    const watcher = this.goalWatchers.get(sessionId);
    const hasForeground = Boolean(pending && !pending.settled);
    const hasGoal = Boolean(watcher && !watcher.settled);
    if (hasForeground === hasGoal) {
      return undefined;
    }
    return hasForeground
      ? { owner: "foreground", claimId: pending!.claimId }
      : { owner: "goal", claimId: watcher!.claimId };
  }

  private currentClaimForOwner(
    sessionId: string,
    owner: SessionTurnOwner,
  ): SessionTurnClaim | undefined {
    if (owner === "foreground") {
      const pending = this.pendingTurns.get(sessionId);
      return pending && !pending.settled
        ? { owner, claimId: pending.claimId }
        : undefined;
    }
    const watcher = this.goalWatchers.get(sessionId);
    return watcher && !watcher.settled
      ? { owner, claimId: watcher.claimId }
      : undefined;
  }

  private pendingForClaim(sessionId: string, claim: SessionTurnClaim): PendingTurn | undefined {
    if (claim.owner !== "foreground") {
      return undefined;
    }
    const pending = this.pendingTurns.get(sessionId);
    return pending?.claimId === claim.claimId && !pending.settled ? pending : undefined;
  }

  private watcherForClaim(sessionId: string, claim: SessionTurnClaim): GoalWatcher | undefined {
    if (claim.owner !== "goal") {
      return undefined;
    }
    const watcher = this.goalWatchers.get(sessionId);
    return watcher?.claimId === claim.claimId && !watcher.settled ? watcher : undefined;
  }

  private handleRoutedTurnStart(sessionId: string, turn: number, owner: SessionTurnOwner): void {
    const routing = this.routingFor(sessionId);
    const hadPendingStart = routing.pendingStarts.delete(turn);
    if (!routing.claims.has(turn)) {
      const current = this.currentClaimForOwner(sessionId, owner);
      if (current) {
        routing.claims.set(turn, current);
      }
    }
    if (!hadPendingStart || owner !== "foreground") {
      return;
    }
    const claim = routing.claims.get(turn);
    const pending = claim ? this.pendingForClaim(sessionId, claim) : undefined;
    if (!pending) {
      return;
    }
    pending.turnsStarted += 1;
    pending.activeTurns.add(turn);
    if (pending.turnsStarted > 1) {
      pending.awaitingReview = false;
      if (pending.backgroundTimer) {
        clearTimeout(pending.backgroundTimer);
        pending.backgroundTimer = undefined;
      }
    }
  }

  private finishRoutedTurn(sessionId: string, turn: number | undefined): void {
    if (turn === undefined) {
      return;
    }
    const routing = this.turnRouting.get(sessionId);
    if (!routing) {
      return;
    }
    routing.owners.delete(turn);
    routing.claims.delete(turn);
    routing.pendingStarts.delete(turn);
    if (routing.openTurn === turn) {
      routing.openTurn = undefined;
    }
    if (routing.owners.size === 0 && routing.pendingStarts.size === 0 && routing.openTurn === undefined) {
      this.turnRouting.delete(sessionId);
    }
  }

  private async handleAssistantChunk(pending: PendingTurn, data: Record<string, unknown>): Promise<void> {
    const turn = numberValue(data.turn);
    const step = numberValue(data.step);
    const chunk = asRecord(data.chunk);
    if (!chunk || turn === undefined || step === undefined) {
      return;
    }
    const key = `${turn}:${step}`;
    switch (chunk.type) {
      case "text-delta": {
        const text = stringValue(chunk.text) ?? "";
        if (!text) {
          return;
        }
        pending.chunkedSteps.add(key);
        pending.text += text;
        pending.input.onProgress?.(pending.text);
        await this.emit(pending, {
          type: "assistant_text",
          text,
          delta: true,
          sessionId: pending.sessionId,
        });
        return;
      }
      case "reasoning-delta": {
        const text = stringValue(chunk.text) ?? "";
        if (text) {
          pending.reasoningChunkedSteps.add(key);
          await this.emit(pending, { type: "thinking", text, sessionId: pending.sessionId });
        }
        return;
      }
      case "usage": {
        const usage = parseUsage(chunk.usage);
        if (usage) {
          pending.usageByStep.set(key, usage);
        }
        return;
      }
      default:
        return;
    }
  }

  private async handleAssistantMessage(pending: PendingTurn, data: Record<string, unknown>): Promise<void> {
    const turn = numberValue(data.turn);
    const step = numberValue(data.step);
    if (turn === undefined || step === undefined) {
      return;
    }
    const key = `${turn}:${step}`;
    const usage = parseUsage(data.usage);
    if (usage) {
      pending.usageByStep.set(key, usage);
    }
    const message = asRecord(data.message);
    const content = message?.content;
    if (!pending.reasoningChunkedSteps.has(key)) {
      const reasoning = assistantContentText(content, "reasoning");
      if (reasoning) {
        await this.emit(pending, {
          type: "thinking",
          text: reasoning,
          sessionId: pending.sessionId,
        });
      }
    }
    if (pending.chunkedSteps.has(key)) {
      return;
    }
    const text = assistantContentText(content, "text");
    if (!text) {
      return;
    }
    pending.text = pending.text ? `${pending.text}\n${text}` : text;
    pending.input.onProgress?.(pending.text);
    await this.emit(pending, {
      type: "assistant_text",
      text,
      sessionId: pending.sessionId,
    });
  }

  private async handleToolResult(pending: PendingTurn, data: Record<string, unknown>): Promise<void> {
    const message = asRecord(data.message);
    const source = asRecord(message?.source);
    const firstBlock = Array.isArray(message?.content) ? asRecord(message.content[0]) : undefined;
    const callId = stringValue(source?.callId) ?? stringValue(firstBlock?.toolCallId);
    if (!callId) {
      return;
    }
    const call = pending.toolCalls.get(callId);
    pending.outstandingToolCalls.delete(callId);
    this.noteTurnActivity(pending);
    await this.emit(pending, {
      type: "tool_result",
      toolUseId: callId,
      toolName: call?.name,
      output: textFromContent(firstBlock?.content ?? message?.content),
      isError: firstBlock?.isError === true || data.error !== undefined,
      sessionId: pending.sessionId,
    });
  }

  private async handleGoalTurnEvent(
    watcher: GoalWatcher,
    type: string | undefined,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (type === "assistant/chunk") {
      const turn = numberValue(data.turn);
      const step = numberValue(data.step);
      const chunk = asRecord(data.chunk);
      if (!chunk || turn === undefined || step === undefined) {
        return;
      }
      const key = `${turn}:${step}`;
      if (chunk.type === "text-delta") {
        const text = stringValue(chunk.text) ?? "";
        if (text) {
          watcher.chunkedSteps.add(key);
          await this.emitGoal(watcher, {
            type: "assistant_text",
            text,
            delta: true,
            sessionId: watcher.sessionId,
          });
        }
      } else if (chunk.type === "reasoning-delta") {
        const text = stringValue(chunk.text) ?? "";
        if (text) {
          watcher.reasoningChunkedSteps.add(key);
          await this.emitGoal(watcher, {
            type: "thinking",
            text,
            sessionId: watcher.sessionId,
          });
        }
      }
      return;
    }
    if (type === "assistant/message") {
      const turn = numberValue(data.turn);
      const step = numberValue(data.step);
      if (turn === undefined || step === undefined) {
        return;
      }
      const key = `${turn}:${step}`;
      const content = asRecord(data.message)?.content;
      if (!watcher.reasoningChunkedSteps.has(key)) {
        const reasoning = assistantContentText(content, "reasoning");
        if (reasoning) {
          await this.emitGoal(watcher, {
            type: "thinking",
            text: reasoning,
            sessionId: watcher.sessionId,
          });
        }
      }
      if (watcher.chunkedSteps.has(key)) {
        return;
      }
      const text = assistantContentText(content, "text");
      if (text) {
        await this.emitGoal(watcher, {
          type: "assistant_text",
          text,
          sessionId: watcher.sessionId,
        });
      }
      return;
    }
    if (type === "tool/result") {
      const message = asRecord(data.message);
      const source = asRecord(message?.source);
      const firstBlock = Array.isArray(message?.content) ? asRecord(message.content[0]) : undefined;
      const callId = stringValue(source?.callId) ?? stringValue(firstBlock?.toolCallId);
      if (!callId) {
        return;
      }
      const call = watcher.toolCalls.get(callId);
      await this.emitGoal(watcher, {
        type: "tool_result",
        toolUseId: callId,
        toolName: call?.name,
        output: textFromContent(firstBlock?.content ?? message?.content),
        isError: firstBlock?.isError === true || data.error !== undefined,
        sessionId: watcher.sessionId,
      });
    }
  }

  private handleTurnEnd(pending: PendingTurn, data: Record<string, unknown>): void {
    const turn = numberValue(data.turn);
    if (turn !== undefined) {
      pending.activeTurns.delete(turn);
      pending.turnsEnded.add(turn);
    }
    const reason = asRecord(data.reason);
    const kind = stringValue(reason?.kind) ?? "error";
    if (kind !== "completed") {
      if (kind === "aborted") {
        this.settleFailure(pending, abortError());
      } else {
        const detail = kind === "error"
          ? stringValue(asRecord(reason?.error)?.message)
          : undefined;
        this.settleFailure(
          pending,
          new Error(detail ?? `DeepSeek Harness turn ended with ${kind}`),
        );
      }
      return;
    }
    if (pending.settleTimer) {
      clearTimeout(pending.settleTimer);
    }
    pending.settleTimer = setTimeout(() => {
      pending.settleTimer = undefined;
      this.maybeSettleCompleted(pending);
    }, this.turnSettleDelayMs);
    pending.settleTimer.unref?.();
  }

  private async handleJobs(payload: Record<string, unknown>): Promise<void> {
    const sessionId = stringValue(payload.sessionId);
    if (!sessionId || !Array.isArray(payload.jobs)) {
      return;
    }
    const previous = this.jobsBySession.get(sessionId) ?? new Map<string, Job>();
    const current = new Map<string, Job>();
    for (const rawJob of payload.jobs) {
      const job = parseJob(rawJob);
      if (job) {
        current.set(job.id, job);
      }
    }
    this.jobsBySession.set(sessionId, current);
    const owners = this.jobOwnersBySession.get(sessionId) ?? new Map<string, SessionTurnClaim>();
    this.jobOwnersBySession.set(sessionId, owners);
    const activeOwner = this.activeClaimForSession(sessionId);

    for (const job of current.values()) {
      const prior = previous.get(job.id);
      if (isLiveJob(job) && !prior) {
        if (activeOwner) {
          owners.set(job.id, activeOwner);
          await this.emitBackgroundJobStarted(sessionId, activeOwner, job);
        }
      } else if (isLiveJob(job) && owners.has(job.id)) {
        this.trackLiveBackgroundJob(sessionId, owners.get(job.id)!, job.id);
      }
      if (!isLiveJob(job) && prior && isLiveJob(prior)) {
        const owner = owners.get(job.id);
        if (owner) {
          await this.emitBackgroundJobFinished(sessionId, owner, job);
          owners.delete(job.id);
        }
      }
    }
    for (const prior of previous.values()) {
      if (isLiveJob(prior) && !current.has(prior.id)) {
        const owner = owners.get(prior.id);
        if (owner) {
          await this.emitBackgroundJobFinished(sessionId, owner, {
            ...prior,
            status: "completed",
          });
          owners.delete(prior.id);
        }
      }
    }
    if (owners.size === 0) {
      this.jobOwnersBySession.delete(sessionId);
    }
    const pending = this.pendingTurns.get(sessionId);
    if (pending?.sawBackground && pending.liveJobs.size === 0 && pending.turnsEnded.size > 0) {
      this.waitForBackgroundReview(pending);
    }
  }

  private trackLiveBackgroundJob(
    sessionId: string,
    owner: SessionTurnClaim,
    jobId: string,
  ): void {
    const pending = this.pendingForClaim(sessionId, owner);
    if (pending) {
      pending.liveJobs.add(jobId);
      this.noteTurnActivity(pending);
    }
  }

  private async emitBackgroundJobStarted(
    sessionId: string,
    owner: SessionTurnClaim,
    job: Job,
  ): Promise<void> {
    if (owner.owner === "foreground") {
      const pending = this.pendingForClaim(sessionId, owner);
      if (!pending) {
        return;
      }
      pending.sawBackground = true;
      pending.liveJobs.add(job.id);
      this.noteTurnActivity(pending);
      await this.emit(pending, {
        type: "background_task_started",
        taskId: job.id,
        description: job.label,
        sessionId,
      });
      return;
    }
    const watcher = this.watcherForClaim(sessionId, owner);
    if (watcher) {
      await this.emitGoal(watcher, {
        type: "background_task_started",
        taskId: job.id,
        description: job.label,
        sessionId,
      });
    }
  }

  private async emitBackgroundJobFinished(
    sessionId: string,
    owner: SessionTurnClaim,
    job: Job,
  ): Promise<void> {
    if (owner.owner === "foreground") {
      const pending = this.pendingForClaim(sessionId, owner);
      if (!pending) {
        return;
      }
      pending.liveJobs.delete(job.id);
      this.noteTurnActivity(pending);
      await this.emit(pending, {
        type: "background_task_finished",
        taskId: job.id,
        status: job.status,
        summary: job.detail,
        sessionId,
      });
      return;
    }
    const watcher = this.watcherForClaim(sessionId, owner);
    if (watcher) {
      await this.emitGoal(watcher, {
        type: "background_task_finished",
        taskId: job.id,
        status: job.status,
        summary: job.detail,
        sessionId,
      });
    }
  }

  private async handleApproval(frame: DeepSeekHarnessServerRequest): Promise<void> {
    const payload = frame.payload;
    const sessionId = stringValue(payload.sessionId);
    const approvalId = stringValue(payload.approvalId);
    const toolName = stringValue(payload.toolName);
    if (!sessionId || !approvalId || !toolName) {
      await this.rejectMalformedRequest(frame.rpcId, "Malformed DeepSeek Harness approval request");
      return;
    }
    const owner = this.activeClaimForSession(sessionId);
    const pending = owner ? this.pendingForClaim(sessionId, owner) : undefined;
    const watcher = owner ? this.watcherForClaim(sessionId, owner) : undefined;
    if (pending) {
      this.noteTurnActivity(pending);
    }
    const grants = this.sessionApprovalGrants.get(sessionId) ?? new Set<string>();
    this.sessionApprovalGrants.set(sessionId, grants);
    let decision: EngineApprovalDecision = { behavior: "deny" };
    if (grants.has(toolName)) {
      decision = { behavior: "allow", scope: "session" };
    } else if (pending?.input.onApprovalRequest) {
      const callId = stringValue(payload.callId);
      const call = callId ? pending.toolCalls.get(callId) : undefined;
      try {
        await this.emit(pending, {
          type: "permission_request",
          toolName,
          toolInput: call?.input,
          sessionId,
        });
        decision = await this.waitForPendingOperation(
          pending,
          pending.input.onApprovalRequest({
            engine: "deepseek",
            toolName,
            toolInput: call?.input,
            cwd: pending.workspace,
            sessionId,
            abortSignal: pending.abortController.signal,
          }),
        );
      } catch {
        decision = { behavior: "deny" };
      }
    } else if (watcher?.onApprovalRequest) {
      const callId = stringValue(payload.callId);
      const call = callId ? watcher.toolCalls.get(callId) : undefined;
      try {
        await this.emitGoal(watcher, {
          type: "permission_request",
          toolName,
          toolInput: call?.input,
          sessionId,
        });
        decision = await waitForOperationOrAbort(
          Promise.resolve().then(() => watcher.onApprovalRequest!({
            engine: "deepseek",
            toolName,
            toolInput: call?.input,
            cwd: watcher.workspace,
            sessionId,
            abortSignal: watcher.abortController.signal,
          })),
          watcher.abortController.signal,
        );
      } catch {
        decision = { behavior: "deny" };
      }
    } else {
      if (watcher) {
        const callId = stringValue(payload.callId);
        const call = callId ? watcher.toolCalls.get(callId) : undefined;
        await this.emitGoal(watcher, {
          type: "permission_request",
          toolName,
          toolInput: call?.input,
          sessionId,
        });
      }
      decision = { behavior: "deny" };
    }
    const receipt = await this.gateway.respond(frame.rpcId, {
      sessionId,
      approvalId,
      outcome: decision.behavior === "allow" ? "allowed-once" : "rejected",
    });
    if (!receipt.accepted && receipt.reason !== "not-pending") {
      throw new Error(`DeepSeek Harness rejected approval response: ${receipt.reason ?? "unknown"}`);
    }
    if (receipt.accepted && decision.behavior === "allow" && decision.scope === "session") {
      grants.add(toolName);
    }
    if (pending) {
      this.noteTurnActivity(pending);
    }
  }

  private async handleQuestion(frame: DeepSeekHarnessServerRequest): Promise<void> {
    const payload = frame.payload;
    const sessionId = stringValue(payload.sessionId);
    const rawQuestions = Array.isArray(payload.questions) ? payload.questions : [];
    const questions = rawQuestions
      .map(parseQuestion)
      .filter((question): question is Question => question !== null);
    if (!sessionId || questions.length === 0 || questions.length !== rawQuestions.length) {
      await this.rejectMalformedRequest(frame.rpcId, "Malformed DeepSeek Harness question request");
      return;
    }
    const owner = this.activeClaimForSession(sessionId);
    const pending = owner ? this.pendingForClaim(sessionId, owner) : undefined;
    const watcher = owner ? this.watcherForClaim(sessionId, owner) : undefined;
    if (pending) {
      this.noteTurnActivity(pending);
    }
    let decision: EngineApprovalDecision = { behavior: "deny" };
    if (pending?.input.onApprovalRequest) {
      try {
        decision = await this.waitForPendingOperation(
          pending,
          pending.input.onApprovalRequest({
            engine: "deepseek",
            toolName: "AskUserQuestion",
            toolInput: { questions },
            cwd: pending.workspace,
            sessionId,
            abortSignal: pending.abortController.signal,
          }),
        );
      } catch {
        decision = { behavior: "deny" };
      }
    } else if (watcher?.onApprovalRequest) {
      try {
        await this.emitGoal(watcher, {
          type: "permission_request",
          toolName: "AskUserQuestion",
          toolInput: { questions },
          sessionId,
        });
        decision = await waitForOperationOrAbort(
          Promise.resolve().then(() => watcher.onApprovalRequest!({
            engine: "deepseek",
            toolName: "AskUserQuestion",
            toolInput: { questions },
            cwd: watcher.workspace,
            sessionId,
            abortSignal: watcher.abortController.signal,
          })),
          watcher.abortController.signal,
        );
      } catch {
        decision = { behavior: "deny" };
      }
    } else if (watcher) {
      await this.emitGoal(watcher, {
        type: "permission_request",
        toolName: "AskUserQuestion",
        toolInput: { questions },
        sessionId,
      });
    }
    const answers = decision.behavior === "allow"
      ? questionAnswers(questions, decision.updatedInput)
      : questions.map((question) => ({ id: question.id, selected: [] as string[] }));
    const receipt = await this.gateway.respond(frame.rpcId, {
      sessionId,
      answer: { answers },
    });
    if (!receipt.accepted && receipt.reason !== "not-pending") {
      throw new Error(`DeepSeek Harness rejected question response: ${receipt.reason ?? "unknown"}`);
    }
    if (pending) {
      this.noteTurnActivity(pending);
    }
  }

  private async rejectMalformedRequest(rpcId: string, message: string): Promise<void> {
    const receipt = await this.gateway.respondError(rpcId, {
      code: "invalid-request",
      message,
    });
    if (!receipt.accepted && receipt.reason !== "not-pending") {
      throw new Error(`DeepSeek Harness rejected malformed-request response: ${receipt.reason ?? "unknown"}`);
    }
  }

  private async handleProjection(payload: Record<string, unknown>): Promise<void> {
    const sessionId = stringValue(payload.sessionId);
    const key = stringValue(payload.key);
    const seq = numberValue(payload.seq);
    if (!sessionId || !key || seq === undefined) {
      return;
    }
    const watermarks = this.projectionWatermarks.get(sessionId) ?? new Map<string, number>();
    this.projectionWatermarks.set(sessionId, watermarks);
    if (seq <= (watermarks.get(key) ?? -1)) {
      return;
    }
    watermarks.set(key, seq);
    const values = this.projectionValues.get(sessionId) ?? {};
    values[key] = payload.value;
    this.projectionValues.set(sessionId, values);
    const pending = this.pendingTurns.get(sessionId);
    if (pending) {
      this.noteTurnActivity(pending);
    }
    await this.ensureGoalStateLoaded();
    await this.reconcileGoalState(sessionId);
  }

  private handleStreamError(payload: Record<string, unknown>): void {
    const error = asRecord(payload.error);
    const failure = new DeepSeekHarnessRpcError({
      code: stringValue(error?.code) ?? "stream-error",
      message: stringValue(error?.message) ?? "DeepSeek Harness event stream failed",
      details: error?.details,
    });
    for (const pending of [...this.pendingTurns.values()]) {
      this.settleFailure(pending, failure);
    }
    for (const watcher of [...this.goalWatchers.values()]) {
      this.rejectGoalWatcher(watcher, failure);
    }
  }

  private handleHostAgentError(payload: Record<string, unknown>): void {
    const sessionId = stringValue(payload.sessionId);
    const message = stringValue(payload.message);
    if (!sessionId || !message) {
      return;
    }
    const failure = new Error(`DeepSeek Harness agent failed: ${message}`);
    const pending = this.pendingTurns.get(sessionId);
    if (pending) {
      this.settleFailure(pending, failure);
    }
    const watcher = this.goalWatchers.get(sessionId);
    if (watcher) {
      this.rejectGoalWatcher(watcher, failure);
    }
  }

  private async handleHostSessionRemoved(payload: Record<string, unknown>): Promise<void> {
    const sessionId = stringValue(payload.sessionId);
    if (!sessionId) {
      return;
    }
    this.knownSessionWorkspaces.delete(sessionId);
    this.configuredSessions.delete(sessionId);
    this.sessionEventSeqs.delete(sessionId);
    this.turnRouting.delete(sessionId);
    this.jobsBySession.delete(sessionId);
    this.jobOwnersBySession.delete(sessionId);
    this.sessionApprovalGrants.delete(sessionId);
    this.projectionValues.delete(sessionId);
    this.projectionWatermarks.delete(sessionId);
    await this.ensureGoalStateLoaded();
    await this.deleteGoalBudgetState(sessionId);
    const failure = new Error(`DeepSeek Harness session ${sessionId} was removed`);
    const pending = this.pendingTurns.get(sessionId);
    if (pending) {
      this.settleFailure(pending, failure);
    }
    const watcher = this.goalWatchers.get(sessionId);
    if (watcher) {
      this.rejectGoalWatcher(watcher, failure);
    }
  }

  private createPendingTurn(
    sessionId: string,
    input: CodexUserMessageInput,
    workspace: string,
  ): PendingTurn {
    let resolve!: (response: CodexAdapterResponse) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<CodexAdapterResponse>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // A callback can block before sendUserMessage reaches `await pending.promise`.
    // Keep the rejection observed while the abort signal releases that callback.
    void promise.catch(() => {});
    const pending: PendingTurn = {
      claimId: randomUUID(),
      sessionId,
      input,
      workspace,
      resolve,
      reject,
      promise,
      text: "",
      lastSeq: -1,
      emittedSession: false,
      turnsStarted: 0,
      turnsEnded: new Set(),
      activeTurns: new Set(),
      chunkedSteps: new Set(),
      reasoningChunkedSteps: new Set(),
      usageByStep: new Map(),
      toolCalls: new Map(),
      outstandingToolCalls: new Set(),
      liveJobs: new Set(),
      sawBackground: false,
      awaitingReview: false,
      settling: false,
      settled: false,
      abortController: new AbortController(),
      lastActivityAt: Date.now(),
      timeoutsDisabled: input.disableRuntimeTimeout === true,
    };
    if (input.abortSignal) {
      pending.abortListener = () => {
        pending.abortController.abort();
        void this.gateway.request("session.cancel", { sessionId }).catch(() => {});
        this.settleFailure(pending, abortError());
      };
      input.abortSignal.addEventListener("abort", pending.abortListener, { once: true });
    }
    return pending;
  }

  private maybeSettleCompleted(pending: PendingTurn): void {
    if (pending.settled || pending.settling || pending.activeTurns.size > 0) {
      return;
    }
    if (!pending.sawBackground) {
      this.settleSuccess(pending);
      return;
    }
    if (pending.liveJobs.size > 0) {
      return;
    }
    if (pending.turnsStarted > 1) {
      this.settleSuccess(pending);
      return;
    }
    this.waitForBackgroundReview(pending);
  }

  private waitForBackgroundReview(pending: PendingTurn): void {
    if (pending.settled || pending.settling || pending.liveJobs.size > 0 || pending.turnsStarted > 1) {
      return;
    }
    pending.awaitingReview = true;
    if (pending.backgroundTimer) {
      return;
    }
    pending.backgroundTimer = setTimeout(() => {
      pending.backgroundTimer = undefined;
      if (pending.awaitingReview && pending.liveJobs.size === 0 && pending.activeTurns.size === 0) {
        this.settleSuccess(pending);
      }
    }, this.backgroundReviewGraceMs);
    pending.backgroundTimer.unref?.();
  }

  private settleSuccess(pending: PendingTurn, forcedText?: string): void {
    if (pending.settled || pending.settling) {
      return;
    }
    pending.settling = true;
    const text = forcedText ?? pending.text;
    const usage = aggregateUsage(pending.usageByStep.values());
    const response: CodexAdapterResponse = {
      text,
      sessionId: pending.sessionId,
      ...(usage ? { usage } : {}),
    };
    void this.emit(pending, { type: "result", text, sessionId: pending.sessionId })
      .then(() => {
        this.cleanupPending(pending);
        pending.resolve(response);
      })
      .catch((error) => {
        this.cleanupPending(pending);
        pending.reject(error);
      });
  }

  private settleFailure(pending: PendingTurn, error: unknown): void {
    if (pending.settled) {
      return;
    }
    this.cleanupPending(pending);
    pending.reject(error);
  }

  private cleanupPending(pending: PendingTurn): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    if (pending.settleTimer) {
      clearTimeout(pending.settleTimer);
    }
    if (pending.backgroundTimer) {
      clearTimeout(pending.backgroundTimer);
    }
    if (pending.hardTimeout) {
      clearTimeout(pending.hardTimeout);
    }
    if (pending.inactivityTimeout) {
      clearTimeout(pending.inactivityTimeout);
    }
    if (pending.abortListener && pending.input.abortSignal) {
      pending.input.abortSignal.removeEventListener("abort", pending.abortListener);
    }
    pending.abortController.abort();
    if (this.pendingTurns.get(pending.sessionId) === pending) {
      this.pendingTurns.delete(pending.sessionId);
    }
  }

  private armTurnTimeouts(pending: PendingTurn): void {
    if (pending.timeoutsDisabled) {
      return;
    }
    if (this.turnTimeoutMs !== null) {
      pending.hardTimeout = setTimeout(() => {
        pending.hardTimeout = undefined;
        this.cancelTimedOutTurn(
          pending,
          `DeepSeek Harness turn timed out after ${formatTimeoutMinutes(this.turnTimeoutMs!)}`,
        );
      }, this.turnTimeoutMs);
      pending.hardTimeout.unref?.();
    }
    this.scheduleInactivityTimeout(pending);
  }

  private noteTurnActivity(pending: PendingTurn): void {
    if (pending.settled) {
      return;
    }
    pending.lastActivityAt = Date.now();
    this.scheduleInactivityTimeout(pending);
  }

  private scheduleInactivityTimeout(pending: PendingTurn): void {
    if (pending.inactivityTimeout) {
      clearTimeout(pending.inactivityTimeout);
      pending.inactivityTimeout = undefined;
    }
    if (
      pending.settled
      || pending.timeoutsDisabled
      || this.inactivityTimeoutMs === null
      || pending.outstandingToolCalls.size > 0
      || pending.liveJobs.size > 0
    ) {
      return;
    }
    const elapsed = Math.max(0, Date.now() - pending.lastActivityAt);
    const delay = Math.max(1, this.inactivityTimeoutMs - elapsed);
    pending.inactivityTimeout = setTimeout(() => {
      pending.inactivityTimeout = undefined;
      if (
        pending.settled
        || pending.outstandingToolCalls.size > 0
        || pending.liveJobs.size > 0
      ) {
        return;
      }
      const currentElapsed = Math.max(0, Date.now() - pending.lastActivityAt);
      if (currentElapsed < this.inactivityTimeoutMs!) {
        this.scheduleInactivityTimeout(pending);
        return;
      }
      this.cancelTimedOutTurn(
        pending,
        `DeepSeek Harness turn became inactive after ${formatTimeoutMinutes(this.inactivityTimeoutMs!)}`,
      );
    }, delay);
    pending.inactivityTimeout.unref?.();
  }

  private cancelTimedOutTurn(pending: PendingTurn, message: string): void {
    if (pending.settled) {
      return;
    }
    void this.gateway.request("session.cancel", { sessionId: pending.sessionId }).catch(() => {});
    this.settleFailure(pending, new Error(message));
  }

  private async emit(pending: PendingTurn, event: EngineStreamEvent): Promise<void> {
    if (event.type === "session") {
      if (pending.emittedSession) {
        return;
      }
      pending.emittedSession = true;
    }
    const callback = pending.input.onEngineEvent;
    if (!callback) {
      return;
    }
    await this.waitForPendingOperation(
      pending,
      Promise.resolve().then(() => callback(event)),
    );
  }

  private async emitGoal(watcher: GoalWatcher, event: EngineStreamEvent): Promise<void> {
    const callback = watcher.onEngineEvent;
    if (!callback || watcher.settled) {
      return;
    }
    const operation = Promise.resolve().then(() => callback(event));
    void operation.catch(() => {});
    await waitForOperationOrAbort(operation, watcher.abortController.signal);
  }

  private createGoalWatcher(sessionId: string, input: {
    workspace: string;
    onEngineEvent?: (event: EngineStreamEvent) => void | Promise<void>;
    onApprovalRequest?: (request: EngineApprovalRequest) => Promise<EngineApprovalDecision>;
    abortSignal?: AbortSignal;
  }): GoalWatcher {
    let resolve!: (response: CodexThreadGoalResponse) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<CodexThreadGoalResponse>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => {});
    return {
      claimId: randomUUID(),
      sessionId,
      workspace: input.workspace,
      onEngineEvent: input.onEngineEvent,
      onApprovalRequest: input.onApprovalRequest,
      resolve,
      reject,
      promise,
      latestGoal: null,
      settled: false,
      abortController: new AbortController(),
      abortSignal: input.abortSignal,
      chunkedSteps: new Set(),
      reasoningChunkedSteps: new Set(),
      toolCalls: new Map(),
    };
  }

  private resolveGoalWatcher(watcher: GoalWatcher, goal: CodexThreadGoal | null): void {
    if (watcher.settled) {
      return;
    }
    watcher.settled = true;
    if (watcher.pollTimer) {
      clearTimeout(watcher.pollTimer);
      watcher.pollTimer = undefined;
    }
    watcher.resolve({ goal, sessionId: watcher.sessionId });
  }

  private rejectGoalWatcher(watcher: GoalWatcher, error: unknown): void {
    if (watcher.settled) {
      return;
    }
    watcher.settled = true;
    watcher.abortController.abort();
    if (watcher.pollTimer) {
      clearTimeout(watcher.pollTimer);
      watcher.pollTimer = undefined;
    }
    watcher.reject(error);
  }

  private cleanupGoalWatcher(watcher: GoalWatcher): void {
    if (watcher.pollTimer) {
      clearTimeout(watcher.pollTimer);
      watcher.pollTimer = undefined;
    }
    if (watcher.abortListener && watcher.abortSignal) {
      watcher.abortSignal.removeEventListener("abort", watcher.abortListener);
    }
    watcher.abortController.abort();
    if (this.goalWatchers.get(watcher.sessionId) === watcher) {
      this.goalWatchers.delete(watcher.sessionId);
    }
  }

  private async reconcileGoalState(
    sessionId: string,
    options: { throwOnPauseFailure?: boolean } = {},
  ): Promise<void> {
    const values = this.projectionValues.get(sessionId) ?? {};
    const projection = parseGoalProjection(values.goal);
    if (!projection) {
      return;
    }
    const goal = this.codexGoal(sessionId, projection, values);
    const watcher = this.goalWatchers.get(sessionId);
    const matchingWatcher = watcher
      && !watcher.settled
      && watcher.goalId === projection.goal.id
      ? watcher
      : undefined;
    if (matchingWatcher) {
      matchingWatcher.latestGoal = goal;
    }
    if (goal.status === "complete") {
      if (matchingWatcher) {
        this.resolveGoalWatcher(matchingWatcher, goal);
      }
      return;
    }
    if (goal.status !== "budgetLimited") {
      return;
    }

    try {
      if (projection.goal.phase === "active") {
        await this.pauseGoalForBudget(sessionId, projection);
      }
      const currentWatcher = this.goalWatchers.get(sessionId);
      if (currentWatcher === matchingWatcher && matchingWatcher && !matchingWatcher.settled) {
        this.resolveGoalWatcher(matchingWatcher, goal);
      }
    } catch (error) {
      if (matchingWatcher) {
        this.rejectGoalWatcher(matchingWatcher, error);
      }
      if (options.throwOnPauseFailure) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to pause DeepSeek goal ${projection.goal.id} at its token budget: ${message}`);
    }
  }

  private scheduleGoalPoll(watcher: GoalWatcher, delayMs: number): void {
    if (watcher.settled) {
      return;
    }
    watcher.pollTimer = setTimeout(() => {
      watcher.pollTimer = undefined;
      if (this.recoveringTransport) {
        this.scheduleGoalPoll(watcher, 250);
        return;
      }
      void this.readProjectionValues(watcher.sessionId)
        .then(() => this.reconcileGoalState(watcher.sessionId, { throwOnPauseFailure: true }))
        .then(() => {
          if (!watcher.settled) {
            this.scheduleGoalPoll(watcher, 250);
          }
        })
        .catch((error) => this.rejectGoalWatcher(watcher, error));
    }, delayMs);
    watcher.pollTimer.unref?.();
  }

  private async waitForPendingOperation<T>(pending: PendingTurn, operation: Promise<T>): Promise<T> {
    const signal = pending.abortController.signal;
    if (signal.aborted) {
      throw abortError();
    }
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(abortError());
      signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private async createFreshGoal(
    sessionId: string,
    objective: string,
    tokenBudget: number | null,
    signal?: AbortSignal,
  ): Promise<string> {
    const existingValues = await this.readProjectionValues(sessionId);
    const baselineTokens = projectionTokenTotal(existingValues.tokenUsage);
    const existing = parseGoalProjection(existingValues.goal);
    if (existing) {
      const cleared = asRecord(await this.gateway.request("goal.clear", {
        sessionId,
        ref: { id: existing.goal.id, revision: existing.goal.revision },
      }, signal));
      if (cleared?.cleared !== true) {
        throw new Error(`DeepSeek Harness refused to clear existing goal ${existing.goal.id}`);
      }
    }
    await this.deleteGoalBudgetState(sessionId);

    const response = asRecord(await this.gateway.request("goal.create", {
      sessionId,
      objective,
    }, signal));
    const ref = asRecord(response?.ref);
    const goalId = stringValue(ref?.id);
    const revision = numberValue(ref?.revision);
    if (!goalId) {
      throw new Error("DeepSeek Harness goal.create returned no goal id");
    }
    try {
      await this.setGoalBudgetState(sessionId, {
        goalId,
        tokenBudget,
        baselineTokens,
      });
    } catch (error) {
      await this.gateway.request("goal.clear", {
        sessionId,
        ref: { id: goalId, revision: revision ?? 1 },
      }, signal).catch(() => {});
      throw error;
    }
    return goalId;
  }

  private async ensureGoalStateLoaded(): Promise<void> {
    this.goalStateLoadPromise ??= this.loadGoalState();
    await this.goalStateLoadPromise;
  }

  private async loadGoalState(): Promise<void> {
    if (!this.goalStatePath) {
      return;
    }
    let raw: string;
    try {
      raw = await readFile(this.goalStatePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid DeepSeek goal state JSON at ${this.goalStatePath}`, { cause: error });
    }
    const root = asRecord(parsed);
    const sessions = asRecord(root?.sessions);
    if (root?.version !== 1 || !sessions) {
      throw new Error(`Unsupported DeepSeek goal state format at ${this.goalStatePath}`);
    }
    for (const [sessionId, value] of Object.entries(sessions)) {
      const state = asRecord(value);
      const goalId = stringValue(state?.goalId);
      const baselineTokens = numberValue(state?.baselineTokens);
      let tokenBudget: number | null;
      if (state?.tokenBudget === null) {
        tokenBudget = null;
      } else {
        const parsedBudget = numberValue(state?.tokenBudget);
        if (parsedBudget === undefined || parsedBudget < 0) {
          throw new Error(`Invalid DeepSeek goal state for session ${sessionId}`);
        }
        tokenBudget = parsedBudget;
      }
      if (
        !goalId
        || baselineTokens === undefined
        || baselineTokens < 0
      ) {
        throw new Error(`Invalid DeepSeek goal state for session ${sessionId}`);
      }
      this.goalBudgetStates.set(sessionId, { goalId, tokenBudget, baselineTokens });
    }
  }

  private async persistGoalState(): Promise<void> {
    if (!this.goalStatePath) {
      return;
    }
    const sessions = Object.fromEntries(
      [...this.goalBudgetStates.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([sessionId, state]) => [sessionId, state]),
    );
    const serialized = `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`;
    const destination = this.goalStatePath;
    const operation = this.goalStateWriteChain
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.goalStateWriteChain = operation;
    await operation;
  }

  private async setGoalBudgetState(sessionId: string, state: GoalBudgetState): Promise<void> {
    this.goalBudgetStates.set(sessionId, state);
    try {
      await this.persistGoalState();
    } catch (error) {
      if (this.goalBudgetStates.get(sessionId) === state) {
        this.goalBudgetStates.delete(sessionId);
      }
      throw error;
    }
  }

  private async deleteGoalBudgetState(sessionId: string): Promise<void> {
    const previous = this.goalBudgetStates.get(sessionId);
    if (!previous) {
      return;
    }
    this.goalBudgetStates.delete(sessionId);
    try {
      await this.persistGoalState();
    } catch (error) {
      if (!this.goalBudgetStates.has(sessionId)) {
        this.goalBudgetStates.set(sessionId, previous);
      }
      throw error;
    }
  }

  private async ensureObservedGoalBudgetState(
    sessionId: string,
    projection: GoalProjection,
    values: Record<string, unknown>,
  ): Promise<void> {
    if (this.goalBudgetStates.get(sessionId)?.goalId === projection.goal.id) {
      return;
    }
    await this.setGoalBudgetState(sessionId, {
      goalId: projection.goal.id,
      tokenBudget: null,
      baselineTokens: projectionTokenTotal(values.tokenUsage),
    });
  }

  private async pauseGoalForBudget(sessionId: string, initialProjection: GoalProjection): Promise<void> {
    const key = `${sessionId}\u0000${initialProjection.goal.id}`;
    const existing = this.goalBudgetPausePromises.get(key);
    if (existing) {
      return await existing;
    }
    const operation = (async () => {
      let projection = initialProjection;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const values = this.projectionValues.get(sessionId) ?? {};
        const latest = parseGoalProjection(values.goal);
        if (!latest || latest.goal.id !== projection.goal.id || latest.goal.phase !== "active") {
          return;
        }
        projection = latest;
        if (this.codexGoal(sessionId, projection, values).status !== "budgetLimited") {
          return;
        }
        try {
          const response = asRecord(await this.gateway.request("goal.pause", {
            sessionId,
            ref: { id: projection.goal.id, revision: projection.goal.revision },
          }));
          const responseRef = asRecord(response?.ref);
          const currentValues = this.projectionValues.get(sessionId) ?? {};
          const current = parseGoalProjection(currentValues.goal);
          if (
            current?.goal.id === projection.goal.id
            && current.goal.revision === projection.goal.revision
            && current.goal.phase === "active"
          ) {
            currentValues.goal = {
              ...current,
              goal: {
                ...current.goal,
                phase: "paused",
                revision: numberValue(responseRef?.revision) ?? current.goal.revision,
              },
              updatedAt: Date.now(),
            };
            this.projectionValues.set(sessionId, currentValues);
          }
          return;
        } catch (error) {
          const refreshedValues = await this.readProjectionValues(sessionId);
          const refreshed = parseGoalProjection(refreshedValues.goal);
          if (!refreshed || refreshed.goal.id !== projection.goal.id || refreshed.goal.phase !== "active") {
            return;
          }
          if (attempt === 1 || refreshed.goal.revision === projection.goal.revision) {
            throw error;
          }
          projection = refreshed;
        }
      }
    })();
    this.goalBudgetPausePromises.set(key, operation);
    try {
      await operation;
    } finally {
      if (this.goalBudgetPausePromises.get(key) === operation) {
        this.goalBudgetPausePromises.delete(key);
      }
    }
  }

  private async createOrAttachSession(sessionId: string, workspace: string): Promise<void> {
    const requestedWorkspace = path.resolve(workspace);
    const knownWorkspace = this.knownSessionWorkspaces.get(sessionId);
    if (knownWorkspace) {
      if (knownWorkspace !== requestedWorkspace) {
        throw new Error(
          `DeepSeek Harness session ${sessionId} belongs to ${knownWorkspace}, not ${requestedWorkspace}`,
        );
      }
      return;
    }
    const response = asRecord(await this.gateway.request("session.create", {
      sessionId,
      cwd: requestedWorkspace,
      agentPreset: "standard",
    }));
    const actualSessionId = stringValue(response?.sessionId);
    if (!actualSessionId) {
      throw new Error("DeepSeek Harness session.create returned no sessionId");
    }
    if (actualSessionId !== sessionId) {
      throw new Error(`DeepSeek Harness changed preallocated session id ${sessionId} to ${actualSessionId}`);
    }
    this.knownSessionWorkspaces.set(sessionId, requestedWorkspace);
  }

  private async configureSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    const runtime = await this.loadRuntimeConfiguration();
    const fingerprint = JSON.stringify(runtime);
    if (this.configuredSessions.get(sessionId) === fingerprint) {
      return;
    }
    await this.executeHarnessCommand(
      sessionId,
      `/permission ${runtime.permissionPreset}`,
      signal,
    );
    if (runtime.model || runtime.enforceDefaultModel) {
      const defaultModel = runtime.enforceDefaultModel
        ? await this.loadHostDefaultModel(signal)
        : undefined;
      const models = asRecord(await this.gateway.request("session.models", { sessionId }, signal));
      const current = asRecord(models?.current);
      const currentSelection = readModelSelection(current);
      if (!currentSelection) {
        throw new Error("DeepSeek Harness session.models returned no current provider/model");
      }
      const target = resolveModelSelection({
        current: currentSelection,
        baseline: defaultModel,
        configured: runtime.model,
        groups: Array.isArray(models?.groups) ? models.groups : [],
      });
      if (
        currentSelection.provider !== target.provider
        || currentSelection.model !== target.model
        || (target.reasoningEffort !== undefined
          && currentSelection.reasoningEffort !== target.reasoningEffort)
      ) {
        await this.gateway.request("session.selectModel", {
          sessionId,
          provider: target.provider,
          model: target.model,
          ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
        }, signal);
      }
    }
    this.configuredSessions.set(sessionId, fingerprint);
  }

  private async executeHarnessCommand(
    sessionId: string,
    line: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const execution = asRecord(await this.gateway.request("commands/execute", {
      args: {
        agentId: sessionId,
        line,
        images: [],
      },
    }, signal));
    if (!execution) {
      throw new Error(`DeepSeek Harness did not recognize ${line}`);
    }
    const result = asRecord(execution.result);
    const kind = stringValue(result?.kind);
    const text = stringValue(result?.text) ?? "";
    if (kind === "error") {
      throw new Error(text || `DeepSeek Harness command ${line} failed`);
    }
    if (kind !== "success") {
      throw new Error(`DeepSeek Harness returned an invalid result for ${line}`);
    }
    return text;
  }

  private async loadRuntimeConfiguration(): Promise<{
    permissionPreset: DeepSeekHarnessPermissionPreset;
    model?: DeepSeekHarnessModelSelection;
    enforceDefaultModel: boolean;
  }> {
    if (!this.configPath) {
      return {
        permissionPreset: this.permissionPreset,
        ...(this.model ? { model: this.model } : {}),
        enforceDefaultModel: false,
      };
    }
    const parsed = await readValidatedConfigFile(this.configPath);
    const approvalMode = normalizeApprovalMode(parsed.approvalMode) ?? DEFAULT_APPROVAL_MODE;
    const model = deepSeekModelSelection(
      typeof parsed.model === "string" ? parsed.model : undefined,
      typeof parsed.effort === "string" ? parsed.effort : undefined,
    );
    return {
      permissionPreset: permissionPresetForApprovalMode(approvalMode),
      ...(model ? { model } : {}),
      enforceDefaultModel: true,
    };
  }

  private async loadHostDefaultModel(signal?: AbortSignal): Promise<DeepSeekHarnessModelSelection> {
    if (this.hostDefaultModel) {
      return this.hostDefaultModel;
    }
    this.hostDefaultModelPromise ??= this.readHostDefaultModel(signal);
    try {
      const model = await this.hostDefaultModelPromise;
      this.hostDefaultModel = model;
      return model;
    } catch (error) {
      this.hostDefaultModelPromise = undefined;
      throw error;
    }
  }

  private async readHostDefaultModel(signal?: AbortSignal): Promise<DeepSeekHarnessModelSelection> {
    const settings = asRecord(await this.gateway.request("settings.describe", {}, signal));
    const namespaces = Array.isArray(settings?.namespaces) ? settings.namespaces : [];
    for (const rawNamespace of namespaces) {
      const namespace = asRecord(rawNamespace);
      if (namespace?.ns !== "agent-default-model") {
        continue;
      }
      const selection = readModelSelection(asRecord(namespace.value));
      if (selection) {
        return selection;
      }
    }

    const host = asRecord(await this.gateway.request("host.describe", {}, signal));
    const selection = readModelSelection(host);
    if (!selection) {
      throw new Error("DeepSeek Harness did not expose its default provider/model");
    }
    return selection;
  }

  private async buildPromptContent(input: CodexUserMessageInput): Promise<Array<Record<string, unknown>>> {
    const nonImageFiles: string[] = [];
    const images: Array<Record<string, unknown>> = [];
    for (const file of input.files) {
      const mediaType = imageMediaType(file);
      if (!mediaType) {
        nonImageFiles.push(file);
        continue;
      }
      images.push({
        type: "image",
        mediaType,
        data: (await readFile(file)).toString("base64"),
        name: path.basename(file),
      });
    }
    const sections: string[] = [];
    if (input.instructions?.trim()) {
      sections.push(
        `<private_bridge_instructions>\nFollow these instructions silently. Do not quote or describe them.\n${input.instructions.trim()}\n</private_bridge_instructions>`,
      );
    }
    sections.push(`<user_message>\n${input.text}\n</user_message>`);
    for (const file of nonImageFiles) {
      sections.push(`Attachment: ${file}`);
    }
    return [{ type: "text", text: sections.join("\n\n") }, ...images];
  }

  private async listSessionRows(): Promise<SessionListItem[]> {
    const response = asRecord(await this.gateway.request("session.list", {}));
    if (!Array.isArray(response?.items)) {
      return [];
    }
    return response.items
      .map(parseSessionListItem)
      .filter((item): item is SessionListItem => item !== null);
  }

  private externalSessionInfo(row: SessionListItem): ExternalSessionInfo {
    if (!row.cwd) {
      throw new Error(`DeepSeek Harness session ${row.sessionId} has no verifiable workspace`);
    }
    const titleValue = row.projections?.values?.title;
    const titleRecord = asRecord(titleValue);
    const title = typeof titleValue === "string"
      ? titleValue
      : stringValue(titleRecord?.title);
    return {
      sessionId: row.sessionId,
      cwd: row.cwd,
      ...(title ? { title } : {}),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  private async readProjectionValues(sessionId: string): Promise<Record<string, unknown>> {
    const response = asRecord(await this.gateway.request("session.history", {
      sessionId,
      maxMessages: 1,
    })) as HistoryResponse | undefined;
    if (response?.projections?.values) {
      this.mergeProjectionSnapshot(
        sessionId,
        response.projections.values,
        response.projections.asOfSeq,
      );
    }
    return this.projectionValues.get(sessionId) ?? {};
  }

  private mergeProjectionSnapshot(
    sessionId: string,
    snapshot: Record<string, unknown>,
    asOfSeq: number | undefined,
  ): void {
    if (asOfSeq === undefined) {
      throw new Error(`DeepSeek Harness projection snapshot for ${sessionId} is missing asOfSeq`);
    }
    const values = this.projectionValues.get(sessionId) ?? {};
    const watermarks = this.projectionWatermarks.get(sessionId) ?? new Map<string, number>();
    const watermark = asOfSeq;
    const keys = new Set([...Object.keys(values), ...Object.keys(snapshot)]);
    for (const key of keys) {
      if (watermark <= (watermarks.get(key) ?? -1)) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
        values[key] = snapshot[key];
      } else {
        delete values[key];
      }
      watermarks.set(key, watermark);
    }
    this.projectionValues.set(sessionId, values);
    this.projectionWatermarks.set(sessionId, watermarks);
  }

  private codexGoal(
    sessionId: string,
    projection: GoalProjection,
    values: Record<string, unknown>,
  ): CodexThreadGoal {
    const budgetState = this.goalBudgetStates.get(sessionId);
    const matchingBudgetState = budgetState?.goalId === projection.goal.id ? budgetState : undefined;
    const tokenBudget = matchingBudgetState?.tokenBudget ?? null;
    const tokensUsed = matchingBudgetState
      ? Math.max(0, projectionTokenTotal(values.tokenUsage) - matchingBudgetState.baselineTokens)
      : 0;
    const budgetLimited = tokenBudget !== null && tokensUsed >= tokenBudget;
    const status: CodexThreadGoal["status"] = projection.goal.phase === "complete"
      ? "complete"
      : budgetLimited
        ? "budgetLimited"
        : projection.goal.phase === "active"
          ? "active"
          : "paused";
    return {
      threadId: sessionId,
      objective: projection.goal.objective,
      status,
      tokenBudget,
      tokensUsed,
      timeUsedSeconds: Math.max(0, Math.floor((projection.updatedAt - projection.createdAt) / 1_000)),
      createdAt: Math.floor(projection.createdAt / 1_000),
      updatedAt: Math.floor(projection.updatedAt / 1_000),
    };
  }

  private async recoverTransport(info: DeepSeekHarnessReconnectInfo): Promise<void> {
    const barrier = this.beginTransportRecovery();
    let failure: unknown;
    try {
      if (info.reason === "host-restart") {
        await this.closeProcessLocalJobsAfterHostRestart();
      }
      await this.recoverActiveSessions(info.reason === "host-restart");
    } catch (error) {
      failure = error;
    } finally {
      // Keep admission buffered until every recovery batch is drained. A live
      // frame can arrive while a callback for an older buffered frame awaits;
      // releasing the flag before the drain would let that newer sequence jump
      // ahead and make the remaining buffered frame look stale.
      while (this.bufferedFrames.length > 0) {
        const buffered = this.bufferedFrames.splice(0);
        for (const frame of buffered) {
          await this.enqueueFrameNow(frame);
        }
      }
      this.recoveringTransport = false;
      if (this.transportRecoveryBarrier === barrier) {
        this.transportRecoveryBarrier = undefined;
        if (failure === undefined) {
          barrier.resolve();
        } else {
          barrier.reject(failure);
        }
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
  }

  private async closeProcessLocalJobsAfterHostRestart(): Promise<void> {
    const sessions = [...this.jobsBySession.entries()];
    try {
      for (const [sessionId, jobs] of sessions) {
        const owners = this.jobOwnersBySession.get(sessionId);
        for (const job of jobs.values()) {
          const owner = owners?.get(job.id);
          if (!owner || !isLiveJob(job)) {
            continue;
          }
          try {
            await this.emitBackgroundJobFinished(sessionId, owner, {
              ...job,
              status: "failed",
              detail: "DeepSeek Harness restarted before the background job reported completion",
              finishedAt: Date.now(),
            });
          } catch (error) {
            const pending = this.pendingForClaim(sessionId, owner);
            if (pending) {
              this.settleFailure(pending, error);
            }
            const watcher = this.watcherForClaim(sessionId, owner);
            if (watcher) {
              this.rejectGoalWatcher(watcher, error);
            }
          }
        }
      }
    } finally {
      this.jobsBySession.clear();
      this.jobOwnersBySession.clear();
    }
  }

  private async recoverActiveSessions(rearmGoals: boolean): Promise<void> {
    const sessionIds = new Set([
      ...this.pendingTurns.keys(),
      ...this.goalWatchers.keys(),
    ]);
    for (const sessionId of sessionIds) {
      try {
        const events = await this.readHistorySince(
          sessionId,
          this.sessionEventSeqs.get(sessionId) ?? -1,
        );
        for (const entry of events) {
          const event = asRecord(asRecord(entry)?.event);
          if (event) {
            await this.handleSessionEvent({ sessionId, event });
          }
        }
        await this.reconcileGoalState(sessionId);
        if (rearmGoals) {
          await this.rearmGoalAfterHostRestart(sessionId);
        }
      } catch (error) {
        const pending = this.pendingTurns.get(sessionId);
        if (pending) {
          this.settleFailure(pending, error);
        }
        const watcher = this.goalWatchers.get(sessionId);
        if (watcher) {
          this.rejectGoalWatcher(watcher, error);
        }
      }
    }
  }

  private async rearmGoalAfterHostRestart(sessionId: string): Promise<void> {
    const watcher = this.goalWatchers.get(sessionId);
    if (!watcher || watcher.settled || !watcher.goalId) {
      return;
    }
    const values = this.projectionValues.get(sessionId) ?? {};
    const projection = parseGoalProjection(values.goal);
    if (
      !projection
      || projection.goal.id !== watcher.goalId
      || projection.goal.phase !== "active"
      || this.codexGoal(sessionId, projection, values).status !== "active"
    ) {
      return;
    }

    try {
      await this.gateway.request("goal.resume", {
        sessionId,
        ref: { id: projection.goal.id, revision: projection.goal.revision },
      }, watcher.abortController.signal);
    } catch (error) {
      if (!isAlreadyArmedGoalError(error)) {
        throw error;
      }
    }
  }

  private async readHistorySince(sessionId: string, lastSeq: number): Promise<unknown[]> {
    const pages: unknown[][] = [];
    let beforeSeq: number | undefined;
    let complete = false;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const response = asRecord(await this.gateway.request("session.history", {
        sessionId,
        maxMessages: 50,
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      })) as HistoryResponse | undefined;
      if (response?.projections?.values) {
        this.mergeProjectionSnapshot(
          sessionId,
          response.projections.values,
          response.projections.asOfSeq,
        );
      }
      const events = response?.events ?? [];
      pages.unshift(events);
      const seqs = events
        .map((entry) => numberValue(asRecord(asRecord(entry)?.event)?.seq))
        .filter((seq): seq is number => seq !== undefined);
      const oldestSeq = seqs.length > 0 ? Math.min(...seqs) : undefined;
      if (!response?.hasMore) {
        complete = true;
        break;
      }
      if (oldestSeq === undefined) {
        throw new Error(`DeepSeek Harness history pagination for ${sessionId} has more pages but no sequence cursor`);
      }
      if (oldestSeq <= lastSeq) {
        complete = true;
        break;
      }
      if (beforeSeq !== undefined && oldestSeq >= beforeSeq) {
        throw new Error(`DeepSeek Harness history pagination for ${sessionId} did not advance`);
      }
      beforeSeq = oldestSeq;
    }
    if (!complete) {
      throw new Error(`DeepSeek Harness history pagination limit reached for ${sessionId}`);
    }
    return pages
      .flat()
      .sort((left, right) => (
        numberValue(asRecord(asRecord(left)?.event)?.seq) ?? Number.MAX_SAFE_INTEGER
      ) - (
        numberValue(asRecord(asRecord(right)?.event)?.seq) ?? Number.MAX_SAFE_INTEGER
      ));
  }
}

type Question = {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  intent?: unknown;
};

function permissionPresetForApprovalMode(
  approvalMode: "normal" | "full-auto" | "bypass",
): DeepSeekHarnessPermissionPreset {
  if (approvalMode === "bypass") {
    return "danger-full-access";
  }
  if (approvalMode === "full-auto") {
    return "full-auto";
  }
  return "workspace-write";
}

function deepSeekModelSelection(
  configuredModel: string | undefined,
  reasoningEffort: string | undefined,
): DeepSeekHarnessModelSelection | undefined {
  const model = configuredModel?.trim();
  const effort = reasoningEffort?.trim();
  if (!model && !effort) {
    return undefined;
  }
  if (!model) {
    return { reasoningEffort: effort };
  }
  const separator = model.indexOf("/");
  if (separator > 0 && separator < model.length - 1) {
    return {
      provider: model.slice(0, separator),
      model: model.slice(separator + 1),
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  }
  return { model, ...(effort ? { reasoningEffort: effort } : {}) };
}

function readModelSelection(value: Record<string, unknown> | undefined): DeepSeekHarnessModelSelection | undefined {
  const provider = stringValue(value?.provider)?.trim();
  const model = stringValue(value?.model)?.trim();
  if (!provider || !model) {
    return undefined;
  }
  const reasoningEffort = stringValue(value?.reasoningEffort)?.trim();
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function resolveModelSelection(input: {
  current: DeepSeekHarnessModelSelection;
  baseline?: DeepSeekHarnessModelSelection;
  configured?: DeepSeekHarnessModelSelection;
  groups: unknown[];
}): Required<Pick<DeepSeekHarnessModelSelection, "provider" | "model">> & DeepSeekHarnessModelSelection {
  const base = input.baseline ?? input.current;
  const model = input.configured?.model ?? base.model;
  if (!model) {
    throw new Error("DeepSeek Harness has no model to configure");
  }
  const preferredProvider = input.configured?.provider ?? base.provider ?? input.current.provider;
  const provider = input.configured?.provider
    ?? providerForModel(input.groups, model, preferredProvider)
    ?? preferredProvider;
  if (!provider) {
    throw new Error(`DeepSeek Harness has no provider for model ${model}`);
  }
  const reasoningEffort = input.configured?.reasoningEffort
    ?? (
      input.configured?.model === undefined
      && input.configured?.provider === undefined
      && base.reasoningEffort
        ? base.reasoningEffort
        : defaultEffortForModel(input.groups, provider, model)
    );
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function providerForModel(
  groups: unknown[],
  model: string,
  preferredProvider: string | undefined,
): string | undefined {
  const candidates = groups.flatMap((rawGroup) => {
    const group = asRecord(rawGroup);
    const provider = stringValue(group?.id);
    const models = Array.isArray(group?.models) ? group.models : [];
    return provider && models.some((rawModel) => stringValue(asRecord(rawModel)?.id) === model)
      ? [provider]
      : [];
  });
  if (preferredProvider && candidates.includes(preferredProvider)) {
    return preferredProvider;
  }
  return candidates.length === 1 ? candidates[0] : preferredProvider;
}

function defaultEffortForModel(
  groups: unknown[],
  provider: string,
  model: string,
): string | undefined {
  for (const rawGroup of groups) {
    const group = asRecord(rawGroup);
    if (stringValue(group?.id) !== provider || !Array.isArray(group?.models)) {
      continue;
    }
    for (const rawModel of group.models) {
      const candidate = asRecord(rawModel);
      if (stringValue(candidate?.id) !== model) {
        continue;
      }
      return stringValue(asRecord(candidate?.reasoning)?.defaultEffort);
    }
  }
  return undefined;
}

function parseQuestion(value: unknown): Question | null {
  const record = asRecord(value);
  const id = stringValue(record?.id);
  const question = stringValue(record?.question);
  if (!id || !question) {
    return null;
  }
  const options = Array.isArray(record?.options)
    ? record.options.map((option) => {
      const item = asRecord(option);
      const label = stringValue(item?.label);
      return label ? { label, ...(stringValue(item?.description) ? { description: stringValue(item?.description)! } : {}) } : null;
    }).filter((option): option is { label: string; description?: string } => option !== null)
    : undefined;
  return {
    id,
    question,
    ...(stringValue(record?.detail) ? { detail: stringValue(record?.detail)! } : {}),
    ...(stringValue(record?.header) ? { header: stringValue(record?.header)! } : {}),
    ...(options ? { options } : {}),
    ...(typeof record?.multiSelect === "boolean" ? { multiSelect: record.multiSelect } : {}),
    ...(record?.intent !== undefined ? { intent: record.intent } : {}),
  };
}

function questionAnswers(
  questions: Question[],
  updatedInput: unknown,
): Array<{ id: string; selected: string[]; custom?: string }> {
  const input = asRecord(updatedInput);
  const answerRecord = asRecord(input?.answers) ?? {};
  return questions.map((question) => {
    const raw = answerRecord[question.question];
    const values = Array.isArray(raw)
      ? raw.filter((value): value is string => typeof value === "string")
      : typeof raw === "string"
        ? question.multiSelect
          ? raw.split(/\s*[,，]\s*/).filter(Boolean)
          : [raw]
        : [];
    const labels = new Set(question.options?.map((option) => option.label) ?? []);
    const selected = values.filter((value) => labels.has(value));
    const customValues = values.filter((value) => !labels.has(value));
    return {
      id: question.id,
      selected,
      ...(customValues.length > 0 ? { custom: customValues.join(", ") } : {}),
    };
  });
}

function parseSessionListItem(value: unknown): SessionListItem | null {
  const record = asRecord(value);
  const sessionId = stringValue(record?.sessionId);
  const updatedAt = numberValue(record?.updatedAt);
  if (!sessionId || updatedAt === undefined) {
    return null;
  }
  const projections = asRecord(record?.projections);
  return {
    sessionId,
    updatedAt,
    running: record?.running === true,
    blank: record?.blank === true,
    ...(stringValue(record?.cwd) ? { cwd: stringValue(record?.cwd)! } : {}),
    ...(projections ? {
      projections: {
        ...(numberValue(projections.asOfSeq) !== undefined ? { asOfSeq: numberValue(projections.asOfSeq)! } : {}),
        ...(asRecord(projections.values) ? { values: asRecord(projections.values)! } : {}),
      },
    } : {}),
  };
}

function parseJob(value: unknown): Job | null {
  const record = asRecord(value);
  const id = stringValue(record?.id);
  const kind = stringValue(record?.kind);
  const label = stringValue(record?.label);
  const status = stringValue(record?.status) as Job["status"] | undefined;
  const startedAt = numberValue(record?.startedAt);
  if (!id || !kind || !label || !status || startedAt === undefined) {
    return null;
  }
  if (!["running", "stopping", "completed", "killed", "failed"].includes(status)) {
    return null;
  }
  return {
    id,
    kind,
    label,
    status,
    startedAt,
    ...(stringValue(record?.detail) ? { detail: stringValue(record?.detail)! } : {}),
    ...(numberValue(record?.finishedAt) !== undefined ? { finishedAt: numberValue(record?.finishedAt)! } : {}),
  };
}

function isLiveJob(job: Job): boolean {
  return job.status === "running" || job.status === "stopping";
}

function isAlreadyArmedGoalError(error: unknown): boolean {
  if (!(error instanceof DeepSeekHarnessRpcError) || error.code !== "internal") {
    return false;
  }
  return asRecord(error.details)?.goalCode === "GOAL_INVALID_TRANSITION"
    && /already active and armed/i.test(error.message);
}

function parseGoalProjection(value: unknown): GoalProjection | null {
  const record = asRecord(value);
  const goal = asRecord(record?.goal);
  const id = stringValue(goal?.id);
  const revision = numberValue(goal?.revision);
  const objective = stringValue(goal?.objective);
  const phase = stringValue(goal?.phase) as GoalProjection["goal"]["phase"] | undefined;
  const maxGoalRounds = numberValue(goal?.maxGoalRounds);
  const roundsStarted = numberValue(record?.roundsStarted);
  const createdAt = numberValue(record?.createdAt);
  const updatedAt = numberValue(record?.updatedAt);
  if (
    !id || revision === undefined || !objective || !phase || maxGoalRounds === undefined
    || roundsStarted === undefined || createdAt === undefined || updatedAt === undefined
  ) {
    return null;
  }
  return {
    goal: { id, revision, objective, phase, maxGoalRounds },
    roundsStarted,
    createdAt,
    updatedAt,
  };
}

function parseUsage(value: unknown): Usage | null {
  const record = asRecord(value);
  const inputTokens = numberValue(record?.inputTokens);
  const outputTokens = numberValue(record?.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: numberValue(record?.cacheReadTokens) ?? 0,
    cacheWriteTokens: numberValue(record?.cacheWriteTokens) ?? 0,
  };
}

function aggregateUsage(usages: Iterable<Usage>): AdapterUsage | undefined {
  let count = 0;
  const total = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  for (const usage of usages) {
    count += 1;
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cachedTokens += usage.cacheReadTokens + usage.cacheWriteTokens;
  }
  return count > 0 ? total : undefined;
}

function projectionTokenTotal(value: unknown): number {
  const record = asRecord(value);
  return [
    record?.uncachedInputTokens,
    record?.outputTokens,
    record?.cacheReadTokens,
    record?.cacheWriteTokens,
  ].reduce<number>((sum, part) => sum + (numberValue(part) ?? 0), 0);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function textFromContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  const texts: string[] = [];
  for (const item of value) {
    const block = asRecord(item);
    if (!block) {
      continue;
    }
    if ((block.type === "text" || block.type === "reasoning") && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "tool-result") {
      const nested = textFromContent(block.content);
      if (nested) {
        texts.push(nested);
      }
    }
  }
  return texts.join("\n");
}

function assistantContentText(value: unknown, type: "text" | "reasoning"): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => asRecord(item))
    .filter((block): block is Record<string, unknown> => block?.type === type)
    .map((block) => stringValue(block.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

function imageMediaType(filePath: string): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return null;
  }
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function waitForOperationOrAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortError();
  }
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(abortError());
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

function abortError(): Error {
  const error = new Error("DeepSeek Harness turn was aborted");
  error.name = "AbortError";
  return error;
}

function formatTimeoutMinutes(timeoutMs: number): string {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
