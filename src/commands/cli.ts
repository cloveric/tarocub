import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, type Dirent } from "node:fs";
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createLarkChannel, type LarkChannelOptions } from "@larksuiteoapi/node-sdk";

import { resolveInstanceName, resolveInstanceStateDir, type EnvSource } from "../config.js";
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
import { resolveApprovalMode } from "../state/approval-mode.js";
import {
  filterTimelineEvents,
  parseTimelineEvents,
  resolveTimelineLogPath,
  type TimelineEvent,
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
import { resolveDefaultLarkStateDir } from "../lark/config.js";
import { LarkGroupModeStore } from "../lark/group-mode-store.js";
import { createLarkServiceRuntime, resolveLarkInstanceName, resolveLarkRuntimeConfig, resolveLarkServiceLockPath, type LarkChannelLike, type LarkRuntimeEnv } from "../lark/service.js";
import { detectLarkCliStatus, ensureLarkCliBridgeBindingConfig, type LarkCliStatus } from "../lark/cli.js";
import { deliverLarkResponse } from "../lark/delivery.js";
import { runLarkWizard } from "../lark/wizard.js";
import { loadCodexUserDefaults, renderCodexEffortSetting, renderCodexModelSetting } from "../codex/user-defaults.js";
import {
  OPTIONAL_LARK_SCOPES,
  REQUIRED_LARK_SCOPES,
  formatLarkPermissionConsoleUrl,
  formatLarkProvisioningResult,
  formatLarkScopeImportJson,
  formatLarkScopeImportNextSteps,
  inspectLarkAppProvisioning,
  provisionLarkApp,
  type LarkProvisioningResult,
} from "../lark/provisioning.js";
import { redactLarkSensitiveText } from "../lark/redaction.js";

const execFile = promisify(execFileCallback);
const LARK_SETUP_TMUX_SESSION_PREFIX = "cctb-lark-setup-";
const LARK_SETUP_LOG_FILENAME = "lark-setup.log";
const ACTIVE_LARK_TURN_STALE_MS = 6 * 60 * 60_000;
const LARK_SERVICE_STOP_GRACE_MS = 5_000;
const LARK_SERVICE_FORCE_STOP_GRACE_MS = 2_000;
const TELEGRAM_CONFIGURE_USAGE = "Usage: telegram configure <bot-token> | telegram configure --instance <name> <bot-token>";
const LARK_SETUP_USAGE = "Usage: lark setup [--detached] [--skip-wizard] [--install-cli] [--identity bot-only|user-default] [--skip-provision] [--skip-auth] [--start-service|--no-start-service]";

export interface CliLogger {
  log: (message: string) => void;
}

export interface LarkRunCommandInput {
  file: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinText?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export type LarkRunCommand = (input: LarkRunCommandInput) => Promise<{ stdout: string; stderr: string }>;

export interface LarkServiceCommandInput {
  env: LarkRuntimeEnv;
  stateDir: string;
  logPath: string;
  entrypoint: string;
  cwd: string;
}

export interface LarkDetachedSetupCommandInput {
  env: LarkRuntimeEnv;
  stateDir: string;
  logPath: string;
  entrypoint: string;
  cwd: string;
  args: string[];
}

export interface LarkServiceCommandDeps {
  start?: (input: LarkServiceCommandInput) => Promise<"started" | "already_running">;
  stop?: (input: LarkServiceCommandInput) => Promise<"stopped" | "not_running">;
  waitUntilRunning?: (input: LarkServiceCommandInput) => Promise<void>;
  readLogs?: (input: { stateDir: string; logPath: string; tail: number }) => Promise<string>;
  findProcessIds?: (input: LarkServiceCommandInput) => Promise<number[]>;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal?: NodeJS.Signals) => void;
  stopGraceMs?: number;
  forceStopGraceMs?: number;
  scheduleDeferredRestart?: (input: LarkServiceCommandInput, options?: { current?: boolean }) => Promise<string>;
  spawnDetached?: (
    command: string,
    args: string[],
    options: { cwd: string; stdoutPath: string; stderrPath: string; env?: NodeJS.ProcessEnv },
  ) => void;
  sleep?: (ms: number) => Promise<void>;
  inspectApp?: CliOptions["larkInspectApp"];
}

interface DashboardCommandEnv extends Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR" | "TAROCUB_INSTANCE" | "CODEX_TELEGRAM_INSTANCE"> {}

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
    "HOME" | "USERPROFILE" | "TAROCUB_INSTANCE" | "CODEX_TELEGRAM_INSTANCE" | "CODEX_TELEGRAM_STATE_DIR" | "TELEGRAM_BOT_TOKEN" | "CODEX_HOME" | "CLAUDE_CONFIG_DIR"
  > & {
    CCTB_SEND_URL?: string;
    CCTB_SEND_TOKEN?: string;
    CCTB_SEND_COMMAND?: string;
    CODEX_THREAD_ID?: string;
    LARK_APP_ID?: string;
    LARK_APP_SECRET?: string;
    LARK_DOMAIN?: string;
    CCTB_LARK_INSTANCE?: string;
    CCTB_LARK_STATE_DIR?: string;
    CCTB_LARK_ACTIVE_TURN?: string;
    CCTB_LARK_ACTIVE_INSTANCE?: string;
    CCTB_LARK_ACTIVE_STATE_DIR?: string;
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
  larkDetectCli?: () => Promise<LarkCliStatus>;
  larkRunCommand?: LarkRunCommand;
  stdinText?: string;
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

function extractOptionalInstanceOption(argv: string[]): { instanceName?: string; args: string[] } {
  let instanceName: string | undefined;
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

function applyLarkInstanceOption(env: LarkRuntimeEnv, instanceName?: string): LarkRuntimeEnv {
  if (!instanceName) {
    return env;
  }
  const { CCTB_LARK_STATE_DIR: _inheritedStateDir, ...rest } = env;
  void _inheritedStateDir;
  return {
    ...rest,
    CCTB_LARK_INSTANCE: instanceName,
    TAROCUB_INSTANCE: instanceName,
  };
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

  throw new Error(TELEGRAM_CONFIGURE_USAGE);
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
    const status = await store.getStatus();
    if (status.policy === "pairing") {
      logger.log(`Note: current policy is pairing; private chats still require \`${commandName} pair <code>\` to authorize the user.`);
    }
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

async function formatLarkStatus(
  env: LarkRuntimeEnv,
  detectCli: () => Promise<LarkCliStatus> = detectLarkCliStatus,
): Promise<string> {
  const stateDir = resolveLarkStateDirForCli(env);
  const operationalLines = await inspectLarkOperationalStatus(stateDir, detectCli);
  const serviceStatus = await describeLarkServiceLock(stateDir);
  const lines = [
    "Lark channel",
    `Instance: ${resolveLarkInstanceName(env)}`,
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

async function inspectLarkOperationalStatus(
  stateDir: string,
  detectCli: () => Promise<LarkCliStatus> = detectLarkCliStatus,
): Promise<string[]> {
  const larkCliStatus = await detectCli().catch((error): LarkCliStatus => ({
    available: false,
    error: error instanceof Error ? error.message : String(error),
  }));
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
      `Lark CLI: ${renderLarkCliStatusForTerminal(larkCliStatus)}`,
      "Allowed Lark groups: unknown",
      "Listen-all Lark groups: unknown",
      "Lark cron jobs: unknown",
    ];
  }

  let cfg: Awaited<ReturnType<typeof loadInstanceConfig>> | undefined;
  let codexDefaults: Awaited<ReturnType<typeof loadCodexUserDefaults>> | undefined;
  let rawConfig: Record<string, unknown> = {};
  let allowedGroups = "unknown";
  try {
    cfg = await loadInstanceConfig(stateDir);
    codexDefaults = cfg.engine === "codex" ? await loadCodexUserDefaults() : undefined;
    rawConfig = await readRawLarkCliConfig(stateDir);
    allowedGroups = String(cfg.groupMode.allowedChatIds.length);
  } catch {
    // Keep status usable even when config state is unreadable.
  }

  let listenAllGroups = "unknown";
  try {
    const storedListenAllGroups = await new LarkGroupModeStore(stateDir).countListenAll();
    listenAllGroups = cfg?.groupMode.enabled === false ? "0" : String(storedListenAllGroups);
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
    `Model: ${cfg ? renderCodexModelSetting(cfg.model, codexDefaults, "en") : "unknown"}`,
    `Effort: ${cfg ? renderCodexEffortSetting(cfg.effort, codexDefaults, "en") : "unknown"}`,
    `Codex Fast Mode: ${cfg ? (cfg.codexServiceTier === "fast" ? "on" : "off") : "unknown"}`,
    `Approval mode: ${cfg ? renderLarkCliApprovalModeStatus(rawConfig.approvalMode) : "unknown"}`,
    `Budget: ${cfg ? (cfg.budgetUsd !== undefined ? `$${cfg.budgetUsd.toFixed(2)}` : "none") : "unknown"}`,
    `Locale: ${cfg?.locale ?? "unknown"}`,
    `Verbosity: ${cfg?.verbosity ?? "unknown"}`,
    `Timezone: ${cfg?.timezone ?? "unknown"}`,
    `Lark CLI: ${renderLarkCliStatusForTerminal(larkCliStatus)}`,
    `Allowed Lark groups: ${allowedGroups}`,
    `Listen-all Lark groups: ${listenAllGroups}`,
    `Lark cron jobs: ${cronJobs}`,
  ];
  if (listenAllGroups !== "0" && listenAllGroups !== "unknown") {
    const cronLineIndex = lines.findIndex((line) => line.startsWith("Lark cron jobs:"));
    lines.splice(cronLineIndex === -1 ? lines.length : cronLineIndex, 0, "Group-all platform scopes: require im:message and im:message.group_msg; run `lark doctor` if ordinary group messages do not arrive.");
  }
  return lines;
}

function renderLarkCliStatusForTerminal(status: LarkCliStatus): string {
  if (status.available) {
    return status.version ? `available (${status.version})` : "available";
  }
  return status.error ? `unavailable (${truncateCliStatusDetail(status.error)})` : "unavailable";
}

function truncateCliStatusDetail(detail: string): string {
  const normalized = detail.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
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
  const resolved = resolveApprovalMode(mode);
  if (resolved === "bypass") {
    return "YOLO unsafe/bypass";
  }
  if (resolved === "full-auto") {
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
      ["docs", "--api-version", "v2", "+create", "--help"],
      { timeout: 3_000, maxBuffer: 1024 * 1024 },
    );
    const help = `${stdout}\n${stderr}`;
    if (help.includes("--content") && help.includes("--doc-format")) {
      return "ok lark-cli docs +create: v2 XML/Markdown create flags available (requires lark-cli >= 1.0.41)";
    }
    return "warn lark-cli docs +create: installed CLI help did not expose v2 --content/--doc-format; upgrade lark-cli to >= 1.0.41";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `warn lark-cli docs +create: ${detail}; upgrade lark-cli to >= 1.0.41 if this machine has an older CLI`;
  }
}

async function runLarkCommandProcess(input: LarkRunCommandInput): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxBuffer = input.maxBuffer ?? 10 * 1024 * 1024;
  return await new Promise((resolve, reject) => {
    const child = spawn(input.file, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    };
    // Escalate to SIGKILL if a wedged child ignores SIGTERM, so it can't linger
    // as an orphan after we've already rejected the parent promise.
    const terminateChild = () => {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // child already gone
        }
      }, 2_000).unref?.();
    };
    const timer = setTimeout(() => {
      terminateChild();
      finish(new Error(`${input.file} ${input.args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
      } else {
        stderr += chunk.toString("utf8");
      }
      if (stdout.length + stderr.length > maxBuffer) {
        terminateChild();
        finish(new Error(`${input.file} ${input.args.join(" ")} exceeded output limit`));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = redactLarkSensitiveText(`${stderr}\n${stdout}`.trim());
      finish(new Error(`${input.file} ${input.args.join(" ")} failed${signal ? ` (${signal})` : ""}${detail ? `: ${detail}` : ""}`));
    });
    if (input.stdinText !== undefined) {
      child.stdin.end(input.stdinText);
    } else {
      child.stdin.end();
    }
  });
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
      checks.push(...formatLarkProvisioningForDoctor(provisioning, env));
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

function formatLarkProvisioningForDoctor(result: LarkProvisioningResult, env: LarkRuntimeEnv): string[] {
  return formatLarkProvisioningResult(result, {
    ...(env.LARK_APP_ID ? { appId: env.LARK_APP_ID } : {}),
    ...(env.LARK_DOMAIN ? { domain: env.LARK_DOMAIN } : {}),
  }).map((line) => {
    const severity = isOkLarkProvisioningLine(line) ? "ok" : line.startsWith("Optional — ") ? "info" : "warn";
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
  return redactLarkSensitiveText(detail);
}

async function runLarkSecretsCommand(
  args: string[],
  env: LarkRuntimeEnv,
  logger: CliLogger,
  stdinText?: string,
): Promise<boolean> {
  const action = args[0] ?? "";
  if (action === "get") {
    if (args.length !== 1) {
      throw new Error("Usage: lark secrets get");
    }
    const loadedEnv = await loadLarkRuntimeEnv(env);
    logger.log(formatLarkSecretProviderResponse(loadedEnv, parseLarkSecretProviderRequest(stdinText ?? await readCliStdin())));
    return true;
  }
  if (action === "list") {
    if (args.length !== 1) {
      throw new Error("Usage: lark secrets list");
    }
    const loadedEnv = await loadLarkRuntimeEnv(env);
    logger.log(loadedEnv.LARK_APP_ID ? `app-${loadedEnv.LARK_APP_ID}` : "No Lark app secret is configured.");
    return true;
  }
  throw new Error("Usage: lark secrets <get|list>");
}

function parseLarkSecretProviderRequest(input: string): { ids: string[] } {
  if (!input.trim()) {
    return { ids: [] };
  }
  const parsed = JSON.parse(input) as { ids?: unknown };
  return {
    ids: Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === "string") : [],
  };
}

function formatLarkSecretProviderResponse(env: LarkRuntimeEnv, request: { ids: string[] }): string {
  const values: Record<string, string> = {};
  const errors: Record<string, { message: string }> = {};
  const secretId = env.LARK_APP_ID ? `app-${env.LARK_APP_ID}` : undefined;
  for (const id of request.ids) {
    if (secretId && id === secretId && env.LARK_APP_SECRET) {
      values[id] = env.LARK_APP_SECRET;
    } else {
      errors[id] = { message: "not found" };
    }
  }
  return JSON.stringify({
    protocolVersion: 1,
    values,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  });
}

async function readCliStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  return await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function runLarkCliBridgeCommand(
  args: string[],
  env: LarkRuntimeEnv,
  logger: CliLogger,
  runCommand: LarkRunCommand,
): Promise<boolean> {
  const action = args[0] ?? "";
  if (action === "init") {
    if (args.length !== 1) {
      throw new Error("Usage: lark cli init");
    }
    const loadedEnv = await loadLarkRuntimeEnv(env);
    if (!loadedEnv.LARK_APP_ID) {
      throw new Error("LARK_APP_ID is required");
    }
    if (!loadedEnv.LARK_APP_SECRET) {
      throw new Error("LARK_APP_SECRET is required");
    }
    const brand = loadedEnv.LARK_DOMAIN === "lark" ? "lark" : "feishu";
    await runCommand({
      file: "lark-cli",
      args: ["config", "init", "--app-id", loadedEnv.LARK_APP_ID, "--app-secret-stdin", "--brand", brand],
      stdinText: `${loadedEnv.LARK_APP_SECRET}\n`,
      timeoutMs: 30_000,
    });
    logger.log("lark-cli config initialized from bridge credentials.");
    return true;
  }
  if (action === "bind") {
    const { identity, force } = parseLarkCliBindArgs(args.slice(1));
    await bindLarkCliBridgeIdentity(env, runCommand, {
      identity,
      force,
    });
    logger.log(`lark-cli bound to bridge credentials with ${identity} identity.`);
    return true;
  }
  if (action === "preflight") {
    const { install, identity } = parseLarkCliPreflightArgs(args.slice(1));
    await ensureLarkCliAvailable({ install, logger, runCommand });
    await configureLarkCliIdentity(env, runCommand, { identity });
    logger.log([
      "lark-cli preflight complete.",
      `identity: ${identity}`,
      "source: lark-channel",
      "Secrets: served through bridge exec-provider; app secret is not passed in argv/env.",
    ].join("\n"));
    return true;
  }
  if (action === "identity") {
    const identityAction = parseLarkCliIdentityCommandArgs(args.slice(1));
    if (identityAction === "status") {
      const context = await prepareLarkCliBridgeContext(env);
      const defaultAs = await runCommand({
        file: "lark-cli",
        args: ["config", "default-as"],
        env: context.childEnv,
        timeoutMs: 30_000,
      });
      const strictMode = await runCommand({
        file: "lark-cli",
        args: ["config", "strict-mode"],
        env: context.childEnv,
        timeoutMs: 30_000,
      });
      logger.log(redactLarkSensitiveText([
        "lark-cli identity status:",
        `default-as: ${formatCommandOutput(defaultAs)}`,
        `strict-mode: ${formatCommandOutput(strictMode)}`,
      ].join("\n")));
      return true;
    }
    await configureLarkCliIdentity(env, runCommand, { identity: identityAction });
    logger.log(`lark-cli identity set to ${identityAction}.`);
    return true;
  }
  throw new Error("Usage: lark cli <init|bind|preflight|identity>");
}

type LarkCliBridgeIdentity = "bot-only" | "user-default";

function parseLarkCliBindArgs(args: string[]): { identity: LarkCliBridgeIdentity; force: boolean } {
  let identity: LarkCliBridgeIdentity = "bot-only";
  let force = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--identity") {
      const value = parseLarkCliIdentityValue(args[++index]);
      if (!value) {
        throw new Error("Usage: lark cli bind [--identity bot-only|user-default] [--force]");
      }
      identity = value;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    throw new Error("Usage: lark cli bind [--identity bot-only|user-default] [--force]");
  }
  return { identity, force };
}

function parseLarkCliPreflightArgs(args: string[]): { install: boolean; identity: LarkCliBridgeIdentity } {
  let install = false;
  let identity: LarkCliBridgeIdentity = "bot-only";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--install") {
      install = true;
      continue;
    }
    if (arg === "--identity") {
      const value = parseLarkCliIdentityValue(args[++index]);
      if (!value) {
        throw new Error("Usage: lark cli preflight [--install] [--identity bot-only|user-default]");
      }
      identity = value;
      continue;
    }
    throw new Error("Usage: lark cli preflight [--install] [--identity bot-only|user-default]");
  }
  return { install, identity };
}

function parseLarkCliIdentityCommandArgs(args: string[]): LarkCliBridgeIdentity | "status" {
  if (args.length !== 1) {
    throw new Error("Usage: lark cli identity <status|bot-only|user-default>");
  }
  if (args[0] === "status") {
    return "status";
  }
  const identity = parseLarkCliIdentityValue(args[0]);
  if (!identity) {
    throw new Error("Usage: lark cli identity <status|bot-only|user-default>");
  }
  return identity;
}

function parseLarkCliIdentityValue(value: string | undefined): LarkCliBridgeIdentity | null {
  return value === "bot-only" || value === "user-default" ? value : null;
}

async function ensureLarkCliAvailable(input: {
  install: boolean;
  logger: CliLogger;
  runCommand: LarkRunCommand;
}): Promise<void> {
  try {
    await input.runCommand({
      file: "lark-cli",
      args: ["--version"],
      timeoutMs: 10_000,
    });
    return;
  } catch (error) {
    if (!input.install) {
      throw new Error([
        "lark-cli is not available.",
        "Install it with: npm install -g @larksuite/cli",
        `Details: ${renderCommandError(error)}`,
      ].join("\n"));
    }
  }

  input.logger.log("lark-cli not found; installing @larksuite/cli globally...");
  await input.runCommand({
    file: "npm",
    args: ["install", "-g", "@larksuite/cli"],
    timeoutMs: 120_000,
  });
}

async function configureLarkCliIdentity(
  env: LarkRuntimeEnv,
  runCommand: LarkRunCommand,
  input: { identity: LarkCliBridgeIdentity },
): Promise<void> {
  const context = await bindLarkCliBridgeIdentity(env, runCommand, {
    identity: input.identity,
    force: false,
  });
  await runCommand({
    file: "lark-cli",
    args: ["config", "default-as", input.identity === "user-default" ? "user" : "bot"],
    env: context.childEnv,
    timeoutMs: 30_000,
  });
  await runCommand({
    file: "lark-cli",
    args: ["config", "strict-mode", input.identity === "user-default" ? "off" : "bot"],
    env: context.childEnv,
    timeoutMs: 30_000,
  });
}

async function bindLarkCliBridgeIdentity(
  env: LarkRuntimeEnv,
  runCommand: LarkRunCommand,
  input: { identity: LarkCliBridgeIdentity; force: boolean },
): Promise<{ childEnv: NodeJS.ProcessEnv }> {
  const context = await prepareLarkCliBridgeContext(env);
  await runCommand({
    file: "lark-cli",
    args: [
      "config",
      "bind",
      "--source",
      "lark-channel",
      "--app-id",
      context.appId,
      "--identity",
      input.identity,
      ...(input.force ? ["--force"] : []),
    ],
    env: context.childEnv,
    timeoutMs: 30_000,
  });
  return { childEnv: context.childEnv };
}

async function prepareLarkCliBridgeContext(env: LarkRuntimeEnv): Promise<{
  appId: string;
  childEnv: NodeJS.ProcessEnv;
}> {
  const loadedEnv = await loadLarkRuntimeEnv(env);
  if (!loadedEnv.LARK_APP_ID) {
    throw new Error("LARK_APP_ID is required");
  }
  const stateDir = resolveLarkStateDir(loadedEnv);
  const brand = loadedEnv.LARK_DOMAIN === "lark" ? "lark" : "feishu";
  await ensureLarkCliBridgeBindingConfig({
    appId: loadedEnv.LARK_APP_ID,
    stateDir,
    brand,
    homeDir: loadedEnv.HOME ?? loadedEnv.USERPROFILE,
    entrypoint: resolveCliEntrypoint(),
  });
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(loadedEnv.HOME ? { HOME: loadedEnv.HOME } : {}),
    ...(loadedEnv.USERPROFILE ? { USERPROFILE: loadedEnv.USERPROFILE } : {}),
    CCTB_LARK_STATE_DIR: stateDir,
    LARK_CHANNEL: "1",
  };
  delete childEnv.LARK_APP_SECRET;
  return {
    appId: loadedEnv.LARK_APP_ID,
    childEnv,
  };
}

function formatCommandOutput(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim() || "(empty)";
}

function renderCommandError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function runLarkAuthCommand(
  args: string[],
  env: LarkRuntimeEnv,
  logger: CliLogger,
  runCommand: LarkRunCommand,
): Promise<boolean> {
  const action = args[0] ?? "";
  const context = await prepareLarkCliBridgeContext(env);
  if (action === "start") {
    const result = await runCommand({
      file: "lark-cli",
      args: ["auth", "login", "--no-wait", "--json", ...normalizeLarkAuthStartArgs(args.slice(1))],
      env: context.childEnv,
      timeoutMs: 30_000,
    });
    logger.log(formatLarkOAuthStartResult(result.stdout));
    return true;
  }
  if (action === "finish") {
    if (args.length !== 2 || args[1]?.startsWith("-")) {
      throw new Error("Usage: lark auth finish <device-code>");
    }
    await runCommand({
      file: "lark-cli",
      args: ["auth", "login", "--device-code", args[1]],
      env: context.childEnv,
      timeoutMs: 11 * 60 * 1000,
    });
    logger.log("Lark OAuth finished.");
    return true;
  }
  if (action === "status") {
    if (args.length > 2 || (args[1] && args[1] !== "--verify")) {
      throw new Error("Usage: lark auth status [--verify]");
    }
    const result = await runCommand({
      file: "lark-cli",
      args: ["auth", "status", ...(args[1] === "--verify" ? ["--verify"] : [])],
      env: context.childEnv,
      timeoutMs: 30_000,
    });
    logger.log(redactLarkSensitiveText(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim()));
    return true;
  }
  throw new Error("Usage: lark auth <start|finish|status>");
}

function normalizeLarkAuthStartArgs(args: string[]): string[] {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--recommend") {
      normalized.push(arg);
      continue;
    }
    if (arg === "--domain" || arg === "--scope" || arg === "--exclude") {
      const value = args[++index];
      if (!value) {
        throw new Error("Usage: lark auth start [--recommend] [--domain <domains>] [--scope <scopes>] [--exclude <scopes>]");
      }
      normalized.push(arg, value);
      continue;
    }
    if (arg.startsWith("--domain=") || arg.startsWith("--scope=") || arg.startsWith("--exclude=")) {
      normalized.push(arg);
      continue;
    }
    throw new Error("Usage: lark auth start [--recommend] [--domain <domains>] [--scope <scopes>] [--exclude <scopes>]");
  }
  return normalized;
}

function formatLarkOAuthStartResult(stdout: string): string {
  const parsed = parseJsonFromPossiblyDecoratedOutput(stdout) as {
    verification_url?: string;
    verification_uri?: string;
    device_code?: string;
    user_code?: string;
    expires_in?: number;
  };
  const verificationUrl = parsed.verification_url ?? parsed.verification_uri;
  if (!verificationUrl || !parsed.device_code) {
    throw new Error("lark-cli auth login --no-wait did not return verification_url and device_code");
  }
  return [
    "Lark OAuth started.",
    "Open this URL in a private chat/device flow:",
    verificationUrl,
    ...(parsed.user_code ? [`User code: ${parsed.user_code}`] : []),
    `Device code: ${parsed.device_code}`,
    ...(typeof parsed.expires_in === "number" ? [`Expires in: ${parsed.expires_in}s`] : []),
    `Finish: node dist/src/index.js lark auth finish ${parsed.device_code}`,
    "(approve in the browser first; `auth finish` then waits for your approval, up to ~11 min.)",
  ].join("\n");
}

function parseJsonFromPossiblyDecoratedOutput(output: string): unknown {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // lark-cli may wrap the JSON in a leading banner and/or a trailing `_notice`
    // line. Extract the first balanced {...} block instead of slicing to the end,
    // which would re-include a trailing notice and fail to parse.
    const block = extractFirstJsonObject(trimmed);
    if (block) {
      return JSON.parse(block) as unknown;
    }
  }
  throw new Error("Expected JSON output from lark-cli");
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await execFile("tmux", ["has-session", "-t", sessionName], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

function buildLarkSetupTmuxSessionName(stateDir: string): string {
  const digest = createHash("sha256").update(path.resolve(stateDir)).digest("hex").slice(0, 12);
  return `${LARK_SETUP_TMUX_SESSION_PREFIX}${digest}`;
}

async function defaultKillTmuxSession(sessionName: string): Promise<boolean> {
  try {
    await execFile("tmux", ["kill-session", "-t", sessionName], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function resolveLarkSetupLogPath(stateDir: string): string {
  return path.join(stateDir, LARK_SETUP_LOG_FILENAME);
}

export function buildDetachedLarkSetupCommand(input: LarkDetachedSetupCommandInput): string {
  const args = input.args.filter((arg) => arg !== "--detached");
  const instanceName = resolveLarkInstanceName(input.env);
  return [
    "cd",
    shellQuote(input.cwd),
    "&&",
    "env",
    "-u",
    "LARK_APP_ID",
    "-u",
    "LARK_APP_SECRET",
    "-u",
    "LARK_DOMAIN",
    `CCTB_LARK_STATE_DIR=${shellQuote(input.stateDir)}`,
    `CCTB_LARK_INSTANCE=${shellQuote(instanceName)}`,
    `TAROCUB_INSTANCE=${shellQuote(instanceName)}`,
    shellQuote(process.execPath),
    shellQuote(input.entrypoint),
    "lark",
    "setup",
    ...args.map(shellQuote),
    ">",
    shellQuote(input.logPath),
    "2>&1",
  ].join(" ");
}

async function startDetachedLarkSetup(input: LarkDetachedSetupCommandInput): Promise<{ sessionName: string }> {
  await mkdir(input.stateDir, { recursive: true });
  await rm(input.logPath, { force: true });
  const sessionName = buildLarkSetupTmuxSessionName(input.stateDir);
  if (await tmuxSessionExists(sessionName)) {
    await defaultKillTmuxSession(sessionName);
  }
  const command = buildDetachedLarkSetupCommand(input);
  try {
    await execFile("tmux", ["new-session", "-d", "-s", sessionName, command], { timeout: 5_000 });
  } catch (error) {
    throw new Error(`Detached Lark setup requires tmux. Start the foreground setup instead or install tmux first. ${error instanceof Error ? error.message : String(error)}`);
  }
  return { sessionName };
}

function extractDetachedLarkSetupUrl(logText: string): string | undefined {
  const match = logText.match(/Open directly:\s*(https?:\/\/\S+)/);
  return match?.[1];
}

async function waitForDetachedLarkSetupUrl(logPath: string): Promise<string | undefined> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const logText = await readFile(logPath, "utf8");
      const url = extractDetachedLarkSetupUrl(logText);
      if (url) {
        return url;
      }
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
        throw error;
      }
    }
    await sleep(200);
  }
  return undefined;
}

function withoutDirectLarkAppCredentials(env: LarkRuntimeEnv): LarkRuntimeEnv {
  const {
    LARK_APP_ID: _appId,
    LARK_APP_SECRET: _appSecret,
    LARK_DOMAIN: _domain,
    ...rest
  } = env;
  void _appId;
  void _appSecret;
  void _domain;
  return rest;
}

function clearDirectLarkAppCredentials(env: NodeJS.ProcessEnv): void {
  delete env.LARK_APP_ID;
  delete env.LARK_APP_SECRET;
  delete env.LARK_DOMAIN;
}

export function resolveLarkCommandTargetEnv(env: LarkRuntimeEnv): LarkRuntimeEnv {
  const explicitInstance = env.CCTB_LARK_INSTANCE ?? env.TAROCUB_INSTANCE;
  if (!explicitInstance || !env.CCTB_LARK_STATE_DIR) {
    return env;
  }
  const instanceName = resolveLarkInstanceName({
    CCTB_LARK_INSTANCE: explicitInstance,
  });
  const resolvedStateDir = path.resolve(env.CCTB_LARK_STATE_DIR);
  const stateDirBasename = path.basename(resolvedStateDir);
  if (stateDirBasename === instanceName) {
    return env;
  }
  const inheritedLooksLikeDefaultInstanceDir = path.resolve(resolveDefaultLarkStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CCTB_LARK_INSTANCE: stateDirBasename,
  })) === resolvedStateDir;
  if (!inheritedLooksLikeDefaultInstanceDir) {
    return env;
  }

  const {
    CCTB_LARK_STATE_DIR: _staleLarkStateDir,
    CODEX_TELEGRAM_STATE_DIR: _staleBridgeStateDir,
    ...rest
  } = env;
  void _staleLarkStateDir;
  void _staleBridgeStateDir;
  return rest;
}

export const resolveLarkSetupTargetEnv = resolveLarkCommandTargetEnv;

async function defaultStartLarkService(
  input: LarkServiceCommandInput,
  deps: Pick<LarkServiceCommandDeps, "spawnDetached"> = {},
): Promise<"started" | "already_running"> {
  await mkdir(input.stateDir, { recursive: true });
  if ((await describeLarkServiceLock(input.stateDir)).startsWith("running ")) {
    return "already_running";
  }

  const instanceName = resolveLarkInstanceName(input.env);
  const serviceEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CCTB_LARK_STATE_DIR: input.stateDir,
    CCTB_LARK_INSTANCE: instanceName,
    TAROCUB_INSTANCE: instanceName,
  };
  clearDirectLarkAppCredentials(serviceEnv);
  delete serviceEnv.CCTB_SEND_URL;
  delete serviceEnv.CCTB_SEND_TOKEN;
  delete serviceEnv.CCTB_SEND_COMMAND;
  delete serviceEnv.CODEX_THREAD_ID;
  clearLarkActiveTurnEnv(serviceEnv);

  (deps.spawnDetached ?? defaultSpawnDetached)(process.execPath, [input.entrypoint, "lark", "run", "--instance", instanceName], {
    cwd: input.cwd,
    stdoutPath: input.logPath,
    stderrPath: input.logPath,
    env: serviceEnv,
  });
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
  if (!normalized.includes(input.entrypoint)) {
    return false;
  }
  const instanceName = resolveLarkInstanceName(input.env);
  return normalized.includes(input.stateDir) ||
    normalized.includes(`CCTB_LARK_INSTANCE=${instanceName}`) ||
    normalized.includes(`CCTB_LARK_INSTANCE='${instanceName}'`) ||
    normalized.includes(`CCTB_LARK_INSTANCE="${instanceName}"`) ||
    normalized.includes(`TAROCUB_INSTANCE=${instanceName}`) ||
    normalized.includes(`TAROCUB_INSTANCE='${instanceName}'`) ||
    normalized.includes(`TAROCUB_INSTANCE="${instanceName}"`) ||
    new RegExp(`(?:^|\\s)--instance(?:=|\\s+)${escapeRegExp(instanceName)}(?:\\s|$)`).test(normalized);
}

function defaultKillLarkProcess(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH") {
      return;
    }
    throw error;
  }
}

async function defaultStopLarkService(
  input: LarkServiceCommandInput,
  deps: Pick<LarkServiceCommandDeps, "findProcessIds" | "isProcessAlive" | "killProcess" | "sleep" | "stopGraceMs" | "forceStopGraceMs"> = {},
): Promise<"stopped" | "not_running"> {
  let stopped = false;
  const findProcessIds = deps.findProcessIds ?? defaultFindLarkServiceProcessIds;
  const isAlive = deps.isProcessAlive ?? isProcessAlive;
  const killProcess = deps.killProcess ?? defaultKillLarkProcess;
  const sleepProcess = deps.sleep ?? sleep;
  const stopGraceMs = deps.stopGraceMs ?? LARK_SERVICE_STOP_GRACE_MS;
  const forceStopGraceMs = deps.forceStopGraceMs ?? LARK_SERVICE_FORCE_STOP_GRACE_MS;

  const pidsToStop = new Set<number>();
  const pid = await readLarkLockPid(input.stateDir);
  const lockPidAlive = pid !== null && isAlive(pid);
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
  const deadline = Date.now() + stopGraceMs;
  while (Date.now() < deadline && [...pidsToStop].some((processId) => isAlive(processId))) {
    await sleepProcess(100);
  }

  const lingeringProcessIds = [...pidsToStop].filter((processId) => isAlive(processId));
  for (const processId of lingeringProcessIds) {
    killProcess(processId, "SIGKILL");
  }
  const forceDeadline = Date.now() + forceStopGraceMs;
  while (Date.now() < forceDeadline && lingeringProcessIds.some((processId) => isAlive(processId))) {
    await sleepProcess(100);
  }
  const stillAliveProcessIds = lingeringProcessIds.filter((processId) => isAlive(processId));
  if (stillAliveProcessIds.length > 0) {
    throw new Error(`Lark service process(es) did not exit: ${stillAliveProcessIds.join(", ")}`);
  }

  if (pid !== null && !isAlive(pid)) {
    await rm(resolveLarkServiceLockPath(input.stateDir), { force: true });
  }

  return stopped ? "stopped" : "not_running";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_LARK_DEFERRED_RESTART_DELAY_MS = 5_000;
const DEFERRED_LARK_RESTART_HELPER_SCRIPT = `
const { spawnSync } = require("node:child_process");

const entrypoint = process.argv[1];
const stateDir = process.argv[2];
const instanceName = process.argv[3];
const delayMs = Number.parseInt(process.argv[4] ?? "5000", 10);
const retryDelayMs = 30_000;
const maxWaitMs = 2 * 60 * 60 * 1000;
const deadline = Date.now() + maxWaitMs;

function runRestart() {
  const env = { ...process.env };
  env.CCTB_LARK_STATE_DIR = stateDir;
  env.CCTB_LARK_INSTANCE = instanceName;
  env.TAROCUB_INSTANCE = instanceName;
  delete env.CCTB_SEND_URL;
  delete env.CCTB_SEND_TOKEN;
  delete env.CCTB_SEND_COMMAND;
  delete env.CODEX_THREAD_ID;
  delete env.CCTB_LARK_ACTIVE_TURN;
  delete env.CCTB_LARK_ACTIVE_INSTANCE;
  delete env.CCTB_LARK_ACTIVE_STATE_DIR;
  delete env.LARK_APP_ID;
  delete env.LARK_APP_SECRET;
  delete env.LARK_DOMAIN;

  const result = spawnSync(process.execPath, [entrypoint, "lark", "service", "restart"], {
    env,
    encoding: "utf8",
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if ((result.status ?? 1) === 0) {
    process.exit(0);
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join("\\n");
  const queueBusy = /active or queued Lark turn\\(s\\)|Refusing to restart without --force/.test(output);
  if (queueBusy && Date.now() + retryDelayMs <= deadline) {
    process.stderr.write(
      \`Deferred Lark restart for "\${instanceName}" is waiting for the turn queue to drain; retrying in \${Math.ceil(retryDelayMs / 1000)}s.\\n\`,
    );
    setTimeout(runRestart, retryDelayMs);
    return;
  }

  process.exit(result.status ?? 1);
}

setTimeout(runRestart, Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 5000);
`;

function defaultSpawnDetached(
  command: string,
  args: string[],
  options: { cwd: string; stdoutPath: string; stderrPath: string; env?: NodeJS.ProcessEnv },
): void {
  const stdoutFd = openSync(options.stdoutPath, "a");
  const stderrFd = options.stderrPath === options.stdoutPath ? stdoutFd : openSync(options.stderrPath, "a");
  try {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: true,
      env: options.env ?? process.env,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    child.unref();
  } finally {
    closeSync(stdoutFd);
    if (stderrFd !== stdoutFd) {
      closeSync(stderrFd);
    }
  }
}

async function defaultScheduleDeferredLarkServiceRestart(
  input: LarkServiceCommandInput,
  deps: Pick<LarkServiceCommandDeps, "spawnDetached"> = {},
  options: { current?: boolean; delayMs?: number } = {},
): Promise<string> {
  await mkdir(input.stateDir, { recursive: true });
  const instanceName = resolveLarkInstanceName(input.env);
  const delayMs = Math.max(1, Math.trunc(options.delayMs ?? DEFAULT_LARK_DEFERRED_RESTART_DELAY_MS));
  const logPath = path.join(input.stateDir, "deferred-restart.log");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CCTB_LARK_STATE_DIR: input.stateDir,
    CCTB_LARK_INSTANCE: instanceName,
    TAROCUB_INSTANCE: instanceName,
  };
  clearDirectLarkAppCredentials(env);
  delete env.CCTB_SEND_URL;
  delete env.CCTB_SEND_TOKEN;
  delete env.CCTB_SEND_COMMAND;
  delete env.CODEX_THREAD_ID;
  clearLarkActiveTurnEnv(env);

  (deps.spawnDetached ?? defaultSpawnDetached)(process.execPath, [
    "-e",
    DEFERRED_LARK_RESTART_HELPER_SCRIPT,
    input.entrypoint,
    input.stateDir,
    instanceName,
    String(delayMs),
  ], {
    cwd: input.cwd,
    stdoutPath: logPath,
    stderrPath: logPath,
    env,
  });

  const target = options.current ? "current Lark instance" : "Lark instance";
  return `Scheduled deferred restart for ${target} "${instanceName}" in ${Math.ceil(delayMs / 1000)}s; it will retry until the Lark turn queue is idle.`;
}

function getLarkTimelineMessageId(event: TimelineEvent): string | undefined {
  const metadata = event.metadata;
  const value = metadata?.larkMessageId ?? metadata?.messageId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function removePendingLarkTimelineEvent(
  pendingByConversationKey: Map<string, TimelineEvent[]>,
  conversationKey: string,
  messageId: string,
): void {
  const pending = pendingByConversationKey.get(conversationKey);
  if (!pending) {
    return;
  }

  const index = pending.findIndex((event) => getLarkTimelineMessageId(event) === messageId);
  if (index >= 0) {
    pending.splice(index, 1);
  }
  if (pending.length === 0) {
    pendingByConversationKey.delete(conversationKey);
  }
}

async function readLarkPendingTurnActivity(stateDir: string): Promise<{
  activeTurnCount: number;
  oldestAcceptedAt?: string;
}> {
  let raw: string;
  try {
    raw = await readFile(resolveTimelineLogPath(stateDir), "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { activeTurnCount: 0 };
    }
    throw error;
  }

  const pendingByConversationKey = new Map<string, TimelineEvent[]>();
  for (const event of parseTimelineEvents(raw)) {
    if (event.channel !== "lark") {
      continue;
    }

    const conversationKey = event.conversationKey ?? "";
    if (event.type === "input.received") {
      const pending = pendingByConversationKey.get(conversationKey) ?? [];
      pending.push(event);
      pendingByConversationKey.set(conversationKey, pending);
      continue;
    }

    if (event.type !== "turn.completed" && event.type !== "command.handled") {
      continue;
    }

    const messageId = getLarkTimelineMessageId(event);
    if (messageId) {
      removePendingLarkTimelineEvent(pendingByConversationKey, conversationKey, messageId);
      continue;
    }

    const pending = pendingByConversationKey.get(conversationKey);
    pending?.shift();
    if (pending && pending.length === 0) {
      pendingByConversationKey.delete(conversationKey);
    }
  }

  const freshPending = [...pendingByConversationKey.values()]
    .flat()
    .filter((event) => {
      const timestampMs = event.timestamp ? new Date(event.timestamp).getTime() : Number.NaN;
      return !Number.isFinite(timestampMs) || Date.now() - timestampMs <= ACTIVE_LARK_TURN_STALE_MS;
    });

  const oldestAcceptedAt = freshPending
    .map((event) => event.timestamp)
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort()[0];

  return {
    activeTurnCount: freshPending.length,
    ...(oldestAcceptedAt ? { oldestAcceptedAt } : {}),
  };
}

async function assertNoActiveLarkTurnsBeforeServiceAction(
  stateDir: string,
  instanceName: string,
  action: "restart" | "stop",
): Promise<void> {
  const activity = await readLarkPendingTurnActivity(stateDir);
  if (activity.activeTurnCount <= 0) {
    return;
  }

  const acceptedAt = activity.oldestAcceptedAt ? ` Oldest accepted at ${activity.oldestAcceptedAt}.` : "";
  throw new Error(
    `Lark instance "${instanceName}" has ${activity.activeTurnCount} active or queued Lark turn(s).` +
      `${acceptedAt} Refusing to ${action} without --force.`,
  );
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

interface LarkServiceTarget {
  instanceName: string;
  stateDir: string;
}

async function listConfiguredLarkServiceTargets(env: LarkRuntimeEnv): Promise<LarkServiceTarget[]> {
  const homeDir = env.HOME ?? env.USERPROFILE;
  if (!homeDir) {
    return [];
  }
  const channelsDir = path.join(homeDir, ".cctb");
  let dirents: Dirent[];
  try {
    dirents = await readdir(channelsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const targets: LarkServiceTarget[] = [];
  for (const entry of dirents) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const stateDir = path.join(channelsDir, entry.name);
    try {
      await readFile(path.join(stateDir, "lark.env"), "utf8");
    } catch {
      continue;
    }
    targets.push({
      instanceName: normalizeInstanceName(entry.name),
      stateDir,
    });
  }
  return targets.sort((left, right) => left.instanceName.localeCompare(right.instanceName));
}

async function loadLarkServiceTargetEnv(baseEnv: LarkRuntimeEnv, target: LarkServiceTarget): Promise<LarkRuntimeEnv> {
  const targetBaseEnv = withoutDirectLarkAppCredentials(baseEnv);
  const {
    CODEX_TELEGRAM_STATE_DIR: _telegramStateDir,
    ...rest
  } = targetBaseEnv;
  void _telegramStateDir;
  return await loadLarkRuntimeEnv({
    ...rest,
    CCTB_LARK_INSTANCE: target.instanceName,
    TAROCUB_INSTANCE: target.instanceName,
    CCTB_LARK_STATE_DIR: target.stateDir,
  });
}

function buildLarkServiceCommandInput(env: LarkRuntimeEnv): LarkServiceCommandInput {
  const stateDir = resolveLarkStateDir(env);
  return {
    env,
    stateDir,
    logPath: resolveLarkServiceLogPath(stateDir),
    entrypoint: resolveCliEntrypoint(),
    cwd: process.cwd(),
  };
}

function isCurrentActiveLarkTurnTarget(env: LarkRuntimeEnv, targetEnv: LarkRuntimeEnv, targetStateDir: string): boolean {
  if (env.CCTB_LARK_ACTIVE_TURN !== "1") {
    return false;
  }
  const activeStateDir = env.CCTB_LARK_ACTIVE_STATE_DIR?.trim();
  if (activeStateDir && path.resolve(activeStateDir) === path.resolve(targetStateDir)) {
    return true;
  }
  const activeInstance = env.CCTB_LARK_ACTIVE_INSTANCE?.trim();
  return Boolean(activeInstance) && normalizeInstanceName(activeInstance) === resolveLarkInstanceName(targetEnv);
}

function clearLarkActiveTurnEnv(env: NodeJS.ProcessEnv): void {
  delete env.CCTB_LARK_ACTIVE_TURN;
  delete env.CCTB_LARK_ACTIVE_INSTANCE;
  delete env.CCTB_LARK_ACTIVE_STATE_DIR;
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
  const { enabled: all, args: argsWithoutAll } = extractBooleanFlag(args.slice(1), "--all");

  if (subcommand === "status") {
    if (all) {
      if (argsWithoutAll.length !== 0) {
        throw new Error("Usage: lark service status [--all]");
      }
      const targets = await listConfiguredLarkServiceTargets(loadedEnv);
      if (targets.length === 0) {
        logger.log("No Lark instances found.");
        return true;
      }
      for (const target of targets) {
        logger.log(await formatLarkStatus(await loadLarkServiceTargetEnv(loadedEnv, target)));
      }
      return true;
    }
    if (args.length !== 1) {
      throw new Error("Usage: lark service status [--all]");
    }
    logger.log(await formatLarkStatus(loadedEnv));
    return true;
  }

  if (subcommand === "doctor") {
    if (all) {
      if (argsWithoutAll.length !== 0) {
        throw new Error("Usage: lark service doctor [--all]");
      }
      const targets = await listConfiguredLarkServiceTargets(loadedEnv);
      if (targets.length === 0) {
        logger.log("No Lark instances found.");
        return true;
      }
      for (const target of targets) {
        logger.log(await formatLarkDoctor(await loadLarkServiceTargetEnv(loadedEnv, target), deps.inspectApp ?? inspectLarkAppProvisioning));
      }
      return true;
    }
    if (args.length !== 1) {
      throw new Error("Usage: lark service doctor [--all]");
    }
    logger.log(await formatLarkDoctor(loadedEnv, deps.inspectApp ?? inspectLarkAppProvisioning));
    return true;
  }

  const commandInput = buildLarkServiceCommandInput(loadedEnv);
  const stateDir = commandInput.stateDir;

  if (subcommand === "logs") {
    if (all) {
      throw new Error("Usage: lark service logs [tail-count]");
    }
    if (args.length > 2) {
      throw new Error("Usage: lark service logs [tail-count]");
    }
    const tail = args[1] ? parsePositiveInteger(args[1], "tail count") : 80;
    logger.log(await (deps.readLogs ?? defaultReadLarkServiceLogs)({ stateDir, logPath: commandInput.logPath, tail }));
    return true;
  }

  if (subcommand === "start") {
    if (all) {
      if (argsWithoutAll.length !== 0) {
        throw new Error("Usage: lark service start [--all]");
      }
      const targets = await listConfiguredLarkServiceTargets(loadedEnv);
      if (targets.length === 0) {
        logger.log("No Lark instances found.");
        return true;
      }
      for (const target of targets) {
        const targetInput = buildLarkServiceCommandInput(await loadLarkServiceTargetEnv(loadedEnv, target));
        await prepareLarkServiceStartEnv(targetInput.env);
        const result = deps.start ? await deps.start(targetInput) : await defaultStartLarkService(targetInput, deps);
        if (result === "started") {
          await (deps.waitUntilRunning ?? defaultWaitUntilLarkServiceRunning)(targetInput);
        }
        logger.log(formatLarkServiceAction("start", result));
      }
      return true;
    }
    if (args.length !== 1) {
      throw new Error("Usage: lark service start [--all]");
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
    const { enabled: force, args: stopArgs } = extractBooleanFlag(argsWithoutAll, "--force");
    if (stopArgs.length !== 0) {
      throw new Error("Usage: lark service stop [--all] [--force]");
    }
    if (all) {
      const targets = await listConfiguredLarkServiceTargets(loadedEnv);
      if (targets.length === 0) {
        logger.log("No Lark instances found.");
        return true;
      }
      for (const target of targets) {
        const targetEnv = await loadLarkServiceTargetEnv(loadedEnv, target);
        const targetInput = buildLarkServiceCommandInput(targetEnv);
        if (isCurrentActiveLarkTurnTarget(env, targetEnv, targetInput.stateDir)) {
          logger.log(`Skipped current Lark instance "${target.instanceName}"; run lark service stop from a terminal if you need to stop it too.`);
          continue;
        }
        if (!force) {
          await assertNoActiveLarkTurnsBeforeServiceAction(targetInput.stateDir, resolveLarkInstanceName(targetEnv), "stop");
        }
        const result = deps.stop ? await deps.stop(targetInput) : await defaultStopLarkService(targetInput, deps);
        logger.log(formatLarkServiceAction("stop", result));
      }
      return true;
    }
    if (isCurrentActiveLarkTurnTarget(env, loadedEnv, stateDir)) {
      throw new Error(`Refusing to stop current Lark instance "${resolveLarkInstanceName(loadedEnv)}" from inside an active Lark turn; run it from a terminal if you need to stop it.`);
    }
    if (!force) {
      await assertNoActiveLarkTurnsBeforeServiceAction(stateDir, resolveLarkInstanceName(loadedEnv), "stop");
    }
    const result = deps.stop ? await deps.stop(commandInput) : await defaultStopLarkService(commandInput, deps);
    logger.log(formatLarkServiceAction("stop", result));
    return true;
  }

  if (subcommand === "restart") {
    const { enabled: defer, args: afterDefer } = extractBooleanFlag(argsWithoutAll, "--defer");
    const { enabled: force, args: restartArgs } = extractBooleanFlag(afterDefer, "--force");
    if (restartArgs.length !== 0) {
      throw new Error("Usage: lark service restart [--all] [--defer] [--force]");
    }
    const scheduleDeferredRestart = deps.scheduleDeferredRestart
      ?? ((deferredInput, options) => defaultScheduleDeferredLarkServiceRestart(deferredInput, deps, options));
    if (all) {
      const targets = await listConfiguredLarkServiceTargets(loadedEnv);
      if (targets.length === 0) {
        logger.log("No Lark instances found.");
        return true;
      }
      let deferredCurrentInput: LarkServiceCommandInput | null = null;
      for (const target of targets) {
        const targetEnv = await loadLarkServiceTargetEnv(loadedEnv, target);
        const targetInput = buildLarkServiceCommandInput(targetEnv);
        if (isCurrentActiveLarkTurnTarget(env, targetEnv, targetInput.stateDir)) {
          deferredCurrentInput = targetInput;
          continue;
        }
        if (defer) {
          logger.log(await scheduleDeferredRestart(targetInput, {}));
          continue;
        }
        if (!force) {
          await assertNoActiveLarkTurnsBeforeServiceAction(targetInput.stateDir, resolveLarkInstanceName(targetEnv), "restart");
        }
        await prepareLarkServiceStartEnv(targetEnv);
        const stopResult = deps.stop ? await deps.stop(targetInput) : await defaultStopLarkService(targetInput, deps);
        logger.log(formatLarkServiceAction("stop", stopResult));
        const result = deps.start ? await deps.start(targetInput) : await defaultStartLarkService(targetInput, deps);
        if (result === "started") {
          await (deps.waitUntilRunning ?? defaultWaitUntilLarkServiceRunning)(targetInput);
        }
        logger.log(formatLarkServiceAction("start", result));
      }
      if (deferredCurrentInput) {
        logger.log(await scheduleDeferredRestart(deferredCurrentInput, { current: true }));
      }
      return true;
    }
    if (defer) {
      logger.log(await scheduleDeferredRestart(commandInput, {}));
      return true;
    }
    if (isCurrentActiveLarkTurnTarget(env, loadedEnv, stateDir)) {
      logger.log(await scheduleDeferredRestart(commandInput, { current: true }));
      return true;
    }
    if (!force) {
      await assertNoActiveLarkTurnsBeforeServiceAction(stateDir, resolveLarkInstanceName(loadedEnv), "restart");
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
  if (isLarkAccessMutation(args) && !hasExplicitLarkAccessTarget(env, loadedEnv)) {
    throw new Error("Refusing to modify the implicit default Lark access store. Set CCTB_LARK_INSTANCE=<name> or run lark setup first.");
  }
  const stateDir = resolveLarkStateDir(loadedEnv);
  const instanceName = resolveLarkInstanceName(loadedEnv);
  return await runAccessCommand(["access", ...args], {
    HOME: loadedEnv.HOME,
    USERPROFILE: loadedEnv.USERPROFILE,
    TAROCUB_INSTANCE: instanceName,
    CODEX_TELEGRAM_STATE_DIR: stateDir,
    CODEX_TELEGRAM_INSTANCE: instanceName,
  }, logger, {
    commandName: "lark access",
    defaultInstanceName: instanceName,
    ensureAgentInstructions: false,
  });
}

function isLarkAccessMutation(args: string[]): boolean {
  return args[0] === "pair" ||
    args[0] === "policy" ||
    args[0] === "allow" ||
    args[0] === "revoke" ||
    args[0] === "multi";
}

function hasExplicitLarkAccessTarget(env: LarkRuntimeEnv, loadedEnv: LarkRuntimeEnv): boolean {
  return Boolean(
    env.CCTB_LARK_INSTANCE ||
    env.CCTB_LARK_STATE_DIR ||
    loadedEnv.CCTB_LARK_INSTANCE ||
    loadedEnv.CCTB_LARK_STATE_DIR ||
    loadedEnv.LARK_APP_ID ||
    loadedEnv.LARK_APP_SECRET,
  );
}

async function resolveLarkScopedEnv(env: LarkRuntimeEnv): Promise<{ env: InstanceTokenEnv; instanceName: string }> {
  const loadedEnv = await loadLarkRuntimeEnv(env);
  const stateDir = resolveLarkStateDir(loadedEnv);
  const instanceName = resolveLarkInstanceName(loadedEnv);
  return {
    instanceName,
    env: {
      HOME: loadedEnv.HOME,
      USERPROFILE: loadedEnv.USERPROFILE,
      TAROCUB_INSTANCE: instanceName,
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
  "Usage: lark send --chat <oc_xxx> [--reply-to <message-id>] [--thread] [--message <text>] [--image <path>] [--file <path>] [--stdin] [text]",
  "",
  "Options:",
  "  --chat, --chat-id <oc_xxx>       Target Lark chat id. Required; the CLI will not guess from saved chats.",
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
  void stateDir;
  throw new Error("lark send requires --chat <oc_xxx>; refusing to infer a target chat from saved Lark state.");
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
    source: "tarocub-cli",
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
    detectCli?: CliOptions["larkDetectCli"];
    runCommand?: CliOptions["larkRunCommand"];
    stdinText?: CliOptions["stdinText"];
  } = {},
): Promise<boolean> {
  const scoped = extractOptionalInstanceOption(argv.slice(1));
  const subcommand = scoped.args[0] ?? "status";
  const args = scoped.args.slice(1);
  const larkEnv = resolveLarkCommandTargetEnv(applyLarkInstanceOption(env, scoped.instanceName));

  if (subcommand === "setup") {
    return await runLarkSetupCommand(args, larkEnv, logger, {
      inspectApp: deps.inspectApp,
      provisionApp: deps.provisionApp,
      runCommand: deps.runCommand ?? runLarkCommandProcess,
      service: deps.service,
    });
  }

  if (subcommand === "service") {
    return await runLarkServiceCommand(args, larkEnv, logger, {
      ...deps.service,
      inspectApp: deps.service?.inspectApp ?? deps.inspectApp,
    });
  }

  if (subcommand === "send") {
    return await runLarkSendCommand(args, larkEnv, logger, deps.send);
  }

  if (subcommand === "secrets") {
    return await runLarkSecretsCommand(args, larkEnv, logger, deps.stdinText);
  }

  if (subcommand === "cli") {
    return await runLarkCliBridgeCommand(args, larkEnv, logger, deps.runCommand ?? runLarkCommandProcess);
  }

  if (subcommand === "auth") {
    return await runLarkAuthCommand(args, larkEnv, logger, deps.runCommand ?? runLarkCommandProcess);
  }

  if (subcommand === "access") {
    return await runLarkAccessCommand(args, larkEnv, logger);
  }

  if (subcommand === "audit") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    return await runAuditCommand(["audit", "--instance", runtime.instanceName, ...args], runtime.env, logger);
  }

  if (subcommand === "timeline") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    const timelineArgs = hasOption(args, "--channel") ? args : ["--channel", "lark", ...args];
    return await runTimelineCommand(["timeline", "--instance", runtime.instanceName, ...timelineArgs], runtime.env, logger);
  }

  if (subcommand === "dashboard") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    return await runDashboardCommand(args, runtime.env, logger, deps.dashboard);
  }

  if (subcommand === "session") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    return await runSessionCommand(["session", ...args], runtime.env, logger, {
      commandName: "lark session",
      defaultInstanceName: runtime.instanceName,
      showInstanceOption: false,
    });
  }

  if (subcommand === "task") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    return await runTaskCommand(["task", ...args], runtime.env, logger, {
      commandName: "lark task",
      defaultInstanceName: runtime.instanceName,
      showInstanceOption: false,
    });
  }

  if (subcommand === "backup") {
    await runLarkBackupCommand(args, larkEnv, logger);
    return true;
  }

  if (subcommand === "restore") {
    await runLarkRestoreCommand(args, larkEnv, logger);
    return true;
  }

  if (subcommand === "instructions") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    return await runInstructionsCommand(["instructions", ...args], runtime.env, logger, {
      allowUpgrade: false,
      commandName: "lark instructions",
      defaultInstanceName: runtime.instanceName,
      showInstanceOption: false,
    });
  }

  if (subcommand === "engine") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    return await runEngineCommand(["engine", ...args, "--instance", runtime.instanceName], runtime.env, logger);
  }

  if (subcommand === "yolo") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    return await runYoloCommand(["yolo", ...args, "--instance", runtime.instanceName], runtime.env, logger);
  }

  if (subcommand === "budget") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    return await runBudgetCommand(["budget", ...args, "--instance", runtime.instanceName], runtime.env, logger);
  }

  if (subcommand === "locale") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    return await runLocaleCommand(["locale", ...args, "--instance", runtime.instanceName], runtime.env, logger);
  }

  if (subcommand === "verbosity") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    return await runVerbosityCommand(["verbosity", ...args, "--instance", runtime.instanceName], runtime.env, logger);
  }

  if (subcommand === "usage") {
    const runtime = await resolveLarkScopedEnv(larkEnv);
    return await runUsageCommand(["usage", ...args, "--instance", runtime.instanceName], runtime.env, logger);
  }

  if (subcommand === "status") {
    if (args.length !== 0) {
      throw new Error("Usage: lark status [--instance <name>]");
    }
    const loadedEnv = await loadLarkRuntimeEnv(larkEnv);
    logger.log(await formatLarkStatus(loadedEnv, deps.detectCli ?? detectLarkCliStatus));
    return true;
  }

  if (subcommand === "doctor") {
    if (args.length !== 0) {
      throw new Error("Usage: lark doctor [--instance <name>]");
    }
    const loadedEnv = await loadLarkRuntimeEnv(larkEnv);
    logger.log(await formatLarkDoctor(loadedEnv, deps.inspectApp ?? inspectLarkAppProvisioning));
    return true;
  }

  if (subcommand === "provision") {
    if (args.length !== 0) {
      throw new Error("Usage: lark provision [--instance <name>]");
    }
    const loadedEnv = await loadLarkRuntimeEnv(larkEnv);
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
      ...formatLarkProvisioningResult(provisioning, {
        appId: loadedEnv.LARK_APP_ID,
        ...(loadedEnv.LARK_DOMAIN ? { domain: loadedEnv.LARK_DOMAIN } : {}),
      }).map((line) => `- ${line}`),
    ].join("\n"));
    return true;
  }

  if (subcommand === "permissions") {
    if (args.length === 1 && args[0] === "--missing") {
      const loadedEnv = await loadLarkRuntimeEnv(larkEnv);
      if (!loadedEnv.LARK_APP_ID) {
        throw new Error("LARK_APP_ID is required");
      }
      if (!loadedEnv.LARK_APP_SECRET) {
        throw new Error("LARK_APP_SECRET is required");
      }
      let inspected: LarkProvisioningResult | undefined;
      let inspectError: string | undefined;
      try {
        inspected = await (deps.inspectApp ?? inspectLarkAppProvisioning)({
          appId: loadedEnv.LARK_APP_ID,
          appSecret: loadedEnv.LARK_APP_SECRET,
          ...(loadedEnv.LARK_DOMAIN ? { domain: loadedEnv.LARK_DOMAIN } : {}),
        });
      } catch (error) {
        inspectError = redactLarkDoctorError(error, loadedEnv);
      }
      const lines = [
        "Lark missing scopes JSON",
        "Paste this into Feishu/Lark Developer Console -> your app -> Permissions -> bulk import/open.",
        `Permissions page: ${formatLarkPermissionConsoleUrl(loadedEnv.LARK_APP_ID, loadedEnv.LARK_DOMAIN)}`,
        ...(inspected
          ? [
              inspected.missingScopes.length > 0
                ? formatLarkScopeImportJson(inspected.missingScopes)
                : "No missing required scopes.",
            ]
          : [
              `Could not inspect currently missing scopes: ${inspectError}`,
              "Fallback full required scopes JSON",
              formatLarkScopeImportJson(REQUIRED_LARK_SCOPES),
            ]),
      ];
      lines.push(...formatLarkScopeImportNextSteps(inspected?.missingScopes ?? REQUIRED_LARK_SCOPES, {
        appId: loadedEnv.LARK_APP_ID,
        ...(loadedEnv.LARK_DOMAIN ? { domain: loadedEnv.LARK_DOMAIN } : {}),
      }));
      if (inspected && inspected.unauthorizedScopes.length > 0) {
        lines.push(`Already configured but awaiting approval: ${inspected.unauthorizedScopes.join(", ")}`);
      }
      logger.log(lines.join("\n"));
      return true;
    }

    if (args.length !== 0) {
      throw new Error("Usage: lark permissions [--missing]");
    }
    logger.log([
      "Lark required scopes JSON (core — auto-granted by the PersonalAgent QR registration; import only to recover a missing one):",
      formatLarkScopeImportJson(REQUIRED_LARK_SCOPES),
      "",
      "Lark optional scopes JSON (advanced — import + publish ONLY to enable Sheets / ordinary group messages / doc auto-grant):",
      formatLarkScopeImportJson(OPTIONAL_LARK_SCOPES),
      "Paste either into Feishu/Lark Developer Console -> your app -> Permissions -> bulk import/open.",
      ...formatLarkScopeImportNextSteps([...REQUIRED_LARK_SCOPES, ...OPTIONAL_LARK_SCOPES]),
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
    if (hasHelpFlag(args)) {
      logger.log("Usage: node dist/src/index.js lark run");
      return true;
    }
    throw new Error("Usage: node dist/src/index.js lark run");
  }

  throw new Error("Usage: lark <setup|status|doctor|provision|permissions|wizard|run|service|send|secrets|cli|auth|access|session|task|backup|restore|instructions|engine|yolo|budget|locale|verbosity|usage|audit|timeline|dashboard>");
}

async function runLarkSetupCommand(
  args: string[],
  env: LarkRuntimeEnv,
  logger: CliLogger,
  deps: {
    inspectApp?: CliOptions["larkInspectApp"];
    provisionApp?: CliOptions["larkProvisionApp"];
    runCommand: LarkRunCommand;
    service?: LarkServiceCommandDeps;
  },
): Promise<boolean> {
  const options = parseLarkSetupArgs(args);
  const targetEnv = resolveLarkSetupTargetEnv(env);
  const summary: string[] = [];

  if (options.detached) {
    if (options.skipWizard) {
      throw new Error(`${LARK_SETUP_USAGE}; --detached requires the QR wizard, so remove --skip-wizard.`);
    }
    const loadedEnv = await loadLarkRuntimeEnv(targetEnv);
    const stateDir = resolveLarkStateDir(loadedEnv);
    const logPath = resolveLarkSetupLogPath(stateDir);
    const entrypoint = resolveCliEntrypoint();
    const { sessionName } = await startDetachedLarkSetup({
      env: loadedEnv,
      stateDir,
      logPath,
      entrypoint,
      cwd: process.cwd(),
      args,
    });
    const setupUrl = await waitForDetachedLarkSetupUrl(logPath);
    logger.log([
      "Lark setup is running in the background.",
      `Instance: ${resolveLarkInstanceName(loadedEnv)}`,
      `State dir: ${stateDir}`,
      `tmux session: ${sessionName}`,
      `Log: ${logPath}`,
      ...(setupUrl ? [`Open directly: ${setupUrl}`] : ["Open link: pending; tail the log until the QR link appears."]),
      `Watch: tmux attach -t ${sessionName}   |   Cancel: tmux kill-session -t ${sessionName}`,
      "The setup process will keep polling after this chat turn ends, then start the Lark service when setup completes.",
    ].join("\n"));
    return true;
  }

  // Tell the user where things live up front, so a long step never looks frozen
  // with no idea where to check.
  const foregroundStateDir = resolveLarkStateDir(targetEnv);
  logger.log([
    `Setting up Lark (instance ${resolveLarkInstanceName(targetEnv)}).`,
    `State dir: ${foregroundStateDir}`,
    `Service log (after start): ${resolveLarkServiceLogPath(foregroundStateDir)}`,
  ].join("\n"));

  let setupEnv = targetEnv;
  if (options.skipWizard) {
    // No wizard means credentials must already be saved. Fail early and clearly
    // here rather than deep inside the lark-cli bind step with "LARK_APP_ID is
    // required".
    const existing = await loadLarkRuntimeEnv(setupEnv);
    if (!existing.LARK_APP_ID || !existing.LARK_APP_SECRET) {
      throw new Error(
        "No saved Lark credentials found. Run `node dist/src/index.js lark setup` without --skip-wizard to register an app, or set LARK_APP_ID and LARK_APP_SECRET first.",
      );
    }
    summary.push("wizard: skipped");
  } else {
    await runLarkWizard(targetEnv, logger);
    setupEnv = withoutDirectLarkAppCredentials(targetEnv);
    summary.push("wizard: ok");
  }

  logger.log("Binding lark-cli to the bridge credentials…");
  await ensureLarkCliAvailable({
    install: options.installCli,
    logger,
    runCommand: deps.runCommand,
  });
  await configureLarkCliIdentity(setupEnv, deps.runCommand, { identity: options.identity });
  summary.push("lark-cli: ok");

  let loadedEnv = await loadLarkRuntimeEnv(setupEnv);
  let provisioningNeedsAttention = false;
  if (!options.skipProvision) {
    if (!loadedEnv.LARK_APP_ID || !loadedEnv.LARK_APP_SECRET) {
      throw new Error("LARK_APP_ID and LARK_APP_SECRET are required for provisioning");
    }
    logger.log("Provisioning Lark app permissions (contacting the Lark API)…");
    try {
      const provisioning = await (deps.provisionApp ?? provisionLarkApp)({
        appId: loadedEnv.LARK_APP_ID,
        appSecret: loadedEnv.LARK_APP_SECRET,
        ...(loadedEnv.LARK_DOMAIN ? { domain: loadedEnv.LARK_DOMAIN } : {}),
        logger,
      });
      provisioningNeedsAttention = provisioning.missingScopes.length > 0 || provisioning.unauthorizedScopes.length > 0;
      summary.push(`provision: ${provisioningNeedsAttention ? "attention needed" : "ok"}`);
    } catch (error) {
      // A provisioning failure must not abort the whole run (and lose the doctor
      // summary + next steps), the way auth already degrades gracefully.
      provisioningNeedsAttention = true;
      summary.push(`provision: failed (${redactLarkSensitiveText(renderCommandError(error))})`);
    }
  } else {
    summary.push("provision: skipped");
  }

  loadedEnv = await loadLarkRuntimeEnv(setupEnv);
  let authSummary = "auth: skipped";
  const authNextSteps: string[] = [];
  if (!options.skipAuth) {
    logger.log("Verifying Lark user authorization…");
    try {
      const context = await prepareLarkCliBridgeContext(loadedEnv);
      await deps.runCommand({
        file: "lark-cli",
        args: ["auth", "status", "--verify"],
        env: context.childEnv,
        timeoutMs: 30_000,
      });
      authSummary = "auth: ok";
    } catch (error) {
      authSummary = `auth: attention needed (${redactLarkSensitiveText(renderCommandError(error))})`;
      authNextSteps.push(
        `auth next: ${RECOMMENDED_LARK_USER_AUTH_START_COMMAND}`,
        "auth finish: node dist/src/index.js lark auth finish <device-code>",
      );
    }
  }
  summary.push(authSummary);
  summary.push(...authNextSteps);

  logger.log("Running Lark doctor…");
  const doctor = await formatLarkDoctor(loadedEnv, deps.inspectApp ?? inspectLarkAppProvisioning);
  const doctorNeedsAttention = hasActionableLarkDoctorProblem(doctor);
  summary.push(doctorNeedsAttention ? "doctor: attention needed" : "doctor: ok");
  const shouldStartService = options.startService ?? !options.skipWizard;
  if (shouldStartService) {
    if (provisioningNeedsAttention || doctorNeedsAttention) {
      summary.push("service: skipped (fix Lark permissions first)");
    } else {
      logger.log("Starting Lark service…");
      const serviceResult = await startLarkServiceFromSetup(loadedEnv, deps.service);
      summary.push(`service: ${serviceResult === "already_running" ? "already running" : "started"}`);
    }
  } else {
    summary.push("service: skipped");
  }
  const nextSteps = buildLarkSetupNextSteps(provisioningNeedsAttention || doctorNeedsAttention);
  logger.log([
    "Lark setup complete.",
    ...summary.map((line) => `- ${line}`),
    "",
    doctor,
    ...(nextSteps.length > 0 ? ["", ...nextSteps] : []),
  ].join("\n"));
  return true;
}

/**
 * One consolidated "do these, then rerun" block when setup ends without a
 * running service, so the operator isn't left guessing among scattered scope
 * lines. The console URL + missing-scope JSON are already in the doctor output.
 */
function buildLarkSetupNextSteps(needsAttention: boolean): string[] {
  if (!needsAttention) {
    return [];
  }
  return [
    "Next steps to finish setup:",
    "1) Open the permission console URL shown above and bulk-import the missing scopes JSON.",
    "2) Publish the app version — scopes do not take effect until the version is published/approved.",
    "3) Rerun: node dist/src/index.js lark provision && node dist/src/index.js lark doctor && node dist/src/index.js lark service start",
  ];
}

const RECOMMENDED_LARK_USER_AUTH_START_COMMAND = 'node dist/src/index.js lark auth start --recommend --domain docs,drive --scope "sheets:spreadsheet:create sheets:spreadsheet:write_only sheets:spreadsheet:read sheets:spreadsheet.meta:read"';

function hasActionableLarkDoctorProblem(doctor: string): boolean {
  return doctor
    .split("\n")
    .some((line) => {
      if (!line.startsWith("- fail ") && !line.startsWith("- warn ")) {
        return false;
      }
      return !line.startsWith("- warn Service lock:");
    });
}

async function startLarkServiceFromSetup(
  env: LarkRuntimeEnv,
  deps: LarkServiceCommandDeps = {},
): Promise<"started" | "already_running"> {
  await prepareLarkServiceStartEnv(env);
  const stateDir = resolveLarkStateDir(env);
  const input: LarkServiceCommandInput = {
    env,
    stateDir,
    logPath: resolveLarkServiceLogPath(stateDir),
    entrypoint: resolveCliEntrypoint(),
    cwd: process.cwd(),
  };
  const result = await (deps.start ?? defaultStartLarkService)(input);
  if (result === "started") {
    await (deps.waitUntilRunning ?? defaultWaitUntilLarkServiceRunning)(input);
  }
  return result;
}

function parseLarkSetupArgs(args: string[]): {
  detached: boolean;
  skipWizard: boolean;
  installCli: boolean;
  identity: LarkCliBridgeIdentity;
  skipProvision: boolean;
  skipAuth: boolean;
  startService?: boolean;
} {
  let detached = false;
  let skipWizard = false;
  let installCli = false;
  let identity: LarkCliBridgeIdentity = "bot-only";
  let skipProvision = false;
  let skipAuth = false;
  let startService: boolean | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--detached") {
      detached = true;
      continue;
    }
    if (arg === "--skip-wizard") {
      skipWizard = true;
      continue;
    }
    if (arg === "--install-cli") {
      installCli = true;
      continue;
    }
    if (arg === "--identity") {
      const parsed = parseLarkCliIdentityValue(args[++index]);
      if (!parsed) {
        throw new Error(LARK_SETUP_USAGE);
      }
      identity = parsed;
      continue;
    }
    if (arg === "--skip-provision") {
      skipProvision = true;
      continue;
    }
    if (arg === "--skip-auth") {
      skipAuth = true;
      continue;
    }
    if (arg === "--start-service") {
      startService = true;
      continue;
    }
    if (arg === "--no-start-service") {
      startService = false;
      continue;
    }
    throw new Error(LARK_SETUP_USAGE);
  }
  return { detached, skipWizard, installCli, identity, skipProvision, skipAuth, startService };
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

    const currentServiceInstanceName = env.TAROCUB_INSTANCE ?? env.CODEX_TELEGRAM_INSTANCE
      ? resolveInstanceName(env)
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
        const channelsDir = resolveChannelsDirFromEnv(env);
        const dirents = await readdir(channelsDir, { withFileTypes: true });
        const candidateNames = dirents
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => entry.name)
          .sort();
        instanceNames = [];
        for (const name of candidateNames) {
          if (!await isLarkOnlyStateDir(path.join(channelsDir, name))) {
            instanceNames.push(name);
          }
        }
      } catch {
        instanceNames = [];
      }
      if (instanceNames.length === 0) {
        logger.log("No Telegram instances found.");
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
    const mode = resolveApprovalMode(config.approvalMode);
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
  lark <setup|status|doctor|provision|permissions|wizard|run|service|send|access|session|task|backup|restore|instructions|engine|yolo|budget|locale|verbosity|usage|audit|timeline|dashboard>
                                              Inspect, configure, or run the Feishu/Lark channel
  lark setup [--detached] [--install-cli]     Run the QR wizard, CLI bind, provision, auth check, doctor, and service start
  lark permissions [--missing]                Print copyable Feishu/Lark permission JSON
  lark service <start|stop|restart|status|logs|doctor> [--force]
                                              Manage the Feishu/Lark service lifecycle
  lark send --chat <oc_xxx> [--reply-to <message-id>] [--thread] [--message <text>] [--image <path>] [--file <path>] [--stdin]
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
    const names: string[] = [];
    for (const entry of dirents) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      if (await isLarkOnlyStateDir(path.join(channelsDir, entry.name))) {
        continue;
      }
      names.push(entry.name);
    }
    return names.sort();
  } catch {
    return [];
  }
}

async function isLarkOnlyStateDir(stateDir: string): Promise<boolean> {
  const envText = await readOptionalFile(path.join(stateDir, ".env"));
  if (envText && /\bTELEGRAM_BOT_TOKEN\s*=/.test(envText)) {
    return false;
  }
  return Boolean(await readOptionalFile(path.join(stateDir, "lark.env"))) ||
    await isDirectory(path.join(stateDir, "lark-service")) ||
    Boolean(await readOptionalFile(path.join(stateDir, "lark-chat-id-map.json"))) ||
    Boolean(await readOptionalFile(path.join(stateDir, "lark-user-id-map.json")));
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    await readdir(dirPath);
    return true;
  } catch {
    return false;
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
    if (normalized.length === 2 && (normalized[1] === "--help" || normalized[1] === "-h")) {
      logger.log(TELEGRAM_CONFIGURE_USAGE);
      return true;
    }
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
      detectCli: options.larkDetectCli,
      runCommand: options.larkRunCommand,
      stdinText: options.stdinText,
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
