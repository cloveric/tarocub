import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import { resolveInstanceLockPath, type InstanceLockRecord } from "../state/instance-lock.js";
import { InstanceLockRecordSchema } from "../state/instance-lock-schema.js";
import { RuntimeStateStore } from "../state/runtime-state.js";
import { RuntimeStateSchema } from "../state/runtime-state-schema.js";
import { withFileMutex } from "../state/file-mutex.js";
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
  readInstanceServiceEnvFromEnvFile,
  readInstanceRuntimeConfig,
  resolveEngineRuntime,
} from "../service.js";
import { inspectSessions as inspectSessionBindings } from "./session.js";
import { inspectInstanceAgentInstructions } from "./access.js";

export interface ServiceCommandEnv
  extends Pick<
    EnvSource,
    "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR" | "TELEGRAM_BOT_TOKEN" | "CODEX_HOME" | "CLAUDE_CONFIG_DIR"
  > {}

export interface ServiceCommandDeps {
  cwd?: string;
  isProcessAlive?: (pid: number) => boolean;
  isExpectedServiceProcess?: (pid: number, entryPath: string, instanceName: string) => boolean;
  spawnDetached?: (
    command: string,
    args: string[],
    options: { cwd: string; stdoutPath: string; stderrPath: string; env?: NodeJS.ProcessEnv },
  ) => number | void;
  sleep?: (ms: number) => Promise<void>;
  killProcessTree?: (pid: number) => void;
  forceKillProcessTree?: (pid: number) => void;
  findServiceProcessIds?: (entryPath: string, instanceName: string) => Promise<number[]> | number[];
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
  serviceErrorCount: number | null;
  serviceHealthCount: number | null;
  lastServiceHealthAt?: string;
  lastServiceHealthOutcome?: string;
  fileRejectedCount: number | null;
  workflowFailedCount: number | null;
  turnPoolWaitCount: number | null;
  lastTurnPoolWaitAt?: string;
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
const ACTIVE_TURN_STALE_MS = 6 * 60 * 60_000;
const DEFAULT_DEFERRED_RESTART_DELAY_MS = 5_000;
// Turn-scoped side-channel env that a long-lived service must never inherit. The
// scheduling turn exports these (send URL/token/command, thread id, the instance
// marker); a restarted service that inherited them would target a stale channel.
// Mirrors the set the Lark deferred-restart path scrubs in cli.ts.
const DEFERRED_RESTART_SCRUB_ENV_KEYS = [
  "CODEX_TELEGRAM_INSTANCE",
  "CCTB_SEND_URL",
  "CCTB_SEND_TOKEN",
  "CCTB_SEND_COMMAND",
  "CODEX_THREAD_ID",
] as const;
const DEFERRED_RESTART_PID_FILE = "deferred-restart.pid";
// A deferred-restart helper retries for at most ~2h; treat any pidfile older
// than that (plus slack) as stale so a recycled pid can't block forever.
const DEFERRED_RESTART_PID_STALE_MS = 3 * 60 * 60 * 1000;
// The helper waits for the active turn (the one that scheduled the restart) to
// finish instead of force-killing it: drop --force and retry on the refusal
// message until the turn queue drains, capped at maxWaitMs. Mirrors the Lark path.
const DEFERRED_RESTART_HELPER_SCRIPT = `
const { spawnSync } = require("node:child_process");

const entryPath = process.argv[1];
const instanceName = process.argv[2];
const delayMs = Number.parseInt(process.argv[3] ?? "5000", 10);
const scrubKeys = (process.argv[4] ?? "").split(",").filter(Boolean);
const retryDelayMs = 30_000;
const maxWaitMs = 2 * 60 * 60 * 1000;
const deadline = Date.now() + maxWaitMs;

function runRestart() {
  const env = { ...process.env };
  for (const key of scrubKeys) {
    delete env[key];
  }

  const restartArgs = [
    entryPath,
    "telegram",
    "service",
    "restart",
    "--instance",
    instanceName,
  ];
  const result = spawnSync(process.execPath, restartArgs, {
    env,
    encoding: "utf8",
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if ((result.status ?? 1) === 0) {
    process.exit(0);
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join("\\n");
  const queueBusy = /active Telegram turn\\(s\\)|Refusing to stop\\/restart without --force/.test(output);
  if (Date.now() + retryDelayMs <= deadline) {
    const reason = queueBusy
      ? "is waiting for the active turn to finish"
      : \`failed with status \${result.status ?? "unknown"}\`;
    process.stderr.write(
      \`Deferred restart for "\${instanceName}" \${reason}; retrying in \${Math.ceil(retryDelayMs / 1000)}s.\\n\`,
    );
    setTimeout(runRestart, retryDelayMs);
    return;
  }

  process.exit(result.status ?? 1);
}

setTimeout(runRestart, Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 5000);
`;

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

    return isServiceCommandLine(result.stdout.trim(), entryPath, instanceName);
  }

  // macOS / Linux: read /proc or use ps
  const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout) {
    return false;
  }

  return isServiceCommandLine(result.stdout.trim(), entryPath, instanceName);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isServiceCommandLine(commandLine: string, entryPath: string, instanceName: string): boolean {
  const normalizedCommandLine = commandLine.replace(/\\/g, "/").toLowerCase();
  const normalizedEntryPath = entryPath.replace(/\\/g, "/").toLowerCase();
  const relativeEntryPath = path.relative(process.cwd(), entryPath).replace(/\\/g, "/").toLowerCase();
  const entryAlternatives = [...new Set([
    normalizedEntryPath,
    relativeEntryPath,
    "dist/src/index.js",
  ].filter((entry) => entry.length > 0))].map(escapeRegExp);
  const instance = escapeRegExp(instanceName.toLowerCase());
  const pattern = new RegExp(
    `(?:^|\\s)(?:${entryAlternatives.join("|")})\\s+--instance(?:=|\\s+)${instance}(?:\\s|$)`,
  );
  return pattern.test(normalizedCommandLine);
}

function defaultSpawnDetached(
  command: string,
  args: string[],
  options: { cwd: string; stdoutPath: string; stderrPath: string; env?: NodeJS.ProcessEnv },
): number | void {
  const stdoutFd = openSync(options.stdoutPath, "a");
  const stderrFd = openSync(options.stderrPath, "a");
  const env = { ...process.env, ...(options.env ?? {}) };
  scrubTurnScopedServiceEnv(env);
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    env,
    ...(process.platform === "win32" ? { windowsHide: true } : {}),
  });
  child.unref();
  closeSync(stdoutFd);
  closeSync(stderrFd);
  return child.pid;
}

function scrubTurnScopedServiceEnv(env: NodeJS.ProcessEnv): void {
  for (const key of DEFERRED_RESTART_SCRUB_ENV_KEYS) {
    delete env[key];
  }
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

function defaultForceKillProcessTree(pid: number): void {
  if (process.platform === "win32") {
    defaultKillProcessTree(pid);
    return;
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      throw new Error(`Failed to force stop pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function defaultFindServiceProcessIds(entryPath: string, instanceName: string): number[] {
  if (process.platform === "win32") {
    return [];
  }

  const result = spawnSync("ps", ["-axo", "pid=,args="], {
    encoding: "utf8",
  });

  const psPids = parseServiceProcessIdsFromProcessList(result.stdout, entryPath, instanceName);
  if (result.status === 0 && psPids.length > 0) {
    return psPids;
  }

  const pgrepResult = spawnSync("pgrep", ["-fl", "dist/src/index.js"], {
    encoding: "utf8",
  });

  if (pgrepResult.status !== 0 || !pgrepResult.stdout) {
    return psPids;
  }

  return parseServiceProcessIdsFromProcessList(pgrepResult.stdout, entryPath, instanceName);
}

function parseServiceProcessIdsFromProcessList(stdout: string | null | undefined, entryPath: string, instanceName: string): number[] {
  if (!stdout) {
    return [];
  }

  const pids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match?.[1] || !match[2]) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    if (pid !== process.pid && Number.isInteger(pid) && isServiceCommandLine(match[2], entryPath, instanceName)) {
      pids.push(pid);
    }
  }

  return pids;
}

async function findRunningServiceProcessIds(
  paths: Pick<ServicePaths, "entryPath" | "instanceName">,
  deps: Required<Pick<ServiceCommandDeps, "isProcessAlive" | "isExpectedServiceProcess" | "findServiceProcessIds">>,
): Promise<number[]> {
  const runningPids: number[] = [];
  const seen = new Set<number>();

  for (const pid of await deps.findServiceProcessIds(paths.entryPath, paths.instanceName)) {
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);

    if (deps.isProcessAlive(pid) && deps.isExpectedServiceProcess(pid, paths.entryPath, paths.instanceName)) {
      runningPids.push(pid);
    }
  }

  return runningPids;
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

async function readRuntimeActivity(
  stateDir: string,
  deps: Pick<ServiceCommandDeps, "readTextFile"> = {},
): Promise<{
  activeTurnCount: number;
  activeTurnStartedAt?: string;
  activeTurnUpdatedAt?: string;
  stale: boolean;
}> {
  const runtimeStatePath = path.join(stateDir, "runtime-state.json");
  let raw: string;
  try {
    raw = deps.readTextFile
      ? await deps.readTextFile(runtimeStatePath)
      : await readFile(runtimeStatePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { activeTurnCount: 0, stale: false };
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { activeTurnCount: 0, stale: false };
  }

  const parsed = RuntimeStateSchema.safeParse(value);
  if (!parsed.success) {
    return { activeTurnCount: 0, stale: false };
  }

  const updatedAt = parsed.data.activeTurnUpdatedAt ?? parsed.data.activeTurnStartedAt;
  const updatedMs = updatedAt ? new Date(updatedAt).getTime() : Number.NaN;
  const stale = parsed.data.activeTurnCount > 0 &&
    (!Number.isFinite(updatedMs) || Date.now() - updatedMs > ACTIVE_TURN_STALE_MS);
  return {
    activeTurnCount: parsed.data.activeTurnCount,
    activeTurnStartedAt: parsed.data.activeTurnStartedAt,
    activeTurnUpdatedAt: parsed.data.activeTurnUpdatedAt,
    stale,
  };
}

async function assertNoActiveTurnsBeforeStop(
  stateDir: string,
  instanceName: string,
  deps: Pick<ServiceCommandDeps, "readTextFile">,
): Promise<void> {
  const activity = await readRuntimeActivity(stateDir, deps);
  if (activity.activeTurnCount <= 0 || activity.stale) {
    return;
  }

  throw new Error(
    `Instance "${instanceName}" has ${activity.activeTurnCount} active Telegram turn(s). ` +
    "Refusing to stop/restart without --force.",
  );
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
  const findServiceProcessIds = deps.findServiceProcessIds ?? defaultFindServiceProcessIds;
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

  const locklessPids = await findRunningServiceProcessIds(paths, {
    isProcessAlive,
    isExpectedServiceProcess,
    findServiceProcessIds,
  });
  if (locklessPids.length > 0) {
    throw new Error(`Instance "${paths.instanceName}" is already running with pid ${locklessPids[0]}.`);
  }

  await mkdir(paths.stateDir, { recursive: true });
  await new RuntimeStateStore(path.join(paths.stateDir, "runtime-state.json")).resetActiveTurns();

  // Rotate logs before truncating on start
  const { rotateInstanceLogs } = await import("../state/log-rotation.js");
  await rotateInstanceLogs(paths.stateDir);

  await writeFile(paths.stdoutPath, "", "utf8");
  await writeFile(paths.stderrPath, "", "utf8");

  const instanceServiceEnv = await readInstanceServiceEnvFromEnvFile({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: paths.instanceName,
  });
  const serviceEnv = Object.keys(instanceServiceEnv).length > 0 ? instanceServiceEnv : undefined;

  spawnDetachedProcess(process.execPath, [paths.entryPath, "--instance", paths.instanceName], {
    cwd,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    ...(serviceEnv ? { env: serviceEnv } : {}),
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

async function readPendingDeferredRestartPid(
  pidFilePath: string,
  isProcessAlive: (pid: number) => boolean,
): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(pidFilePath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    return null;
  }

  let pid: number | null = null;
  let scheduledAt: number | null = null;
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; scheduledAt?: unknown };
    pid = typeof parsed.pid === "number" ? parsed.pid : null;
    const at = typeof parsed.scheduledAt === "string" ? Date.parse(parsed.scheduledAt) : NaN;
    scheduledAt = Number.isNaN(at) ? null : at;
  } catch {
    pid = null;
  }

  if (pid === null || !isProcessAlive(pid)) {
    return null;
  }
  // Time-based staleness: a real helper cannot outlive its own retry deadline,
  // so a pidfile older than that is stale even if isProcessAlive(pid) is true —
  // the pid was recycled by an unrelated live process. Without this, recycling
  // would permanently block every future deferred restart for the instance.
  if (scheduledAt !== null && Date.now() - scheduledAt > DEFERRED_RESTART_PID_STALE_MS) {
    return null;
  }
  return pid;
}

export async function scheduleDeferredServiceRestart(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
  options: { current?: boolean; delayMs?: number } = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const spawnDetachedProcess = deps.spawnDetached ?? defaultSpawnDetached;
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const delayMs = Math.max(1, Math.trunc(options.delayMs ?? DEFAULT_DEFERRED_RESTART_DELAY_MS));

  if (!existsSync(paths.entryPath)) {
    throw new Error(`Built entrypoint not found: ${paths.entryPath}`);
  }

  await mkdir(paths.stateDir, { recursive: true });

  // Singleton guard: a live pending helper means a deferred restart is already
  // scheduled for this instance; spawning a second would double-restart (and kill
  // a turn that the first helper is waiting on). Verified production-real.
  const pidFilePath = path.join(paths.stateDir, DEFERRED_RESTART_PID_FILE);
  return await withFileMutex(`${pidFilePath}.schedule`, async () => {
    const pendingPid = await readPendingDeferredRestartPid(pidFilePath, isProcessAlive);
    if (pendingPid !== null) {
      const target = options.current ? "current instance" : "instance";
      return `Deferred restart for ${target} "${paths.instanceName}" is already pending (pid ${pendingPid}); not scheduling another.`;
    }

    // Scrub the turn-scoped side channel from the helper's own environment so neither
    // the helper nor the service it spawns inherits a stale channel.
    const helperEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of DEFERRED_RESTART_SCRUB_ENV_KEYS) {
      helperEnv[key] = undefined;
    }

    const logPath = path.join(paths.stateDir, "deferred-restart.log");
    const helperPid = spawnDetachedProcess(process.execPath, [
      "-e",
      DEFERRED_RESTART_HELPER_SCRIPT,
      paths.entryPath,
      paths.instanceName,
      String(delayMs),
      DEFERRED_RESTART_SCRUB_ENV_KEYS.join(","),
    ], {
      cwd,
      stdoutPath: logPath,
      stderrPath: logPath,
      env: helperEnv,
    });

    if (typeof helperPid === "number") {
      await writeFile(pidFilePath, JSON.stringify({ pid: helperPid, scheduledAt: new Date().toISOString() }), "utf8");
    }

    const target = options.current ? "current instance" : "instance";
    return `Scheduled deferred restart for ${target} "${paths.instanceName}" in ${Math.ceil(delayMs / 1000)}s; it will retry until the active turn finishes.`;
  });
}

export async function stopServiceInstance(
  env: ServiceCommandEnv,
  instanceName: string,
  deps: ServiceCommandDeps = {},
  options: { force?: boolean } = {},
): Promise<string> {
  const cwd = deps.cwd ?? process.cwd();
  const paths = resolveServicePaths(env, instanceName, cwd);
  const isProcessAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const isExpectedServiceProcess = deps.isExpectedServiceProcess ?? defaultIsExpectedServiceProcess;
  const killProcessTree = deps.killProcessTree ?? defaultKillProcessTree;
  const forceKillProcessTree = deps.forceKillProcessTree ?? defaultForceKillProcessTree;
  const findServiceProcessIds = deps.findServiceProcessIds ?? defaultFindServiceProcessIds;
  const sleep = deps.sleep ?? defaultSleep;
  const legacyLaunchAgentPath = resolveLegacyLaunchAgentPlistPath(env, instanceName);
  const legacyLaunchdWarning = existsSync(legacyLaunchAgentPath)
    ? ` ${formatLegacyLaunchdWarning(paths.instanceName)}`
    : "";

  const existingLock = await readLockRecord(paths.lockPath);
  const pidsToStop = new Set<number>();
  if (
    existingLock !== null &&
    isProcessAlive(existingLock.pid) &&
    isExpectedServiceProcess(existingLock.pid, paths.entryPath, paths.instanceName)
  ) {
    pidsToStop.add(existingLock.pid);
  }

  for (const pid of await findServiceProcessIds(paths.entryPath, paths.instanceName)) {
    if (isProcessAlive(pid) && isExpectedServiceProcess(pid, paths.entryPath, paths.instanceName)) {
      pidsToStop.add(pid);
    }
  }

  if (pidsToStop.size === 0) {
    removeLockIfMatches(paths.lockPath, existingLock?.pid ?? null);
    return `Instance "${paths.instanceName}" is not running.${legacyLaunchdWarning}`;
  }

  if (!options.force) {
    await assertNoActiveTurnsBeforeStop(paths.stateDir, paths.instanceName, deps);
  }

  for (const pid of pidsToStop) {
    if (isProcessAlive(pid) && isExpectedServiceProcess(pid, paths.entryPath, paths.instanceName)) {
      killProcessTree(pid);
    }
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    if ([...pidsToStop].every((pid) => !isProcessAlive(pid) || !isExpectedServiceProcess(pid, paths.entryPath, paths.instanceName))) {
      return `Stopped instance "${paths.instanceName}".${legacyLaunchdWarning}`;
    }

    await sleep(250);
  }

  if (options.force) {
    for (const pid of pidsToStop) {
      if (isProcessAlive(pid) && isExpectedServiceProcess(pid, paths.entryPath, paths.instanceName)) {
        forceKillProcessTree(pid);
      }
    }

    for (let attempt = 0; attempt < 20; attempt++) {
      if ([...pidsToStop].every((pid) => !isProcessAlive(pid) || !isExpectedServiceProcess(pid, paths.entryPath, paths.instanceName))) {
        return `Stopped instance "${paths.instanceName}".${legacyLaunchdWarning}`;
      }

      await sleep(250);
    }
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
  const findServiceProcessIds = deps.findServiceProcessIds ?? defaultFindServiceProcessIds;
  const lockRecord = await readLockRecord(paths.lockPath);
  const lockedPid = lockRecord?.pid ?? null;
  const lockedRunning =
    lockedPid !== null &&
    isProcessAlive(lockedPid) &&
    isExpectedServiceProcess(lockedPid, paths.entryPath, paths.instanceName);
  let runningPid = lockedRunning ? lockedPid : null;
  if (runningPid === null) {
    const locklessPids = await findRunningServiceProcessIds(paths, {
      isProcessAlive,
      isExpectedServiceProcess,
      findServiceProcessIds,
    });
    runningPid = locklessPids[0] ?? null;
  }
  const running = runningPid !== null;
  if (!running) {
    removeLockIfMatches(paths.lockPath, lockedPid);
  }
  const accessStore = new AccessStore(path.join(paths.stateDir, "access.json"));
  const accessStatus = await accessStore.getStatus();
  const configPath = path.join(paths.stateDir, "config.json");
  const runtimeConfig = await readInstanceRuntimeConfig(configPath);
  const engine = runtimeConfig.engine;
  const approvalMode = runtimeConfig.approvalMode;
  const engineRuntime = resolveEngineRuntime(engine, approvalMode, runtimeConfig.codexRuntime);
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
    serviceErrorCount: 0,
    serviceHealthCount: 0,
    fileRejectedCount: 0,
    workflowFailedCount: 0,
    turnPoolWaitCount: 0,
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
    pid: runningPid,
    engine,
    runtime: engineRuntime,
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
    serviceErrorCount: timelineWarning === undefined ? timelineSummary.serviceErrorCount : null,
    serviceHealthCount: timelineWarning === undefined ? timelineSummary.serviceHealthCount : null,
    lastServiceHealthAt: timelineSummary.lastServiceHealthAt,
    lastServiceHealthOutcome: timelineSummary.lastServiceHealthOutcome,
    fileRejectedCount: timelineWarning === undefined ? timelineSummary.fileRejectedCount : null,
    workflowFailedCount: timelineWarning === undefined ? timelineSummary.workflowFailedCount : null,
    turnPoolWaitCount: timelineWarning === undefined ? timelineSummary.turnPoolWaitCount : null,
    lastTurnPoolWaitAt: timelineSummary.lastTurnPoolWaitAt,
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
  const sharedEnvKey = status.engine === "claude"
    ? "CLAUDE_CONFIG_DIR"
    : status.engine === "codex"
      ? "CODEX_HOME"
      : null;
  const shellSharedEnvValue =
    sharedEnvKey === "CLAUDE_CONFIG_DIR"
      ? env.CLAUDE_CONFIG_DIR?.trim() || null
      : sharedEnvKey === "CODEX_HOME"
        ? env.CODEX_HOME?.trim() || null
        : null;
  let environmentCheck = {
    ok: true,
    detail: "Shared engine env matches the current shell.",
  };
  if (sharedEnvKey === null) {
    environmentCheck = {
      ok: true,
      detail: "No shared engine config env check is needed for this engine.",
    };
  } else if (status.running && status.pid !== null) {
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
  const instructions = await inspectInstanceAgentInstructions(env, instanceName);
  checks.push({
    name: "instructions",
    ok: instructions.state === "current" || instructions.state === "missing",
    detail: instructions.state === "current"
      ? `Instance instructions are current at ${instructions.path}.`
      : instructions.state === "missing"
        ? `${instructions.detail}; service can run without it. To add the standard transport block, run "telegram instructions upgrade --instance ${status.instanceName}".`
        : `${instructions.detail}; run "telegram instructions upgrade --instance ${status.instanceName}"${instructions.state === "custom-transport" ? " or review and use --force" : ""}.`,
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
          : `Timeline events: ${status.timelineEvents}. Last turn completion: ${status.lastTurnCompletionAt ?? "none"}. Last retry: ${status.lastRetryAt ?? "none"}. Last budget block: ${status.lastBudgetBlockedAt ?? "none"}. Last crew run: ${status.lastCrewRunAt ?? "none"}. Incident counts: retries=${status.retryCount}, budget blocks=${status.budgetBlockedCount}, service errors=${status.serviceErrorCount}, file rejections=${status.fileRejectedCount}, workflow failures=${status.workflowFailedCount}, crew runs started=${status.crewRunsStartedCount}, crew runs completed=${status.crewRunsCompletedCount}, crew runs failed=${status.crewRunsFailedCount}. Service health events=${status.serviceHealthCount}, last health=${status.lastServiceHealthOutcome ?? "none"} at ${status.lastServiceHealthAt ?? "none"}. Shared worker waits=${status.turnPoolWaitCount}, last wait=${status.lastTurnPoolWaitAt ?? "none"}. Latest crew run: ${status.latestCrewRunId ? `${status.latestCrewRunId} (${status.latestCrewRunWorkflow ?? "unknown"}, ${status.latestCrewRunStatus ?? "unknown"}/${status.latestCrewRunStage ?? "unknown"}, updated ${status.latestCrewRunUpdatedAt ?? "unknown"})` : "none"}.`,
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
