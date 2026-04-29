import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { joinStatePath, resolveInstanceStateDir } from "../config.js";
import { normalizeInstanceName } from "../instance.js";
import { appendAuditEvent } from "../state/audit-log.js";
import { defaultTelegramToolRegistry } from "../tools/telegram-tool-registry.js";

export interface InstanceTokenEnv {
  HOME?: string;
  USERPROFILE?: string;
  CODEX_TELEGRAM_STATE_DIR?: string;
}

export interface PersistedInstanceToken {
  instanceName: string;
  stateDir: string;
  envPath: string;
}

function registeredToolName(name: string): string {
  return defaultTelegramToolRegistry.get(name)?.name ?? name;
}

function toolTag(name: string, payload: Record<string, unknown>): string {
  return `[tool:${JSON.stringify({ name: registeredToolName(name), payload })}]`;
}

function toolExample(name: string, index = 0): string {
  const tool = defaultTelegramToolRegistry.get(name);
  const payload = tool?.examples?.[index];
  if (!payload) {
    throw new Error(`missing generated agent example for tool: ${name}`);
  }
  return toolTag(name, payload);
}

export function renderDefaultInstanceAgentInstructions(): string {
  return [
  "## Telegram Transport",
  "",
  `Plain text only; ask in chat, not blocking prompt tools. For existing file delivery, emit one inline tool tag such as ${toolExample("send.file")}, ${toolExample("send.image")}, or ${toolExample("send.batch")}. Small text/code may use one fenced \`file:name.ext\` block; never claim delivery by path only.`,
  "",
  "## Scheduled Tasks",
  "",
  `For reminders or recurring tasks, emit one inline tool tag, such as ${toolExample("cron.add", 0)}, ${toolExample("cron.add", 1)}, or ${toolExample("cron.add", 2)}. Use exactly one of \`in\`, \`at\`, or \`cron\`; optional \`description\` is shown in \`/cron list\`; never include \`chatId\` or \`userId\`. The bridge confirms success or failure; do not claim scheduling succeeded in your own words. Use native/session-local schedulers only if the user explicitly asks for non-Telegram scheduling.`,
  "",
  ].join("\n");
}

export const DEFAULT_INSTANCE_AGENT_INSTRUCTIONS = renderDefaultInstanceAgentInstructions();

const GENERATED_SCHEDULED_TASKS_BLOCKS = [
  [
    "## Scheduled Tasks",
    "",
    `For reminders or recurring tasks, emit one inline tool tag, such as ${toolExample("cron.add", 0)}, ${toolExample("cron.add", 1)}, or ${toolExample("cron.add", 2)}. Use exactly one of \`in\`, \`at\`, or \`cron\`; optional \`description\` is shown in \`/cron list\`; never include \`chatId\` or \`userId\`. The bridge confirms success or failure; do not claim scheduling succeeded in your own words.`,
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For reminders or recurring tasks, emit one inline tag in your reply, such as `[cron-add:{\"in\":\"10m\",\"prompt\":\"check email\"}]`, `[cron-add:{\"at\":\"2026-05-01T09:00:00Z\",\"prompt\":\"Monday standup\"}]`, or `[cron-add:{\"cron\":\"0 9 * * 1\",\"prompt\":\"weekly summary\"}]`. Use exactly one of `in`, `at`, or `cron`; optional `description` is shown in `/cron list`; never include `chatId` or `userId`. The bridge will confirm success or failure, so do not claim a reminder is scheduled in your own words.",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For reminders or recurring tasks, use `cctb cron add --in 10m --prompt \"...\"`, `cctb cron add --at ISO_TIME --prompt \"...\"`, or `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"...\"` when available; use `cctb cron list` to inspect. If `cctb cron` is unavailable, ask the user to send `/cron add <m h dom mon dow> <task>` or emit one `[cron-add:{\"in\":\"10m\",\"prompt\":\"...\"}]` fallback tag; use `at` or `cron` instead of `in` when needed, never include chatId/userId, and let the bridge confirm. Do not claim a reminder is scheduled unless the command succeeds or the bridge confirms the fallback.",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For reminders or recurring tasks, use `cctb cron add --in 10m --prompt \"...\"`, `cctb cron add --at ISO_TIME --prompt \"...\"`, or `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"...\"` when available; use `cctb cron list` to inspect. If `cctb cron` is unavailable, ask the user to send `/cron add <m h dom mon dow> <task>` in chat. Do not claim a reminder is scheduled unless the command succeeds.",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For reminders or recurring tasks, use `cctb cron add --in 10m --prompt \"...\"`, `cctb cron add --at ISO_TIME --prompt \"...\"`, or `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"...\"` when available; use `cctb cron list` to inspect. If `cctb cron` is unavailable, ask the user to send `/cron add <m h dom mon dow> <task>` in chat. Do not use Claude/Codex native schedule, cron, automation, reminder, loop, CronCreate, or ScheduleWakeup tools for Telegram reminders; they are session-local and may not deliver through Telegram. Do not claim a reminder is scheduled unless the command succeeds.",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For Telegram-delivered reminders or recurring tasks, use `cctb cron add --in 10m --prompt \"...\"`, `cctb cron add --at ISO_TIME --prompt \"...\"`, or `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"...\"` when available; use `cctb cron list` to inspect. If `cctb cron` is unavailable, ask the user to send `/cron add <m h dom mon dow> <task>` in chat. If the user explicitly asks for a native/session-local scheduler, you may use Claude/Codex native schedule, cron, automation, reminder, loop, CronCreate, or ScheduleWakeup tools, but first state that those jobs are session-local and may not persist or deliver through Telegram. Do not claim a Telegram reminder is scheduled unless the `cctb cron` or `/cron` command succeeds.",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For persistent recurring tasks that should send results back to this Telegram chat (\"every day at 9am summarize X\", \"每周一汇总…\"), use the Bash tool to call `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"<task>\"` (env `CCTB_CRON_URL` / `CCTB_CRON_TOKEN` are already set; PATH already has `cctb`). Run `cctb cron --help` to see all subcommands (list, delete, toggle, etc.). The user can also type `/cron ...` directly in chat. Do NOT use the Claude Code `schedule` skill (detached, output won't reach Telegram), the `loop` skill (single-session only, dies when turn ends), or system `crontab`/`at` (won't survive bot restart). `ScheduleWakeup` is acceptable only for short within-turn waits (<10 minutes).",
  ].join("\n"),
  [
    "## Scheduled Tasks",
    "",
    "For persistent recurring tasks that should send results back to this Telegram chat (\"every day at 9am summarize X\", \"每周一汇总…\"), prefer asking the user to send `/cron add <m h dom mon dow> <task>` in chat. In turn-scoped CLI sessions, `cctb cron add --cron \"<m h dom mon dow>\" --prompt \"<task>\"` may also be available; if it reports missing `CCTB_CRON_URL` / `CCTB_CRON_TOKEN`, fall back to the chat `/cron` command. Do NOT use the Claude Code `schedule` skill (detached, output won't reach Telegram), the `loop` skill (single-session only, dies when turn ends), or system `crontab`/`at` (won't survive bot restart). `ScheduleWakeup` is acceptable only for short within-turn waits (<10 minutes).",
  ].join("\n"),
];

const LEGACY_GENERATED_TELEGRAM_TRANSPORT_BLOCKS = [
  [
    "## Telegram Transport",
    "",
    "Plain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`; if `cctb` is unavailable, emit [tool:{\"name\":\"send.file\",\"payload\":{\"path\":\"/absolute/path\"}}] or `send.image`; small text/code may use one fenced `file:name.ext` block; never claim delivery by path only.",
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    "Plain text only; ask in chat, not blocking prompt tools; deliver files with `telegram send --file PATH` / `telegram send --image PATH`, write disk outputs to `.telegram-out/current`, or use one fenced `file:name.ext` block for small text/code; never claim delivery by only naming a path.",
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    "Plain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`, or one fenced `file:name.ext` block for small text/code; never claim delivery by path only.",
  ].join("\n"),
  [
    "## Telegram Transport",
    "",
    "Plain text only; ask in chat, not blocking prompt tools; deliver files with `cctb send --file PATH` / `cctb send --image PATH`; if `cctb` is unavailable, use `[send-file:<absolute path>]` / `[send-image:<absolute path>]`; small text/code may use one fenced `file:name.ext` block; never claim delivery by path only.",
  ].join("\n"),
];

export type InstanceAgentInstructionsState =
  | "missing"
  | "empty"
  | "current"
  | "legacy-generated"
  | "custom-transport"
  | "no-transport";

export interface InstanceAgentInstructionsInspection {
  state: InstanceAgentInstructionsState;
  path: string;
  detail: string;
}

export interface InstanceAgentInstructionsUpgradeResult {
  status: "created" | "current" | "upgraded" | "appended" | "manual-review" | "force-upgraded";
  path: string;
  changed: boolean;
  dryRun?: boolean;
  backupPath?: string;
}

function trimForCompare(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function findTelegramTransportSection(content: string): { start: number; end: number; text: string } | null {
  const normalized = content.replace(/\r\n/g, "\n");
  const heading = /^## Telegram Transport[^\n]*\n?/m.exec(normalized);
  if (!heading || heading.index === undefined) {
    return null;
  }
  const start = heading.index;
  const afterHeading = start + heading[0].length;
  const nextHeading = /^## (?!Telegram Transport\b)[^\n]*\n?/m.exec(normalized.slice(afterHeading));
  const end = nextHeading?.index === undefined ? normalized.length : afterHeading + nextHeading.index;
  return { start, end, text: normalized.slice(start, end) };
}

export function inspectInstanceAgentInstructionsContent(
  content: string,
  agentPath = "",
): InstanceAgentInstructionsInspection {
  const trimmed = trimForCompare(content);
  if (!trimmed) {
    return { state: "empty", path: agentPath, detail: "agent.md is empty" };
  }
  if (trimmed.includes(trimForCompare(DEFAULT_INSTANCE_AGENT_INSTRUCTIONS))) {
    return { state: "current", path: agentPath, detail: "Telegram transport instructions are current" };
  }

  const section = findTelegramTransportSection(content);
  if (!section) {
    return { state: "no-transport", path: agentPath, detail: "agent.md has no Telegram Transport section" };
  }

  const sectionText = trimForCompare(section.text);
  if (LEGACY_GENERATED_TELEGRAM_TRANSPORT_BLOCKS.some((block) => trimForCompare(block) === sectionText)) {
    return { state: "legacy-generated", path: agentPath, detail: "Telegram Transport section uses an older generated template" };
  }

  return { state: "custom-transport", path: agentPath, detail: "Telegram Transport section is custom or unknown" };
}

function replaceTelegramTransportSection(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const section = findTelegramTransportSection(normalized);
  if (!section) {
    const prefix = normalized.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${DEFAULT_INSTANCE_AGENT_INSTRUCTIONS}`;
  }

  const before = normalized.slice(0, section.start).trimEnd();
  let after = normalized.slice(section.end).trimStart();
  for (const block of GENERATED_SCHEDULED_TASKS_BLOCKS) {
    const normalizedBlock = trimForCompare(block);
    if (trimForCompare(after).startsWith(normalizedBlock)) {
      after = after.slice(after.indexOf("## Scheduled Tasks") + block.length).trimStart();
      break;
    }
  }
  return `${before}${before ? "\n\n" : ""}${DEFAULT_INSTANCE_AGENT_INSTRUCTIONS}${after ? `\n\n${after}` : ""}`;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

async function writeAgentBackup(agentPath: string, content: string, now: () => Date): Promise<string> {
  const baseBackupPath = `${agentPath}.bak.${Math.floor(now().getTime() / 1000)}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const backupPath = attempt === 0 ? baseBackupPath : `${baseBackupPath}-${attempt}`;
    try {
      await writeFile(backupPath, content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return backupPath;
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not create unique backup path for ${agentPath}`);
}

export async function inspectInstanceAgentInstructions(
  env: Pick<InstanceTokenEnv, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): Promise<InstanceAgentInstructionsInspection> {
  const agentPath = resolveInstanceAgentInstructionsPath(env, instanceName);
  try {
    return inspectInstanceAgentInstructionsContent(await readFile(agentPath, "utf8"), agentPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { state: "missing", path: agentPath, detail: "agent.md is missing" };
    }
    throw error;
  }
}

export async function upgradeInstanceAgentInstructions(
  env: Pick<InstanceTokenEnv, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
  options: { force?: boolean; dryRun?: boolean; now?: () => Date } = {},
): Promise<InstanceAgentInstructionsUpgradeResult> {
  const agentPath = resolveInstanceAgentInstructionsPath(env, instanceName);
  if (!options.dryRun) {
    await mkdir(path.dirname(agentPath), { recursive: true, mode: 0o700 });
  }

  let content: string | undefined;
  try {
    content = await readFile(agentPath, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      if (options.dryRun) {
        return { status: "created", path: agentPath, changed: false, dryRun: true };
      }
      await writeFile(agentPath, DEFAULT_INSTANCE_AGENT_INSTRUCTIONS, { encoding: "utf8", mode: 0o600 });
      return { status: "created", path: agentPath, changed: true };
    }
    throw error;
  }

  const inspection = inspectInstanceAgentInstructionsContent(content, agentPath);
  if (inspection.state === "current") {
    return { status: "current", path: agentPath, changed: false };
  }
  if (inspection.state === "empty") {
    if (options.dryRun) {
      return { status: "created", path: agentPath, changed: false, dryRun: true };
    }
    await writeFile(agentPath, DEFAULT_INSTANCE_AGENT_INSTRUCTIONS, { encoding: "utf8", mode: 0o600 });
    return { status: "created", path: agentPath, changed: true };
  }
  if (inspection.state === "no-transport") {
    if (options.dryRun) {
      return { status: "appended", path: agentPath, changed: false, dryRun: true };
    }
    await writeFile(agentPath, replaceTelegramTransportSection(content), { encoding: "utf8", mode: 0o600 });
    return { status: "appended", path: agentPath, changed: true };
  }
  if (inspection.state === "legacy-generated") {
    if (options.dryRun) {
      return { status: "upgraded", path: agentPath, changed: false, dryRun: true };
    }
    await writeFile(agentPath, replaceTelegramTransportSection(content), { encoding: "utf8", mode: 0o600 });
    return { status: "upgraded", path: agentPath, changed: true };
  }
  if (!options.force) {
    return { status: "manual-review", path: agentPath, changed: false };
  }

  if (options.dryRun) {
    return { status: "force-upgraded", path: agentPath, changed: false, dryRun: true };
  }
  const backupPath = await writeAgentBackup(agentPath, content, options.now ?? (() => new Date()));
  await writeFile(agentPath, replaceTelegramTransportSection(content), { encoding: "utf8", mode: 0o600 });
  return { status: "force-upgraded", path: agentPath, changed: true, backupPath };
}

export function resolveInstanceAccessStatePath(
  env: Pick<InstanceTokenEnv, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): string {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
  });

  return joinStatePath(stateDir, "access.json");
}

export function resolveInstanceAgentInstructionsPath(
  env: Pick<InstanceTokenEnv, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): string {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
  });

  return joinStatePath(stateDir, "agent.md");
}

export async function ensureDefaultInstanceAgentInstructions(
  env: Pick<InstanceTokenEnv, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR">,
  instanceName: string,
): Promise<{ path: string; created: boolean }> {
  const agentPath = resolveInstanceAgentInstructionsPath(env, instanceName);

  await mkdir(path.dirname(agentPath), { recursive: true, mode: 0o700 });

  try {
    await writeFile(agentPath, DEFAULT_INSTANCE_AGENT_INSTRUCTIONS, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { path: agentPath, created: true };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      return { path: agentPath, created: false };
    }
    throw error;
  }
}

export async function writeInstanceBotToken(
  env: InstanceTokenEnv,
  instanceName: string,
  botToken: string,
): Promise<PersistedInstanceToken> {
  const normalizedInstanceName = normalizeInstanceName(instanceName);
  const stateDir = resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
    CODEX_TELEGRAM_INSTANCE: normalizedInstanceName,
  });
  const envPath = joinStatePath(stateDir, ".env");
  const nextLine = `TELEGRAM_BOT_TOKEN=${JSON.stringify(botToken)}`;
  let contents = nextLine;

  try {
    const existing = await readFile(envPath, "utf8");
    const lines = existing.replace(/\r?\n$/, "").split(/\r?\n/);
    const mergedLines = lines.filter((line) => !line.startsWith("TELEGRAM_BOT_TOKEN="));
    mergedLines.push(nextLine);
    contents = mergedLines.join("\n");
    contents += "\n";
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }

    contents = `${nextLine}\n`;
  }

  await mkdir(path.dirname(envPath), { recursive: true, mode: 0o700 });
  await writeFile(envPath, contents, { encoding: "utf8", mode: 0o600 });
  await ensureDefaultInstanceAgentInstructions(env, normalizedInstanceName);
  await appendAuditEvent(stateDir, {
    type: "configure.token",
    instanceName: normalizedInstanceName,
    outcome: "success",
  });

  return { instanceName: normalizedInstanceName, stateDir, envPath };
}
