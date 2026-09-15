import {
  BoardStore,
  type BoardAttachment,
  type BoardAttachmentInput,
  type BoardClaim,
  type BoardClaimResult,
  type BoardCompletionResult,
  type BoardComment,
  type BoardDispatchResult,
  type BoardDispatcherPolicy,
  type BoardEvent,
  type BoardExport,
  type BoardExportOptions,
  type BoardGcReport,
  type BoardMutationOptions,
  type BoardOperationalDiagnostics,
  type BoardPlanInput,
  type BoardReadyResult,
  type BoardRecord,
  type BoardRepairReport,
  type BoardSettingsPatch,
  type BoardStats,
  type BoardSubscription,
  type BoardTaskActor,
  type BoardTaskCardUpdate,
  type BoardTaskCommentInput,
  type BoardTaskDeleteResult,
  type BoardTaskEditUpdate,
  type BoardTaskExecutionUpdate,
  type BoardTaskInput,
  type BoardTaskPriority,
  type BoardTaskRecord,
  type BoardTaskStatus,
  type BoardTaskWorkspaceInput,
  type BoardWipLimits,
} from "./board-store.js";
import type { BoardDiagnostics } from "./sqlite-kanban-repository.js";

export type BoardErrorCode =
  | "BOARD_NOT_FOUND"
  | "BOARD_INVALID_TRANSITION"
  | "BOARD_DEPENDENCY_CONFLICT"
  | "BOARD_WIP_LIMIT"
  | "BOARD_CLAIM_CONFLICT"
  | "BOARD_STALE_REVISION"
  | "BOARD_AUTHORIZATION"
  | "BOARD_VALIDATION"
  | "BOARD_STORAGE"
  | "BOARD_DISPATCH"
  | "BOARD_OPERATION_FAILED";

export class BoardDomainError extends Error {
  constructor(
    public readonly code: BoardErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BoardDomainError";
  }
}

export class BoardNotFoundError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_NOT_FOUND", message, options);
    this.name = "BoardNotFoundError";
  }
}

export class BoardInvalidTransitionError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_INVALID_TRANSITION", message, options);
    this.name = "BoardInvalidTransitionError";
  }
}

export class BoardDependencyConflictError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_DEPENDENCY_CONFLICT", message, options);
    this.name = "BoardDependencyConflictError";
  }
}

export class BoardWipLimitError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_WIP_LIMIT", message, options);
    this.name = "BoardWipLimitError";
  }
}

export class BoardClaimConflictError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_CLAIM_CONFLICT", message, options);
    this.name = "BoardClaimConflictError";
  }
}

export class BoardStaleRevisionError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_STALE_REVISION", message, options);
    this.name = "BoardStaleRevisionError";
  }
}

export class BoardAuthorizationError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_AUTHORIZATION", message, options);
    this.name = "BoardAuthorizationError";
  }
}

export class BoardValidationError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_VALIDATION", message, options);
    this.name = "BoardValidationError";
  }
}

export class BoardStorageError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_STORAGE", message, options);
    this.name = "BoardStorageError";
  }
}

export class BoardDispatchError extends BoardDomainError {
  constructor(message: string, options?: ErrorOptions) {
    super("BOARD_DISPATCH", message, options);
    this.name = "BoardDispatchError";
  }
}

function classifyBoardError(error: unknown): BoardDomainError {
  if (error instanceof BoardDomainError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const options = error instanceof Error ? { cause: error } : undefined;
  if (/board (?:task|checklist item|run|attachment) not found|board not found/i.test(message)) {
    return new BoardNotFoundError(message, options);
  }
  if (/stale revision/i.test(message)) {
    return new BoardStaleRevisionError(message, options);
  }
  if (/WIP limit/i.test(message)) {
    return new BoardWipLimitError(message, options);
  }
  if (/claim conflict|already claimed|claim expired|active claim|lease token/i.test(message)) {
    return new BoardClaimConflictError(message, options);
  }
  if (/dependency cycle|parent cycle|unmet dependencies|cannot depend on itself|cannot be its own parent|unknown board plan dependency|parent and child|dependency tasks must belong/i.test(message)) {
    return new BoardDependencyConflictError(message, options);
  }
  if (/already running|cannot be (?:started|completed|marked ready|scheduled|promoted|blocked|unblocked|edited|reassigned|linked|deleted)|must be .* before (?:starting|claiming)|has no running run|is not in review|does not require review|cannot request review|cannot reopen review|is not archived|already archived|schedule is not due/i.test(message)) {
    return new BoardInvalidTransitionError(message, options);
  }
  if (/SQLITE_|Kanban database|repository transaction|invalid board store state|schema version/i.test(message)) {
    return new BoardStorageError(message, options);
  }
  if (/outside the instance state|escapes the asset root|symbolic link|non-symbolic-link/i.test(message)) {
    return new BoardAuthorizationError(message, options);
  }
  if (/required|invalid board|must be absolute|at most \d+ tasks|duplicate board|already exists|confirmation must exactly match|must be a (?:positive|non-negative)|oversized|size mismatch|hash mismatch|unsupported board import|idempotency key/i.test(message)) {
    return new BoardValidationError(message, options);
  }
  return new BoardDomainError("BOARD_OPERATION_FAILED", message, options);
}

async function runBoardOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw classifyBoardError(error);
  }
}

/** Shared application boundary used by Telegram, Lark, CLI, Web, and model tools. */
export class BoardService {
  private readonly store: BoardStore;

  constructor(stateDir: string, store?: BoardStore) {
    this.store = store ?? new BoardStore(stateDir);
  }

  async listBoards(): Promise<BoardRecord[]> {
    return await runBoardOperation(() => this.store.listBoards());
  }

  async getBoard(slug: string): Promise<BoardRecord | null> {
    return await runBoardOperation(() => this.store.getBoard(slug));
  }

  async createBoard(input: {
    name: string;
    slug?: string;
    settings?: BoardSettingsPatch;
    dispatcherPolicy?: BoardDispatcherPolicy;
  }, options: BoardMutationOptions = {}): Promise<BoardRecord> {
    return await runBoardOperation(() => this.store.createBoard(input, options));
  }

  async getActiveBoard(conversationKey: string): Promise<BoardRecord> {
    return await runBoardOperation(() => this.store.getActiveBoard(conversationKey));
  }

  async selectBoard(conversationKey: string, slug: string, options: BoardMutationOptions = {}): Promise<BoardRecord> {
    return await runBoardOperation(() => this.store.selectBoard(conversationKey, slug, options));
  }

  async updateBoardSettings(
    slug: string,
    patch: BoardSettingsPatch,
    options: BoardMutationOptions = {},
  ): Promise<BoardRecord> {
    return await runBoardOperation(() => this.store.updateBoardSettings(slug, patch, options));
  }

  async setDispatcherPolicy(
    slug: string,
    policy: BoardDispatcherPolicy,
    options: BoardMutationOptions = {},
  ): Promise<BoardRecord> {
    return await runBoardOperation(() => this.store.setDispatcherPolicy(slug, policy, options));
  }

  async listEvents(input: {
    boardSlug?: string;
    taskId?: string;
    afterSequence?: number;
    limit?: number;
  } = {}): Promise<BoardEvent[]> {
    return await runBoardOperation(() => this.store.listEvents(input));
  }

  async listSubscriptions(slug: string): Promise<BoardSubscription[]> {
    return await runBoardOperation(() => this.store.listSubscriptions(slug));
  }

  async subscribe(
    slug: string,
    conversationKey: string,
    eventFilter: string[] = [],
    options: BoardMutationOptions = {},
  ): Promise<BoardSubscription> {
    return await runBoardOperation(() => this.store.subscribe(slug, conversationKey, eventFilter, options));
  }

  async unsubscribe(slug: string, conversationKey: string, options: BoardMutationOptions = {}): Promise<boolean> {
    return await runBoardOperation(() => this.store.unsubscribe(slug, conversationKey, options));
  }

  async listTasks(status?: BoardTaskStatus): Promise<BoardTaskRecord[]> {
    return await runBoardOperation(() => this.store.listTasks(status));
  }

  async listBoardTasks(slug: string, status?: BoardTaskStatus): Promise<BoardTaskRecord[]> {
    return await runBoardOperation(() => this.store.listBoardTasks(slug, status));
  }

  async listChildTasks(id: string): Promise<BoardTaskRecord[]> {
    return await runBoardOperation(() => this.store.listChildTasks(id));
  }

  async getTask(id: string): Promise<BoardTaskRecord | null> {
    return await runBoardOperation(() => this.store.getTask(id));
  }

  async createTask(input: BoardTaskInput, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.createTask(input, options));
  }

  async editTask(id: string, update: BoardTaskEditUpdate, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.editTask(id, update, options));
  }

  async acceptTriage(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.acceptTriage(id, options));
  }

  async reassignTask(id: string, assignee: string | null, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.reassignTask(id, assignee, options));
  }

  async linkDependency(id: string, dependencyId: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.linkDependency(id, dependencyId, options));
  }

  async removeDependency(id: string, dependencyId: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.removeDependency(id, dependencyId, options));
  }

  async deleteTask(
    id: string,
    input: BoardMutationOptions & { confirmTaskId: string },
  ): Promise<BoardTaskDeleteResult> {
    return await runBoardOperation(() => this.store.deleteTask(id, input));
  }

  async updateTaskCard(id: string, update: BoardTaskCardUpdate, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.updateTaskCard(id, update, options));
  }

  async appendAcceptanceCriterion(
    id: string,
    criterion: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.appendAcceptanceCriterion(id, criterion, options));
  }

  async appendChecklistItem(id: string, text: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.appendChecklistItem(id, text, options));
  }

  async setChecklistItemDone(
    id: string,
    checklistItemId: string,
    done: boolean,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.setChecklistItemDone(id, checklistItemId, done, options));
  }

  async getLimits(): Promise<BoardWipLimits> {
    return await runBoardOperation(() => this.store.getLimits());
  }

  async setLimits(limits: Partial<BoardWipLimits>, options: BoardMutationOptions = {}): Promise<BoardWipLimits> {
    return await runBoardOperation(() => this.store.setLimits(limits, options));
  }

  async createPlan(input: BoardPlanInput, options: BoardMutationOptions = {}): Promise<{ tasks: BoardTaskRecord[] }> {
    return await runBoardOperation(() => this.store.createPlan(input, options));
  }

  async setTaskWorkspace(
    id: string,
    workspace: BoardTaskWorkspaceInput,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.setTaskWorkspace(id, workspace, options));
  }

  async setTaskExecution(
    id: string,
    execution: BoardTaskExecutionUpdate,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.setTaskExecution(id, execution, options));
  }

  async setParentTask(id: string, parentTaskId: string | null, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.setParentTask(id, parentTaskId, options));
  }

  async scheduleTask(
    id: string,
    scheduledAt: string,
    timezone?: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.scheduleTask(id, scheduledAt, timezone, options));
  }

  async promoteScheduledTask(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.promoteScheduledTask(id, options));
  }

  async promoteDueTasks(slug: string, now?: Date): Promise<BoardTaskRecord[]> {
    return await runBoardOperation(() => this.store.promoteDueTasks(slug, now));
  }

  async archiveTask(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.archiveTask(id, options));
  }

  async restoreTask(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.restoreTask(id, options));
  }

  async cancelTask(id: string, reason: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.cancelTask(id, reason, options));
  }

  async timeoutTask(id: string, reason?: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.timeoutTask(id, reason, options));
  }

  async reopenReview(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.reopenReview(id, options));
  }

  async updateRunEvidence(
    id: string,
    runId: string,
    update: { logText?: string; inputTokens?: number; outputTokens?: number; costUsd?: number; summary?: string },
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.updateRunEvidence(id, runId, update, options));
  }

  async listComments(id: string): Promise<BoardComment[]> {
    return await runBoardOperation(() => this.store.listComments(id));
  }

  async addComment(
    id: string,
    input: BoardTaskCommentInput,
  ): Promise<{ task: BoardTaskRecord; comment: BoardComment }> {
    return await runBoardOperation(() => this.store.addComment(id, input));
  }

  async listAttachments(id: string): Promise<BoardAttachment[]> {
    return await runBoardOperation(() => this.store.listAttachments(id));
  }

  async attachFile(
    id: string,
    input: BoardAttachmentInput,
  ): Promise<{ task: BoardTaskRecord; attachment: BoardAttachment }> {
    return await runBoardOperation(() => this.store.attachFile(id, input));
  }

  async detachAttachment(
    id: string,
    attachmentId: string,
    options: BoardMutationOptions = {},
  ): Promise<{ task: BoardTaskRecord; attachment: BoardAttachment }> {
    return await runBoardOperation(() => this.store.detachAttachment(id, attachmentId, options));
  }

  async getClaim(id: string): Promise<BoardClaim | null> {
    return await runBoardOperation(() => this.store.getClaim(id));
  }

  async listClaims(slug?: string): Promise<BoardClaim[]> {
    return await runBoardOperation(() => this.store.listClaims(slug));
  }

  async claimTask(
    id: string,
    owner: string,
    input: BoardMutationOptions & { leaseDurationMs?: number } = {},
  ): Promise<BoardClaimResult> {
    return await runBoardOperation(() => this.store.claimTask(id, owner, input));
  }

  async heartbeatClaim(
    id: string,
    leaseToken: string,
    input: BoardMutationOptions & { leaseDurationMs?: number; note?: string } = {},
  ): Promise<BoardClaimResult> {
    return await runBoardOperation(() => this.store.heartbeatClaim(id, leaseToken, input));
  }

  async releaseClaim(id: string, leaseToken: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.releaseClaim(id, leaseToken, options));
  }

  async startClaimedTask(id: string, leaseToken: string, options: BoardMutationOptions = {}): Promise<BoardClaimResult> {
    return await runBoardOperation(() => this.store.startClaimedTask(id, leaseToken, options));
  }

  async dispatchNext(
    slug: string,
    input: BoardMutationOptions & { owner?: string; automatic?: boolean } = {},
  ): Promise<BoardDispatchResult> {
    return await runBoardOperation(() => this.store.dispatchNext(slug, input));
  }

  async completeClaimedTask(
    id: string,
    leaseToken: string,
    summary?: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardCompletionResult> {
    return await runBoardOperation(() => this.store.completeClaimedTask(id, leaseToken, summary, options));
  }

  async recordDispatchFailure(
    id: string,
    leaseToken: string,
    error: string,
    input: BoardMutationOptions & { infrastructure?: boolean } = {},
  ): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.recordDispatchFailure(id, leaseToken, error, input));
  }

  async recoverExpiredClaims(now?: Date): Promise<BoardTaskRecord[]> {
    return await runBoardOperation(() => this.store.recoverExpiredClaims(now));
  }

  async recoverTimedOutRuns(now?: Date): Promise<BoardTaskRecord[]> {
    return await runBoardOperation(() => this.store.recoverTimedOutRuns(now));
  }

  async requestReview(id: string, summary?: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.requestReview(id, summary, options));
  }

  async approveReview(id: string, options: BoardMutationOptions = {}): Promise<BoardCompletionResult> {
    return await runBoardOperation(() => this.store.approveReview(id, options));
  }

  async requestChanges(id: string, reason: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.requestChanges(id, reason, options));
  }

  async stats(slug: string): Promise<BoardStats> {
    return await runBoardOperation(() => this.store.stats(slug));
  }

  async exportBoard(slug: string, options: BoardExportOptions = {}): Promise<BoardExport> {
    return await runBoardOperation(() => this.store.exportBoard(slug, options));
  }

  async importBoard(
    value: unknown,
    input: BoardMutationOptions & { slug?: string; name?: string; maxAttachmentBytes?: number } = {},
  ): Promise<{ board: BoardRecord; taskIds: string[] }> {
    return await runBoardOperation(() => this.store.importBoard(value, input));
  }

  async operationalDiagnostics(now?: Date): Promise<BoardOperationalDiagnostics> {
    return await runBoardOperation(() => this.store.operationalDiagnostics(now));
  }

  async repair(input: BoardMutationOptions & { confirm?: boolean } = {}): Promise<BoardRepairReport> {
    return await runBoardOperation(() => this.store.repair(input));
  }

  async gcAssets(input: BoardMutationOptions & { confirm?: boolean } = {}): Promise<BoardGcReport> {
    return await runBoardOperation(() => this.store.gcAssets(input));
  }

  async heartbeatTask(
    id: string,
    note?: string,
    now?: Date,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.heartbeatTask(id, note, now, options));
  }

  async recoverStaleRuns(input: {
    olderThanMs: number;
    now?: Date;
    reason?: string;
    actor?: BoardTaskActor;
  }): Promise<BoardTaskRecord[]> {
    return await runBoardOperation(() => this.store.recoverStaleRuns(input));
  }

  async assignTask(id: string, assignee: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.assignTask(id, assignee, options));
  }

  async addDependency(id: string, dependencyId: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.addDependency(id, dependencyId, options));
  }

  async markReady(id: string, options: BoardMutationOptions = {}): Promise<BoardReadyResult> {
    return await runBoardOperation(() => this.store.markReady(id, options));
  }

  async startTask(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.startTask(id, options));
  }

  async startReadyTask(id: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.startReadyTask(id, options));
  }

  async failTask(id: string, error: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.failTask(id, error, options));
  }

  async failRunningRun(
    id: string,
    runId: string,
    error: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord | null> {
    return await runBoardOperation(() => this.store.failRunningRun(id, runId, error, options));
  }

  async blockTask(id: string, reason: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.blockTask(id, reason, options));
  }

  async unblockTask(id: string, options: BoardMutationOptions = {}): Promise<BoardReadyResult> {
    return await runBoardOperation(() => this.store.unblockTask(id, options));
  }

  async completeTask(
    id: string,
    summary?: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardCompletionResult> {
    return await runBoardOperation(() => this.store.completeTask(id, summary, options));
  }

  async completeRunningRun(
    id: string,
    runId: string,
    summary?: string,
    options: BoardMutationOptions = {},
  ): Promise<BoardCompletionResult | null> {
    return await runBoardOperation(() => this.store.completeRunningRun(id, runId, summary, options));
  }

  async setReviewGate(
    id: string,
    review: { required: boolean; reviewer?: string },
    options: BoardMutationOptions = {},
  ): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.setReviewGate(id, review, options));
  }

  async approveTask(id: string, options: BoardMutationOptions = {}): Promise<BoardCompletionResult> {
    return await runBoardOperation(() => this.store.approveTask(id, options));
  }

  async rejectTask(id: string, reason: string, options: BoardMutationOptions = {}): Promise<BoardTaskRecord> {
    return await runBoardOperation(() => this.store.rejectTask(id, reason, options));
  }

  async diagnostics(): Promise<BoardDiagnostics> {
    return await runBoardOperation(() => this.store.diagnostics());
  }
}

export type BoardOperations = Pick<
  BoardService,
  | "listTasks"
  | "getTask"
  | "createTask"
  | "updateTaskCard"
  | "appendAcceptanceCriterion"
  | "appendChecklistItem"
  | "setChecklistItemDone"
  | "getLimits"
  | "setLimits"
  | "createPlan"
  | "setTaskWorkspace"
  | "heartbeatTask"
  | "recoverStaleRuns"
  | "assignTask"
  | "addDependency"
  | "markReady"
  | "startTask"
  | "startReadyTask"
  | "failTask"
  | "failRunningRun"
  | "blockTask"
  | "unblockTask"
  | "completeTask"
  | "completeRunningRun"
  | "setReviewGate"
  | "approveTask"
  | "rejectTask"
  | "diagnostics"
>;

export type { BoardTaskPriority };
