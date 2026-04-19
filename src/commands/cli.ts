import { readFile, rename, unlink, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { resolveInstanceStateDir, type EnvSource } from "../config.js";
import { AccessStore } from "../state/access-store.js";
import { normalizeInstanceName } from "../instance.js";
import { resolveInstanceAccessStatePath, type InstanceTokenEnv, writeInstanceBotToken } from "./access.js";
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
  startServiceInstance,
  stopServiceInstance,
  type ServiceCommandDeps,
} from "./service.js";

export interface CliLogger {
  log: (message: string) => void;
}

export interface CliOptions {
  env?: Pick<
    EnvSource,
    "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR" | "TELEGRAM_BOT_TOKEN" | "CODEX_HOME" | "CLAUDE_CONFIG_DIR"
  >;
  logger?: CliLogger;
  serviceDeps?: ServiceCommandDeps;
}

function normalizeCommandArgs(argv: string[]): string[] {
  if (argv[0] === "telegram") {
    return argv.slice(1);
  }

  return argv;
}

function extractInstanceOption(argv: string[]): { instanceName: string; args: string[] } {
  let instanceName = "default";
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
    `Paired users: ${status.pairedUsers}`,
    `Allowlist: ${allowlist}`,
    `Pending pairs: ${pendingPairs}`,
  ].join("\n");
}

async function runAccessCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  if (argv.length < 2) {
    throw new Error("Usage: telegram access <pair|policy|allow|revoke> ...");
  }

  const subcommand = argv[1];
  const { instanceName, args } = extractInstanceOption(argv.slice(2));
  const auditStateDir = resolveAuditStateDir(env, instanceName);
  const store = new AccessStore(resolveInstanceAccessStatePath(env, instanceName));

  if (subcommand === "pair") {
    if (args.length !== 1) {
      throw new Error("Usage: telegram access pair [--instance <name>] <code>");
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
    logger.log(`Redeemed pairing code for instance "${instanceName}" and chat ${pairedUser.telegramChatId}.`);
    return true;
  }

  if (subcommand === "policy") {
    if (args.length !== 1 || (args[0] !== "pairing" && args[0] !== "allowlist")) {
      throw new Error("Usage: telegram access policy [--instance <name>] <pairing|allowlist>");
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
      throw new Error("Usage: telegram access allow [--instance <name>] <chat-id>");
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
      throw new Error("Usage: telegram access revoke [--instance <name>] <chat-id>");
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

  throw new Error("Usage: telegram access <pair|policy|allow|revoke> ...");
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
        throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus>]");
      }
      filter.type = args[index + 1] as TimelineEventFilter["type"];
      index++;
      continue;
    }

    if (argument === "--chat") {
      if (index + 1 >= args.length) {
        throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus>]");
      }
      filter.chatId = parseChatId(args[index + 1]);
      index++;
      continue;
    }

    if (argument === "--outcome") {
      if (index + 1 >= args.length) {
        throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus>]");
      }
      filter.outcome = args[index + 1];
      index++;
      continue;
    }

    if (argument === "--channel") {
      if (index + 1 >= args.length) {
        throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus>]");
      }
      const value = args[index + 1];
      if (value !== "telegram" && value !== "bus") {
        throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus>]");
      }
      filter.channel = value;
      index++;
      continue;
    }

    throw new Error("Usage: telegram timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus>]");
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

async function runSessionCommand(argv: string[], env: InstanceTokenEnv, logger: CliLogger): Promise<boolean> {
  if (argv.length < 2) {
    throw new Error("Usage: telegram session <list|inspect|reset> ...");
  }

  const subcommand = argv[1];
  const { instanceName, args } = extractInstanceOption(argv.slice(2));

  if (subcommand === "list") {
    if (args.length !== 0) {
      throw new Error("Usage: telegram session list [--instance <name>]");
    }

    const result = await inspectSessions(env, instanceName);
    logger.log(formatSessionList(instanceName, result.sessions, result.warning));
    return true;
  }

  if (subcommand === "show" || subcommand === "inspect") {
    if (args.length !== 1) {
      throw new Error(`Usage: telegram session ${subcommand} [--instance <name>] <chat-id>`);
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
      throw new Error("Usage: telegram session reset [--instance <name>] <chat-id>");
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

  throw new Error("Usage: telegram session <list|inspect|reset> ...");
}

async function runTaskCommand(argv: string[], env: InstanceTokenEnv, logger: CliLogger): Promise<boolean> {
  if (argv.length < 2) {
    throw new Error("Usage: telegram task <list|inspect|clear> ...");
  }

  const subcommand = argv[1];
  const { instanceName, args } = extractInstanceOption(argv.slice(2));

  if (subcommand === "list") {
    if (args.length !== 0) {
      throw new Error("Usage: telegram task list [--instance <name>]");
    }

    const result = await listTasks(env, instanceName);
    logger.log(formatTaskList(instanceName, result));
    return true;
  }

  if (subcommand === "inspect") {
    if (args.length !== 1) {
      throw new Error("Usage: telegram task inspect [--instance <name>] <upload-id>");
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
      throw new Error("Usage: telegram task clear [--instance <name>] <upload-id>");
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

  throw new Error("Usage: telegram task <list|inspect|clear> ...");
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
  const { instanceName, args } = extractInstanceOption(argv.slice(2));

  if (subcommand !== "logs" && args.length !== 0) {
    throw new Error("Usage: telegram service <start|stop|restart|status|logs|doctor> [--instance <name>]");
  }

  if (subcommand === "start") {
    logger.log(await startServiceInstance(env, instanceName, serviceDeps));
    return true;
  }

  if (subcommand === "stop") {
    logger.log(await stopServiceInstance(env, instanceName, serviceDeps));
    return true;
  }

  if (subcommand === "restart") {
    await stopServiceInstance(env, instanceName, serviceDeps);
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
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: instanceName,
  });
  return path.join(stateDir, "agent.md");
}

async function runInstructionsCommand(
  argv: string[],
  env: InstanceTokenEnv,
  logger: CliLogger,
): Promise<boolean> {
  if (argv.length < 2) {
    throw new Error("Usage: telegram instructions <show|set|path> [--instance <name>] [file-path]");
  }

  const subcommand = argv[1];
  const { instanceName, args } = extractInstanceOption(argv.slice(2));
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
      throw new Error("Usage: telegram instructions set [--instance <name>] <file-path>");
    }

    const sourcePath = args[0];
    const content = await readFile(sourcePath, "utf8");
    await mkdir(path.dirname(agentMdPath), { recursive: true });
    await writeFile(agentMdPath, content, "utf8");
    logger.log(`Wrote instructions for instance "${instanceName}" (${content.length} bytes) to ${agentMdPath}`);
    return true;
  }

  throw new Error("Usage: telegram instructions <show|set|path> [--instance <name>] [file-path]");
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

async function writeInstanceConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  // Atomic write: stage-then-rename so a kill mid-write can't leave a
  // truncated config.json on disk. A partial JSON file gets parsed as an
  // error and the instance silently runs on defaults.
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  try {
    await rename(tempPath, configPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
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
  const config = await readInstanceConfig(configPath);
  const auditStateDir = resolveAuditStateDir(env, instanceName);

  if (subcommand === "on") {
    config.approvalMode = "full-auto";
    await writeInstanceConfig(configPath, config);
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
    config.approvalMode = "normal";
    await writeInstanceConfig(configPath, config);
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
    config.approvalMode = "bypass";
    await writeInstanceConfig(configPath, config);
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

  if (args.length === 0) {
    const config = await readInstanceConfig(configPath);
    const engine = config.engine ?? "codex";
    logger.log(`Instance "${instanceName}": engine = ${engine}`);
    return true;
  }

  const engine = args[0];
  if (engine !== "codex" && engine !== "claude") {
    throw new Error("Usage: telegram engine <codex|claude> [--instance <name>]");
  }

  const config = await readInstanceConfig(configPath);
  config.engine = engine;
  await writeInstanceConfig(configPath, config);

  const auditStateDir = resolveAuditStateDir(env, instanceName);
  await appendAuditEvent(auditStateDir, {
    type: "config.engine",
    instanceName,
    outcome: "success",
    metadata: { engine },
  });

  logger.log(`Instance "${instanceName}": engine set to "${engine}". Restart the service to apply.`);
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

  const config = await readInstanceConfig(configPath);
  config.verbosity = level;
  await writeInstanceConfig(configPath, config);
  const label = level === 0 ? "quiet (no progress)" : level === 2 ? "detailed (1s updates)" : "normal (2s updates)";
  logger.log(`Instance "${instanceName}": verbosity set to ${level} (${label}).`);
  return true;
}

const HELP_TEXT = `Usage: telegram <command> [options]

Commands:
  configure <token> [--instance <name>]       Configure bot token for an instance
  service <start|stop|restart|status|logs|doctor> [--instance <name>]
                                              Manage the service lifecycle
  access <pair|policy|allow|revoke> [--instance <name>]
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
  timeline [count] [--instance <name>] [--type <type>] [--chat <id>] [--outcome <outcome>] [--channel <telegram|bus>]
                                              View timeline trail
  instructions <show|set|path> [--instance <name>]
                                              Manage per-instance agent.md
  yolo [on|off|unsafe] [--instance <name>]    Toggle YOLO auto-approval mode
  engine [codex|claude] [--instance <name>]   Switch AI engine per instance
  usage [--instance <name>]                   Show token usage and cost
  verbosity [0|1|2] [--instance <name>]       Set progress output level
  budget [set <usd>|show] [--instance <name>] Manage cost budget and block-on-exceed
  locale [en|zh] [--instance <name>]          Set user-facing message language
  instance <list|rename|delete> [...]         Manage instances (list, rename, delete)
  logs rotate [--instance <name>]             Rotate log files now (auto on service start)
  backup [--instance <name>] [--out <path>]   Back up instance state to a .cctb.gz archive (pure Node)
  restore <archive> [--instance <name>]       Restore instance state from a backup archive
  dashboard                                   Open a visual status dashboard in the browser
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
      entries = dirents.filter((e) => e.isDirectory()).map((e) => e.name).sort();
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
    config.budgetUsd = amount;
    await writeInstanceConfig(configPath, config);
    logger.log(`Instance "${instanceName}": budget set to $${amount.toFixed(2)}. Bot will block new requests when the budget is exhausted.`);
    return true;
  }

  if (args[0] === "clear") {
    delete config.budgetUsd;
    await writeInstanceConfig(configPath, config);
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
  config.locale = locale;
  await writeInstanceConfig(configPath, config);
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
    const { generateDashboard } = await import("./dashboard.js");
    const outPath = await generateDashboard(env);
    logger.log(`Dashboard generated: ${outPath}`);
    return true;
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
