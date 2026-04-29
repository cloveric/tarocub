import type { CronJobRecord } from "./state/cron-store-schema.js";

export interface CronCliEnv {
  [key: string]: string | undefined;
  CCTB_CRON_URL?: string;
  CCTB_CRON_TOKEN?: string;
}

export interface CronCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CronCliOptions {
  env?: CronCliEnv;
  fetchFn?: typeof fetch;
  io?: CronCliIo;
}

export interface CronCliResult {
  exitCode: number;
}

const USAGE = [
  "Usage: cctb cron <command> [options]",
  "",
  "Commands:",
  "  add (--cron <expr> | --in <duration> | --at <iso-time>) --prompt <text>",
  "      [--description <text>]",
  "  add <cron-expr> <prompt...>",
  "      Positional form: 5-field cron expression followed by prompt text.",
  "  list",
  "      List cron jobs scoped to the current chat.",
  "",
  "Examples:",
  "  cctb cron add --in 10m --prompt \"drink water\"",
  "  cctb cron add --at 2026-04-29T09:00:00+08:00 --prompt \"morning summary\"",
  "",
  "Environment:",
  "  CCTB_CRON_URL    Helper server URL (set by the bridge).",
  "  CCTB_CRON_TOKEN  Bearer token for the helper server.",
].join("\n");

function defaultIo(): CronCliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

function isHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

interface AddArgs {
  cronExpr?: string;
  runAt?: string;
  prompt: string;
  description?: string;
}

const CRON_FIELD_REGEX = /^[A-Za-z0-9*\-/,?#L]+$/;

function looksLikeCronField(token: string): boolean {
  return CRON_FIELD_REGEX.test(token);
}

function looksLikeFiveFieldCron(tokens: string[]): boolean {
  if (tokens.length < 5) {
    return false;
  }
  for (let i = 0; i < 5; i++) {
    if (!looksLikeCronField(tokens[i]!)) {
      return false;
    }
  }
  return true;
}

const DURATION_RE = /^(\d+)(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;

function parseDurationMs(value: string): number {
  const match = DURATION_RE.exec(value.trim());
  if (!match) {
    throw new Error(`--in must be a duration like 10m, 2h, or 1d, got "${value}"`);
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier =
    unit.startsWith("s") ? 1000 :
      unit.startsWith("m") ? 60_000 :
        unit.startsWith("h") ? 60 * 60_000 :
          24 * 60 * 60_000;
  const ms = amount * multiplier;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 366 * 24 * 60 * 60_000) {
    throw new Error("--in must be greater than 0 and no more than 366 days");
  }
  return ms;
}

function parseRunAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--at must be a valid date/time, got "${value}"`);
  }
  if (date.getTime() <= Date.now()) {
    throw new Error("--at must be in the future");
  }
  return date.toISOString();
}

function parseAddArgs(argv: string[]): AddArgs {
  let cronExpr: string | undefined;
  let runAt: string | undefined;
  let prompt: string | undefined;
  let description: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--cron") {
      const value = argv[++i];
      if (!value) throw new Error("--cron requires a value");
      cronExpr = value;
      continue;
    }
    if (arg === "--in") {
      const value = argv[++i];
      if (!value) throw new Error("--in requires a value");
      runAt = new Date(Date.now() + parseDurationMs(value)).toISOString();
      continue;
    }
    if (arg === "--at") {
      const value = argv[++i];
      if (!value) throw new Error("--at requires a value");
      runAt = parseRunAt(value);
      continue;
    }
    if (arg === "--prompt") {
      const value = argv[++i];
      if (!value) throw new Error("--prompt requires a value");
      prompt = value;
      continue;
    }
    if (arg === "--description") {
      const value = argv[++i];
      if (!value) throw new Error("--description requires a value");
      description = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (cronExpr === undefined && looksLikeFiveFieldCron(positional)) {
    cronExpr = positional.slice(0, 5).join(" ");
    const remainder = positional.slice(5).join(" ").trim();
    if (remainder) {
      prompt = prompt ?? remainder;
    }
  } else if (cronExpr === undefined && positional.length > 0) {
    throw new Error("cron expression is required (use --cron or pass it as the first positional arguments)");
  }

  if (cronExpr && runAt) {
    throw new Error("use only one of --cron, --in, or --at");
  }
  if (!cronExpr && !runAt) {
    throw new Error("--cron, --in, or --at is required");
  }
  if (!prompt) {
    throw new Error("--prompt is required");
  }

  const result: AddArgs = { prompt };
  if (cronExpr !== undefined) result.cronExpr = cronExpr;
  if (runAt !== undefined) result.runAt = runAt;
  if (description !== undefined) result.description = description;
  return result;
}

interface PostResponse {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

async function postJson(
  baseUrl: string,
  action: string,
  token: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<PostResponse> {
  const url = `${baseUrl.replace(/\/+$/, "")}/${action}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  let parsed: Record<string, unknown> = {};
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      const value = JSON.parse(text) as unknown;
      if (value && typeof value === "object") {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = { error: text };
    }
  }
  const ok = response.ok && parsed.ok !== false;
  return { ok, status: response.status, body: parsed };
}

function formatJobLine(job: CronJobRecord): string {
  const status = job.enabled ? "on" : "off";
  const schedule = job.runOnce && job.targetAt ? `once=${job.targetAt}` : job.cronExpr;
  const desc = job.description ? ` desc=${JSON.stringify(job.description)}` : "";
  const lastRun = job.lastRunAt ? ` lastRun=${job.lastRunAt}` : "";
  const lastError = job.lastError ? ` lastError=${JSON.stringify(job.lastError)}` : "";
  return `${job.id}\t${status}\t${schedule}\tprompt=${JSON.stringify(job.prompt)}${desc}${lastRun}${lastError}`;
}

function extractError(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.error === "string" && body.error.trim()) {
    return body.error.trim();
  }
  return fallback;
}

export async function runCronCli(
  argv: string[],
  options: CronCliOptions = {},
): Promise<CronCliResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchFn ?? fetch;
  const io = options.io ?? defaultIo();

  if (argv.length === 0 || isHelpFlag(argv[0]!)) {
    io.out(USAGE);
    return { exitCode: argv.length === 0 ? 1 : 0 };
  }

  const command = argv[0]!;
  const rest = argv.slice(1);

  if (command === "--help" || command === "-h" || command === "help") {
    io.out(USAGE);
    return { exitCode: 0 };
  }

  if (!["add", "list"].includes(command)) {
    io.err(`unknown command: ${command}`);
    io.err(USAGE);
    return { exitCode: 1 };
  }

  const url = env.CCTB_CRON_URL;
  const token = env.CCTB_CRON_TOKEN;
  if (!url || !token) {
    io.err(
      "CCTB_CRON_URL and CCTB_CRON_TOKEN must be set; this command only works inside an active bridge session.",
    );
    return { exitCode: 1 };
  }

  try {
    if (command === "add") {
      if (rest.length > 0 && isHelpFlag(rest[0]!)) {
        io.out(USAGE);
        return { exitCode: 0 };
      }
      const body = parseAddArgs(rest);
      const response = await postJson(url, "add", token, body, fetchImpl);
      if (!response.ok) {
        io.err(`add failed: ${extractError(response.body, `HTTP ${response.status}`)}`);
        return { exitCode: 1 };
      }
      const job = response.body.job as CronJobRecord | undefined;
      if (job) {
        io.out(`added ${job.id} ${job.cronExpr} -> ${JSON.stringify(job.prompt)}`);
      } else {
        io.out("added");
      }
      return { exitCode: 0 };
    }

    if (command === "list") {
      const response = await postJson(url, "list", token, {}, fetchImpl);
      if (!response.ok) {
        io.err(`list failed: ${extractError(response.body, `HTTP ${response.status}`)}`);
        return { exitCode: 1 };
      }
      const jobs = Array.isArray(response.body.jobs) ? (response.body.jobs as CronJobRecord[]) : [];
      if (jobs.length === 0) {
        io.out("(no cron jobs)");
        return { exitCode: 0 };
      }
      for (const job of jobs) {
        io.out(formatJobLine(job));
      }
      return { exitCode: 0 };
    }

    io.err(`unknown command: ${command}`);
    return { exitCode: 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`cron ${command} failed: ${message}`);
    return { exitCode: 1 };
  }
}
