import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import { resolveInstanceLockPath, type InstanceLockRecord } from "../state/instance-lock.js";
import { InstanceLockRecordSchema } from "../state/instance-lock-schema.js";
import { AccessStore } from "../state/access-store.js";
import {
  getLatestFailure,
  parseAuditEvents,
  resolveAuditLogPath,
  summarizeAuditEvents,
  type AuditSummary,
} from "../state/audit-log.js";
import {
  parseTimelineEvents,
  resolveTimelineLogPath,
  summarizeTimelineEvents,
  type TimelineSummary,
} from "../state/timeline-log.js";
import { CREW_RUN_STATE_UNREADABLE_WARNING, CrewRunStore } from "../state/crew-run-store.js";
import { FILE_WORKFLOW_STATE_UNREADABLE_WARNING } from "../state/file-workflow-store.js";
import { FileWorkflowStore } from "../state/file-workflow-store.js";
import { TelegramApi } from "../telegram/api.js";
import {
  getLastHandledUpdateId,
  lookupTelegramBotIdentity,
  readConfiguredBotToken,
  readInstanceRuntimeConfig,
  resolveEngineRuntime,
} from "../service.js";
import { inspectSessions as inspectSessionBindings } from "./session.js";

export interface ServiceCommandEnv
  extends Pick<
    EnvSource,
    "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR" | "TELEGRAM_BOT_TOKEN" | "CODEX_HOME" | "CLAUDE_CONFIG_DIR"
  > {}

export interface ServiceCommandDeps {
  cwd?: string;
  isProcessAlive?: (pid: number) => boolean;
  isExpectedServiceProcess?: (pid: number, entryPath: string, instanceName: string) => boolean;
  spawnDetached?: (command: string, args: string[], options: { cwd: string; stdoutPath: string; stderrPath: string }) => void;
  sleep?: (ms: number) => Promise<void>;
  killProcessTree?: (pid: number) => void;
  readTextFile?: (filePath: string) => Promise<string>;
  readConfiguredBotToken?: (env: ServiceCommandEnv, instanceName: string) => Promise<string | null>;
  fetchTelegramBotIdentity?: (botToken: string) => Promise<{ firstName: string; username?: string }>;
  readProcessEnvironment?: (pid: number) => Promise<Record<string, string> | null>;
}

export interface ServicePaths {
  instanceName: string;
  stateDir: string;
  lockPath: string;
  stdoutPath: string;
  stderrPath: string;
  entryPath: string;
}

export interface ServiceLiveness {
  running: boolean;
  pid: number | null;
}

export interface ServiceStatus {
  instanceName: string;
  running: boolean;
  pid: number | null;
  engine: string;
  runtime: string;
  lockPath: string;
  stateDir: string;
  stdoutPath: string;
  stderrPath: string;
  policy: string;
  pairedUsers: number;
  allowlistCount: number;
  pendingPairs: number;
  sessionBindings: number | null;
  sessionBindingsWarning?: string;
  lastHandledUpdateId: number | null;
  botTokenConfigured: boolean;
  botIdentity?: {
    firstName: string;
    username?: string;
  };
  botIdentityWarning?: string;
  lastErrorLine?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  auditEvents: number;
  latestFailureCategory?: string;
  timelineEvents: number | null;
  lastTurnCompletionAt?: string;
  lastRetryAt?: string;
  lastBudgetBlockedAt?: string;
  retryCount: number | null;
  budgetBlockedCount: number | null;
  fileRejectedCount: number | null;
  workflowFailedCount: number | null;
  crewRunsStartedCount: number | null;
  crewRunsCompletedCount: number | null;
  crewRunsFailedCount: number | null;
  lastCrewRunAt?: string;
  latestCrewRunId?: string;
  latestCrewRunWorkflow?: string;
  latestCrewRunStatus?: string;
  latestCrewRunStage?: string;
  latestCrewRunUpdatedAt?: string;
  crewRunStateWarning?: string;
  timelineWarning?: string;
  unresolvedTasks: number | null;
  blockingTasks: number | null;
  awaitingContinueTasks: number | null;
  unresolvedTasksWarning?: string;
}

export interface ServiceDoctorResult {
  instanceName: string;
  engine: string;
  runtime: string;
  healthy: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
  }>;
}

const BLOCKING_WORKFLOW_STATUSES = new Set(["preparing", "processing", "failed"]);
const LEGACY_AUTOSTART_LABEL_PREFIX = "com.cloveric.cc-telegram-bridge.";

function resolveHomeDir(env: Pick<ServiceCommandEnv, "HOME" | "USERPROFILE">): string {
  const homeDir = env.HOME ?? env.USERPROFILE;
  if (!homeDir) {
    throw new Error("HOME or USERPROFILE is required");
  }

  return homeDir;
}

function resolveLegacyLaunchAgentPlistPath(
  env: Pick<ServiceCommandEnv, "HOME" | "USERPROFILE">,
  instanceName: string,
): string {
  return path.join(
    resolveHomeDir(env),
    "Library",
    "LaunchAgents",
    `${LEGACY_AUTOSTART_LABEL_PREFIX}${normalizeInstanceName(instanceName)}.plist`,
  );
}

function formatLegacyLaunchdWarning(instanceName: string): string {
  return `Warning: legacy launchd plist still exists. Run "bash scripts/cleanup-legacy-launchd.sh ${instanceName}" to remove it.`;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return false;
      }

      if (code === "EPERM") {
        return true;
      }
    }

    throw error;
  }
}

function defaultIsExpectedServiceProcess(pid: number, entryPath: string, instanceName: string): boolean {
  if (process.platform === "win32") {
    const relativeEntryPath = path.relative(process.cwd(), entryPath).replace(/\\/g, "/");
    const encoded = Buffer.from(
      `
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}";
        if ($null -eq $proc) { exit 1 }
        $proc.CommandLine
      `,
      "utf16le",
    ).toString("base64");

    const result = spawnSync("pwsh", ["-NoProfile", "-EncodedCommand", encoded], {
      windowsHide: true,
      encoding: "utf8",
    });

    if (result.status !== 0 || !result.stdout) {
      return false;
    }

    const commandLine = result.stdout.trim().toLowerCase();
    return (
      (commandLine.includes(entryPath.toLowerCase()) ||
        commandLine.includes(relativeEntryPath.toLowerCase()) ||
        commandLine.includes("dist/src/index.js")) &&
      commandLine.includes(`--instance ${instanceName.toLowerCase()}`)
    );
  }

  // macOS / Linux: read /proc or use ps
  const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout) {
    return false;
  }

  const commandLine = result.stdout.trim().toLowerCase();
  const instancePattern = new RegExp(`(?:^|\\s)--instance(?:=|\\s+)${instanceName.toLowerCase()}(?:\\s|$)`);
  return (
    commandLine.includes("dist/src/index.js") &&
    instancePattern.test(commandLine)
  );
}

function defaultSpawnDetached(
  command: string,
  args: string[],
  options: { cwd: string; stdoutPath: string; stderrPath: string },
): void {
  const stdoutFd = openSync(options.stdoutPath, "a");
  const stderrFd = openSync(options.stderrPath, "a");
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  });
  child.unref();
  closeSync(stdoutFd);
  closeSync(stderrFd);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultKillProcessTree(pid: number): void {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8",
    });

    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `Failed to stop pid ${pid}`).trim());
    }

    return;
  }

  // macOS / Linux: kill process group
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Fallback: kill just the process
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      throw new Error(`Failed to stop pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function defaultReadProcessEnvironment(pid: number): Promise<Record<string, string> | null> {
  if (process.platform === "win32") {
    return null;
  }

  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  const commandLine = result.stdout.trim();
  const environment: Record<string, string> = {};

  for (const key of ["CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    const pattern = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`);
    const match = commandLine.match(pattern);
    if (match?.[1]) {
      environment[key] = match[1];
    }
  }

  return environment;
}

async function readLockRecord(lockPath: string): Promise<InstanceLockRecord | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = InstanceLockRecordSchema.safeParse(parsed);
    if (result.success) {
      return result.data;
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
  }

  return null;
}

export async function inspectInstanceServiceLiveness(
  input: { stateDir: string; instanceName: string },
  deps: Pick<ServiceCommandDeps, "cwd" | "isProcessAlive" | "isExpectedServiceProcess"> = {},
): Promise<ServiceLiveness> {
  const cwd = deps.cwd ?? process.cwd();
  const lock = await readLockRecord(resolveInstanceLockPath(input.stateDir));
  const pid = lock?.pid ?? null;
  if (pid === null) {
    return { running: false, pid: null };
  }

  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const isExpectedServiceProcess = deps.isExpectedServiceProcess ?? defaultIsExpectedServiceProcess;
  const entryPath = path.join(cwd, "dist", "src", "index.js");
  const running = isProcessAlive(pid) && isExpectedServiceProcess(pid, entryPath, input.instanceName);
  return {
    running,
    pid: running ? pid : null,
  };
}

function isFreshLockRecord(
  lock: InstanceLockRecord | null,
  existingLock: InstanceLockRecord | null,
  isProcessAlive: (pid: number) => boolean,
  isExpectedServiceProcess: (pid: number, entryPath: string, instanceName: string) => boolean,
  entryPath: string,
  instanceName: string,
): boolean {
  if (lock === null) {
    return false;
  }

  if (!isProcessAlive(lock.pid) || !isExpectedServiceProcess(lock.pid, entryPath, instanceName)) {
    return false;
  }

  if (existingLock === null) {
    return true;
  }

  return lock.pid !== existingLock.pid || lock.token !== existingLock.token;
}

function removeLockIfMatches(lockPath: string, expectedPid: number | null): void {
  if (expectedPid === null) {
    return;
  }

  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = InstanceLockRecordSchema.safeParse(parsed);
    if (result.success && result.data.pid === expectedPid) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    return;
  }
}

async function readLastNonEmptyLine(filePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.at(-1);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }

    throw error;
  }
}

async function summarizeUnresolvedTasks(stateDir: string): Promise<{
  unresolvedTasks: number | null;
  blockingTasks: number | null;
  awaitingContinueTasks: number | null;
  unresolvedTasksWarning?: string;
}> {
  const workflowStore = new FileWorkflowStore(stateDir);
  const { state, warning } = await workflowStore.inspect();
  if (warning) {
    return {
      unresolvedTasks: null,
      blockingTasks: null,
      awaitingContinueTasks: null,
      unresolvedTasksWarning: FILE_WORKFLOW_STATE_UNREADABLE_WARNING,
    };
  }

  const blockingTasks = state.records.filter((record) => BLOCKING_WORKFLOW_STATUSES.has(record.status)).length;
  const awaitingContinueTasks = state.records.filter((record) => record.status === "awaiting_continue").length;

  return {
    unresolvedTasks: state.records.filter((record) => record.status !== "completed").length,
    blockingTasks,
    awaitingContinueTasks,
  };
}

function tailLines(text: string, maxLines = 40): string {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-maxLines).join("\n");
}

export function resolveServicePaths(
  env: ServiceCommandEnv,
  instanceName: string,
  cwd: string,
): ServicePaths {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
  });

  return {
    instanceName: normalizedInstanceName,
    stateDir,
    lockPath: resolveInstanceLockPath(stateDir),
    stdoutPath: path.join(stateDir, "service.stdout.log"),
    stderrPath: path.join(stateDir, "service.stderr.log"),
    entryPath: path.join(cwd, "dist", "src", "index.js"),
  };
}

export async function startServiceInstance(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const isExpectedServiceProcess = deps.isExpectedServiceProcess ?? defaultIsExpectedServiceProcess;
  const spawnDetachedProcess = deps.spawnDetached ?? defaultSpawnDetached;
  const sleep = deps.sleep ?? defaultSleep;

  if (!existsSync(paths.entryPath)) {
    throw new Error(`Built entrypoint not found: ${paths.entryPath}`);
  }

  const existingLock = await readLockRecord(paths.lockPath);
  if (
    existingLock !== null &&
    isProcessAlive(existingLock.pid) &&
    isExpectedServiceProcess(existingLock.pid, paths.entryPath, paths.instanceName)
  ) {
    throw new Error(`Instance "${paths.instanceName}" is already running with pid ${existingLock.pid}.`);
  }

  await mkdir(paths.stateDir, { recursive: true });

  // Rotate logs before truncating on start
  const { rotateInstanceLogs } = await import("../state/log-rotation.js");
  await rotateInstanceLogs(paths.stateDir);

  await writeFile(paths.stdoutPath, "", "utf8");
  await writeFile(paths.stderrPath, "", "utf8");

  spawnDetachedProcess(process.execPath, [paths.entryPath, "--instance", paths.instanceName], {
    cwd,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
  });

  for (let attempt = 0; attempt < 20; attempt++) {
    const lock = await readLockRecord(paths.lockPath);
    if (lock && isFreshLockRecord(lock, existingLock, isProcessAlive, isExpectedServiceProcess, paths.entryPath, paths.instanceName)) {
      return `Started instance "${paths.instanceName}" with pid ${lock.pid}.`;
    }

    await sleep(250);
  }

  throw new Error(`Instance "${paths.instanceName}" did not reach a running state.`);
}

export async function stopServiceInstance(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const isExpectedServiceProcess = deps.isExpectedServiceProcess ?? defaultIsExpectedServiceProcess;
  const killProcessTree = deps.killProcessTree ?? defaultKillProcessTree;
  const sleep = deps.sleep ?? defaultSleep;
  const legacyLaunchAgentPath = resolveLegacyLaunchAgentPlistPath(env, instanceName);
  const legacyLaunchdWarning = existsSync(legacyLaunchAgentPath)
    ? ` ${formatLegacyLaunchdWarning(paths.instanceName)}`
    : "";

  const existingLock = await readLockRecord(paths.lockPath);
  if (
    existingLock === null ||
    !isProcessAlive(existingLock.pid) ||
    !isExpectedServiceProcess(existingLock.pid, paths.entryPath, paths.instanceName)
  ) {
    removeLockIfMatches(paths.lockPath, existingLock?.pid ?? null);
    return `Instance "${paths.instanceName}" is not running.${legacyLaunchdWarning}`;
  }

  killProcessTree(existingLock.pid);

  for (let attempt = 0; attempt < 20; attempt++) {
    if (!isProcessAlive(existingLock.pid)) {
      return `Stopped instance "${paths.instanceName}".${legacyLaunchdWarning}`;
    }

    await sleep(250);
  }

  throw new Error(`Instance "${paths.instanceName}" did not stop cleanly.`);
}

export async function getServiceStatus(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
): Promise<ServiceStatus> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const isExpectedServiceProcess = deps.isExpectedServiceProcess ?? defaultIsExpectedServiceProcess;
  const lockRecord = await readLockRecord(paths.lockPath);
  const pid = lockRecord?.pid ?? null;
  const running =
    pid !== null &&
    isProcessAlive(pid) &&
    isExpectedServiceProcess(pid, paths.entryPath, paths.instanceName);
  if (!running) {
    removeLockIfMatches(paths.lockPath, pid);
  }
  const accessStore = new AccessStore(path.join(paths.stateDir, "access.json"));
  const accessStatus = await accessStore.getStatus();
  const configPath = path.join(paths.stateDir, "config.json");
  const runtimeConfig = await readInstanceRuntimeConfig(configPath);
  const engine = runtimeConfig.engine;
  const approvalMode = runtimeConfig.approvalMode;
  const sessionSummary = await inspectSessionBindings(env, paths.instanceName);
  const lastHandledUpdateId = await getLastHandledUpdateId(path.join(paths.stateDir, "inbox"));
  const readToken = deps.readConfiguredBotToken ?? readConfiguredBotToken;
  const fetchIdentity =
    deps.fetchTelegramBotIdentity ??
    (async (botToken: string): Promise<{ firstName: string; username?: string }> => {
      const api = new TelegramApi(botToken);
      return lookupTelegramBotIdentity(api);
    });
  const botToken = await readToken(env, paths.instanceName);
  let botIdentity: { firstName: string; username?: string } | undefined;
  let botIdentityWarning: string | undefined;

  if (botToken) {
    try {
      botIdentity = await fetchIdentity(botToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      botIdentityWarning = `Bot identity lookup failed: ${message}`;
    }
  }

  const lastErrorLine = await readLastNonEmptyLine(paths.stderrPath);
  let auditSummary: AuditSummary = { totalEvents: 0 };
  let latestFailureCategory: string | undefined;
  let timelineSummary: TimelineSummary = {
    totalEvents: 0,
    retryCount: 0,
    budgetBlockedCount: 0,
    fileRejectedCount: 0,
    workflowFailedCount: 0,
    crewRunsStartedCount: 0,
    crewRunsCompletedCount: 0,
    crewRunsFailedCount: 0,
  };
  let timelineWarning: string | undefined;
  let crewRunStateWarning: string | undefined;
  let latestCrewRunId: string | undefined;
  let latestCrewRunWorkflow: string | undefined;
  let latestCrewRunStatus: string | undefined;
  let latestCrewRunStage: string | undefined;
  let latestCrewRunUpdatedAt: string | undefined;
  try {
    const rawAudit = await readFile(resolveAuditLogPath(paths.stateDir), "utf8");
    const auditEvents = parseAuditEvents(rawAudit);
    auditSummary = summarizeAuditEvents(auditEvents);
    latestFailureCategory = getLatestFailure(auditEvents)?.category;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  try {
    const rawTimeline = await readFile(resolveTimelineLogPath(paths.stateDir), "utf8");
    const timelineEvents = parseTimelineEvents(rawTimeline);
    timelineSummary = summarizeTimelineEvents(timelineEvents);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error)
    ) {
      throw error;
    }

    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      timelineWarning = "timeline log unreadable";
    }
  }
  const latestCrewRun = await new CrewRunStore(paths.stateDir).inspectLatest();
  crewRunStateWarning = latestCrewRun.warning;
  latestCrewRunId = latestCrewRun.run?.runId;
  latestCrewRunWorkflow = latestCrewRun.run?.workflow;
  latestCrewRunStatus = latestCrewRun.run?.status;
  latestCrewRunStage = latestCrewRun.run?.currentStage;
  latestCrewRunUpdatedAt = latestCrewRun.run?.updatedAt;
  const workflowSummary = await summarizeUnresolvedTasks(paths.stateDir);

  return {
    instanceName: paths.instanceName,
    running,
    pid: running ? pid : null,
    engine,
    runtime: resolveEngineRuntime(engine, approvalMode),
    lockPath: paths.lockPath,
    stateDir: paths.stateDir,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    policy: accessStatus.policy,
    pairedUsers: accessStatus.pairedUsers,
    allowlistCount: accessStatus.allowlist.length,
    pendingPairs: accessStatus.pendingPairs.length,
    sessionBindings: sessionSummary.warning ? null : sessionSummary.sessions.length,
    sessionBindingsWarning: sessionSummary.warning,
    lastHandledUpdateId,
    botTokenConfigured: botToken !== null,
    botIdentity,
    botIdentityWarning,
    lastErrorLine,
    lastSuccessAt: auditSummary.lastSuccessAt,
    lastFailureAt: auditSummary.lastErrorAt,
    auditEvents: auditSummary.totalEvents,
    latestFailureCategory,
    timelineEvents: timelineWarning === undefined ? timelineSummary.totalEvents : null,
    lastTurnCompletionAt: timelineSummary.lastTurnCompletionAt,
    lastRetryAt: timelineSummary.lastRetryAt,
    lastBudgetBlockedAt: timelineSummary.lastBudgetBlockedAt,
    retryCount: timelineWarning === undefined ? timelineSummary.retryCount : null,
    budgetBlockedCount: timelineWarning === undefined ? timelineSummary.budgetBlockedCount : null,
    fileRejectedCount: timelineWarning === undefined ? timelineSummary.fileRejectedCount : null,
    workflowFailedCount: timelineWarning === undefined ? timelineSummary.workflowFailedCount : null,
    crewRunsStartedCount: timelineWarning === undefined ? timelineSummary.crewRunsStartedCount : null,
    crewRunsCompletedCount: timelineWarning === undefined ? timelineSummary.crewRunsCompletedCount : null,
    crewRunsFailedCount: timelineWarning === undefined ? timelineSummary.crewRunsFailedCount : null,
    lastCrewRunAt: timelineSummary.lastCrewRunAt,
    latestCrewRunId,
    latestCrewRunWorkflow,
    latestCrewRunStatus,
    latestCrewRunStage,
    latestCrewRunUpdatedAt,
    crewRunStateWarning,
    timelineWarning,
    unresolvedTasks: workflowSummary.unresolvedTasks,
    blockingTasks: workflowSummary.blockingTasks,
    awaitingContinueTasks: workflowSummary.awaitingContinueTasks,
    unresolvedTasksWarning: workflowSummary.unresolvedTasksWarning,
  };
}

export async function runServiceDoctor(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
): Promise<ServiceDoctorResult> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const status = await getServiceStatus(env, instanceName, deps);
  const checks: ServiceDoctorResult["checks"] = [];
  const readProcessEnvironment = deps.readProcessEnvironment ?? defaultReadProcessEnvironment;

  checks.push({
    name: "engine",
    ok: true,
    detail: `Engine: ${status.engine}.`,
  });
  checks.push({
    name: "runtime",
    ok: true,
    detail: `Runtime: ${status.runtime}.`,
  });
  checks.push({
    name: "build",
    ok: existsSync(paths.entryPath),
    detail: existsSync(paths.entryPath) ? `Entrypoint found at ${paths.entryPath}` : `Missing entrypoint at ${paths.entryPath}`,
  });
  checks.push({
    name: "token",
    ok: status.botTokenConfigured,
    detail: status.botTokenConfigured ? "Bot token is configured." : "Bot token is missing.",
  });
  checks.push({
    name: "service",
    ok: status.running,
    detail: status.running ? `Instance is running with pid ${status.pid}.` : "Instance is not running.",
  });
  checks.push({
    name: "identity",
    ok: status.botTokenConfigured && !status.botIdentityWarning,
    detail:
      status.botIdentityWarning ??
      (status.botIdentity
        ? `Bot identity resolved as ${status.botIdentity.firstName}${status.botIdentity.username ? ` (@${status.botIdentity.username})` : ""}.`
        : "Bot identity not available."),
  });
  const sharedEnvKey = status.engine === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const shellSharedEnvValue =
    sharedEnvKey === "CLAUDE_CONFIG_DIR" ? env.CLAUDE_CONFIG_DIR?.trim() || null : env.CODEX_HOME?.trim() || null;
  let environmentCheck = {
    ok: true,
    detail: "Shared engine env matches the current shell.",
  };
  if (status.running && status.pid !== null) {
    const processEnvironment = await readProcessEnvironment(status.pid);
    if (processEnvironment !== null) {
      const processSharedEnvValue = processEnvironment[sharedEnvKey]?.trim() || null;
      if (shellSharedEnvValue !== processSharedEnvValue) {
        if (shellSharedEnvValue === null && processSharedEnvValue !== null) {
          environmentCheck = {
            ok: false,
            detail: `The running service exports ${sharedEnvKey}=${processSharedEnvValue} while the current shell does not. Restart the service from the shell you want to use, or clear the stale shared-engine env first.`,
          };
        } else if (shellSharedEnvValue !== null && processSharedEnvValue === null) {
          environmentCheck = {
            ok: false,
            detail: `The current shell exports ${sharedEnvKey}=${shellSharedEnvValue}, but the running service does not. Restart the service from this shell if you changed shared engine env.`,
          };
        } else {
          environmentCheck = {
            ok: false,
            detail: `The current shell exports ${sharedEnvKey}=${shellSharedEnvValue}, but the running service uses ${sharedEnvKey}=${processSharedEnvValue}. Restart the service so its shared engine env matches the shell you are using.`,
          };
        }
      } else if (shellSharedEnvValue === null) {
        environmentCheck = {
          ok: true,
          detail: `Shared engine env matches the current shell (${sharedEnvKey} not explicitly set).`,
        };
      } else {
        environmentCheck = {
          ok: true,
          detail: `Shared engine env matches the current shell (${sharedEnvKey}=${shellSharedEnvValue}).`,
        };
      }
    } else {
      environmentCheck = {
        ok: true,
        detail: "Process environment inspection is unavailable on this platform.",
      };
    }
  } else {
    environmentCheck = {
      ok: true,
      detail: "Service is not running, so live environment comparison is unavailable.",
    };
  }
  checks.push({
    name: "environment",
    ok: environmentCheck.ok,
    detail: environmentCheck.detail,
  });
  const legacyLaunchAgentPath = resolveLegacyLaunchAgentPlistPath(env, instanceName);
  checks.push({
    name: "legacy-launchd",
    ok: !existsSync(legacyLaunchAgentPath),
    detail: existsSync(legacyLaunchAgentPath)
      ? `Legacy launchd plist still exists at ${legacyLaunchAgentPath}. Remove it with "bash scripts/cleanup-legacy-launchd.sh ${status.instanceName}" so service stop/start cannot fight a stale launchd entry.`
      : "No legacy launchd plist detected.",
  });
  checks.push({
    name: "sessions",
    ok: status.sessionBindingsWarning === undefined,
    detail:
      status.sessionBindingsWarning !== undefined
        ? `Session bindings: unknown (${status.sessionBindingsWarning}).`
        : `Session bindings: ${status.sessionBindings}.`,
  });
  checks.push({
    name: "audit",
    ok: true,
    detail: `Audit events: ${status.auditEvents}. Last success: ${status.lastSuccessAt ?? "none"}. Last failure: ${status.lastFailureAt ?? "none"}. latest failure category: ${status.latestFailureCategory ?? "none"}.`,
  });
  checks.push({
    name: "timeline",
    ok: status.timelineWarning === undefined && status.crewRunStateWarning === undefined,
    detail:
      status.timelineWarning !== undefined
        ? `Timeline events: unknown (${status.timelineWarning}).`
        : status.crewRunStateWarning !== undefined
          ? `Timeline events: ${status.timelineEvents}. Crew runs: unknown (${status.crewRunStateWarning}).`
          : `Timeline events: ${status.timelineEvents}. Last turn completion: ${status.lastTurnCompletionAt ?? "none"}. Last retry: ${status.lastRetryAt ?? "none"}. Last budget block: ${status.lastBudgetBlockedAt ?? "none"}. Last crew run: ${status.lastCrewRunAt ?? "none"}. Incident counts: retries=${status.retryCount}, budget blocks=${status.budgetBlockedCount}, file rejections=${status.fileRejectedCount}, workflow failures=${status.workflowFailedCount}, crew runs started=${status.crewRunsStartedCount}, crew runs completed=${status.crewRunsCompletedCount}, crew runs failed=${status.crewRunsFailedCount}. Latest crew run: ${status.latestCrewRunId ? `${status.latestCrewRunId} (${status.latestCrewRunWorkflow ?? "unknown"}, ${status.latestCrewRunStatus ?? "unknown"}/${status.latestCrewRunStage ?? "unknown"}, updated ${status.latestCrewRunUpdatedAt ?? "unknown"})` : "none"}.`,
  });
  checks.push({
    name: "tasks",
    ok: status.unresolvedTasksWarning === undefined && (status.blockingTasks ?? 0) === 0,
    detail:
      status.unresolvedTasksWarning !== undefined
        ? `unresolved tasks: unknown (${status.unresolvedTasksWarning}).`
        : `unresolved tasks: ${status.unresolvedTasks}. blocking tasks: ${status.blockingTasks}. awaiting continue: ${status.awaitingContinueTasks}.`,
  });
  checks.push({
    name: "stderr",
    ok: !status.lastErrorLine,
    detail: status.lastErrorLine ? `Last stderr line: ${status.lastErrorLine}` : "No stderr output recorded.",
  });

  return {
    instanceName: status.instanceName,
    engine: status.engine,
    runtime: status.runtime,
    healthy: checks.every((check) => check.ok),
    checks,
  };
}

export async function getServiceLogs(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
  maxLines = 40,
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const readTextFile = deps.readTextFile ?? ((filePath: string) => readFile(filePath, "utf8"));

  let stdout = "";
  let stderr = "";

  try {
    stdout = await readTextFile(paths.stdoutPath);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  try {
    stderr = await readTextFile(paths.stderrPath);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  return [
    `Instance: ${normalizeInstanceName(instanceName)}`,
    "--- stdout ---",
    tailLines(stdout, maxLines) || "(empty)",
    "--- stderr ---",
    tailLines(stderr, maxLines) || "(empty)",
  ].join("\n");
}
