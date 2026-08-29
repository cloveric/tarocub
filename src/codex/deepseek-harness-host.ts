import { randomUUID } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  DeepSeekHarnessProtocolClient,
  type DeepSeekHarnessProtocolHandlers,
  type DeepSeekHarnessProtocolOptions,
} from "./deepseek-harness-protocol.js";

export interface DeepSeekHarnessReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  off(event: "data", listener: (chunk: Buffer | string) => void): this;
}

export interface DeepSeekHarnessChildProcess {
  readonly stdout: DeepSeekHarnessReadable;
  readonly stderr: DeepSeekHarnessReadable;
  readonly pid?: number;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  off(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface DeepSeekHarnessSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
  shell?: boolean;
}

export type SpawnDeepSeekHarness = (
  executable: string,
  args: string[],
  options: DeepSeekHarnessSpawnOptions,
) => DeepSeekHarnessChildProcess;

interface DeepSeekHarnessProtocol {
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

export interface DeepSeekHarnessHostOptions {
  executable: string;
  sharedHome: string;
  stateDir: string;
  workspacePath: string;
  searchMcp?: DeepSeekHarnessSearchMcp;
  instructionsPath?: string;
  childEnv?: NodeJS.ProcessEnv;
  spawnDsh?: SpawnDeepSeekHarness;
  protocolFactory?: (baseUrl: string) => DeepSeekHarnessProtocol;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  restartDelayMs?: number;
  onDiagnostic?: (message: string) => void;
}

export interface DeepSeekHarnessSearchMcp {
  command: string;
  args: string[];
  cwd: string;
}

const WEB_ARGS = ["web", "--no-open", "--host", "127.0.0.1", "--port", "0"];
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 30_000;
const MAX_DIAGNOSTIC_CHARS = 4_096;

export function createDeepSeekHarnessProtocolOptions(
  onDiagnostic?: (message: string) => void,
): DeepSeekHarnessProtocolOptions {
  return {
    onMalformedFrame: (error) => {
      onDiagnostic?.(
        `DeepSeek Harness ignored a malformed downlink frame: ${formatDiagnosticError(error)}`,
      );
    },
    onHandlerError: (error) => {
      onDiagnostic?.(
        `DeepSeek Harness downlink handler failed: ${formatDiagnosticError(error)}`,
      );
    },
  };
}

export class DeepSeekHarnessHost {
  private readonly executable: string;
  private readonly options: DeepSeekHarnessHostOptions;
  private readonly spawnDsh: SpawnDeepSeekHarness;
  private readonly protocolFactory: (baseUrl: string) => DeepSeekHarnessProtocol;
  private handlers: DeepSeekHarnessProtocolHandlers | undefined;
  private child: DeepSeekHarnessChildProcess | undefined;
  private protocol: DeepSeekHarnessProtocol | undefined;
  private readyPromise: Promise<void> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private restartAttempts = 0;
  private generation = 0;
  private restartRequired = false;
  private closing = false;

  constructor(options: DeepSeekHarnessHostOptions) {
    this.options = options;
    this.executable = stripMatchingQuotes(options.executable);
    this.spawnDsh = options.spawnDsh ?? defaultSpawnDeepSeekHarness;
    this.protocolFactory = options.protocolFactory ?? ((baseUrl) => new DeepSeekHarnessProtocolClient(
      baseUrl,
      createDeepSeekHarnessProtocolOptions(options.onDiagnostic),
    ));
  }

  async connect(handlers: DeepSeekHarnessProtocolHandlers): Promise<void> {
    this.handlers = handlers;
    this.closing = false;
    await this.ensureReady(false);
  }

  async request(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.ensureReady(false);
    return await this.requireProtocol().request(method, payload, signal);
  }

  async respond(rpcId: string, value: unknown, signal?: AbortSignal): Promise<{ accepted: boolean; reason?: string }> {
    await this.ensureReady(false);
    return await this.requireProtocol().respond(rpcId, value, signal);
  }

  async respondError(
    rpcId: string,
    error: { code: string; message: string; details?: unknown },
    signal?: AbortSignal,
  ): Promise<{ accepted: boolean; reason?: string }> {
    await this.ensureReady(false);
    return await this.requireProtocol().respondError(rpcId, error, signal);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.handlers = undefined;
    this.generation += 1;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const protocol = this.protocol;
    const child = this.child;
    this.protocol = undefined;
    this.child = undefined;
    this.readyPromise = undefined;
    this.restartRequired = false;
    await protocol?.close().catch(() => {});
    if (child) {
      await stopChild(child, this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    }
  }

  private async ensureReady(isRestart: boolean): Promise<void> {
    if (this.closing) {
      throw new Error("DeepSeek Harness host is closed");
    }
    if (this.protocol) {
      return;
    }
    if (!this.handlers) {
      throw new Error("DeepSeek Harness host is not connected");
    }
    if (!this.readyPromise) {
      const generation = ++this.generation;
      // Any caller may be the first one to demand the replacement process after
      // a crash. Preserve the crash identity independently of the restart timer
      // so an ordinary RPC cannot accidentally turn a restart into a silent
      // "initial" start and suppress adapter recovery.
      const starting = this.startGeneration(generation, isRestart || this.restartRequired);
      this.readyPromise = starting;
      void starting.catch(() => {}).finally(() => {
        if (this.readyPromise === starting && !this.protocol) {
          this.readyPromise = undefined;
        }
      });
    }
    await this.readyPromise;
  }

  private async startGeneration(generation: number, isRestart: boolean): Promise<void> {
    const prepared = await prepareDeepSeekHarnessHome({
      sharedHome: this.options.sharedHome,
      stateDir: this.options.stateDir,
      instructionsPath: this.options.instructionsPath,
      searchMcp: this.options.searchMcp,
      onDiagnostic: this.options.onDiagnostic,
    });
    if (this.closing || generation !== this.generation) {
      throw new Error("DeepSeek Harness host closed during startup");
    }

    const child = this.spawnDsh(this.executable, [...WEB_ARGS], {
      cwd: this.options.workspacePath,
      env: {
        ...(this.options.childEnv ?? process.env),
        DSH_HOME: prepared.home,
        DSH_PERMISSION_MODE: "workspace-write",
        TAROCUB_SEARCH_MCP_OWNER: prepared.searchMcpOwner,
      },
      stdio: ["ignore", "pipe", "pipe"],
      ...(process.platform === "win32" && /\.(?:cmd|bat)$/i.test(this.executable)
        ? { shell: true }
        : {}),
    });
    this.child = child;
    let published = false;
    let protocol: DeepSeekHarnessProtocol | undefined;
    const drainOutput = (_chunk: Buffer | string) => {};
    const runtimeError = (error: Error) => {
      if (!published || this.closing || generation !== this.generation) {
        return;
      }
      void this.handleRuntimeFailure(
        generation,
        child,
        new Error(`DeepSeek Harness runtime error: ${error.message}`, { cause: error }),
        true,
      );
    };
    const runtimeClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!published || this.closing || generation !== this.generation) {
        return;
      }
      void this.handleRuntimeFailure(
        generation,
        child,
        new Error(
          `DeepSeek Harness exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`,
        ),
        false,
      );
    };
    const cleanupRuntimeListeners = () => {
      child.stdout.off("data", drainOutput);
      child.stderr.off("data", drainOutput);
      child.off("error", runtimeError);
    };
    // Keep both pipes flowing after startup. Leaving a piped stream unread can
    // fill the OS buffer and block an otherwise healthy long-running Harness.
    child.stdout.on("data", drainOutput);
    child.stderr.on("data", drainOutput);
    child.on("error", runtimeError);
    child.on("close", runtimeClose);
    child.once("close", cleanupRuntimeListeners);

    try {
      const baseUrl = await waitForStartupUrl(
        child,
        this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      );
      if (this.closing || generation !== this.generation) {
        throw new Error("DeepSeek Harness host closed during startup");
      }
      protocol = this.protocolFactory(baseUrl);
      await protocol.connect(this.handlers!);
      if (this.closing || generation !== this.generation) {
        throw new Error("DeepSeek Harness host closed during startup");
      }
      this.protocol = protocol;
      published = true;
      if (isRestart) {
        await this.handlers?.onReconnect?.({ reason: "host-restart" });
      }
      if (
        this.closing
        || generation !== this.generation
        || this.child !== child
        || this.protocol !== protocol
      ) {
        throw new Error("DeepSeek Harness exited during reconnect recovery");
      }
      this.restartRequired = false;
    } catch (error) {
      child.off("close", runtimeClose);
      if (this.child === child) {
        this.child = undefined;
      }
      if (this.protocol === protocol) {
        this.protocol = undefined;
      }
      await protocol?.close().catch(() => {});
      await stopChild(child, this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS).catch(() => {});
      throw error;
    }
  }

  private async handleRuntimeFailure(
    generation: number,
    child: DeepSeekHarnessChildProcess,
    error: Error,
    terminateChild: boolean,
  ): Promise<void> {
    if (this.closing || generation !== this.generation || this.child !== child) {
      return;
    }
    this.child = undefined;
    const protocol = this.protocol;
    this.protocol = undefined;
    this.readyPromise = undefined;
    this.restartRequired = true;
    await protocol?.close().catch(() => {});
    this.options.onDiagnostic?.(error.message);
    try {
      await this.handlers?.onDisconnect?.(error);
    } catch (notifyError) {
      this.options.onDiagnostic?.(
        `DeepSeek Harness disconnect handler failed: ${
          notifyError instanceof Error ? notifyError.message : String(notifyError)
        }`,
      );
    } finally {
      if (terminateChild) {
        await stopChild(child, this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS)
          .catch(() => {});
      }
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.closing || !this.handlers || this.restartTimer) {
      return;
    }
    // Exponential backoff, capped: a permanently failing spawn (missing binary,
    // revoked credentials) used to retry every 500ms forever, logging twice a
    // second and spawning a process per attempt.
    const baseDelay = this.options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
    const delay = Math.min(baseDelay * 2 ** Math.min(this.restartAttempts, 10), MAX_RESTART_DELAY_MS);
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.ensureReady(true)
        .then(() => {
          this.restartAttempts = 0;
        })
        .catch((error) => {
          this.options.onDiagnostic?.(
            `DeepSeek Harness restart failed (attempt ${this.restartAttempts}, next in ${Math.min(baseDelay * 2 ** Math.min(this.restartAttempts, 10), MAX_RESTART_DELAY_MS)}ms): ${error instanceof Error ? error.message : String(error)}`,
          );
          this.scheduleRestart();
        });
    }, delay);
    this.restartTimer.unref?.();
  }

  private requireProtocol(): DeepSeekHarnessProtocol {
    if (!this.protocol) {
      throw new Error("DeepSeek Harness protocol is unavailable");
    }
    return this.protocol;
  }
}

export interface PrepareDeepSeekHarnessHomeOptions {
  sharedHome: string;
  stateDir: string;
  instructionsPath?: string;
  searchMcp?: DeepSeekHarnessSearchMcp;
  onDiagnostic?: (message: string) => void;
}

export type DeepSeekHarnessSearchMcpOwner = "bridge" | "plugin";

export interface PreparedDeepSeekHarnessHome {
  home: string;
  patchPath: string;
  searchMcpOwner: DeepSeekHarnessSearchMcpOwner;
}

const SEARCH_PLUGIN_NAME = "tarocub-deepseek-harness-plugin";
const SEARCH_MCP_PROTOCOL = 1;

const PERMISSION_PATCH = `
# TaroCub keeps full-auto sandboxed while bypass remains explicitly unconfined.
- id: permission
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      full-auto:
        sandbox: workspace-write
        approval: never
      danger-full-access:
        sandbox: danger-full-access
        approval: never
`;

function renderSearchMcpPatch(searchMcp: DeepSeekHarnessSearchMcp): string {
  const command = JSON.stringify(searchMcp.command);
  const args = JSON.stringify(searchMcp.args);
  const cwd = JSON.stringify(path.resolve(searchMcp.cwd));
  return `
# TaroCub exposes its source-traceable search server as native Harness tools.
- insert:
    - id: mcp-cctb-search-bridge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: cctb_search
        transport: stdio
        command: ${command}
        args: ${args}
        cwd: ${cwd}
        env:
          BRAVE_API_KEY: !!js process.env.BRAVE_API_KEY || ''
          BRAVE_SEARCH_API_KEY: !!js process.env.BRAVE_SEARCH_API_KEY || ''
          TAVILY_API_KEY: !!js process.env.TAVILY_API_KEY || ''
          CODEX_HOME: !!js process.env.CODEX_HOME || ''
          HOME: !!js process.env.HOME || ''
          USERPROFILE: !!js process.env.USERPROFILE || ''
        failOnStartupError: false
`;
}

export async function prepareDeepSeekHarnessHome(
  options: PrepareDeepSeekHarnessHomeOptions,
): Promise<PreparedDeepSeekHarnessHome> {
  const sharedHome = path.resolve(options.sharedHome);
  const searchMcpOwner = await detectSearchMcpOwner(sharedHome, options.onDiagnostic);
  const home = path.resolve(options.stateDir, "dsh-home");
  if (home === sharedHome || home.startsWith(`${sharedHome}${path.sep}`)) {
    throw new Error("DeepSeek Harness private home must not be inside the shared DSH_HOME");
  }

  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700).catch(() => {});
  await linkRequired(path.join(sharedHome, "profiles"), path.join(home, "profiles"), "dir");
  await copyRequiredFile(path.join(sharedHome, "settings.yaml"), path.join(home, "settings.yaml"));
  await linkRequired(
    path.join(sharedHome, ".credentials.yaml"),
    path.join(home, ".credentials.yaml"),
    "file",
  );

  const agentsPath = path.join(home, "AGENTS.md");
  if (options.instructionsPath) {
    await linkRequired(path.resolve(options.instructionsPath), agentsPath, "file");
  } else {
    await removeIfExists(agentsPath);
  }

  const sharedPatchPath = path.join(sharedHome, "cordis.patch.yml");
  const sharedPatch = await readOptionalFile(sharedPatchPath);
  const patchPath = path.join(home, "cordis.patch.yml");
  const prefix = isEmptyPatchDocument(sharedPatch) ? "" : sharedPatch.trimEnd();
  const localPatches = [
    PERMISSION_PATCH.trimStart(),
    ...(options.searchMcp && searchMcpOwner === "bridge"
      ? [renderSearchMcpPatch(options.searchMcp).trimStart()]
      : []),
  ];
  const patch = `${prefix ? `${prefix}\n` : ""}${localPatches.join("\n")}`;
  await writeFileAtomically(patchPath, patch, 0o600);

  return { home, patchPath, searchMcpOwner };
}

async function detectSearchMcpOwner(
  sharedHome: string,
  onDiagnostic?: (message: string) => void,
): Promise<DeepSeekHarnessSearchMcpOwner> {
  const packageRoot = path.join(
    sharedHome,
    "profiles",
    "web",
    "node_modules",
    SEARCH_PLUGIN_NAME,
  );
  const manifestPath = path.join(packageRoot, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "bridge";
    }
    onDiagnostic?.(
      `DeepSeek Harness Search MCP plugin manifest is unreadable; using bridge fallback: ${formatDiagnosticError(error)}`,
    );
    return "bridge";
  }

  if (!isRecord(manifest) || !isRecord(manifest.tarocub) || manifest.tarocub.searchMcp !== true) {
    return "bridge";
  }

  const protocol = manifest.tarocub.searchMcpProtocol;
  const entrypoint = manifest.tarocub.searchMcpEntrypoint;
  if (protocol !== SEARCH_MCP_PROTOCOL) {
    onDiagnostic?.(
      `DeepSeek Harness Search MCP plugin protocol ${String(protocol)} is unsupported; using bridge fallback.`,
    );
    return "bridge";
  }
  if (typeof entrypoint !== "string" || !entrypoint.trim()) {
    onDiagnostic?.(
      "DeepSeek Harness Search MCP plugin entrypoint is missing; using bridge fallback.",
    );
    return "bridge";
  }

  const resolvedEntrypoint = path.resolve(packageRoot, entrypoint);
  if (
    resolvedEntrypoint === packageRoot
    || !resolvedEntrypoint.startsWith(`${packageRoot}${path.sep}`)
  ) {
    onDiagnostic?.(
      "DeepSeek Harness Search MCP plugin entrypoint escapes its package; using bridge fallback.",
    );
    return "bridge";
  }

  try {
    const stat = await lstat(resolvedEntrypoint);
    if (!stat.isFile()) {
      throw new Error("entrypoint is not a file");
    }
  } catch (error) {
    onDiagnostic?.(
      `DeepSeek Harness Search MCP plugin entrypoint is missing; using bridge fallback: ${formatDiagnosticError(error)}`,
    );
    return "bridge";
  }

  const bundle = isRecord(manifest.dsh) && isRecord(manifest.dsh.bundle)
    ? manifest.dsh.bundle
    : undefined;
  const patchReference = bundle?.patch;
  if (typeof patchReference !== "string" || !patchReference.trim()) {
    onDiagnostic?.(
      "DeepSeek Harness Search MCP plugin patch is missing from dsh.bundle; using bridge fallback.",
    );
    return "bridge";
  }

  const resolvedPatch = path.resolve(packageRoot, patchReference);
  if (resolvedPatch === packageRoot || !resolvedPatch.startsWith(`${packageRoot}${path.sep}`)) {
    onDiagnostic?.(
      "DeepSeek Harness Search MCP plugin patch escapes its package; using bridge fallback.",
    );
    return "bridge";
  }

  let pluginPatch: string;
  try {
    const stat = await lstat(resolvedPatch);
    if (!stat.isFile()) {
      throw new Error("patch is not a file");
    }
    pluginPatch = await readFile(resolvedPatch, "utf8");
  } catch (error) {
    onDiagnostic?.(
      `DeepSeek Harness Search MCP plugin patch is missing; using bridge fallback: ${formatDiagnosticError(error)}`,
    );
    return "bridge";
  }

  if (!searchMcpPatchRegistersEntrypoint(pluginPatch, entrypoint)) {
    onDiagnostic?.(
      "DeepSeek Harness Search MCP plugin patch does not register the declared MCP client; using bridge fallback.",
    );
    return "bridge";
  }

  return "plugin";
}

function searchMcpPatchRegistersEntrypoint(patch: string, entrypoint: string): boolean {
  const normalizedPatch = patch.replaceAll("\\", "/");
  const normalizedEntrypoint = entrypoint.replaceAll("\\", "/").replace(/^\.\//, "");
  const lines = normalizedPatch.split(/\r?\n/);
  const start = lines.findIndex((line) => (
    /^\s*-\s+id:\s*["']?mcp-cctb-search["']?\s*$/.test(line)
  ));
  if (start < 0) {
    return false;
  }
  const componentIndent = /^\s*/.exec(lines[start]!)?.[0].length ?? 0;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const sequenceItem = /^(\s*)-\s+\S/.exec(lines[index]!);
    if (sequenceItem && sequenceItem[1]!.length <= componentIndent) {
      end = index;
      break;
    }
  }
  const component = lines.slice(start, end).join("\n");
  return /^\s+name:\s*["']?@deepseek-ai\/dsh-mcp-client["']?\s*$/m.test(component)
    && /^\s+config:\s*$/m.test(component)
    && /^\s+serverName:\s*["']?cctb_search["']?\s*$/m.test(component)
    && component.includes(normalizedEntrypoint);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyPatchDocument(contents: string): boolean {
  const meaningfulLines = contents
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:#.*)?$/.test(line));
  return meaningfulLines.length === 1 && /^\s*\[\]\s*(?:#.*)?$/.test(meaningfulLines[0]!);
}

async function copyRequiredFile(source: string, target: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(source, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`DeepSeek Harness shared file is missing: ${source}`);
    }
    throw error;
  }

  // Harness persists model selection in settings.yaml. Keep that write inside
  // the instance home instead of allowing it through to the desktop dsh home.
  await removeIfExists(target);
  await writeFileAtomically(target, contents, 0o600);
}

async function linkRequired(source: string, target: string, type: "dir" | "file"): Promise<void> {
  await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`DeepSeek Harness shared ${type} is missing: ${source}`);
    }
    throw error;
  });
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() && path.resolve(path.dirname(target), await readlink(target)) === source) {
      return;
    }
    await rm(target, { recursive: stat.isDirectory(), force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await symlink(source, target, process.platform === "win32" && type === "dir" ? "junction" : type);
}

async function removeIfExists(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    await rm(target, { recursive: stat.isDirectory(), force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeFileAtomically(filePath: string, contents: string, mode: number): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, contents, { encoding: "utf8", mode });
    await chmod(tempPath, mode).catch(() => {});
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

function defaultSpawnDeepSeekHarness(
  executable: string,
  args: string[],
  options: DeepSeekHarnessSpawnOptions,
): DeepSeekHarnessChildProcess {
  return spawnChild(executable, args, options) as unknown as DeepSeekHarnessChildProcess;
}

async function waitForStartupUrl(
  child: DeepSeekHarnessChildProcess,
  timeoutMs: number,
): Promise<string> {
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdout = "";
  let diagnostics = "";

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("close", onClose);
      child.off("error", onError);
      if (error) {
        reject(error);
      } else {
        resolve(value!);
      }
    };
    const appendDiagnostic = (value: string) => {
      diagnostics = `${diagnostics}${value}`.slice(-MAX_DIAGNOSTIC_CHARS);
    };
    const onStdout = (chunk: Buffer | string) => {
      const value = decodeChunk(stdoutDecoder, chunk);
      stdout = `${stdout}${value}`.slice(-MAX_DIAGNOSTIC_CHARS);
      appendDiagnostic(value);
      const match = stdout.match(/dsh web:\s*(https?:\/\/127\.0\.0\.1:\d{1,5})(?=\s|$)/i);
      if (!match?.[1]) {
        return;
      }
      try {
        const url = new URL(match[1]);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
          finish(new Error(`DeepSeek Harness published an unsafe startup URL: ${match[1]}`));
          return;
        }
        finish(undefined, url.origin);
      } catch (error) {
        finish(new Error(`DeepSeek Harness published an invalid startup URL: ${String(error)}`));
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      appendDiagnostic(decodeChunk(stderrDecoder, chunk));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = cleanDiagnostic(diagnostics);
      finish(new Error(
        `DeepSeek Harness exited before startup (code=${code ?? "null"}, signal=${signal ?? "none"})${
          detail ? `: ${detail}` : ""
        }`,
      ));
    };
    const onError = (error: Error) => {
      finish(new Error(`DeepSeek Harness failed to start: ${error.message}`, { cause: error }));
    };
    const timer = setTimeout(() => {
      const detail = cleanDiagnostic(diagnostics);
      finish(new Error(
        `DeepSeek Harness startup timed out after ${timeoutMs}ms${detail ? `: ${detail}` : ""}`,
      ));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function stopChild(child: DeepSeekHarnessChildProcess, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      child.off("close", onClose);
      child.off("error", onError);
      resolve();
    };
    const onClose = () => finish();
    const onError = () => finish();
    child.once("close", onClose);
    child.once("error", onError);

    try {
      if (!child.kill("SIGTERM")) {
        finish();
        return;
      }
    } catch {
      finish();
      return;
    }
    killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        finish();
        return;
      }
      forceTimer = setTimeout(finish, 250);
      forceTimer.unref?.();
    }, timeoutMs);
    killTimer.unref?.();
  });
}

function decodeChunk(decoder: StringDecoder, chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : decoder.write(chunk);
}

function cleanDiagnostic(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(-1_000);
}

function formatDiagnosticError(error: unknown): string {
  return cleanDiagnostic(error instanceof Error ? error.message : String(error)) || "unknown error";
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
