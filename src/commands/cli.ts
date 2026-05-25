import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createLarkChannel, type LarkChannelOptions } from "@larksuiteoapi/node-sdk";

import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { AccessStore } from "../state/access-store.js";
import { normalizeInstanceName } from "../instance.js";
import {
  ensureDefaultInstanceAgentInstructions,
  resolveInstanceAccessStatePath,
  resolveInstanceAgentInstructionsPath,
  upgradeInstanceAgentInstructions,
  type InstanceAgentInstructionsUpgradeResult,
  type InstanceTokenEnv,
  writeInstanceBotToken,
} from "./access.js";
import {
  appendAuditEvent,
  filterAuditEvents,
  parseAuditEvents,
  resolveAuditLogPath,
  type AuditEventFilter,
} from "../state/audit-log.js";
import {
  filterTimelineEvents,
  parseTimelineEvents,
  resolveTimelineLogPath,
  type TimelineEventFilter,
} from "../state/timeline-log.js";
import {
  getSessionForChat,
  inspectSessionForChat,
  inspectSessions,
  resetSessionForChat,
  SESSION_STATE_UNREADABLE_WARNING,
} from "./session.js";
import { SessionStore } from "../state/session-store.js";
import {
  clearTaskWithRecovery,
  FILE_WORKFLOW_STATE_UNREADABLE_WARNING,
  inspectTask,
  listTasks,
} from "./task.js";
import {
  getServiceLogs,
  getServiceStatus,
  inspectInstanceServiceLiveness,
  runServiceDoctor,
  scheduleDeferredServiceRestart,
  startServiceInstance,
  stopServiceInstance,
  type ServiceCommandDeps,
} from "./service.js";
import { applyEngineSelection, loadInstanceConfig, updateInstanceConfig } from "../telegram/instance-config.js";
import { parseSideChannelSendArgs, renderSideChannelDeliveryText, runSideChannelSendCommand } from "../telegram/side-channel-send.js";
import { runConfiguredSendCommand, stripSendRoutingArgs, type ConfiguredSendDeps } from "./send.js";
import { runCronCli } from "../cron-cli.js";
import { CronStore } from "../state/cron-store.js";
import { loadLarkRuntimeEnv, resolveLarkEnvFilePath, resolveLarkStateDir, writeLarkEnvFile } from "../lark/env-file.js";
import { LarkGroupModeStore } from "../lark/group-mode-store.js";
import { createLarkServiceRuntime, resolveLarkRuntimeConfig, resolveLarkServiceLockPath, type LarkChannelLike, type LarkRuntimeEnv } from "../lark/service.js";
import { deliverLarkResponse } from "../lark/delivery.js";
import { runLarkWizard } from "../lark/wizard.js";
import {
  REQUIRED_LARK_SCOPES,
  formatLarkProvisioningResult,
  formatLarkTenantScopeImportJson,
  inspectLarkAppProvisioning,
  provisionLarkApp,
  type LarkProvisioningResult,
} from "../lark/provisioning.js";

const execFile = promisify(execFileCallback);
const LEGACY_LARK_SERVICE_TMUX_SESSION = "cctb-lark-service";
const LARK_SERVICE_TMUX_SESSION_PREFIX = "cctb-lark-service-";

export interface CliLogger {
  log: (message: string) => void;
}

export interface LarkServiceCommandInput {
  env: LarkRuntimeEnv;
  stateDir: string;
  logPath: string;
  entrypoint: string;
  cwd: string;
}

export interface LarkServiceCommandDeps {
  start?: (input: LarkServiceCommandInput) => Promise<"started" | "already_running">;
  stop?: (input: LarkServiceCommandInput) => Promise<"stopped" | "not_running">;
  waitUntilRunning?: (input: LarkServiceCommandInput) => Promise<void>;
  readLogs?: (input: { stateDir: string; logPath: string; tail: number }) => Promise<string>;
  findProcessIds?: (input: LarkServiceCommandInput) => Promise<number[]>;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
  killTmuxSession?: (sessionName: string) => Promise<boolean | void>;
  sleep?: (ms: number) => Promise<void>;
  inspectApp?: CliOptions["larkInspectApp"];
}

interface DashboardCommandEnv extends Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR" | "CODEX_TELEGRAM_INSTANCE"> {}

export interface DashboardCommandDeps {
  generateDashboard?: (env: DashboardCommandEnv) => Promise<string>;
  serveDashboard?: (env: DashboardCommandEnv) => Promise<{ url: string; closed: Promise<void> }>;
}

export interface LarkSendCommandDeps {
  createChannel?: (options: LarkChannelOptions) => LarkChannelLike;
  deliverResponse?: typeof deliverLarkResponse;
  readStdin?: () => Promise<string>;
}

export interface CliOptions {
  env?: Pick<
    EnvSource,
    "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_INSTANCE" | "CODEX_TELEGRAM_STATE_DIR" | "TELEGRAM_BOT_TOKEN" | "CODEX_HOME" | "CLAUDE_CONFIG_DIR"
  > & {
    CCTB_SEND_URL?: string;
    CCTB_SEND_TOKEN?: string;
    LARK_APP_ID?: string;
    LARK_APP_SECRET?: string;
    LARK_DOMAIN?: string;
    CCTB_LARK_STATE_DIR?: string;
    LARK_REQUIRE_MENTION_IN_GROUP?: string;
  };
  logger?: CliLogger;
  serviceDeps?: ServiceCommandDeps;
  larkServiceDeps?: LarkServiceCommandDeps;
  sendDeps?: ConfiguredSendDeps;
  larkSendDeps?: LarkSendCommandDeps;
  dashboardDeps?: DashboardCommandDeps;
  larkProvisionApp?: (input: { appId: string; appSecret: string; domain?: string; logger?: CliLogger }) => Promise<LarkProvisioningResult>;
  larkInspectApp?: (input: { appId: string; appSecret: string; domain?: string }) => Promise<LarkProvisioningResult>;
}

function normalizeCommandArgs(argv: string[]): string[] {
  if (argv[0] === "telegram") {
    return argv.slice(1);
  }

  return argv;
}

function extractInstanceOption(argv: string[], defaultInstanceName = "default"): { instanceName: string; args: string[] } {
  let instanceName = normalizeInstanceName(defaultInstanceName);
  const args: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === "--instance") {
      if (index + 1 >= argv.length) {
        throw new Error("Invalid instance name");
      }

      instanceName = normalizeInstanceName(argv[index + 1]);
      index++;
      continue;
    }

    if (argument.startsWith("--instance=")) {
      instanceName = normalizeInstanceName(argument.slice("--instance=".length));
      continue;
    }

    args.push(argument);
  }

  return { instanceName, args };
}

function extractBooleanFlag(argv: string[], flag: string): { enabled: boolean; args: string[] } {
  let enabled = false;
  const args: string[] = [];
  for (const argument of argv) {
    if (argument === flag) {
      enabled = true;
      continue;
    }
    args.push(argument);
  }
  return { enabled, args };
}

function parseConfigureCommand(argv: string[]): { instanceName: string; botToken: string } {
  if (argv.length === 2) {
    return { instanceName: "default", botToken: argv[1] };
  }

  if (argv.length === 4 && argv[1] === "--instance") {
    return {
      instanceName: normalizeInstanceName(argv[2]),
      botToken: argv[3],
    };
  }

  throw new Error("Usage: telegram configure <bot-token> | telegram configure --instance <name> <bot-token>");
}

function parseChatId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid chat id: ${value}`);
  }

  return parsed;
}

function parsePositiveInteger(value: string, fieldName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  return parsed;
}

function formatSessionList(
  instanceName: string,
  sessions: Awaited<ReturnType<typeof inspectSessions>>["sessions"],
  warning?: string,
): string {
  const lines = [`Instance: ${instanceName}`, `Session bindings: ${warning ? "unknown" : sessions.length}`];

  if (warning) {
    lines.push(`Warning: ${warning}`);
    return lines.join("\n");
  }

  if (sessions.length === 0) {
    lines.push("Sessions: none");
    return lines.join("\n");
  }

  for (const session of sessions) {
    lines.push(`- chat ${session.chatId} -> ${session.threadId} [${session.status}] @ ${session.updatedAt}`);
  }

  return lines.join("\n");
}

function formatSessionDetails(
  instanceName: string,
  session: NonNullable<Awaited<ReturnType<typeof getSessionForChat>>>,
): string {
  return [
    `Instance: ${instanceName}`,
    `Chat: ${session.chatId}`,
    `Thread: ${session.threadId}`,
    `Status: ${session.status}`,
    `Updated: ${session.updatedAt}`,
  ].join("\n");
}

function formatTaskList(instanceName: string, result: Awaited<ReturnType<typeof listTasks>>): string {
  const lines = [
    `Instance: ${instanceName}`,
    `Recent file workflow records: ${result.warning ? "unknown" : result.tasks.length}`,
  ];

  if (result.warning) {
    lines.push(`Warning: ${result.warning}`);
    return lines.join("\n");
  }

  if (result.tasks.length === 0) {
    lines.push("Tasks: none");
    return lines.join("\n");
  }

  for (const task of result.tasks) {
    lines.push(`- ${task.uploadId} [${task.status}] chat ${task.chatId} kind=${task.kind} updated ${task.updatedAt}`);
  }

  return lines.join("\n");
}

function formatTaskDetails(instanceName: string, task: Awaited<ReturnType<typeof inspectTask>>["task"] & {}): string {
  if (!task) {
    throw new Error("Task details require a task record.");
  }

  return [
    `Instance: ${instanceName}`,
    `Upload: ${task.uploadId}`,
    `Status: ${task.status}`,
    `Chat: ${task.chatId}`,
    `Kind: ${task.kind}`,
    `Source files: ${task.sourceFiles.length > 0 ? task.sourceFiles.join(", ") : "none"}`,
    `Extracted directory: ${task.extractedPath ?? "none"}`,
    `Detail: ${task.summary || "none"}`,
  ].join("\n");
}

function resolveAuditStateDir(
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): string {
  return resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: instanceName,
  });
}

function formatAccessStatus(instanceName: string, status: Awaited<ReturnType<AccessStore["getStatus"]>>): string {
  const allowlist = status.allowlist.length > 0 ? status.allowlist.join(", ") : "none";
  const pendingPairs =
    status.pendingPairs.length > 0
      ? status.pendingPairs
          .map((pair) => `${pair.code} chat ${pair.telegramChatId} expires ${pair.expiresAt}`)
          .join("; ")
      : "none";

  return [
    `Instance: ${instanceName}`,
    `Policy: ${status.policy}`,
    `Multi-chat: ${status.multiChat ? "on" : "off"}`,
    `Paired users: ${status.pairedUsers}`,
    `Allowlist: ${allowlist}`,
    `Pending pairs: ${pendingPairs}`,
  ].join("\n");
}

async function runAccessCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
  options: {
    commandName?: string;
    defaultInstanceName?: string;
    ensureAgentInstructions?: boolean;
  } = {},
): Promise<boolean> {
  const commandName = options.commandName ?? "telegram access";
  if (argv.length < 2) {
    throw new Error(`Usage: ${commandName} <pair|policy|allow|revoke|multi|status> ...`);
  }

  const subcommand = argv[1];
  const { instanceName, args } = extractInstanceOption(argv.slice(2), options.defaultInstanceName);
  const auditStateDir = resolveAuditStateDir(env, instanceName);
  const store = new AccessStore(resolveInstanceAccessStatePath(env, instanceName));

  if (subcommand === "pair") {
    if (args.length !== 1) {
      throw new Error(`Usage: ${commandName} pair [--instance <name>] <code>`);
    }

    const code = args[0];
    const pairedUser = await store.redeemPairingCode(code, new Date());

    if (!pairedUser) {
    await appendAuditEvent(auditStateDir, {
      type: "access.pair",
      instanceName,
      outcome: "rejected",
        metadata: { code },
      });
      throw new Error(`Pairing code "${code}" is invalid or expired.`);
    }

    await appendAuditEvent(auditStateDir, {
      type: "access.pair",
      instanceName,
      chatId: pairedUser.telegramChatId,
      userId: pairedUser.telegramUserId,
      outcome: "success",
      metadata: { code },
    });
    if (options.ensureAgentInstructions !== false) {
      await ensureDefaultInstanceAgentInstructions(env, instanceName);
    }
    logger.log(`Redeemed pairing code for instance "${instanceName}" and chat ${pairedUser.telegramChatId}.`);
    return true;
  }

  if (subcommand === "policy") {
    if (args.length !== 1 || (args[0] !== "pairing" && args[0] !== "allowlist")) {
      throw new Error(`Usage: ${commandName} policy [--instance <name>] <pairing|allowlist>`);
    }

    await store.setPolicy(args[0]);
    await appendAuditEvent(auditStateDir, {
      type: "access.policy",
      instanceName,
      outcome: "success",
      metadata: { policy: args[0] },
    });
    logger.log(`Updated access policy for instance "${instanceName}" to "${args[0]}".`);
    return true;
  }

  if (subcommand === "allow") {
    if (args.length !== 1) {
      throw new Error(`Usage: ${commandName} allow [--instance <name>] <chat-id>`);
    }

    const chatId = parseChatId(args[0]);
    await store.allowChat(chatId);
    await appendAuditEvent(auditStateDir, {
      type: "access.allow",
      instanceName,
      chatId,
      outcome: "success",
    });
    logger.log(`Allowed chat ${chatId} for instance "${instanceName}".`);
    return true;
  }

  if (subcommand === "revoke") {
    if (args.length !== 1) {
      throw new Error(`Usage: ${commandName} revoke [--instance <name>] <chat-id>`);
    }

    const chatId = parseChatId(args[0]);
    await store.revokeChat(chatId);
    await appendAuditEvent(auditStateDir, {
      type: "access.revoke",
      instanceName,
      chatId,
      outcome: "success",
    });
    logger.log(`Revoked chat ${chatId} for instance "${instanceName}".`);
    return true;
  }

  if (subcommand === "multi") {
    if (args.length !== 1 || (args[0] !== "on" && args[0] !== "off")) {
      throw new Error(`Usage: ${commandName} multi [--instance <name>] <on|off>`);
    }

    const enabled = args[0] === "on";
    await store.setMultiChat(enabled);
    await appendAuditEvent(auditStateDir, {
      type: "access.multi-chat",
      instanceName,
      outcome: "success",
      metadata: { enabled },
    });
    logger.log(`Set multi-chat for instance "${instanceName}" to ${enabled ? "on" : "off"}.`);
    return true;
  }

  if (subcommand === "status") {
    if (args.length !== 0) {
      throw new Error(`Usage: ${commandName} status [--instance <name>]`);
    }

    logger.log(formatAccessStatus(instanceName, await store.getStatus()));
    return true;
  }

  throw new Error(`Usage: ${commandName} <pair|policy|allow|revoke|multi|status> ...`);
}

async function runStatusCommand(argv: string[], env: InstanceTokenEnv, logger: CliLogger): Promise<boolean> {
  const { instanceName, args } = extractInstanceOption(argv.slice(1));

  if (args.length !== 0) {
    throw new Error("Usage: telegram status [--instance <name>]");
  }

  const store = new AccessStore(resolveInstanceAccessStatePath(env, instanceName));
  const status = await store.getStatus();

  logger.log(formatAccessStatus(instanceName, status));
  return true;
}

function resolveLarkStateDirForCli(env: LarkRuntimeEnv): string {
  try {
    return resolveLarkStateDir(env);
  } catch {
    return "(unknown: HOME or USERPROFILE is required)";
  }
}

async function formatLarkStatus(env: LarkRuntimeEnv): Promise<string> {
  const stateDir = resolveLarkStateDirForCli(env);
  const operationalLines = await inspectLarkOperationalStatus(stateDir);
  const serviceStatus = await describeLarkServiceLock(stateDir);
  const lines = [
    "Lark channel",
    `App ID: ${env.LARK_APP_ID ? "configured" : "missing"}`,
    `App Secret: ${env.LARK_APP_SECRET ? "configured" : "missing"}`,
    `Domain: ${env.LARK_DOMAIN ?? "default"}`,
    `State dir: ${stateDir}`,
    `Env file: ${stateDir.startsWith("(unknown:") ? "unknown" : resolveLarkEnvFilePath(env)}`,
    `Service: ${serviceStatus}`,
    `Require mention in groups: ${parseLarkBooleanEnv(env.LARK_REQUIRE_MENTION_IN_GROUP, true) ? "yes" : "no"}`,
    ...operationalLines,
    ...formatLarkStatusNextSteps(serviceStatus),
  ];

  return lines.join("\n");
}

function formatLarkStatusNextSteps(serviceStatus: string): string[] {
  if (serviceStatus.startsWith("running ")) {
    return [
      "Inspect: node dist/src/index.js lark doctor",
      "Logs: node dist/src/index.js lark service logs",
    ];
  }
  return [
    "Run: node dist/src/index.js lark service start",
    "Direct run: node dist/src/index.js lark run",
  ];
}

async function inspectLarkOperationalStatus(stateDir: string): Promise<string[]> {
  if (stateDir.startsWith("(unknown:")) {
    return [
      "Engine: unknown",
      "Model: unknown",
      "Effort: unknown",
      "Codex Fast Mode: unknown",
      "Approval mode: unknown",
      "Budget: unknown",
      "Locale: unknown",
      "Verbosity: unknown",
      "Timezone: unknown",
      "Allowed Lark groups: unknown",
      "Listen-all Lark groups: unknown",
      "Lark cron jobs: unknown",
    ];
  }

  let cfg: Awaited<ReturnType<typeof loadInstanceConfig>> | undefined;
  let rawConfig: Record<string, unknown> = {};
  let allowedGroups = "unknown";
  try {
    cfg = await loadInstanceConfig(stateDir);
    rawConfig = await readRawLarkCliConfig(stateDir);
    allowedGroups = String(cfg.groupMode.allowedChatIds.length);
  } catch {
    // Keep status usable even when config state is unreadable.
  }

  let listenAllGroups = "unknown";
  try {
    listenAllGroups = String(await new LarkGroupModeStore(stateDir).countListenAll());
  } catch {
    // Keep status usable even when group-mode state is unreadable.
  }

  let cronJobs = "unknown";
  try {
    const jobs = (await new CronStore(stateDir).list()).filter((job) => job.channel === "lark");
    cronJobs = `${jobs.length} (enabled ${jobs.filter((job) => job.enabled).length})`;
  } catch {
    // Keep status usable even when cron state is unreadable.
  }

  const lines = [
    `Engine: ${cfg?.engine ?? "unknown"}`,
    `Model: ${cfg?.model ?? (cfg ? "default" : "unknown")}`,
    `Effort: ${cfg?.effort ?? (cfg ? "default" : "unknown")}`,
    `Codex Fast Mode: ${cfg ? (cfg.codexServiceTier === "fast" ? "on" : "off") : "unknown"}`,
    `Approval mode: ${cfg ? renderLarkCliApprovalModeStatus(rawConfig.approvalMode) : "unknown"}`,
    `Budget: ${cfg ? (cfg.budgetUsd !== undefined ? `$${cfg.budgetUsd.toFixed(2)}` : "none") : "unknown"}`,
    `Locale: ${cfg?.locale ?? "unknown"}`,
    `Verbosity: ${cfg?.verbosity ?? "unknown"}`,
    `Timezone: ${cfg?.timezone ?? "unknown"}`,
    `Allowed Lark groups: ${allowedGroups}`,
    `Listen-all Lark groups: ${listenAllGroups}`,
    `Lark cron jobs: ${cronJobs}`,
  ];
  if (listenAllGroups !== "0" && listenAllGroups !== "unknown") {
    const cronLineIndex = lines.findIndex((line) => line.startsWith("Lark cron jobs:"));
    lines.splice(cronLineIndex === -1 ? lines.length : cronLineIndex, 0, "Group-all platform scope: requires im:message.group_msg; run `lark doctor` if ordinary group messages do not arrive.");
  }
  return lines;
}

async function readRawLarkCliConfig(stateDir: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function renderLarkCliApprovalModeStatus(mode: unknown): string {
  if (mode === "bypass") {
    return "YOLO unsafe/bypass";
  }
  if (mode === "full-auto") {
    return "YOLO/full-auto";
  }
  return "normal approvals";
}

async function describeLarkServiceLock(stateDir: string): Promise<string> {
  if (stateDir.startsWith("(unknown:")) {
    return "unknown";
  }

  const lockPath = resolveLarkServiceLockPath(stateDir);
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
      acquiredAt?: unknown;
    };
    if (typeof parsed.pid !== "number") {
      return `unknown lock (${lockPath})`;
    }
    const status = isProcessAlive(parsed.pid) ? "running" : "stale";
    const acquiredAt = typeof parsed.acquiredAt === "string" ? ` since ${parsed.acquiredAt}` : "";
    return `${status} pid ${parsed.pid}${acquiredAt}`;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return "not running";
    }
    return `unknown (${error instanceof Error ? error.message : String(error)})`;
  }
}

function isProcessAlive(pid: number): boolean {
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

function parseLarkBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return /^(?:1|true|yes|on)$/i.test(value.trim());
}

async function checkLarkCliDocsCreate(): Promise<string> {
  try {
    const { stdout, stderr } = await execFile(
      "lark-cli",
      ["docs", "+create", "--help"],
      { timeout: 3_000, maxBuffer: 1024 * 1024 },
    );
    const help = `${stdout}\n${stderr}`;
    if (help.includes("--markdown") && help.includes("--title")) {
      return "ok lark-cli docs +create: markdown create flags available";
    }
    return "warn lark-cli docs +create: installed CLI help did not expose --markdown/--title";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `warn lark-cli docs +create: ${detail}`;
  }
}

async function formatLarkDoctor(
  env: LarkRuntimeEnv,
  inspectApp: NonNullable<CliOptions["larkInspectApp"]> = inspectLarkAppProvisioning,
): Promise<string> {
  const stateDir = resolveLarkStateDirForCli(env);
  const serviceLock = await describeLarkServiceLock(stateDir);
  const checks = [
    `${env.LARK_APP_ID ? "ok" : "fail"} LARK_APP_ID: ${env.LARK_APP_ID ? "configured" : "missing"}`,
    `${env.LARK_APP_SECRET ? "ok" : "fail"} LARK_APP_SECRET: ${env.LARK_APP_SECRET ? "configured" : "missing"}`,
    `ok State dir: ${stateDir}`,
    `${serviceLock.startsWith("running ") ? "ok" : "warn"} Service lock: ${serviceLock}`,
    await checkLarkCliDocsCreate(),
  ];

  try {
    resolveLarkRuntimeConfig(env);
    checks.push("ok runtime config: valid");
  } catch (error) {
    checks.push(`fail runtime config: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (env.LARK_APP_ID && env.LARK_APP_SECRET) {
    try {
      const provisioning = await inspectApp({
        appId: env.LARK_APP_ID,
        appSecret: env.LARK_APP_SECRET,
        ...(env.LARK_DOMAIN ? { domain: env.LARK_DOMAIN } : {}),
      });
      checks.push(...formatLarkProvisioningForDoctor(provisioning));
    } catch (error) {
      checks.push(`warn Lark app provisioning check: ${redactLarkDoctorError(error, env)}`);
    }
  } else {
    checks.push("warn Lark app provisioning check: skipped because app credentials are incomplete");
  }

  return [
    "Lark channel doctor",
    ...checks.map((line) => `- ${line}`),
  ].join("\n");
}

function formatLarkProvisioningForDoctor(result: LarkProvisioningResult): string[] {
  return formatLarkProvisioningResult(result).map((line) => {
    const severity = isOkLarkProvisioningLine(line) ? "ok" : "warn";
    return `${severity} ${line}`;
  });
}

function isOkLarkProvisioningLine(line: string): boolean {
  return line.endsWith(": ok");
}

function redactLarkDoctorError(error: unknown, env: LarkRuntimeEnv): string {
  let detail = error instanceof Error ? error.message : String(error);
  for (const value of [env.LARK_APP_SECRET, env.LARK_APP_ID].filter((item): item is string => Boolean(item))) {
    detail = detail.split(value).join("[redacted]");
  }
  return detail.replace(/(Bearer|app_secret=)\s*[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]");
}

function resolveLarkServiceLogPath(stateDir: string): string {
  return path.join(stateDir, "lark-service.log");
}

function resolveCliEntrypoint(): string {
  const modulePath = fileURLToPath(import.meta.url);
  if (modulePath.endsWith(".js")) {
    return path.resolve(path.dirname(modulePath), "..", "index.js");
  }
  return path.resolve("dist/src/index.js");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await execFile("tmux", ["has-session", "-t", sessionName], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

function buildLarkServiceTmuxSessionName(stateDir: string): string {
  const digest = createHash("sha256").update(path.resolve(stateDir)).digest("hex").slice(0, 12);
  return `${LARK_SERVICE_TMUX_SESSION_PREFIX}${digest}`;
}

async function defaultKillTmuxSession(sessionName: string): Promise<boolean> {
  try {
    await execFile("tmux", ["kill-session", "-t", sessionName], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function buildLarkServiceStartCommand(input: LarkServiceCommandInput): string {
  return [
    "cd",
    shellQuote(input.cwd),
    "&&",
    `CCTB_LARK_STATE_DIR=${shellQuote(input.stateDir)}`,
    `CODEX_TELEGRAM_INSTANCE=${shellQuote("lark")}`,
    shellQuote(process.execPath),
    shellQuote(input.entrypoint),
    "lark",
    "run",
    ">>",
    shellQuote(input.logPath),
    "2>&1",
  ].join(" ");
}

async function defaultStartLarkService(
  input: LarkServiceCommandInput,
  deps: Pick<LarkServiceCommandDeps, "killTmuxSession"> = {},
): Promise<"started" | "already_running"> {
  await mkdir(input.stateDir, { recursive: true });
  if ((await describeLarkServiceLock(input.stateDir)).startsWith("running ")) {
    return "already_running";
  }
  const sessionName = buildLarkServiceTmuxSessionName(input.stateDir);
  const killTmuxSession = deps.killTmuxSession ?? defaultKillTmuxSession;
  if (await tmuxSessionExists(sessionName)) {
    await killTmuxSession(sessionName);
  }

  const command = buildLarkServiceStartCommand(input);
  await execFile("tmux", ["new-session", "-d", "-s", sessionName, command], { timeout: 5_000 });
  return "started";
}

async function defaultWaitUntilLarkServiceRunning(input: LarkServiceCommandInput): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    lastStatus = await describeLarkServiceLock(input.stateDir);
    if (lastStatus.startsWith("running ")) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Lark service did not publish a running lock after start; last status: ${lastStatus}`);
}

async function readLarkLockPid(stateDir: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(resolveLarkServiceLockPath(stateDir), "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : null;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function defaultFindLarkServiceProcessIds(input: LarkServiceCommandInput): Promise<number[]> {
  try {
    const { stdout } = await execFile("ps", ["-axo", "pid=,command="], { timeout: 3_000, maxBuffer: 5 * 1024 * 1024 });
    return findLarkServiceProcessIdsFromPs(stdout, input, process.pid);
  } catch {
    return [];
  }
}

export function findLarkServiceProcessIdsFromPs(psOutput: string, input: LarkServiceCommandInput, currentPid: number = process.pid): number[] {
  return psOutput
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), command: match[2] ?? "" }))
    .filter((processInfo) => processInfo.pid !== currentPid && isLarkRunProcessCommand(processInfo.command, input))
    .map((processInfo) => processInfo.pid);
}

function isLarkRunProcessCommand(command: string, input: LarkServiceCommandInput): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (/^(?:\S*\/)?tmux\b/.test(normalized)) {
    return false;
  }
  if (!/(?:^|\s)lark\s+run(?:\s|$)/.test(normalized)) {
    return false;
  }
  if (/(?:^|\s)lark\s+service(?:\s|$)/.test(normalized)) {
    return false;
  }
  return normalized.includes(input.entrypoint);
}

function defaultKillLarkProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }
}

async function defaultStopLarkService(
  input: LarkServiceCommandInput,
  deps: Pick<LarkServiceCommandDeps, "findProcessIds" | "isProcessAlive" | "killProcess" | "killTmuxSession" | "sleep"> = {},
): Promise<"stopped" | "not_running"> {
  let stopped = false;
  const findProcessIds = deps.findProcessIds ?? defaultFindLarkServiceProcessIds;
  const isAlive = deps.isProcessAlive ?? isProcessAlive;
  const killProcess = deps.killProcess ?? defaultKillLarkProcess;
  const killTmuxSession = deps.killTmuxSession ?? defaultKillTmuxSession;
  const sleepProcess = deps.sleep ?? sleep;

  if (await killTmuxSession(buildLarkServiceTmuxSessionName(input.stateDir))) {
    stopped = true;
  }

  const pidsToStop = new Set<number>();
  const pid = await readLarkLockPid(input.stateDir);
  const lockPidAlive = pid !== null && isAlive(pid);
  if (lockPidAlive && await killTmuxSession(LEGACY_LARK_SERVICE_TMUX_SESSION)) {
    stopped = true;
  }
  if (lockPidAlive && pid !== null) {
    pidsToStop.add(pid);
  }
  for (const processId of await findProcessIds(input)) {
    if (isAlive(processId)) {
      pidsToStop.add(processId);
    }
  }
  if (pidsToStop.size === 0 && pid !== null) {
    await rm(resolveLarkServiceLockPath(input.stateDir), { force: true });
  }

  for (const processId of pidsToStop) {
    killProcess(processId);
    stopped = true;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && [...pidsToStop].some((processId) => isAlive(processId))) {
    await sleepProcess(100);
  }
  if (pid !== null && !isAlive(pid)) {
    await rm(resolveLarkServiceLockPath(input.stateDir), { force: true });
  }

  return stopped ? "stopped" : "not_running";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultReadLarkServiceLogs(input: { logPath: string; tail: number }): Promise<string> {
  try {
    const raw = await readFile(input.logPath, "utf8");
    const lines = raw.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - input.tail)).join("\n").trim() || "(empty)";
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return `(no Lark service log at ${input.logPath})`;
    }
    throw error;
  }
}

function formatLarkServiceAction(action: "start" | "stop", result: "started" | "already_running" | "stopped" | "not_running"): string {
  if (result === "started") {
    return "Started Lark service.";
  }
  if (result === "already_running") {
    return "Lark service is already running.";
  }
  if (result === "stopped") {
    return "Stopped Lark service.";
  }
  return action === "stop" ? "Lark service is not running." : "Lark service was not started.";
}

async function prepareLarkServiceStartEnv(env: LarkRuntimeEnv): Promise<void> {
  const config = resolveLarkRuntimeConfig(env);
  await writeLarkEnvFile(env, {
    appId: config.appId,
    appSecret: config.appSecret,
    ...(env.LARK_DOMAIN ? { domain: env.LARK_DOMAIN } : {}),
    requireMentionInGroup: config.requireMentionInGroup,
  });
}

async function runLarkServiceCommand(
  args: string[],
  env: LarkRuntimeEnv,
  logger: CliLogger,
  deps: LarkServiceCommandDeps = {},
): Promise<boolean> {
  if (args.length === 0) {
    throw new Error("Usage: lark service <start|stop|restart|status|logs|doctor>");
  }

  const subcommand = args[0];
  const loadedEnv = await loadLarkRuntimeEnv(env);

  if (subcommand === "status") {
    if (args.length !== 1) {
      throw new Error("Usage: lark service status");
    }
    logger.log(await formatLarkStatus(loadedEnv));
    return true;
  }

  if (subcommand === "doctor") {
    if (args.length !== 1) {
      throw new Error("Usage: lark service doctor");
    }
    logger.log(await formatLarkDoctor(loadedEnv, deps.inspectApp ?? inspectLarkAppProvisioning));
    return true;
  }

  const stateDir = resolveLarkStateDir(loadedEnv);
  const logPath = resolveLarkServiceLogPath(stateDir);
  const commandInput: LarkServiceCommandInput = {
    env: loadedEnv,
    stateDir,
    logPath,
    entrypoint: resolveCliEntrypoint(),
    cwd: process.cwd(),
  };

  if (subcommand === "logs") {
    if (args.length > 2) {
      throw new Error("Usage: lark service logs [tail-count]");
    }
    const tail = args[1] ? parsePositiveInteger(args[1], "tail count") : 80;
    logger.log(await (deps.readLogs ?? defaultReadLarkServiceLogs)({ stateDir, logPath, tail }));
    return true;
  }

  if (subcommand === "start") {
    if (args.length !== 1) {
      throw new Error("Usage: lark service start");
    }
    await prepareLarkServiceStartEnv(loadedEnv);
    const result = deps.start ? await deps.start(commandInput) : await defaultStartLarkService(commandInput, deps);
    if (result === "started") {
      await (deps.waitUntilRunning ?? defaultWaitUntilLarkServiceRunning)(commandInput);
    }
    logger.log(formatLarkServiceAction("start", result));
    return true;
  }

  if (subcommand === "stop") {
    if (args.length !== 1) {
      throw new Error("Usage: lark service stop");
    }
    const result = deps.stop ? await deps.stop(commandInput) : await defaultStopLarkService(commandInput, deps);
    logger.log(formatLarkServiceAction("stop", result));
    return true;
  }

  if (subcommand === "restart") {
    if (args.length !== 1) {
      throw new Error("Usage: lark service restart");
    }
    await prepareLarkServiceStartEnv(loadedEnv);
    const stopResult = deps.stop ? await deps.stop(commandInput) : await defaultStopLarkService(commandInput, deps);
    logger.log(formatLarkServiceAction("stop", stopResult));
    const result = deps.start ? await deps.start(commandInput) : await defaultStartLarkService(commandInput, deps);
    if (result === "started") {
      await (deps.waitUntilRunning ?? defaultWaitUntilLarkServiceRunning)(commandInput);
    }
    logger.log(formatLarkServiceAction("start", result));
    return true;
  }

  throw new Error("Usage: lark service <start|stop|restart|status|logs|doctor>");
}

async function runLarkAccessCommand(
  args: string[],
  env: LarkRuntimeEnv,
  logger: CliLogger,
): Promise<boolean> {
  const loadedEnv = await loadLarkRuntimeEnv(env);
  const stateDir = resolveLarkStateDir(loadedEnv);
  const instanceName = "lark";
  return await runAccessCommand(["access", ...args], {
    HOME: loadedEnv.HOME,
    USERPROFILE: loadedEnv.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: stateDir,
    CODEX_TELEGRAM_INSTANCE: instanceName,
  }, logger, {
    commandName: "lark access",
    defaultInstanceName: instanceName,
    ensureAgentInstructions: false,
  });
}

async function resolveLarkScopedEnv(env: LarkRuntimeEnv): Promise<{ env: InstanceTokenEnv; instanceName: string }> {
  const loadedEnv = await loadLarkRuntimeEnv(env);
  const stateDir = resolveLarkStateDir(loadedEnv);
  const instanceName = "lark";
  return {
    instanceName,
    env: {
      HOME: loadedEnv.HOME,
      USERPROFILE: loadedEnv.USERPROFILE,
      CODEX_TELEGRAM_STATE_DIR: stateDir,
      CODEX_TELEGRAM_INSTANCE: instanceName,
    },
  };
}

interface ParsedLarkSendArgs {
  chatId?: string;
  replyTo?: string;
  replyInThread: boolean;
  sendArgs: string[];
}

const LARK_SEND_HELP_TEXT = [
  "Usage: lark send [--chat <oc_xxx>] [--reply-to <message-id>] [--thread] [--message <text>] [--image <path>] [--file <path>] [--stdin] [text]",
  "",
  "Options:",
  "  --chat, --chat-id <oc_xxx>       Target Lark chat id. If omitted, exactly one saved Lark chat must exist.",
  "  --reply-to <message-id>          Reply to a specific Lark message.",
  "  --thread                         Keep the reply inside the replied message thread; requires --reply-to.",
  "  --message, -m <text>             Send text/markdown.",
  "  --image <absolute-path>          Send an image file.",
  "  --file <absolute-path>           Send a file.",
  "  --stdin                          Read message text from stdin.",
].join("\n");

function hasHelpFlag(argv: string[]): boolean {
  return argv.some((arg) => arg === "--help" || arg === "-h");
}

function parseLarkSendArgs(argv: string[]): ParsedLarkSendArgs {
  let chatId: string | undefined;
  let replyTo: string | undefined;
  let replyInThread = false;
  const sendArgs: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--chat" || argument === "--chat-id") {
      const value = argv[++index]?.trim();
      if (!value) {
        throw new Error(`${argument} requires a Lark chat id`);
      }
      chatId = value;
      continue;
    }
    if (argument.startsWith("--chat=")) {
      chatId = argument.slice("--chat=".length).trim();
      continue;
    }
    if (argument.startsWith("--chat-id=")) {
      chatId = argument.slice("--chat-id=".length).trim();
      continue;
    }
    if (argument === "--reply-to") {
      const value = argv[++index]?.trim();
      if (!value) {
        throw new Error("--reply-to requires a Lark message id");
      }
      replyTo = value;
      continue;
    }
    if (argument.startsWith("--reply-to=")) {
      replyTo = argument.slice("--reply-to=".length).trim();
      continue;
    }
    if (argument === "--thread") {
      replyInThread = true;
      continue;
    }
    sendArgs.push(argument);
  }

  if (chatId !== undefined && chatId.length === 0) {
    throw new Error("--chat requires a Lark chat id");
  }
  if (replyTo !== undefined && replyTo.length === 0) {
    throw new Error("--reply-to requires a Lark message id");
  }
  if (replyInThread && !replyTo) {
    throw new Error("--thread requires --reply-to <message-id>");
  }

  return { chatId, replyTo, replyInThread, sendArgs };
}

async function buildLarkSendPayload(argv: string[], deps: LarkSendCommandDeps): Promise<ReturnType<typeof parseSideChannelSendArgs>> {
  const stdinIndex = argv.indexOf("--stdin");
  if (stdinIndex === -1) {
    return parseSideChannelSendArgs(argv);
  }

  const readStdin = deps.readStdin ?? (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  });
  const stdinText = (await readStdin()).trim();
  const nextArgs = [
    ...argv.slice(0, stdinIndex),
    ...argv.slice(stdinIndex + 1),
    stdinText,
  ].filter(Boolean);
  return parseSideChannelSendArgs(nextArgs);
}

async function resolveLarkSendChatId(stateDir: string, explicitChatId?: string): Promise<string> {
  if (explicitChatId) {
    return explicitChatId;
  }

  const fs = await import("node:fs/promises");
  const mapPath = path.join(stateDir, "lark-chat-id-map.json");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(mapPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("No Lark chat has been seen yet; pass --chat <oc_xxx>.");
    }
    throw error;
  }

  const targets = Object.values(parsed)
    .filter((value): value is string => typeof value === "string")
    .map((value) => larkChatIdFromStoredConversation(value))
    .filter((value): value is string => Boolean(value));
  const uniqueTargets = [...new Set(targets)];
  if (uniqueTargets.length === 0) {
    throw new Error("No Lark chat has been seen yet; pass --chat <oc_xxx>.");
  }
  if (uniqueTargets.length > 1) {
    throw new Error("Multiple Lark chats found; pass --chat <oc_xxx>.");
  }
  return uniqueTargets[0]!;
}

function larkChatIdFromStoredConversation(value: string): string | null {
  const match = value.match(/^lark:([^:]+)(?::[^:]+)?$/);
  return match?.[1] ?? null;
}

async function runLarkSendCommand(
  args: string[],
  env: LarkRuntimeEnv,
  logger: CliLogger,
  deps: LarkSendCommandDeps = {},
): Promise<boolean> {
  if (hasHelpFlag(args)) {
    logger.log(LARK_SEND_HELP_TEXT);
    return true;
  }

  const loadedEnv = await loadLarkRuntimeEnv(env);
  const config = resolveLarkRuntimeConfig(loadedEnv);
  const parsed = parseLarkSendArgs(args);
  const payload = await buildLarkSendPayload(parsed.sendArgs, deps);
  const chatId = await resolveLarkSendChatId(config.stateDir, parsed.chatId);
  const channel = (deps.createChannel ?? ((options: LarkChannelOptions) => createLarkChannel(options) as LarkChannelLike))({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: "websocket",
    source: "cc-telegram-bridge-cli",
    ...(config.domain !== undefined ? { domain: config.domain } : {}),
  });
  await (deps.deliverResponse ?? deliverLarkResponse)({
    channel,
    runtime: createLarkServiceRuntime(),
    chatId,
    replyTo: parsed.replyTo,
    replyInThread: parsed.replyInThread,
    text: renderSideChannelDeliveryText(payload),
    stateDir: config.stateDir,
    workspaceOverride: process.cwd(),
    allowAnyAbsolutePath: true,
  });
  logger.log(`Sent to Lark chat ${chatId}.`);
  return true;
}

function hasOption(args: string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

async function runDashboardCommand(
  args: string[],
  env: DashboardCommandEnv,
  logger: CliLogger,
  deps: DashboardCommandDeps = {},
): Promise<boolean> {
  const live = args.includes("--live") || args.includes("--serve");
  const dashboardModule = (!deps.generateDashboard || (live && !deps.serveDashboard))
    ? await import("./dashboard.js")
    : null;

  if (live) {
    const serveDashboard = deps.serveDashboard ?? dashboardModule!.serveDashboard;
    const dashboard = await serveDashboard(env);
    logger.log(`Live dashboard: ${dashboard.url} (press Ctrl+C to stop)`);
    await dashboard.closed;
    return true;
  }

  const generateDashboard = deps.generateDashboard ?? dashboardModule!.generateDashboard;
  const outPath = await generateDashboard(env);
  logger.log(`Dashboard generated: ${outPath}`);
  return true;
}

async function runLarkCommand(
  argv: string[],
  env: LarkRuntimeEnv,
  logger: CliLogger,
  deps: {
    inspectApp?: CliOptions["larkInspectApp"];
    provisionApp?: CliOptions["larkProvisionApp"];
    service?: LarkServiceCommandDeps;
    send?: LarkSendCommandDeps;
    dashboard?: DashboardCommandDeps;
  } = {},
): Promise<boolean> {
  const subcommand = argv[1] ?? "status";
  const args = argv.slice(2);

  if (subcommand === "service") {
    return await runLarkServiceCommand(args, env, logger, {
      ...deps.service,
      inspectApp: deps.service?.inspectApp ?? deps.inspectApp,
    });
  }

  if (subcommand === "send") {
    return await runLarkSendCommand(args, env, logger, deps.send);
  }

  if (subcommand === "access") {
    return await runLarkAccessCommand(args, env, logger);
  }

  if (subcommand === "audit") {
    const scoped = await resolveLarkScopedEnv(env);
    return await runAuditCommand(["audit", "--instance", scoped.instanceName, ...args], scoped.env, logger);
  }

  if (subcommand === "timeline") {
    const scoped = await resolveLarkScopedEnv(env);
    const timelineArgs = hasOption(args, "--channel") ? args : ["--channel", "lark", ...args];
    return await runTimelineCommand(["timeline", "--instance", scoped.instanceName, ...timelineArgs], scoped.env, logger);
  }

  if (subcommand === "dashboard") {
    const scoped = await resolveLarkScopedEnv(env);
    return await runDashboardCommand(args, scoped.env, logger, deps.dashboard);
  }

  if (subcommand === "session") {
    const scoped = await resolveLarkScopedEnv(env);
    return await runSessionCommand(["session", ...args], scoped.env, logger, {
      commandName: "lark session",
      defaultInstanceName: scoped.instanceName,
      showInstanceOption: false,
    });
  }

  if (subcommand === "task") {
    const scoped = await resolveLarkScopedEnv(env);
    return await runTaskCommand(["task", ...args], scoped.env, logger, {
      commandName: "lark task",
      defaultInstanceName: scoped.instanceName,
      showInstanceOption: false,
    });
  }

  if (subcommand === "backup") {
    await runLarkBackupCommand(args, env, logger);
    return true;
  }

  if (subcommand === "restore") {
    await runLarkRestoreCommand(args, env, logger);
    return true;
  }

  if (subcommand === "instructions") {
    const scoped = await resolveLarkScopedEnv(env);
    return await runInstructionsCommand(["instructions", ...args], scoped.env, logger, {
      allowUpgrade: false,
      commandName: "lark instructions",
      defaultInstanceName: scoped.instanceName,
      showInstanceOption: false,
    });
  }

  if (subcommand === "engine") {
    const scoped = await resolveLarkScopedEnv(env);
    return await runEngineCommand(["engine", ...args, "--instance", scoped.instanceName], scoped.env, logger);
  }

  if (subcommand === "yolo") {
    const scoped = await resolveLarkScopedEnv(env);
    return await runYoloCommand(["yolo", ...args, "--instance", scoped.instanceName], scoped.env, logger);
  }

  if (subcommand === "budget") {
    const scoped = await resolveLarkScopedEnv(env);
    return await runBudgetCommand(["budget", ...args, "--instance", scoped.instanceName], scoped.env, logger);
  }

  if (subcommand === "locale") {
    const scoped = await resolveLarkScopedEnv(env);
    return await runLocaleCommand(["locale", ...args, "--instance", scoped.instanceName], scoped.env, logger);
  }

  if (subcommand === "verbosity") {
    const scoped = await resolveLarkScopedEnv(env);
    return await runVerbosityCommand(["verbosity", ...args, "--instance", scoped.instanceName], scoped.env, logger);
  }

  if (subcommand === "usage") {
    const scoped = await resolveLarkScopedEnv(env);
    return await runUsageCommand(["usage", ...args, "--instance", scoped.instanceName], scoped.env, logger);
  }

  if (subcommand === "status") {
    if (args.length !== 0) {
      throw new Error("Usage: lark status");
    }
    const loadedEnv = await loadLarkRuntimeEnv(env);
    logger.log(await formatLarkStatus(loadedEnv));
    return true;
  }

  if (subcommand === "doctor") {
    if (args.length !== 0) {
      throw new Error("Usage: lark doctor");
    }
    const loadedEnv = await loadLarkRuntimeEnv(env);
    logger.log(await formatLarkDoctor(loadedEnv, deps.inspectApp ?? inspectLarkAppProvisioning));
    return true;
  }

  if (subcommand === "provision") {
    if (args.length !== 0) {
      throw new Error("Usage: lark provision");
    }
    const loadedEnv = await loadLarkRuntimeEnv(env);
    if (!loadedEnv.LARK_APP_ID) {
      throw new Error("LARK_APP_ID is required");
    }
    if (!loadedEnv.LARK_APP_SECRET) {
      throw new Error("LARK_APP_SECRET is required");
    }
    const provisioning = await (deps.provisionApp ?? provisionLarkApp)({
      appId: loadedEnv.LARK_APP_ID,
      appSecret: loadedEnv.LARK_APP_SECRET,
      ...(loadedEnv.LARK_DOMAIN ? { domain: loadedEnv.LARK_DOMAIN } : {}),
      logger,
    });
    logger.log([
      "Lark app provisioning",
      ...formatLarkProvisioningResult(provisioning).map((line) => `- ${line}`),
    ].join("\n"));
    return true;
  }

  if (subcommand === "permissions") {
    if (args.length === 1 && args[0] === "--missing") {
      const loadedEnv = await loadLarkRuntimeEnv(env);
      if (!loadedEnv.LARK_APP_ID) {
        throw new Error("LARK_APP_ID is required");
      }
      if (!loadedEnv.LARK_APP_SECRET) {
        throw new Error("LARK_APP_SECRET is required");
      }
      const inspected = await (deps.inspectApp ?? inspectLarkAppProvisioning)({
        appId: loadedEnv.LARK_APP_ID,
        appSecret: loadedEnv.LARK_APP_SECRET,
        ...(loadedEnv.LARK_DOMAIN ? { domain: loadedEnv.LARK_DOMAIN } : {}),
      });
      const lines = [
        "Lark missing tenant scopes JSON",
        "Paste this into Feishu/Lark Developer Console -> your app -> Permissions -> bulk import/open.",
        inspected.missingScopes.length > 0
          ? formatLarkTenantScopeImportJson(inspected.missingScopes)
          : "No missing required tenant scopes.",
      ];
      if (inspected.unauthorizedScopes.length > 0) {
        lines.push(`Already configured but awaiting approval: ${inspected.unauthorizedScopes.join(", ")}`);
      }
      logger.log(lines.join("\n"));
      return true;
    }

    if (args.length !== 0) {
      throw new Error("Usage: lark permissions [--missing]");
    }
    logger.log([
      "Lark required tenant scopes JSON",
      "Paste this into Feishu/Lark Developer Console -> your app -> Permissions -> bulk import/open.",
      formatLarkTenantScopeImportJson(REQUIRED_LARK_SCOPES),
    ].join("\n"));
    return true;
  }

  if (subcommand === "wizard") {
    if (args.length !== 0) {
      throw new Error("Usage: lark wizard");
    }
    await runLarkWizard(env, logger);
    return true;
  }

  if (subcommand === "run") {
    throw new Error("Usage: node dist/src/index.js lark run");
  }

  throw new Error("Usage: lark <status|doctor|provision|permissions|wizard|run|service|send|access|session|task|backup|restore|instructions|engine|yolo|budget|locale|verbosity|usage|audit|timeline|dashboard>");
}

async function runAuditCommand(argv: string[], env: InstanceTokenEnv, logger: CliLogger): Promise<boolean> {
  const { instanceName, args } = extractInstanceOption(argv.slice(1));
  const filter: AuditEventFilter = { tail: 20 };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];

    if (/^\d+$/.test(argument)) {
      filter.tail = parsePositiveInteger(argument, "tail count");
      continue;
    }

    if (argument === "--type") {
      if (index + 1 >= args.length) {
        throw new Error("Usage: telegram audit [--instance <name>] [tail-count] [--type <event-type>] [--chat <chat-id>] [--outcome <outcome>]");
      }
      filter.type = args[index + 1];
      index++;
      continue;
    }

    if (argument === "--chat") {
      if (index + 1 >= args.length) {
        throw new Error("Usage: telegram audit [--instance <name>] [tail-count] [--type <event-type>] [--chat <chat-id>] [--outcome <outcome>]");
      }
      filter.chatId = parseChatId(args[index + 1]);
      index++;
      continue;
    }

    if (argument === "--outcome") {
      if (index + 1 >= args.length) {
        throw new Error("Usage: telegram audit [--instance <name>] [tail-count] [--type <event-type>] [--chat <chat-id>] [--outcome <outcome>]");
      }
      filter.outcome = args[index + 1];
      index++;
      continue;
    }

    throw new Error("Usage: telegram audit [--instance <name>] [tail-count] [--type <event-type>] [--chat <chat-id>] [--outcome <outcome>]");
  }
  const auditPath = resolveAuditLogPath(resolveAuditStateDir(env, instanceName));

  try {
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(auditPath, "utf8"));
    const lines = filterAuditEvents(parseAuditEvents(raw), filter).map((event) => JSON.stringify(event));
    logger.log(lines.length > 0 ? lines.join("\n") : "(empty)");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      logger.log("(empty)");
      return true;
    }

    throw error;
  }

  return true;
}

async function runTimelineCommand(argv: string[], env: InstanceTokenEnv, logger: CliLogger): Promise<boolean> {
  const { instanceName, args } = extractInstanceOption(argv.slice(1));
  const filter: TimelineEventFilter = { tail: 20 };

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];

    if (/^\d+$/.test(argument)) {
      filter.tail = parsePositiveInteger(argument, "tail count");
      continue;
    }

    if (argument === "--type") {
      if (index + 1 >= args.length) {
        throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus|lark>]");
      }
      filter.type = args[index + 1] as TimelineEventFilter["type"];
      index++;
      continue;
    }

    if (argument === "--chat") {
      if (index + 1 >= args.length) {
        throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus|lark>]");
      }
      filter.chatId = parseChatId(args[index + 1]);
      index++;
      continue;
    }

    if (argument === "--outcome") {
      if (index + 1 >= args.length) {
        throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus|lark>]");
      }
      filter.outcome = args[index + 1];
      index++;
      continue;
    }

    if (argument === "--channel") {
      if (index + 1 >= args.length) {
        throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus|lark>]");
      }
      const value = args[index + 1];
      if (value !== "telegram" && value !== "bus" && value !== "lark") {
        throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus|lark>]");
      }
      filter.channel = value;
      index++;
      continue;
    }

    throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus|lark>]");
  }

  const timelinePath = resolveTimelineLogPath(resolveAuditStateDir(env, instanceName));

  try {
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(timelinePath, "utf8"));
    const lines = filterTimelineEvents(parseTimelineEvents(raw), filter).map((event) => JSON.stringify(event));
    logger.log(lines.length > 0 ? lines.join("\n") : "(empty)");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      logger.log("(empty)");
      return true;
    }

    throw error;
  }

  return true;
}

type ScopedCommandUsage = {
  commandName: string;
  defaultInstanceName?: string;
  showInstanceOption?: boolean;
};

function usageWithOptionalInstance(
  usage: ScopedCommandUsage,
  suffix: string,
): string {
  return `${usage.commandName} ${suffix.replace("[--instance <name>]", usage.showInstanceOption === false ? "" : "[--instance <name>]").replace(/\s+/g, " ").trim()}`;
}

async function runSessionCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
  usage: ScopedCommandUsage = { commandName: "telegram session", showInstanceOption: true },
): Promise<boolean> {
  if (argv.length < 2) {
    throw new Error(`Usage: ${usage.commandName} <list|inspect|reset> ...`);
  }

  const subcommand = argv[1];
  const { instanceName, args } = extractInstanceOption(argv.slice(2), usage.defaultInstanceName);

  if (subcommand === "list") {
    if (args.length !== 0) {
      throw new Error(`Usage: ${usageWithOptionalInstance(usage, "list [--instance <name>]")}`);
    }

    const result = await inspectSessions(env, instanceName);
    logger.log(formatSessionList(instanceName, result.sessions, result.warning));
    return true;
  }

  if (subcommand === "show" || subcommand === "inspect") {
    if (args.length !== 1) {
      throw new Error(`Usage: ${usageWithOptionalInstance(usage, `${subcommand} [--instance <name>] <chat-id>`)}`);
    }

    const chatId = parseChatId(args[0]);
    const result = await inspectSessionForChat(env, instanceName, chatId);
    if (result.warning === SESSION_STATE_UNREADABLE_WARNING) {
      logger.log(`Session state unreadable for instance "${instanceName}".`);
      return true;
    }
    if (!result.session) {
      logger.log(`No session binding found for chat ${chatId} in instance "${instanceName}".`);
      return true;
    }

    logger.log(formatSessionDetails(instanceName, result.session));
    return true;
  }

  if (subcommand === "reset") {
    if (args.length !== 1) {
      throw new Error(`Usage: ${usageWithOptionalInstance(usage, "reset [--instance <name>] <chat-id>")}`);
    }

    const chatId = parseChatId(args[0]);
    const result = await resetSessionForChat(env, instanceName, chatId);

    if (result.repaired) {
      logger.log(`Session state was unreadable and has been reset for instance "${instanceName}".`);
    } else if (result.cleared) {
      logger.log(`Reset session for chat ${chatId} in instance "${instanceName}".`);
    } else {
      logger.log(`No session binding found for chat ${chatId} in instance "${instanceName}".`);
    }
    return true;
  }

  throw new Error(`Usage: ${usage.commandName} <list|inspect|reset> ...`);
}

async function runTaskCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
  usage: ScopedCommandUsage = { commandName: "telegram task", showInstanceOption: true },
): Promise<boolean> {
  if (argv.length < 2) {
    throw new Error(`Usage: ${usage.commandName} <list|inspect|clear> ...`);
  }

  const subcommand = argv[1];
  const { instanceName, args } = extractInstanceOption(argv.slice(2), usage.defaultInstanceName);

  if (subcommand === "list") {
    if (args.length !== 0) {
      throw new Error(`Usage: ${usageWithOptionalInstance(usage, "list [--instance <name>]")}`);
    }

    const result = await listTasks(env, instanceName);
    logger.log(formatTaskList(instanceName, result));
    return true;
  }

  if (subcommand === "inspect") {
    if (args.length !== 1) {
      throw new Error(`Usage: ${usageWithOptionalInstance(usage, "inspect [--instance <name>] <upload-id>")}`);
    }

    const uploadId = args[0];
    const result = await inspectTask(env, instanceName, uploadId);

    if (result.warning === FILE_WORKFLOW_STATE_UNREADABLE_WARNING) {
      logger.log(`Task state unreadable for instance "${instanceName}".`);
      return true;
    }

    if (!result.task) {
      logger.log(`No task found for "${uploadId}" in instance "${instanceName}".`);
      return true;
    }

    logger.log(formatTaskDetails(instanceName, result.task));
    return true;
  }

  if (subcommand === "clear") {
    if (args.length !== 1) {
      throw new Error(`Usage: ${usageWithOptionalInstance(usage, "clear [--instance <name>] <upload-id>")}`);
    }

    const uploadId = args[0];
    const result = await clearTaskWithRecovery(env, instanceName, uploadId);

    if (result.repaired) {
      logger.log(`Task state was unreadable and has been reset for instance "${instanceName}".`);
    } else if (result.cleared) {
      logger.log(
        result.cleanupWarning
          ? `Cleared task "${uploadId}" in instance "${instanceName}". Warning: ${result.cleanupWarning}`
          : `Cleared task "${uploadId}" in instance "${instanceName}".`,
      );
    } else {
      logger.log(`No task found for "${uploadId}" in instance "${instanceName}".`);
    }

    return true;
  }

  throw new Error(`Usage: ${usage.commandName} <list|inspect|clear> ...`);
}

function formatServiceStatus(status: Awaited<ReturnType<typeof getServiceStatus>>): string {
  const lines = [
    `Instance: ${status.instanceName}`,
    `Running: ${status.running ? "yes" : "no"}`,
    `Pid: ${status.pid ?? "none"}`,
    `Engine: ${status.engine}`,
    `Runtime: ${status.runtime}`,
    `Policy: ${status.policy}`,
    `Paired users: ${status.pairedUsers}`,
    `Allowlist count: ${status.allowlistCount}`,
    `Pending pair count: ${status.pendingPairs}`,
    status.sessionBindingsWarning !== undefined
      ? `Session bindings: unknown (${status.sessionBindingsWarning})`
      : `Session bindings: ${status.sessionBindings}`,
    `Last handled update: ${status.lastHandledUpdateId ?? "none"}`,
    `Audit events: ${status.auditEvents}`,
    status.timelineWarning !== undefined
      ? `Timeline events: unknown (${status.timelineWarning})`
      : `Timeline events: ${status.timelineEvents}`,
    `Last success: ${status.lastSuccessAt ?? "none"}`,
    `Last failure: ${status.lastFailureAt ?? "none"}`,
    `Last turn completion: ${status.lastTurnCompletionAt ?? "none"}`,
    `Last retry: ${status.lastRetryAt ?? "none"}`,
    `Last budget block: ${status.lastBudgetBlockedAt ?? "none"}`,
    `Last crew run: ${status.lastCrewRunAt ?? "none"}`,
    `Retry count: ${status.retryCount ?? "unknown"}`,
    `Budget block count: ${status.budgetBlockedCount ?? "unknown"}`,
    `Service error count: ${status.serviceErrorCount ?? "unknown"}`,
    `File rejection count: ${status.fileRejectedCount ?? "unknown"}`,
    `Workflow failure count: ${status.workflowFailedCount ?? "unknown"}`,
    `Crew runs started: ${status.crewRunsStartedCount ?? "unknown"}`,
    `Crew runs completed: ${status.crewRunsCompletedCount ?? "unknown"}`,
    `Crew runs failed: ${status.crewRunsFailedCount ?? "unknown"}`,
    status.crewRunStateWarning !== undefined
      ? `Latest crew run: unknown (${status.crewRunStateWarning})`
      : `Latest crew run: ${status.latestCrewRunId ? `${status.latestCrewRunId} (${status.latestCrewRunWorkflow ?? "unknown"}, ${status.latestCrewRunStatus ?? "unknown"}/${status.latestCrewRunStage ?? "unknown"}, updated ${status.latestCrewRunUpdatedAt ?? "unknown"})` : "none"}`,
    status.unresolvedTasksWarning !== undefined
      ? `Unresolved tasks: unknown (${status.unresolvedTasksWarning})`
      : `Unresolved tasks: ${status.unresolvedTasks}`,
    status.unresolvedTasksWarning !== undefined
      ? `Blocking tasks: unknown (${status.unresolvedTasksWarning})`
      : `Blocking tasks: ${status.blockingTasks}`,
    status.unresolvedTasksWarning !== undefined
      ? `Awaiting continue tasks: unknown (${status.unresolvedTasksWarning})`
      : `Awaiting continue tasks: ${status.awaitingContinueTasks}`,
    `State dir: ${status.stateDir}`,
    `Stdout log: ${status.stdoutPath}`,
    `Stderr log: ${status.stderrPath}`,
    `Lock path: ${status.lockPath}`,
    `Bot token configured: ${status.botTokenConfigured ? "yes" : "no"}`,
  ];

  if (status.botTokenConfigured) {
    lines.push(
      status.botIdentityWarning ??
        `Bot identity: ${status.botIdentity?.firstName ?? "unavailable"}${
          status.botIdentity?.username ? ` (@${status.botIdentity.username})` : ""
        }`,
    );
  }

  if (status.lastErrorLine) {
    lines.push(`Last error: ${status.lastErrorLine}`);
  }

  return lines.join("\n");
}

function formatServiceDoctor(result: Awaited<ReturnType<typeof runServiceDoctor>>): string {
  const checkLines = result.checks.map((check) => `- ${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}`);

  return [
    `Instance: ${result.instanceName}`,
    `Engine: ${result.engine}`,
    `Runtime: ${result.runtime}`,
    `Healthy: ${result.healthy ? "yes" : "no"}`,
    ...checkLines,
  ].join("\n");
}

async function runServiceCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
  serviceDeps: ServiceCommandDeps,
): Promise<boolean> {
  if (argv.length < 2) {
    throw new Error("Usage: telegram service <start|stop|restart|status|logs|doctor> ...");
  }

  const subcommand = argv[1];
  const serviceArgs = argv.slice(2);
  const hasInstanceOption = serviceArgs.some((argument) => argument === "--instance" || argument.startsWith("--instance="));
  const { instanceName, args: rawArgs } = extractInstanceOption(serviceArgs);
  const { enabled: all, args: afterAll } = extractBooleanFlag(rawArgs, "--all");
  const { enabled: force, args: afterForce } = extractBooleanFlag(afterAll, "--force");
  const { enabled: defer, args } = extractBooleanFlag(afterForce, "--defer");

  if (subcommand !== "logs" && args.length !== 0) {
    throw new Error("Usage: telegram service <start|stop|restart|status|logs|doctor> [--instance <name>] [--all] [--force] [--defer]");
  }
  if (defer && subcommand !== "restart") {
    throw new Error("Usage: telegram service restart [--instance <name>] [--all] [--force] [--defer]");
  }

  if (all) {
    if (hasInstanceOption) {
      throw new Error("Use either --instance <name> or --all, not both.");
    }
    if (subcommand === "logs") {
      throw new Error("Usage: telegram service logs [--instance <name>] [tail-count]");
    }

    const instanceNames = await listConfiguredInstanceNames(env);
    if (instanceNames.length === 0) {
      logger.log("No instances found.");
      return true;
    }

    const currentServiceInstanceName = env.CODEX_TELEGRAM_INSTANCE
      ? normalizeInstanceName(env.CODEX_TELEGRAM_INSTANCE)
      : null;
    const shouldSkipCurrentStop = currentServiceInstanceName !== null && subcommand === "stop";
    let deferredCurrentRestartInstance: string | null = null;

    for (const currentInstanceName of instanceNames) {
      if (shouldSkipCurrentStop && currentInstanceName === currentServiceInstanceName) {
        logger.log(
          `Skipped current instance "${currentInstanceName}"; run ${subcommand} --instance ${currentInstanceName} from a terminal if you need to ${subcommand} it too.`,
        );
        continue;
      }
      if (subcommand === "restart" && currentInstanceName === currentServiceInstanceName) {
        deferredCurrentRestartInstance = currentInstanceName;
        continue;
      }
      if (subcommand === "start") {
        logger.log(await startServiceInstance(env, currentInstanceName, serviceDeps));
        continue;
      }
      if (subcommand === "stop") {
        logger.log(await stopServiceInstance(env, currentInstanceName, serviceDeps, { force }));
        continue;
      }
      if (subcommand === "restart") {
        await stopServiceInstance(env, currentInstanceName, serviceDeps, { force });
        logger.log(await startServiceInstance(env, currentInstanceName, serviceDeps));
        continue;
      }
      if (subcommand === "status") {
        logger.log(formatServiceStatus(await getServiceStatus(env, currentInstanceName, serviceDeps)));
        continue;
      }
      if (subcommand === "doctor") {
        logger.log(formatServiceDoctor(await runServiceDoctor(env, currentInstanceName, serviceDeps)));
        continue;
      }
      throw new Error("Usage: telegram service <start|stop|restart|status|logs|doctor> ...");
    }
    if (deferredCurrentRestartInstance !== null) {
      logger.log(await scheduleDeferredServiceRestart(env, deferredCurrentRestartInstance, serviceDeps, { current: true }));
    }
    return true;
  }

  if (subcommand === "start") {
    logger.log(await startServiceInstance(env, instanceName, serviceDeps));
    return true;
  }

  if (subcommand === "stop") {
    logger.log(await stopServiceInstance(env, instanceName, serviceDeps, { force }));
    return true;
  }

  if (subcommand === "restart") {
    if (defer) {
      logger.log(await scheduleDeferredServiceRestart(env, instanceName, serviceDeps));
      return true;
    }
    await stopServiceInstance(env, instanceName, serviceDeps, { force });
    logger.log(await startServiceInstance(env, instanceName, serviceDeps));
    return true;
  }

  if (subcommand === "status") {
    logger.log(formatServiceStatus(await getServiceStatus(env, instanceName, serviceDeps)));
    return true;
  }

  if (subcommand === "logs") {
    if (args.length > 1) {
      throw new Error("Usage: telegram service logs [--instance <name>] [tail-count]");
    }

    const maxLines = args.length === 1 ? parsePositiveInteger(args[0], "tail count") : 40;
    logger.log(await getServiceLogs(env, instanceName, serviceDeps, maxLines));
    return true;
  }

  if (subcommand === "doctor") {
    logger.log(formatServiceDoctor(await runServiceDoctor(env, instanceName, serviceDeps)));
    return true;
  }

  throw new Error("Usage: telegram service <start|stop|restart|status|logs|doctor> ...");
}

function resolveAgentMdPath(
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): string {
  return resolveInstanceAgentInstructionsPath(env, instanceName);
}

async function runInstructionsCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
  options: {
    allowUpgrade?: boolean;
    commandName?: string;
    defaultInstanceName?: string;
    showInstanceOption?: boolean;
  } = {},
): Promise<boolean> {
  const commandName = options.commandName ?? "telegram instructions";
  const defaultInstanceName = options.defaultInstanceName ?? "default";
  const showInstanceOption = options.showInstanceOption ?? true;
  const instanceUsage = showInstanceOption ? " [--instance <name>]" : "";
  const allowUpgrade = options.allowUpgrade ?? true;
  const commandList = allowUpgrade ? "show|set|path|upgrade" : "show|set|path";
  const usage = `Usage: ${commandName} <${commandList}>${instanceUsage}${allowUpgrade ? " [--all] [--force] [--dry-run]" : ""} [file-path]`;

  if (argv.length < 2) {
    throw new Error(usage);
  }

  const subcommand = argv[1];
  const { instanceName, args } = extractInstanceOption(argv.slice(2), defaultInstanceName);
  const agentMdPath = resolveAgentMdPath(env, instanceName);

  if (subcommand === "path") {
    logger.log(agentMdPath);
    return true;
  }

  if (subcommand === "show") {
    try {
      const content = await readFile(agentMdPath, "utf8");
      const trimmed = content.trim();
      if (!trimmed) {
        logger.log(`Instance "${instanceName}": no instructions configured (agent.md is empty).`);
      } else {
        logger.log(`Instance "${instanceName}" instructions:\n---\n${trimmed}\n---`);
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.log(`Instance "${instanceName}": no instructions configured (agent.md not found).`);
        logger.log(`Create one at: ${agentMdPath}`);
      } else {
        throw error;
      }
    }
    return true;
  }

  if (subcommand === "set") {
    if (args.length !== 1) {
      throw new Error(`Usage: ${commandName} set${instanceUsage} <file-path>`);
    }

    const sourcePath = args[0];
    const content = await readFile(sourcePath, "utf8");
    await mkdir(path.dirname(agentMdPath), { recursive: true });
    await writeFile(agentMdPath, content, "utf8");
    logger.log(`Wrote instructions for instance "${instanceName}" (${content.length} bytes) to ${agentMdPath}`);
    return true;
  }

  if (subcommand === "upgrade") {
    if (!allowUpgrade) {
      throw new Error("Lark transport instructions are injected per turn; use `lark instructions set <file>` for custom bot personality instead of running Telegram transport upgrades.");
    }
    const force = extractBooleanFlag(argv.slice(2), "--force");
    const dryRun = extractBooleanFlag(force.args, "--dry-run");
    const all = extractBooleanFlag(dryRun.args, "--all");
    const { instanceName, args } = extractInstanceOption(all.args, defaultInstanceName);
    if (args.length !== 0) {
      throw new Error(`Usage: ${commandName} upgrade${instanceUsage} [--all] [--force] [--dry-run]`);
    }

    let instanceNames = [instanceName];
    if (all.enabled) {
      try {
        const dirents = await readdir(resolveChannelsDirFromEnv(env), { withFileTypes: true });
        instanceNames = dirents
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => entry.name)
          .sort();
      } catch {
        instanceNames = [];
      }
      if (instanceNames.length === 0) {
        logger.log("No instances found.");
        return true;
      }
    }

    const summary = { upgraded: 0, current: 0, skippedCustom: 0, failed: 0 };
    for (const name of instanceNames) {
      try {
        const result = await upgradeInstanceAgentInstructions(env, name, {
          force: force.enabled,
          dryRun: dryRun.enabled,
        });
        logInstructionsUpgradeResult(logger, name, result);
        if (result.status === "current") {
          summary.current++;
        } else if (result.status === "manual-review") {
          summary.skippedCustom++;
        } else {
          summary.upgraded++;
        }
      } catch (error) {
        if (!all.enabled) {
          throw error;
        }
        summary.failed++;
        logger.log(`Failed to upgrade instructions for instance "${name}": ${formatCliError(error)}`);
      }
    }
    if (all.enabled) {
      logger.log(`Summary: upgraded ${summary.upgraded}, current ${summary.current}, skipped custom ${summary.skippedCustom}, failed ${summary.failed}.`);
    }
    return true;
  }

  throw new Error(usage);
}

function formatCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logInstructionsUpgradeResult(
  logger: CliLogger,
  instanceName: string,
  result: InstanceAgentInstructionsUpgradeResult,
): void {
  const would = result.dryRun ? "Would " : "";
  if (result.status === "created") {
    logger.log(`${would}${result.dryRun ? "create" : "Created"} instructions for instance "${instanceName}" at ${result.path}`);
  } else if (result.status === "current") {
    logger.log(`Instance "${instanceName}" instructions already current.`);
  } else if (result.status === "upgraded") {
    logger.log(`${would}${result.dryRun ? "upgrade" : "Upgraded"} instructions for instance "${instanceName}" at ${result.path}`);
  } else if (result.status === "appended") {
    logger.log(`${would}${result.dryRun ? "append" : "Appended"} Telegram transport instructions for instance "${instanceName}" at ${result.path}`);
  } else if (result.status === "force-upgraded") {
    logger.log(`${would}${result.dryRun ? "force-upgrade" : "Force-upgraded"} instructions for instance "${instanceName}" at ${result.path}`);
    if (result.backupPath) {
      logger.log(`Previous instructions backed up to ${result.backupPath}`);
    }
  } else {
    logger.log(`Instance "${instanceName}" instructions: manual review required; run "telegram instructions upgrade --instance ${instanceName} --force" to replace the custom Telegram Transport block.`);
  }
}

function resolveConfigJsonPath(
  env: Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): string {
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: instanceName,
  });
  return path.join(stateDir, "config.json");
}

async function readInstanceConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function updateCliInstanceConfig(
  env: InstanceTokenEnv,
  instanceName: string,
  updater: (config: Record<string, unknown>) => void,
): Promise<void> {
  await updateInstanceConfig(resolveStateDirForInstance(env, instanceName), updater);
}

async function runYoloCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  const { instanceName, args } = extractInstanceOption(argv.slice(1));
  const configPath = resolveConfigJsonPath(env, instanceName);

  if (args.length === 0) {
    const config = await readInstanceConfig(configPath);
    const mode = config.approvalMode ?? "normal";
    const label =
      mode === "bypass" ? "YOLO UNSAFE (all approvals and sandbox bypassed)"
        : mode === "full-auto" ? "YOLO (full-auto, sandboxed)"
        : "off (normal approval flow)";
    logger.log(`Instance "${instanceName}": ${label}`);
    return true;
  }

  const subcommand = args[0];
  const auditStateDir = resolveAuditStateDir(env, instanceName);

  if (subcommand === "on") {
    await updateCliInstanceConfig(env, instanceName, (config) => {
      config.approvalMode = "full-auto";
    });
    await appendAuditEvent(auditStateDir, {
      type: "config.yolo",
      instanceName,
      outcome: "success",
      metadata: { approvalMode: "full-auto" },
    });
    logger.log(`Instance "${instanceName}": YOLO mode ON (full-auto, sandboxed). Codex will auto-approve within workspace.`);
    return true;
  }

  if (subcommand === "off") {
    await updateCliInstanceConfig(env, instanceName, (config) => {
      config.approvalMode = "normal";
    });
    await appendAuditEvent(auditStateDir, {
      type: "config.yolo",
      instanceName,
      outcome: "success",
      metadata: { approvalMode: "normal" },
    });
    logger.log(`Instance "${instanceName}": YOLO mode OFF. Normal approval flow restored.`);
    return true;
  }

  if (subcommand === "unsafe") {
    await updateCliInstanceConfig(env, instanceName, (config) => {
      config.approvalMode = "bypass";
    });
    await appendAuditEvent(auditStateDir, {
      type: "config.yolo",
      instanceName,
      outcome: "success",
      metadata: { approvalMode: "bypass" },
    });
    logger.log(`Instance "${instanceName}": YOLO UNSAFE. All approvals AND sandbox bypassed. Use with caution.`);
    return true;
  }

  throw new Error("Usage: telegram yolo [on|off|unsafe] [--instance <name>]");
}

async function runEngineCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  const { instanceName, args } = extractInstanceOption(argv.slice(1));
  const configPath = resolveConfigJsonPath(env, instanceName);
  const stateDir = resolveStateDirForInstance(env, instanceName);

  if (args.length === 0) {
    const config = await readInstanceConfig(configPath);
    const engine = config.engine ?? "codex";
    logger.log(`Instance "${instanceName}": engine = ${engine}`);
    return true;
  }

  const engine = args[0];
  if (engine !== "codex" && engine !== "claude" && engine !== "antigravity") {
    throw new Error("Usage: telegram engine <codex|claude|antigravity> [--instance <name>]");
  }

  const config = await readInstanceConfig(configPath);
  const previousEngine =
    config.engine === "claude" || config.engine === "codex" || config.engine === "antigravity"
      ? config.engine
      : "codex";
  let resetSessionBindings = false;

  if (previousEngine !== engine) {
    const sessionStore = new SessionStore(path.join(stateDir, "session.json"));
    try {
      const removedBindings = await sessionStore.clearAll();
      resetSessionBindings = removedBindings > 0;
    } catch {
      throw new Error(
        `Could not switch to ${engine} because this instance's session bindings could not be reset first. Engine remains ${previousEngine}.`,
      );
    }
  }

  let clearedModel = false;
  let enabledFullAuto = false;
  await updateCliInstanceConfig(env, instanceName, (config) => {
    const result = applyEngineSelection(config, engine);
    clearedModel = result.clearedModel;
    enabledFullAuto = result.enabledFullAuto;
  });

  const auditStateDir = resolveAuditStateDir(env, instanceName);
  await appendAuditEvent(auditStateDir, {
    type: "config.engine",
    instanceName,
    outcome: "success",
    metadata: { engine },
  });

  const engineMessage = clearedModel && resetSessionBindings
      ? `Instance "${instanceName}": engine set to "${engine}". Cleared the previous model override and reset this instance's session bindings. Restart the service to apply.`
      : clearedModel
        ? `Instance "${instanceName}": engine set to "${engine}". Cleared the previous model override. Restart the service to apply.`
        : resetSessionBindings
          ? `Instance "${instanceName}": engine set to "${engine}". Reset this instance's session bindings. Restart the service to apply.`
          : `Instance "${instanceName}": engine set to "${engine}". Restart the service to apply.`;
  logger.log(
    enabledFullAuto
      ? `${engineMessage} Antigravity YOLO/full-auto enabled.`
      : engineMessage,
  );
  return true;
}

async function runUsageCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  const { instanceName } = extractInstanceOption(argv.slice(1));
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: instanceName,
  });

  const { UsageStore } = await import("../state/usage-store.js");
  const store = new UsageStore(stateDir);
  const usage = await store.load();

  if (usage.requestCount === 0) {
    logger.log(`Instance "${instanceName}": no usage recorded yet.`);
    return true;
  }

  const cost = usage.totalCostUsd > 0 ? `$${usage.totalCostUsd.toFixed(4)}` : "unknown (Codex does not report USD)";
  logger.log([
    `Instance: ${instanceName}`,
    `Requests: ${usage.requestCount}`,
    `Input tokens: ${usage.totalInputTokens.toLocaleString()}`,
    `Output tokens: ${usage.totalOutputTokens.toLocaleString()}`,
    `Cached tokens: ${usage.totalCachedTokens.toLocaleString()}`,
    `Estimated cost: ${cost}`,
    `Last updated: ${usage.lastUpdatedAt}`,
  ].join("\n"));
  return true;
}

async function runVerbosityCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  const { instanceName, args } = extractInstanceOption(argv.slice(1));
  const configPath = resolveConfigJsonPath(env, instanceName);

  if (args.length === 0) {
    const config = await readInstanceConfig(configPath);
    const v = config.verbosity ?? 1;
    const label = v === 0 ? "quiet (no progress)" : v === 2 ? "detailed (1s updates)" : "normal (2s updates)";
    logger.log(`Instance "${instanceName}": verbosity = ${v} (${label})`);
    return true;
  }

  const level = Number(args[0]);
  if (level !== 0 && level !== 1 && level !== 2) {
    throw new Error("Usage: telegram verbosity [0|1|2] [--instance <name>]\n  0 = quiet, 1 = normal (default), 2 = detailed");
  }

  await updateCliInstanceConfig(env, instanceName, (config) => {
    config.verbosity = level;
  });
  const label = level === 0 ? "quiet (no progress)" : level === 2 ? "detailed (1s updates)" : "normal (2s updates)";
  logger.log(`Instance "${instanceName}": verbosity set to ${level} (${label}).`);
  return true;
}

const HELP_TEXT = `Usage: telegram <command> [options]

Commands:
  configure <token> [--instance <name>]       Configure bot token for an instance
  service <start|stop|restart|status|logs|doctor> [--instance <name>|--all]
                                              Manage the service lifecycle
  access <pair|policy|allow|revoke|multi|status> [--instance <name>]
                                              Manage access control
  status [--instance <name>]                  Show access policy and paired users
  session list [--instance <name>]            Inspect chat-to-thread bindings
  session inspect [--instance <name>] <chat-id>
  session reset [--instance <name>] <chat-id>
  task list [--instance <name>]               Inspect file workflow records
  task inspect [--instance <name>] <upload-id> Inspect one file workflow record
  task clear [--instance <name>] <upload-id>  Clear a file workflow record
  audit [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>]
                                              View audit trail
  timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus|lark>]
                                              View timeline trail
  instructions <show|set|path|upgrade> [--instance <name>] [--all] [--force] [--dry-run]
                                              Manage per-instance agent.md
  yolo [on|off|unsafe] [--instance <name>]    Toggle YOLO auto-approval mode
  engine [codex|claude|antigravity] [--instance <name>]
                                              Switch AI engine per instance
  usage [--instance <name>]                   Show token usage and cost
  verbosity [0|1|2] [--instance <name>]       Set progress output level
  budget [set <usd>|show] [--instance <name>] Manage cost budget and block-on-exceed
  locale [en|zh] [--instance <name>]          Set user-facing message language
  instance <list|rename|delete> [...]         Manage instances (list, rename, delete)
  logs rotate [--instance <name>]             Rotate log files now (auto on service start)
  backup [--instance <name>] [--out <path>]   Back up instance state to a .cctb.gz archive (pure Node)
  restore <archive> [--instance <name>]       Restore instance state from a backup archive
  send [--message <text>] [--image <path>] [--file <path>]
                                              Send files/text through the active turn side-channel or configured Telegram session
  lark <status|doctor|provision|permissions|wizard|run|service|send|access|session|task|backup|restore|instructions|engine|yolo|budget|locale|verbosity|usage|audit|timeline|dashboard>
                                              Inspect, configure, or run the Feishu/Lark channel
  lark permissions [--missing]                Print copyable Feishu/Lark tenant permission JSON
  lark service <start|stop|restart|status|logs|doctor>
                                              Manage the Feishu/Lark service lifecycle
  lark send [--chat <oc_xxx>] [--reply-to <message-id>] [--thread] [--message <text>] [--image <path>] [--file <path>] [--stdin]
                                              Send files/text to a Lark chat using saved app credentials
  lark access <pair|policy|allow|revoke|multi|status>
                                              Manage Feishu/Lark access control in the Lark state dir
  lark session <list|inspect|reset>           Inspect Feishu/Lark chat-to-thread bindings
  lark task <list|inspect|clear>              Inspect Feishu/Lark file workflow records
  lark backup [--out <path>]                  Back up Feishu/Lark state to a .cctb.gz archive
  lark restore <archive> [--force]            Restore Feishu/Lark state from a backup archive
  lark instructions <show|set|path>           Manage Lark agent.md without Telegram transport upgrades
  lark engine|yolo|budget|locale|verbosity|usage
                                              Configure or inspect the Lark runtime instance
  lark audit [count] / lark timeline [count]
                                              Inspect Feishu/Lark audit and timeline logs
  lark dashboard [--live]                     Open a Feishu/Lark-scoped visual status dashboard
  dashboard [--live]                         Open a visual status dashboard in the browser
  help                                        Show this help message`;

function resolveStateDirForInstance(env: InstanceTokenEnv, instanceName: string): string {
  return resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: instanceName,
  });
}

function resolveChannelsDirFromEnv(env: InstanceTokenEnv): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) throw new Error("HOME or USERPROFILE is required");
  return path.join(home, ".cctb");
}

async function listConfiguredInstanceNames(env: InstanceTokenEnv): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const channelsDir = resolveChannelsDirFromEnv(env);
  try {
    const dirents = await fs.readdir(channelsDir, { withFileTypes: true });
    return dirents
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function runLogsCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  const sub = argv[1];
  if (sub !== "rotate") {
    throw new Error("Usage: telegram logs rotate [--instance <name>]");
  }
  const { instanceName } = extractInstanceOption(argv.slice(2));
  const stateDir = resolveStateDirForInstance(env, instanceName);
  const { rotateInstanceLogs } = await import("../state/log-rotation.js");
  const rotated = await rotateInstanceLogs(stateDir);
  if (rotated.length === 0) {
    logger.log(`Instance "${instanceName}": no log files needed rotation.`);
  } else {
    logger.log(`Instance "${instanceName}": rotated ${rotated.length} file(s):`);
    for (const file of rotated) logger.log(`  - ${file}`);
  }
  return true;
}

async function runInstanceCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
  serviceDeps: ServiceCommandDeps = {},
): Promise<boolean> {
  const sub = argv[1];
  const fs = await import("node:fs/promises");
  const channelsDir = resolveChannelsDirFromEnv(env);

  if (sub === "list" || sub === undefined) {
    let entries: string[];
    try {
      const dirents = await fs.readdir(channelsDir, { withFileTypes: true });
      entries = dirents.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
    } catch {
      entries = [];
    }
    if (entries.length === 0) {
      logger.log("No instances found.");
      return true;
    }
    logger.log(`Instances (${entries.length}):`);
    for (const name of entries) {
      const stateDir = path.join(channelsDir, name);
      let engine = "codex";
      try {
        const cfg = JSON.parse(await fs.readFile(path.join(stateDir, "config.json"), "utf8")) as { engine?: string };
        engine = cfg.engine ?? "codex";
      } catch {}
      const liveness = await inspectInstanceServiceLiveness({
        stateDir,
        instanceName: name,
      }, serviceDeps);
      logger.log(`  - ${name} [${engine}] ${liveness.running ? "running" : "stopped"}`);
    }
    return true;
  }

  if (sub === "rename") {
    if (argv.length < 4) {
      throw new Error("Usage: telegram instance rename <old> <new>");
    }
    const oldName = normalizeInstanceName(argv[2]);
    const newName = normalizeInstanceName(argv[3]);
    const runningStatus = await getServiceStatus(env, oldName, serviceDeps);
    if (runningStatus.running) {
      throw new Error(`Stop instance "${oldName}" before renaming it.`);
    }
    const oldDir = path.join(channelsDir, oldName);
    const newDir = path.join(channelsDir, newName);
    try { await fs.access(newDir); throw new Error(`Instance "${newName}" already exists.`); } catch (e) {
      if (e instanceof Error && e.message.includes("already exists")) throw e;
    }
    await fs.rename(oldDir, newDir);
    logger.log(`Renamed "${oldName}" → "${newName}". Remember to stop the service before renaming a live instance.`);
    return true;
  }

  if (sub === "delete") {
    if (argv.length < 3) {
      throw new Error("Usage: telegram instance delete <name> [--yes]");
    }
    const name = normalizeInstanceName(argv[2]);
    const confirmed = argv.includes("--yes");
    if (!confirmed) {
      throw new Error(`Add --yes to confirm deletion of instance "${name}". This cannot be undone.`);
    }
    const runningStatus = await getServiceStatus(env, name, serviceDeps);
    if (runningStatus.running) {
      throw new Error(`Stop instance "${name}" before deleting it.`);
    }
    const dir = path.join(channelsDir, name);
    await fs.rm(dir, { recursive: true, force: true });
    logger.log(`Deleted instance "${name}".`);
    return true;
  }

  throw new Error("Usage: telegram instance <list|rename|delete> ...");
}

async function runBudgetCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  const { instanceName, args } = extractInstanceOption(argv.slice(1));
  const configPath = resolveConfigJsonPath(env, instanceName);
  const config = await readInstanceConfig(configPath);

  if (args.length === 0 || args[0] === "show") {
    const budget = typeof config.budgetUsd === "number" ? config.budgetUsd : null;
    const { UsageStore } = await import("../state/usage-store.js");
    const stateDir = resolveStateDirForInstance(env, instanceName);
    const usage = await new UsageStore(stateDir).load();
    const used = usage.totalCostUsd;
    if (budget === null) {
      logger.log(`Instance "${instanceName}": no budget set. Current spend: $${used.toFixed(4)}`);
    } else {
      const pct = budget > 0 ? Math.round((used / budget) * 100) : 0;
      const remaining = Math.max(0, budget - used);
      logger.log(`Instance "${instanceName}": $${used.toFixed(4)} / $${budget.toFixed(2)} (${pct}%). Remaining: $${remaining.toFixed(4)}`);
    }
    return true;
  }

  if (args[0] === "set") {
    const amount = Number(args[1]);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("Usage: telegram budget set <usd>");
    }
    await updateCliInstanceConfig(env, instanceName, (config) => {
      config.budgetUsd = amount;
    });
    logger.log(`Instance "${instanceName}": budget set to $${amount.toFixed(2)}. Bot will block new requests when the budget is exhausted.`);
    return true;
  }

  if (args[0] === "clear") {
    await updateCliInstanceConfig(env, instanceName, (config) => {
      delete config.budgetUsd;
    });
    logger.log(`Instance "${instanceName}": budget cleared.`);
    return true;
  }

  throw new Error("Usage: telegram budget [set <usd>|show|clear] [--instance <name>]");
}

async function runLocaleCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  const { instanceName, args } = extractInstanceOption(argv.slice(1));
  const configPath = resolveConfigJsonPath(env, instanceName);
  const config = await readInstanceConfig(configPath);

  if (args.length === 0) {
    const locale = config.locale ?? "en";
    logger.log(`Instance "${instanceName}": locale = ${locale}`);
    return true;
  }

  const locale = args[0];
  if (locale !== "en" && locale !== "zh") {
    throw new Error("Usage: telegram locale [en|zh] [--instance <name>]");
  }
  await updateCliInstanceConfig(env, instanceName, (config) => {
    config.locale = locale;
  });
  logger.log(`Instance "${instanceName}": locale set to "${locale}".`);
  return true;
}

async function runBackupCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  const { instanceName, args } = extractInstanceOption(argv.slice(1));
  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1]
    ? args[outIdx + 1]
    : path.join(process.cwd(), `${instanceName}-backup-${Date.now()}.cctb.gz`);

  const stateDir = resolveStateDirForInstance(env, instanceName);
  const fs = await import("node:fs/promises");
  try {
    await fs.access(stateDir);
  } catch {
    throw new Error(`Instance "${instanceName}" state directory not found.`);
  }

  const { createArchive } = await import("../state/archive.js");
  const result = await createArchive(stateDir, outPath);
  logger.log(
    `Backed up instance "${instanceName}" to ${outPath} (${result.fileCount} files, ${Math.round(result.archiveBytes / 1024)} KB compressed from ${Math.round(result.uncompressedBytes / 1024)} KB)`,
  );
  return true;
}

async function runRestoreCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  const { instanceName, args } = extractInstanceOption(argv.slice(1));
  if (args.length < 1) {
    throw new Error("Usage: telegram restore <backup.cctb.gz> [--instance <name>] [--force]");
  }
  const archivePath = args[0];
  const channelsDir = resolveChannelsDirFromEnv(env);
  const fs = await import("node:fs/promises");
  await fs.mkdir(channelsDir, { recursive: true });

  const targetDir = path.join(channelsDir, instanceName);
  const tempExtractRoot = path.join(channelsDir, `.restore-${instanceName}-${Date.now()}`);
  try {
    await fs.access(targetDir);
    if (!args.includes("--force")) {
      throw new Error(`Instance "${instanceName}" already exists. Add --force to overwrite.`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("already exists")) throw e;
  }

  const { extractArchive } = await import("../state/archive.js");
  let result: Awaited<ReturnType<typeof extractArchive>>;
  try {
    result = await extractArchive(archivePath, tempExtractRoot);
  } catch (error) {
    await fs.rm(tempExtractRoot, { recursive: true, force: true });
    throw error;
  }

  // If the archive was created under a different instance name, rename to requested
  const extractedDir = path.join(tempExtractRoot, result.rootName);
  let stagedDir = extractedDir;
  if (result.rootName !== instanceName) {
    stagedDir = path.join(tempExtractRoot, instanceName);
    await fs.rename(extractedDir, stagedDir);
  }

  let backupDir: string | null = null;
  try {
    await fs.access(targetDir);
    backupDir = path.join(channelsDir, `.restore-backup-${instanceName}-${Date.now()}`);
    await fs.rename(targetDir, backupDir);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }

  try {
    await fs.rename(stagedDir, targetDir);
  } catch (error) {
    if (backupDir !== null) {
      await fs.rename(backupDir, targetDir);
    }
    throw error;
  } finally {
    await fs.rm(tempExtractRoot, { recursive: true, force: true });
  }

  if (backupDir !== null) {
    await fs.rm(backupDir, { recursive: true, force: true });
  }

  logger.log(`Restored instance "${instanceName}" from ${archivePath} (${result.fileCount} files).`);
  return true;
}

async function runLarkBackupCommand(
  args: string[],
  env: LarkRuntimeEnv,
  logger: CliLogger,
): Promise<void> {
  const loadedEnv = await loadLarkRuntimeEnv(env);
  const stateDir = resolveLarkStateDir(loadedEnv);
  const outIdx = args.indexOf("--out");
  const outPath = outIdx !== -1 && args[outIdx + 1]
    ? args[outIdx + 1]
    : path.join(process.cwd(), `lark-backup-${Date.now()}.cctb.gz`);

  const fs = await import("node:fs/promises");
  try {
    await fs.access(stateDir);
  } catch {
    throw new Error(`Lark state directory not found: ${stateDir}`);
  }

  const { createArchive } = await import("../state/archive.js");
  const result = await createArchive(stateDir, outPath);
  logger.log(
    `Backed up Lark state to ${outPath} (${result.fileCount} files, ${Math.round(result.archiveBytes / 1024)} KB compressed from ${Math.round(result.uncompressedBytes / 1024)} KB)`,
  );
}

async function runLarkRestoreCommand(
  args: string[],
  env: LarkRuntimeEnv,
  logger: CliLogger,
): Promise<void> {
  if (args.length < 1) {
    throw new Error("Usage: lark restore <backup.cctb.gz> [--force]");
  }

  const loadedEnv = await loadLarkRuntimeEnv(env);
  const targetDir = resolveLarkStateDir(loadedEnv);
  const targetParent = path.dirname(targetDir);
  const targetName = path.basename(targetDir);
  const archivePath = args[0];
  const fs = await import("node:fs/promises");
  await fs.mkdir(targetParent, { recursive: true });

  const tempExtractRoot = path.join(targetParent, `.restore-${targetName}-${Date.now()}`);
  try {
    await fs.access(targetDir);
    if (!args.includes("--force")) {
      throw new Error(`Lark state directory already exists at ${targetDir}. Add --force to overwrite.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) throw error;
  }

  const { extractArchive } = await import("../state/archive.js");
  let result: Awaited<ReturnType<typeof extractArchive>>;
  try {
    result = await extractArchive(archivePath, tempExtractRoot);
  } catch (error) {
    await fs.rm(tempExtractRoot, { recursive: true, force: true });
    throw error;
  }

  const extractedDir = path.join(tempExtractRoot, result.rootName);
  let stagedDir = extractedDir;
  if (result.rootName !== targetName) {
    stagedDir = path.join(tempExtractRoot, targetName);
    await fs.rename(extractedDir, stagedDir);
  }

  let backupDir: string | null = null;
  try {
    await fs.access(targetDir);
    backupDir = path.join(targetParent, `.restore-backup-${targetName}-${Date.now()}`);
    await fs.rename(targetDir, backupDir);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }

  try {
    await fs.rename(stagedDir, targetDir);
  } catch (error) {
    if (backupDir !== null) {
      await fs.rename(backupDir, targetDir);
    }
    throw error;
  } finally {
    await fs.rm(tempExtractRoot, { recursive: true, force: true });
  }

  if (backupDir !== null) {
    await fs.rm(backupDir, { recursive: true, force: true });
  }

  logger.log(`Restored Lark state from ${archivePath} (${result.fileCount} files).`);
}

export async function runCli(argv: string[], options: CliOptions = {}): Promise<boolean> {
  const normalized = normalizeCommandArgs(argv);
  const logger = options.logger ?? console;
  const env = options.env ?? process.env;

  if (normalized.length === 0 || normalized[0] === "help" || normalized[0] === "--help") {
    logger.log(HELP_TEXT);
    return true;
  }

  if (normalized[0] === "configure") {
    const { instanceName, botToken } = parseConfigureCommand(normalized);
    const persisted = await writeInstanceBotToken(env, instanceName, botToken);

    logger.log(`Configured Telegram bot token for instance "${persisted.instanceName}".`);
    return true;
  }

  if (normalized[0] === "send") {
    if (env.CCTB_SEND_URL) {
      await runSideChannelSendCommand(stripSendRoutingArgs(normalized.slice(1)), { env });
      logger.log("Sent via active Telegram turn.");
      return true;
    }

    const result = await runConfiguredSendCommand(normalized.slice(1), env, options.sendDeps);
    logger.log(result.filesSent > 0
      ? `Sent to Telegram chat ${result.chatId} (${result.filesSent} file${result.filesSent === 1 ? "" : "s"}).`
      : `Sent to Telegram chat ${result.chatId}.`);
    return true;
  }

  if (normalized[0] === "cron") {
    const cronEnv: NodeJS.ProcessEnv = { ...env } as NodeJS.ProcessEnv;
    const result = await runCronCli(normalized.slice(1), { env: cronEnv });
    process.exitCode = result.exitCode;
    return true;
  }

  if (normalized[0] === "lark") {
    return runLarkCommand(normalized, env, logger, {
      provisionApp: options.larkProvisionApp,
      inspectApp: options.larkInspectApp,
      service: options.larkServiceDeps,
      send: options.larkSendDeps,
      dashboard: options.dashboardDeps,
    });
  }

  if (normalized[0] === "access") {
    return runAccessCommand(normalized, env, logger);
  }

  if (normalized[0] === "status") {
    return runStatusCommand(normalized, env, logger);
  }

  if (normalized[0] === "service") {
    return runServiceCommand(normalized, env, logger, options.serviceDeps ?? {});
  }

  if (normalized[0] === "session") {
    return runSessionCommand(normalized, env, logger);
  }

  if (normalized[0] === "task") {
    return runTaskCommand(normalized, env, logger);
  }

  if (normalized[0] === "audit") {
    return runAuditCommand(normalized, env, logger);
  }

  if (normalized[0] === "timeline") {
    return runTimelineCommand(normalized, env, logger);
  }

  if (normalized[0] === "instructions") {
    return runInstructionsCommand(normalized, env, logger);
  }

  if (normalized[0] === "yolo") {
    return runYoloCommand(normalized, env, logger);
  }

  if (normalized[0] === "engine") {
    return runEngineCommand(normalized, env, logger);
  }

  if (normalized[0] === "usage") {
    return runUsageCommand(normalized, env, logger);
  }

  if (normalized[0] === "verbosity") {
    return runVerbosityCommand(normalized, env, logger);
  }

  if (normalized[0] === "dashboard") {
    return await runDashboardCommand(normalized.slice(1), env, logger, options.dashboardDeps);
  }

  if (normalized[0] === "logs") {
    return runLogsCommand(normalized, env, logger);
  }

  if (normalized[0] === "instance") {
    return runInstanceCommand(normalized, env, logger, options.serviceDeps ?? {});
  }

  if (normalized[0] === "budget") {
    return runBudgetCommand(normalized, env, logger);
  }

  if (normalized[0] === "locale") {
    return runLocaleCommand(normalized, env, logger);
  }

  if (normalized[0] === "backup") {
    return runBackupCommand(normalized, env, logger);
  }

  if (normalized[0] === "restore") {
    return runRestoreCommand(normalized, env, logger);
  }

  return false;
}
