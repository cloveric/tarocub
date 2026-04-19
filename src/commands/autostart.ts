import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { EnvSource } from "../config.js";
import { resolveInstanceStateDir } from "../config.js";
import { normalizeInstanceName } from "../instance.js";

const execFile = promisify(nodeExecFile);

const AUTOSTART_LABEL_PREFIX = "com.cloveric.cc-telegram-bridge.";

export interface AutostartCommandEnv
  extends Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR" | "CODEX_HOME" | "CLAUDE_CONFIG_DIR"> {
  USER?: string;
}

export interface AutostartLogger {
  log: (message: string) => void;
}

export interface AutostartStatus {
  loaded: boolean;
  running: boolean;
  pid: number | null;
}

export interface AutostartCommandDeps {
  cwd?: string;
  uid?: number;
  nodePath?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  bootstrap?: (label: string, plistPath: string) => Promise<void>;
  enable?: (label: string) => Promise<void>;
  kickstart?: (label: string) => Promise<void>;
  bootout?: (plistPath: string) => Promise<void>;
  inspect?: (label: string) => Promise<AutostartStatus>;
}

function resolveHomeDir(env: Pick<AutostartCommandEnv, "HOME" | "USERPROFILE">): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home) {
    throw new Error(process.platform === "win32" ? "USERPROFILE or HOME is required" : "HOME or USERPROFILE is required");
  }
  return home;
}

function resolveLaunchAgentsDir(env: Pick<AutostartCommandEnv, "HOME" | "USERPROFILE">): string {
  return path.join(resolveHomeDir(env), "Library", "LaunchAgents");
}

function resolveUserName(env: Pick<AutostartCommandEnv, "HOME" | "USERPROFILE" | "USER">): string {
  const explicitUser = env.USER?.trim();
  if (explicitUser) {
    return explicitUser;
  }

  const inheritedUser = process.env.USER?.trim();
  if (inheritedUser) {
    return inheritedUser;
  }

  return path.basename(resolveHomeDir(env));
}

function resolveChannelsDir(env: Pick<AutostartCommandEnv, "HOME" | "USERPROFILE">): string {
  return path.join(resolveHomeDir(env), ".cctb");
}

function resolveInstanceAutostartStateDir(env: AutostartCommandEnv, instanceName: string): string {
  return resolveInstanceStateDir({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_INSTANCE: instanceName,
    CODEX_TELEGRAM_STATE_DIR: env.CODEX_TELEGRAM_STATE_DIR,
  });
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function buildLabel(instanceName: string): string {
  return `${AUTOSTART_LABEL_PREFIX}${instanceName}`;
}

function buildPlistPath(env: Pick<AutostartCommandEnv, "HOME" | "USERPROFILE">, instanceName: string): string {
  return path.join(resolveLaunchAgentsDir(env), `${buildLabel(instanceName)}.plist`);
}

function parseAutostartInstanceOption(argv: string[]): { instanceName?: string; args: string[] } {
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

function renderLaunchAgentPlist(
  env: AutostartCommandEnv,
  instanceName: string,
  cwd: string,
  nodePath: string,
  pathEnv: string,
): string {
  const homeDir = resolveHomeDir(env);
  const environmentVariables = [
    ["HOME", homeDir],
    ["USER", resolveUserName(env)],
    ["USERPROFILE", env.USERPROFILE ?? homeDir],
    ...(env.CODEX_TELEGRAM_STATE_DIR ? ([["CODEX_TELEGRAM_STATE_DIR", env.CODEX_TELEGRAM_STATE_DIR]] as const) : []),
    ["CODEX_HOME", env.CODEX_HOME ?? path.join(homeDir, ".codex")],
    ["CLAUDE_CONFIG_DIR", env.CLAUDE_CONFIG_DIR ?? path.join(homeDir, ".claude")],
    ["PATH", pathEnv],
  ]
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");

  const stateDir = resolveInstanceAutostartStateDir(env, instanceName);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(buildLabel(instanceName))}</string>`,
    "",
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(nodePath)}</string>`,
    `    <string>${xmlEscape(path.join(cwd, "dist", "src", "index.js"))}</string>`,
    "    <string>--instance</string>",
    `    <string>${xmlEscape(instanceName)}</string>`,
    "  </array>",
    "",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(cwd)}</string>`,
    "",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    environmentVariables,
    "  </dict>",
    "",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(path.join(stateDir, "service.stdout.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(path.join(stateDir, "service.stderr.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function listDirectoryNames(directoryPath: string): Promise<string[]> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listAutostartEntries(env: Pick<AutostartCommandEnv, "HOME" | "USERPROFILE">): Promise<string[]> {
  try {
    const entries = await readdir(resolveLaunchAgentsDir(env), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(AUTOSTART_LABEL_PREFIX) && entry.name.endsWith(".plist"))
      .map((entry) => entry.name.slice(AUTOSTART_LABEL_PREFIX.length, -".plist".length))
      .sort();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function createDefaultDeps(uid: number): Required<AutostartCommandDeps> {
  const launchctlDomain = `gui/${uid}`;

  return {
    cwd: process.cwd(),
    uid,
    nodePath: process.execPath,
    pathEnv: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    platform: process.platform,
    bootstrap: async (_label, plistPath) => {
      await execFile("launchctl", ["bootstrap", launchctlDomain, plistPath]);
    },
    enable: async (label) => {
      await execFile("launchctl", ["enable", `${launchctlDomain}/${label}`]);
    },
    kickstart: async (label) => {
      await execFile("launchctl", ["kickstart", "-k", `${launchctlDomain}/${label}`]);
    },
    bootout: async (plistPath) => {
      await execFile("launchctl", ["bootout", launchctlDomain, plistPath]);
    },
    inspect: async (label) => {
      try {
        const { stdout } = await execFile("launchctl", ["print", `${launchctlDomain}/${label}`]);
        return parseLaunchctlPrintStatus(stdout);
      } catch {
        return {
          loaded: false,
          running: false,
          pid: null,
        };
      }
    },
  };
}

export function parseLaunchctlPrintStatus(stdout: string): AutostartStatus {
  const pidMatch = stdout.match(/(?:^|\n)\s*pid = (\d+)/);
  return {
    loaded: true,
    running: /(?:^|\n)\s*state = running\b/.test(stdout),
    pid: pidMatch ? Number(pidMatch[1]) : null,
  };
}

function withDeps(deps: AutostartCommandDeps = {}): Required<AutostartCommandDeps> {
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  return {
    ...createDefaultDeps(uid),
    platform: process.platform,
    ...deps,
  };
}

async function syncInstanceAutostart(
  env: AutostartCommandEnv,
  instanceName: string,
  deps: Required<AutostartCommandDeps>,
): Promise<void> {
  const stateDir = resolveInstanceAutostartStateDir(env, instanceName);
  if (!(await fileExists(stateDir))) {
    throw new Error(`Instance "${instanceName}" not found.`);
  }

  const launchAgentsDir = resolveLaunchAgentsDir(env);
  await mkdir(launchAgentsDir, { recursive: true });

  const plistPath = buildPlistPath(env, instanceName);
  const plist = renderLaunchAgentPlist(env, instanceName, deps.cwd, deps.nodePath, deps.pathEnv);
  await writeFile(plistPath, plist, "utf8");

  try {
    await deps.bootout(plistPath);
  } catch {}
  await deps.bootstrap(buildLabel(instanceName), plistPath);
  await deps.enable(buildLabel(instanceName));
  await deps.kickstart(buildLabel(instanceName));
}

async function removeInstanceAutostart(
  env: Pick<AutostartCommandEnv, "HOME" | "USERPROFILE">,
  instanceName: string,
  deps: Required<AutostartCommandDeps>,
): Promise<void> {
  const plistPath = buildPlistPath(env, instanceName);
  if (await fileExists(plistPath)) {
    try {
      await deps.bootout(plistPath);
    } catch {}
    await rm(plistPath, { force: true });
  }
}

function usage(): string {
  return "Usage: telegram autostart <status|up|down|restart|sync|remove|add> [--instance <name>] [--prune]";
}

export async function runAutostartCommand(
  argv: string[],
  env: AutostartCommandEnv,
  logger: AutostartLogger,
  deps: AutostartCommandDeps = {},
): Promise<boolean> {
  if (argv.length < 2) {
    throw new Error(usage());
  }

  const subcommand = argv[1];
  const parsed = parseAutostartInstanceOption(argv.slice(2));
  const actualDeps = withDeps(deps);
  if (actualDeps.platform !== "darwin") {
    throw new Error("telegram autostart is currently supported only on macOS (launchd).");
  }

  if (env.CODEX_TELEGRAM_STATE_DIR && !parsed.instanceName && (subcommand === "sync" || subcommand === "add" || subcommand === "status")) {
    throw new Error('When CODEX_TELEGRAM_STATE_DIR is set, pass "--instance <name>" to telegram autostart.');
  }

  if (subcommand === "sync" || subcommand === "add") {
    const prune = parsed.args.includes("--prune");
    const extraArgs = parsed.args.filter((argument) => argument !== "--prune");
    if (extraArgs.length > 0) {
      throw new Error(usage());
    }

    if (parsed.instanceName) {
      await syncInstanceAutostart(env, parsed.instanceName, actualDeps);
      logger.log(`Synced autostart for instance "${parsed.instanceName}".`);
      return true;
    }

    const instances = await listDirectoryNames(resolveChannelsDir(env));
    for (const instanceName of instances) {
      await syncInstanceAutostart(env, instanceName, actualDeps);
    }

    let pruned = 0;
    if (prune) {
      const autostartEntries = await listAutostartEntries(env);
      const instanceSet = new Set(instances);
      for (const instanceName of autostartEntries) {
        if (!instanceSet.has(instanceName)) {
          await removeInstanceAutostart(env, instanceName, actualDeps);
          pruned++;
        }
      }
    }

    logger.log(
      prune
        ? `Synced autostart for ${instances.length} instances and pruned ${pruned} stale entr${pruned === 1 ? "y" : "ies"}.`
        : `Synced autostart for ${instances.length} instances.`,
    );
    return true;
  }

  if (subcommand === "remove") {
    const instanceName = parsed.instanceName ?? "default";
    if (parsed.args.length !== 0) {
      throw new Error(usage());
    }
    await removeInstanceAutostart(env, instanceName, actualDeps);
    logger.log(`Removed autostart for instance "${instanceName}".`);
    return true;
  }

  if (subcommand === "up") {
    const instanceName = parsed.instanceName ?? "default";
    if (parsed.args.length !== 0) {
      throw new Error(usage());
    }
    const plistPath = buildPlistPath(env, instanceName);
    if (!(await fileExists(plistPath))) {
      throw new Error(`Autostart plist for instance "${instanceName}" not found. Run "telegram autostart sync --instance ${instanceName}" first.`);
    }
    try {
      await actualDeps.bootout(plistPath);
    } catch {}
    await actualDeps.bootstrap(buildLabel(instanceName), plistPath);
    await actualDeps.enable(buildLabel(instanceName));
    await actualDeps.kickstart(buildLabel(instanceName));
    logger.log(`Started autostart-managed instance "${instanceName}".`);
    return true;
  }

  if (subcommand === "down") {
    const instanceName = parsed.instanceName ?? "default";
    if (parsed.args.length !== 0) {
      throw new Error(usage());
    }
    const plistPath = buildPlistPath(env, instanceName);
    if (!(await fileExists(plistPath))) {
      throw new Error(`Autostart plist for instance "${instanceName}" not found.`);
    }
    await actualDeps.bootout(plistPath);
    logger.log(`Stopped autostart-managed instance "${instanceName}".`);
    return true;
  }

  if (subcommand === "restart") {
    const instanceName = parsed.instanceName ?? "default";
    if (parsed.args.length !== 0) {
      throw new Error(usage());
    }
    const plistPath = buildPlistPath(env, instanceName);
    if (!(await fileExists(plistPath))) {
      throw new Error(`Autostart plist for instance "${instanceName}" not found. Run "telegram autostart sync --instance ${instanceName}" first.`);
    }
    try {
      await actualDeps.bootout(plistPath);
    } catch {}
    await actualDeps.bootstrap(buildLabel(instanceName), plistPath);
    await actualDeps.enable(buildLabel(instanceName));
    await actualDeps.kickstart(buildLabel(instanceName));
    logger.log(`Restarted autostart-managed instance "${instanceName}".`);
    return true;
  }

  if (subcommand === "status") {
    if (parsed.args.length !== 0) {
      throw new Error(usage());
    }

    const discoveredInstances = parsed.instanceName
      ? [parsed.instanceName]
      : await listDirectoryNames(resolveChannelsDir(env));
    const autostartEntries = parsed.instanceName
      ? (await fileExists(buildPlistPath(env, parsed.instanceName))) ? [parsed.instanceName] : []
      : await listAutostartEntries(env);

    const names = [...new Set([...discoveredInstances, ...autostartEntries])].sort();
    if (names.length === 0) {
      logger.log("No autostart entries found.");
      return true;
    }

    logger.log(`Autostart entries (${names.length}):`);
    for (const instanceName of names) {
      const status = await actualDeps.inspect(buildLabel(instanceName));
      const managed = discoveredInstances.includes(instanceName);
      logger.log(
        `  - ${instanceName} managed=${managed ? "yes" : "no"} loaded=${status.loaded ? "yes" : "no"} running=${status.running ? "yes" : "no"} pid=${status.pid ?? "none"}`,
      );
    }
    return true;
  }

  throw new Error(usage());
}
