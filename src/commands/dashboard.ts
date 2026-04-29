import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Cron } from "croner";

import type { EnvSource } from "../config.js";
import { readConfiguredBotToken } from "../service.js";
import { CrewRunStore } from "../state/crew-run-store.js";
import { CronStore } from "../state/cron-store.js";
import type { CronJobRecord } from "../state/cron-store-schema.js";
import { parseTimelineEvents } from "../state/timeline-log.js";
import type { UsageBucket, UsageRecord } from "../state/usage-store.js";
import { inspectInstanceServiceLiveness, type ServiceCommandDeps } from "./service.js";

export interface DashboardEnv extends Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR"> {}

export type DashboardDeps = Pick<ServiceCommandDeps, "cwd" | "isProcessAlive" | "isExpectedServiceProcess">;

function resolveChannelsDir(env: Pick<EnvSource, "HOME" | "USERPROFILE">): string {
  const homeDir = env.HOME ?? env.USERPROFILE;
  if (!homeDir) throw new Error("HOME or USERPROFILE is required");
  return path.join(homeDir, ".cctb");
}

export interface CronJobSnapshot {
  id: string;
  kind: "once" | "recurring";
  enabled: boolean;
  schedule: string;
  nextRunAt: string | null;
  targetAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  failureCount: number;
  maxFailures: number;
  timezone: string | null;
  prompt: string;
  chatId: number;
  userId: number;
}

export interface CurrentTaskSnapshot {
  status: "idle" | "running" | "stale";
  activeTurnCount: number;
  source: "telegram" | "bus" | "cron" | "unknown";
  chatId: number | null;
  userId: number | null;
  updateId: number | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  lastEventType: string | null;
  outcome: string | null;
  detail: string | null;
  filesAccepted: number;
  filesRejected: number;
  cronJobId: string | null;
}

export interface LiveLogEntry {
  timestamp: string;
  type: string;
  outcome: string;
  channel: string;
  chatId: number | null;
  updateId: number | null;
  detail: string;
}

export interface InstanceSnapshot {
  name: string;
  engine: string;
  approvalMode: string;
  verbosity: number;
  effort: string;
  model: string;
  locale: string;
  budgetUsd: number | null;
  bus: string;
  running: boolean;
  pid: number | null;
  policy: string;
  pairedUsers: number;
  allowlistCount: number;
  sessionBindings: number;
  lastHandledUpdateId: number | null;
  botTokenConfigured: boolean;
  agentMdPreview: string;
  claudeMdExists: boolean;
  usage: UsageRecord;
  auditTotal: number;
  lastSuccess: string;
  lastFailure: string;
  lastError: string;
  recentAudit: Array<{ type: string; outcome: string; timestamp: string; detail?: string }>;
  timelineTotal: number;
  recentTimeline: Array<{ type: string; outcome: string; timestamp: string; detail?: string }>;
  currentTask: CurrentTaskSnapshot;
  liveLogs: LiveLogEntry[];
  crewLatestRunId: string | null;
  crewLatestRunWorkflow: string | null;
  crewLatestRunStatus: string | null;
  crewLatestRunStage: string | null;
  crewLatestRunUpdatedAt: string | null;
  cronJobs: CronJobSnapshot[];
  stateDir: string;
}

interface RuntimeStateSnapshot {
  lastHandledUpdateId?: number | null;
  activeTurnCount?: number;
  activeTurnStartedAt?: string;
  activeTurnUpdatedAt?: string;
}

interface RenderOptions {
  refreshSeconds?: number;
  live?: boolean;
  now?: Date;
}

export interface LiveDashboardServer {
  url: string;
  server: Server;
  closed: Promise<void>;
  close: () => Promise<void>;
}

export interface ServeDashboardOptions {
  host?: string;
  port?: number;
  refreshSeconds?: number;
  open?: boolean;
}

const ACTIVE_TURN_STALE_MS = 30 * 60 * 1000;
const LIVE_LOG_LIMIT = 30;

async function rj<T>(fp: string, fb: T): Promise<T> { try { return JSON.parse(await readFile(fp, "utf8")) as T; } catch { return fb; } }
async function fe(fp: string): Promise<boolean> { try { await stat(fp); return true; } catch { return false; } }
async function tp(fp: string, m: number): Promise<string> { try { const t = (await readFile(fp, "utf8")).trim(); return t.length > m ? t.slice(0, m) + "..." : t; } catch { return ""; } }
async function aal(fp: string): Promise<string[]> { try { return (await readFile(fp, "utf8")).split(/\r?\n/).filter(Boolean); } catch { return []; } }
async function ll(fp: string): Promise<string> { try { const l = (await readFile(fp, "utf8")).split(/\r?\n/).map(s => s.trim()).filter(Boolean); return l.at(-1) ?? ""; } catch { return ""; } }

function pa(line: string): InstanceSnapshot["recentAudit"][0] | null {
  try { const e = JSON.parse(line) as Record<string, unknown>; return { type: (e.type as string) ?? "?", outcome: (e.outcome as string) ?? "?", timestamp: (e.timestamp as string) ?? "", detail: typeof e.detail === "string" ? e.detail : undefined }; } catch { return null; }
}

function pt(event: ReturnType<typeof parseTimelineEvents>[number]): InstanceSnapshot["recentTimeline"][0] {
  return {
    type: event.type,
    outcome: event.outcome ?? "?",
    timestamp: event.timestamp ?? "",
    detail: event.detail,
  };
}

function isIsoTimestamp(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  return Number.isFinite(new Date(value).getTime());
}

function timestampMs(value: string | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function metadataString(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) {
    return "";
  }
  const preferredKeys = [
    "toolName",
    "fileName",
    "bytes",
    "reason",
    "cronJobId",
    "durationMs",
    "responseChars",
    "attachments",
    "workflowRecordId",
    "failureCategory",
    "hasSendFileTag",
    "textChars",
  ];
  const parts: string[] = [];
  for (const key of preferredKeys) {
    const value = metadata[key];
    if (value === undefined) {
      continue;
    }
    let rendered: string;
    try {
      rendered = String(value);
    } catch {
      rendered = "[unprintable]";
    }
    parts.push(`${key}=${rendered}`);
    if (parts.length >= 3) {
      break;
    }
  }
  return parts.join(" ");
}

function toLiveLogEntry(event: ReturnType<typeof parseTimelineEvents>[number]): LiveLogEntry {
  const meta = metadataString(event.metadata);
  return {
    timestamp: event.timestamp ?? "",
    type: event.type,
    outcome: event.outcome ?? "",
    channel: event.channel ?? "",
    chatId: event.chatId ?? null,
    updateId: event.updateId ?? null,
    detail: [event.detail, meta].filter(Boolean).join(" · "),
  };
}

function deriveCurrentTask(
  runtimeState: RuntimeStateSnapshot,
  events: ReturnType<typeof parseTimelineEvents>,
): CurrentTaskSnapshot {
  const activeTurnCount = Math.max(0, runtimeState.activeTurnCount ?? 0);
  const taskEvents = events.filter((event) => (
    event.type === "input.received" ||
    event.type === "turn.started" ||
    event.type === "engine.event" ||
    event.type === "engine.event.delivery_failed" ||
    event.type === "file.accepted" ||
    event.type === "file.rejected" ||
    event.type === "turn.completed" ||
    event.type === "cron.triggered" ||
    event.type === "cron.completed" ||
    event.type === "cron.skipped"
  ));
  const lastEvent = taskEvents.at(-1);
  const lastStart = [...taskEvents].reverse().find((event) => (
    event.type === "turn.started" ||
    event.type === "cron.triggered" ||
    event.type === "input.received"
  ));
  const lastCron = [...taskEvents].reverse().find((event) => event.type === "cron.triggered");
  const startedAt = lastStart?.timestamp ?? runtimeState.activeTurnStartedAt ?? null;
  const startedMs = timestampMs(startedAt ?? undefined);
  const eventsSinceStart = Number.isFinite(startedMs)
    ? taskEvents.filter((event) => timestampMs(event.timestamp) >= startedMs)
    : [];
  const lastActivityAt = [
    lastEvent?.timestamp,
    runtimeState.activeTurnUpdatedAt,
    runtimeState.activeTurnStartedAt,
  ].filter(isIsoTimestamp).sort((a, b) => timestampMs(b) - timestampMs(a))[0] ?? null;
  const latestActivityMs = timestampMs(lastActivityAt ?? undefined);
  const status: CurrentTaskSnapshot["status"] = activeTurnCount > 0
    ? Date.now() - latestActivityMs > ACTIVE_TURN_STALE_MS ? "stale" : "running"
    : "idle";
  const cronJobId = typeof lastCron?.metadata?.cronJobId === "string" ? lastCron.metadata.cronJobId : null;
  const cronLooksActive = cronJobId !== null && (
    activeTurnCount > 0 ||
    !eventsSinceStart.some((event) => event.type === "cron.completed" && event.metadata?.cronJobId === cronJobId)
  );
  const source = cronLooksActive
    ? "cron"
    : lastStart?.channel === "bus"
      ? "bus"
      : lastStart?.channel === "telegram"
        ? "telegram"
        : "unknown";
  const lastTaskEvent = eventsSinceStart.at(-1) ?? lastEvent;

  return {
    status,
    activeTurnCount,
    source,
    chatId: lastTaskEvent?.chatId ?? lastStart?.chatId ?? null,
    userId: lastTaskEvent?.userId ?? lastStart?.userId ?? null,
    updateId: lastTaskEvent?.updateId ?? lastStart?.updateId ?? null,
    startedAt,
    lastActivityAt,
    lastEventType: lastTaskEvent?.type ?? null,
    outcome: lastTaskEvent?.outcome ?? null,
    detail: lastTaskEvent?.detail ?? null,
    filesAccepted: eventsSinceStart.filter((event) => event.type === "file.accepted").length,
    filesRejected: eventsSinceStart.filter((event) => event.type === "file.rejected").length,
    cronJobId,
  };
}

function nextCronRunIso(expr: string, timezone?: string): string | null {
  try {
    const cron = new Cron(expr, { paused: true, timezone });
    const next = cron.nextRun();
    cron.stop();
    return next?.toISOString() ?? null;
  } catch {
    return null;
  }
}

function toCronJobSnapshot(job: CronJobRecord): CronJobSnapshot {
  const kind = job.runOnce ? "once" : "recurring";
  const targetAt = job.targetAt ?? null;
  return {
    id: job.id,
    kind,
    enabled: job.enabled,
    schedule: kind === "once" && targetAt ? `once ${targetAt}` : job.cronExpr,
    nextRunAt: job.enabled
      ? kind === "once"
        ? targetAt
        : nextCronRunIso(job.cronExpr, job.timezone)
      : null,
    targetAt,
    lastRunAt: job.lastRunAt ?? null,
    lastSuccessAt: job.lastSuccessAt ?? null,
    lastError: job.lastError ?? null,
    failureCount: job.failureCount,
    maxFailures: job.maxFailures,
    timezone: job.timezone ?? null,
    prompt: job.prompt,
    chatId: job.chatId,
    userId: job.userId,
  };
}

async function readCronSnapshots(stateDir: string): Promise<CronJobSnapshot[]> {
  try {
    const jobs = await new CronStore(stateDir).list();
    return jobs.map(toCronJobSnapshot);
  } catch {
    return [];
  }
}

function resolveDashboardTargets(env: DashboardEnv): Array<{ name: string; stateDir: string }> {
  if (env.CODEX_TELEGRAM_STATE_DIR) {
    return [{
      name: path.basename(env.CODEX_TELEGRAM_STATE_DIR),
      stateDir: env.CODEX_TELEGRAM_STATE_DIR,
    }];
  }

  return [];
}

async function ci(
  env: DashboardEnv,
  target: { name: string; stateDir: string },
  deps: DashboardDeps = {},
): Promise<InstanceSnapshot> {
  const d = target.stateDir;
  const name = target.name;
  const cfg = await rj<{ engine?: string; approvalMode?: string; verbosity?: number; effort?: string; model?: string; locale?: string; budgetUsd?: number; bus?: { peers?: unknown } }>(path.join(d, "config.json"), {});
  const ac = await rj<{ policy?: string; pairedUsers?: unknown[]; allowlist?: unknown[] }>(path.join(d, "access.json"), {});
  const ss = await rj<{ chats?: unknown[] }>(path.join(d, "session.json"), {});
  const runtimeState = await rj<RuntimeStateSnapshot>(path.join(d, "runtime-state.json"), {});
  const us = await rj<InstanceSnapshot["usage"]>(path.join(d, "usage.json"), { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0, totalCostUsd: 0, lastUpdatedAt: "" });
  const aa = await aal(path.join(d, "audit.log.jsonl"));
  const timelineRaw = await readFile(path.join(d, "timeline.log.jsonl"), "utf8").catch(() => "");
  const timelineEvents = parseTimelineEvents(timelineRaw);
  const cronJobs = await readCronSnapshots(d);
  const ra = aa.slice(-8).map(pa).filter((e): e is NonNullable<typeof e> => e !== null);
  const recentTimeline = timelineEvents.slice(-8).map(pt);
  const liveLogs = timelineEvents.slice(-LIVE_LOG_LIMIT).map(toLiveLogEntry);
  const currentTask = deriveCurrentTask(runtimeState, timelineEvents);
  const latestCrewRun = await new CrewRunStore(d).inspectLatest();
  let ls = "", lf = "";
  for (let i = aa.length - 1; i >= 0; i--) { const e = pa(aa[i]); if (!e) continue; if (!ls && e.outcome === "success") ls = e.timestamp; if (!lf && e.outcome === "error") lf = e.timestamp; if (ls && lf) break; }
  const liveness = await inspectInstanceServiceLiveness({
    stateDir: d,
    instanceName: name,
  }, deps);
  const botToken = await readConfiguredBotToken({
    HOME: env.HOME,
    USERPROFILE: env.USERPROFILE,
    CODEX_TELEGRAM_STATE_DIR: d,
  }, name);

  return {
    name, engine: cfg.engine ?? "codex", approvalMode: cfg.approvalMode ?? "normal", verbosity: cfg.verbosity ?? 1,
    effort: cfg.effort ?? "default", model: cfg.model ?? "default", locale: cfg.locale ?? "en",
    budgetUsd: typeof cfg.budgetUsd === "number" ? cfg.budgetUsd : null,
    bus: cfg.bus?.peers ? (cfg.bus.peers === "*" ? "mesh" : Array.isArray(cfg.bus.peers) ? `${(cfg.bus.peers as unknown[]).length} peers` : "off") : "off",
    running: liveness.running, pid: liveness.pid, policy: ac.policy ?? "pairing",
    pairedUsers: Array.isArray(ac.pairedUsers) ? ac.pairedUsers.length : 0,
    allowlistCount: Array.isArray(ac.allowlist) ? ac.allowlist.length : 0,
    sessionBindings: Array.isArray(ss.chats) ? ss.chats.length : 0,
    lastHandledUpdateId: runtimeState.lastHandledUpdateId ?? null,
    botTokenConfigured: botToken !== null,
    agentMdPreview: await tp(path.join(d, "agent.md"), 160),
    claudeMdExists: await fe(path.join(d, "workspace", "CLAUDE.md")),
    usage: us, auditTotal: aa.length, lastSuccess: ls, lastFailure: lf,
    timelineTotal: timelineEvents.length,
    currentTask,
    liveLogs,
    crewLatestRunId: latestCrewRun.run?.runId ?? null,
    crewLatestRunWorkflow: latestCrewRun.run?.workflow ?? null,
    crewLatestRunStatus: latestCrewRun.run?.status ?? null,
    crewLatestRunStage: latestCrewRun.run?.currentStage ?? null,
    crewLatestRunUpdatedAt: latestCrewRun.run?.updatedAt ?? null,
    cronJobs,
    lastError: (await ll(path.join(d, "service.stderr.log"))).slice(0, 200),
    recentAudit: ra, recentTimeline, stateDir: d,
  };
}

function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function attr(s: string): string { return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function ft(iso: string): string { if (!iso) return "--"; try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); } catch { return iso.slice(0, 16); } }
function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return value.toLocaleString();
}
function bucketTokens(bucket: Pick<UsageBucket, "totalInputTokens" | "totalOutputTokens">): number {
  return bucket.totalInputTokens + bucket.totalOutputTokens;
}
function emptyUsageBucket(): UsageBucket {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    totalCostUsd: 0,
    requestCount: 0,
    lastUpdatedAt: "",
  };
}
function usageBucketFromRecord(usage: UsageRecord): UsageBucket {
  return {
    totalInputTokens: usage.totalInputTokens,
    totalOutputTokens: usage.totalOutputTokens,
    totalCachedTokens: usage.totalCachedTokens,
    totalCostUsd: usage.totalCostUsd,
    requestCount: usage.requestCount,
    lastUpdatedAt: usage.lastUpdatedAt,
  };
}
function sortedUsageEntries(buckets: Record<string, UsageBucket> | undefined, limit: number): Array<[string, UsageBucket]> {
  return Object.entries(buckets ?? {}).sort(([a], [b]) => a.localeCompare(b)).slice(-limit);
}
function renderUsageTrend(entries: Array<[string, UsageBucket]>, unit: "day" | "month"): string {
  if (entries.length === 0) {
    return `<div class="usage-empty">No ${unit} history yet. New buckets start after this upgrade.</div>`;
  }
  const maxTokens = Math.max(...entries.map(([, bucket]) => bucketTokens(bucket)), 1);
  return entries.map(([key, bucket]) => {
    const tokens = bucketTokens(bucket);
    const width = Math.max(4, Math.round((tokens / maxTokens) * 100));
    return `
      <div class="usage-bar-row">
        <span class="usage-bar-key">${esc(key)}</span>
        <span class="usage-bar-track"><span style="width:${width}%"></span></span>
        <span class="usage-bar-value">${formatCompactNumber(tokens)}</span>
      </div>`;
  }).join("");
}
function renderUsageAnalytics(usage: UsageRecord, now: Date): string {
  if (usage.requestCount === 0) {
    return "";
  }

  const todayKey = now.toISOString().slice(0, 10);
  const monthKey = now.toISOString().slice(0, 7);
  const today = usage.daily?.[todayKey] ?? emptyUsageBucket();
  const thisMonth = usage.monthly?.[monthKey] ?? emptyUsageBucket();
  const total = usageBucketFromRecord(usage);
  const totalTokens = bucketTokens(total);
  const avgTokens = usage.requestCount > 0 ? Math.round(totalTokens / usage.requestCount) : 0;
  const avgCost = usage.requestCount > 0 ? usage.totalCostUsd / usage.requestCount : 0;
  const cacheDenominator = usage.totalInputTokens + usage.totalCachedTokens;
  const cacheRatio = cacheDenominator > 0 ? Math.round((usage.totalCachedTokens / cacheDenominator) * 100) : 0;
  const outputRatio = totalTokens > 0 ? Math.round((usage.totalOutputTokens / totalTokens) * 100) : 0;
  const dailyTrend = renderUsageTrend(sortedUsageEntries(usage.daily, 14), "day");
  const monthlyTrend = renderUsageTrend(sortedUsageEntries(usage.monthly, 6), "month");

  return `
    <section class="usage-analytics">
      <div class="usage-head">
        <span>Usage Intelligence</span>
        <strong>${usage.lastUpdatedAt ? `updated ${ft(usage.lastUpdatedAt)}` : "history starts now"}</strong>
      </div>
      <div class="usage-kpis">
        <div><span>${formatCompactNumber(bucketTokens(today))}</span><small>Today</small></div>
        <div><span>${formatCompactNumber(bucketTokens(thisMonth))}</span><small>This Month</small></div>
        <div><span>${formatCompactNumber(avgTokens)}</span><small>Avg / req</small></div>
        <div><span>${cacheRatio}%</span><small>Cache Ratio</small></div>
      </div>
      <div class="usage-split">
        <div>
          <div class="usage-split-label"><span>Input</span><strong>${formatCompactNumber(usage.totalInputTokens)}</strong></div>
          <div class="usage-line"><span style="width:${totalTokens > 0 ? Math.round((usage.totalInputTokens / totalTokens) * 100) : 0}%"></span></div>
        </div>
        <div>
          <div class="usage-split-label"><span>Output</span><strong>${formatCompactNumber(usage.totalOutputTokens)} · ${outputRatio}%</strong></div>
          <div class="usage-line usage-line-output"><span style="width:${outputRatio}%"></span></div>
        </div>
        <div>
          <div class="usage-split-label"><span>Avg cost</span><strong>${avgCost > 0 ? `$${avgCost.toFixed(4)}` : "--"}</strong></div>
          <div class="usage-line usage-line-cost"><span style="width:${Math.min(100, Math.max(4, Math.round(avgCost * 10_000)))}%"></span></div>
        </div>
      </div>
      <div class="usage-trends">
        <div>
          <div class="usage-trend-title">14-day tokens</div>
          ${dailyTrend}
        </div>
        <div>
          <div class="usage-trend-title">Monthly tokens</div>
          ${monthlyTrend}
        </div>
      </div>
    </section>`;
}

// Generate a deterministic geometric SVG pattern for each instance
function geoPattern(name: string, w: number, h: number): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  const abs = (n: number) => (n < 0 ? -n : n);
  const colors = ["#C1392B", "#2B6CB0", "#8B6914", "#1A1A1A", "#6B7280", "#7C8C3C", "#D4A574", "#3B82F6", "#92400E", "#64748B"];
  const shapes: string[] = [];
  const seed = abs(hash);
  const variant = seed % 3;

  for (let i = 0; i < 12; i++) {
    const s = (seed * (i + 1) * 7) % 1000;
    const x = (s * 3) % w;
    const y = ((s * 7) % h);
    const c = colors[(s * 11) % colors.length];
    const size = 8 + (s % 20);
    const opacity = 0.5 + (s % 50) / 100;

    if (variant === 0) {
      // Circles
      shapes.push(`<circle cx="${x}" cy="${y}" r="${size}" fill="${c}" opacity="${opacity}"/>`);
    } else if (variant === 1) {
      // Rectangles
      const rot = (s * 13) % 45;
      shapes.push(`<rect x="${x}" y="${y}" width="${size * 1.5}" height="${size * 1.5}" fill="${c}" opacity="${opacity}" transform="rotate(${rot} ${x + size * 0.75} ${y + size * 0.75})"/>`);
    } else {
      // Mixed
      if (i % 2 === 0) {
        shapes.push(`<circle cx="${x}" cy="${y}" r="${size * 0.8}" fill="${c}" opacity="${opacity}"/>`);
      } else {
        shapes.push(`<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${c}" opacity="${opacity}"/>`);
      }
    }
  }

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="border-radius:12px">${shapes.join("")}</svg>`;
}

export function renderHtml(instances: InstanceSnapshot[], options: RenderOptions = {}): string {
  const renderNow = options.now ?? new Date();
  const now = renderNow.toISOString();
  const total = instances.length;
  const alive = instances.filter(i => i.running).length;
  const reqs = instances.reduce((s, i) => s + i.usage.requestCount, 0);
  const cost = instances.reduce((s, i) => s + i.usage.totalCostUsd, 0);
  const toks = instances.reduce((s, i) => s + i.usage.totalInputTokens + i.usage.totalOutputTokens, 0);

  const stats = [
    { label: "Fleet", value: `${alive}/${total}` },
    { label: "Requests", value: reqs.toLocaleString() },
    { label: "Tokens", value: toks > 1e6 ? `${(toks / 1e6).toFixed(1)}M` : toks.toLocaleString() },
    { label: "Cost", value: cost > 0 ? `$${cost.toFixed(2)}` : "--" },
  ].map(s => `<div class="stat"><div class="stat-val">${s.value}</div><div class="stat-lbl">${s.label}</div></div>`).join("");

  const cards = instances.map(inst => {
    const statusColor = inst.running ? "#2D8B46" : "#C1392B";
    const statusText = inst.running ? "Online" : "Offline";
    const panelPrefix = attr(inst.name);
    const engLabel = inst.engine.charAt(0).toUpperCase() + inst.engine.slice(1);
    const yoloLabel = inst.approvalMode === "bypass" ? " / Unsafe" : inst.approvalMode === "full-auto" ? " / YOLO" : "";
    const effortLabel = inst.effort !== "default" ? ` / ${inst.effort}` : "";
    const modelLabel = inst.model !== "default" ? ` / ${inst.model}` : "";
    const costStr = inst.usage.totalCostUsd > 0 ? `$${inst.usage.totalCostUsd.toFixed(4)}` : "--";
    const cacheRatio = (inst.usage.totalInputTokens + inst.usage.totalCachedTokens) > 0
      ? Math.round(inst.usage.totalCachedTokens / (inst.usage.totalInputTokens + inst.usage.totalCachedTokens) * 100) : 0;
    const usageAnalytics = renderUsageAnalytics(inst.usage, renderNow);
    const pattern = geoPattern(inst.name, 280, 120);
    const task = inst.currentTask;
    const taskColor = task.status === "running" ? "#2D8B46" : task.status === "stale" ? "#C1392B" : "#6B7280";
    const taskBits = [
      task.source !== "unknown" ? task.source : undefined,
      task.chatId !== null ? `chat ${task.chatId}` : undefined,
      task.updateId !== null ? `update ${task.updateId}` : undefined,
      task.cronJobId ? `cron ${task.cronJobId}` : undefined,
      task.activeTurnCount > 0 ? `${task.activeTurnCount} active` : undefined,
    ].filter(Boolean).join(" · ");
    const taskRows = [
      ["Started", task.startedAt ? ft(task.startedAt) : "--"],
      ["Last activity", task.lastActivityAt ? ft(task.lastActivityAt) : "--"],
      ["Last event", task.lastEventType ?? "--"],
      ["Files", `${task.filesAccepted} accepted / ${task.filesRejected} rejected`],
    ].map(([label, value]) => `<div><span>${label}</span><strong>${esc(value)}</strong></div>`).join("");
    const liveLogRows = inst.liveLogs.map(ev => {
      const c = ev.outcome === "error" || ev.outcome === "rejected" ? "#C1392B" : ev.outcome === "success" || ev.outcome === "accepted" ? "#2D8B46" : "#6B7280";
      const scope = [ev.channel, ev.chatId !== null ? `chat ${ev.chatId}` : "", ev.updateId !== null ? `update ${ev.updateId}` : ""].filter(Boolean).join(" · ");
      return `
        <div class="log-row">
          <div class="log-time">${ft(ev.timestamp)}</div>
          <div class="log-main">
            <div><span class="log-type">${esc(ev.type)}</span>${ev.outcome ? ` <span style="color:${c}">${esc(ev.outcome)}</span>` : ""}</div>
            ${ev.detail ? `<div class="log-detail">${esc(ev.detail)}</div>` : ""}
            ${scope ? `<div class="log-scope">${esc(scope)}</div>` : ""}
          </div>
        </div>`;
    }).join("");

    const auditRows = inst.recentAudit.map(ev => {
      const c = ev.outcome === "error" ? "#C1392B" : ev.outcome === "success" ? "#2D8B46" : "#6B7280";
      return `<tr><td class="au-t">${ft(ev.timestamp)}</td><td style="color:${c}">${esc(ev.type)}</td><td style="color:${c}">${ev.outcome}</td></tr>`;
    }).join("");
    const timelineRows = inst.recentTimeline.map(ev => {
      const c = ev.outcome === "error" ? "#C1392B" : ev.outcome === "success" ? "#2D8B46" : ev.outcome === "retry" ? "#8B6914" : "#6B7280";
      return `<tr><td class="au-t">${ft(ev.timestamp)}</td><td style="color:${c}">${esc(ev.type)}</td><td style="color:${c}">${esc(ev.outcome)}</td></tr>`;
    }).join("");
    const cronRows = inst.cronJobs.map(job => {
      const status = job.enabled ? "on" : "off";
      const statusColor = job.enabled ? "#2D8B46" : "#6B7280";
      const next = job.nextRunAt ? ft(job.nextRunAt) : "--";
      const last = job.lastRunAt ? ft(job.lastRunAt) : "--";
      const failures = job.failureCount > 0 ? `<span>failures ${job.failureCount}/${job.maxFailures}</span>` : "";
      const err = job.lastError ? `<div class="cron-err">${esc(job.lastError)}</div>` : "";
      return `
        <div class="cron-row">
          <div class="cron-top">
            <span class="cron-id">${esc(job.id)}</span>
            <span class="cron-kind">${job.kind}</span>
            <span class="cron-status" style="color:${statusColor}">${status}</span>
          </div>
          <div class="cron-prompt">${esc(job.prompt)}</div>
          <div class="cron-meta">
            <span>${esc(job.schedule)}</span>
            ${job.timezone ? `<span>TZ ${esc(job.timezone)}</span>` : ""}
            <span>next ${next}</span>
            <span>last ${last}</span>
            ${failures}
            <span>chat ${job.chatId}</span>
          </div>
          ${err}
        </div>`;
    }).join("");

    return `
    <div class="card">
      <div class="card-art">${pattern}</div>
      <div class="card-body">
        <div class="card-head">
          <h2>${esc(inst.name)}</h2>
          <div class="card-meta">
            <span class="tag" style="background:${statusColor}">${statusText}</span>
            <span class="tag tag-outline">${engLabel}${modelLabel}${effortLabel}${yoloLabel}</span>
          </div>
        </div>

        ${inst.agentMdPreview ? `<blockquote class="personality">${esc(inst.agentMdPreview)}${inst.claudeMdExists ? " <em>+CLAUDE.md</em>" : ""}</blockquote>` : ""}

        <section class="task">
          <div class="task-head">
            <span>Current Task</span>
            <strong style="color:${taskColor}">${task.status}</strong>
          </div>
          ${taskBits ? `<div class="task-meta">${esc(taskBits)}</div>` : ""}
          <div class="task-grid">${taskRows}</div>
          ${task.detail ? `<div class="task-detail">${esc(task.detail)}</div>` : ""}
        </section>

        <div class="metrics">
          <div><span class="m-val">${inst.usage.requestCount.toLocaleString()}</span><span class="m-lbl">Requests</span></div>
          <div><span class="m-val">${costStr}</span><span class="m-lbl">Cost</span></div>
          <div><span class="m-val">${(inst.usage.totalInputTokens + inst.usage.totalOutputTokens).toLocaleString()}</span><span class="m-lbl">Tokens</span></div>
          <div><span class="m-val">${cacheRatio}%</span><span class="m-lbl">Cache</span></div>
        </div>

        ${usageAnalytics}

        <div class="details">
          <div>Sessions <strong>${inst.sessionBindings}</strong></div>
          <div>Paired <strong>${inst.pairedUsers}</strong></div>
          <div>Policy <strong>${inst.policy}</strong></div>
          <div>Locale <strong>${inst.locale}</strong></div>
          <div>Bus <strong>${inst.bus}</strong></div>
          <div>Budget <strong>${inst.budgetUsd !== null ? `$${inst.budgetUsd}` : "--"}</strong></div>
          <div>Crew <strong>${inst.crewLatestRunStatus !== null ? `${inst.crewLatestRunStatus}/${inst.crewLatestRunStage}` : "--"}</strong></div>
          <div>Crew run <strong>${inst.crewLatestRunId ?? "--"}</strong></div>
          <div>Last OK <strong style="color:#2D8B46">${ft(inst.lastSuccess)}</strong></div>
          <div>Last Err <strong style="color:#C1392B">${ft(inst.lastFailure)}</strong></div>
          <div>Verbosity <strong>${inst.verbosity}</strong></div>
        </div>

        ${inst.lastError ? `<div class="err">${esc(inst.lastError)}</div>` : ""}

        ${inst.cronJobs.length > 0 ? `
        <details class="cron" data-panel="${panelPrefix}:cron" open>
          <summary>Scheduled Tasks <span class="au-count">${inst.cronJobs.length}</span></summary>
          ${cronRows}
        </details>` : ""}

        ${inst.recentAudit.length > 0 ? `
        <details class="audit" data-panel="${panelPrefix}:activity">
          <summary>Activity <span class="au-count">${inst.auditTotal.toLocaleString()}</span></summary>
          <table>${auditRows}</table>
        </details>` : ""}

        ${inst.recentTimeline.length > 0 ? `
        <details class="audit" data-panel="${panelPrefix}:timeline">
          <summary>Timeline <span class="au-count">${inst.timelineTotal.toLocaleString()}</span></summary>
          <table>${timelineRows}</table>
        </details>` : ""}

        ${inst.liveLogs.length > 0 ? `
        <details class="logs" data-panel="${panelPrefix}:logs">
          <summary>Live Logs <span class="au-count">${inst.liveLogs.length}</span></summary>
          ${liveLogRows}
        </details>` : ""}

        <div class="card-foot">${esc(inst.stateDir)}</div>
      </div>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${options.refreshSeconds && !options.live ? `<meta http-equiv="refresh" content="${options.refreshSeconds}">` : ""}
<title>CC Telegram Bridge</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#EFEDEA;color:#1A1A1A;min-height:100vh;padding:48px 32px}
.wrap{max-width:1200px;margin:0 auto}

/* Header */
.header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:48px;border-bottom:2px solid #1A1A1A;padding-bottom:20px}
.header h1{font-family:'DM Serif Display',serif;font-size:36px;font-weight:400;letter-spacing:-0.5px}
.header .sub{font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:2px}
.header .mark{font-family:'JetBrains Mono',monospace;font-size:11px;color:#6B7280}

/* Stats bar */
.stats{display:flex;gap:48px;margin-bottom:48px}
.stat{text-align:left}
.stat-val{font-family:'DM Serif Display',serif;font-size:32px;line-height:1}
.stat-lbl{font-size:10px;color:#6B7280;text-transform:uppercase;letter-spacing:2px;margin-top:4px}

/* Grid */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:18px}

/* Card */
.card{background:#FAFAF8;border:1px solid #D4D0CB;border-radius:16px;overflow:hidden;transition:box-shadow 0.2s}
.card:hover{box-shadow:0 4px 24px rgba(0,0,0,0.06)}
.card-art{padding:0;line-height:0}
.card-art svg{width:100%;height:auto;display:block}
.card-body{padding:24px}
.card-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px}
.card-head h2{font-family:'DM Serif Display',serif;font-size:24px;font-weight:400}
.card-meta{display:flex;gap:6px;flex-shrink:0}
.tag{display:inline-block;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;letter-spacing:0.5px}
.tag-outline{background:transparent;color:#1A1A1A;border:1px solid #1A1A1A}
.personality{border-left:3px solid #D4D0CB;padding:8px 14px;margin:0 0 16px 0;font-size:13px;color:#6B7280;font-style:italic;line-height:1.5;max-height:50px;overflow:hidden}
.personality em{color:#8B6914;font-style:normal;font-size:11px}

/* Metrics */
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#D4D0CB;border:1px solid #D4D0CB;border-radius:8px;overflow:hidden;margin-bottom:16px}
.metrics>div{background:#FAFAF8;padding:12px;text-align:center}
.m-val{display:block;font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:600}
.m-lbl{display:block;font-size:9px;color:#6B7280;text-transform:uppercase;letter-spacing:1.5px;margin-top:2px}

/* Usage analytics */
.usage-analytics{border:1px solid #E7E1DA;border-radius:10px;padding:12px;margin-bottom:16px;background:linear-gradient(135deg,rgba(255,255,255,.74),rgba(247,250,252,.66))}
.usage-head{display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6B7280}
.usage-head strong{font-family:'JetBrains Mono',monospace;font-size:9px;color:#9CA3AF;font-weight:500;text-transform:none;letter-spacing:0}
.usage-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}
.usage-kpis div{border:1px solid #EFEDEA;border-radius:8px;padding:9px;background:rgba(255,255,255,.55)}
.usage-kpis span{display:block;font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:600;color:#1A1A1A}
.usage-kpis small{display:block;margin-top:3px;font-size:8px;text-transform:uppercase;letter-spacing:1.2px;color:#9CA3AF}
.usage-split{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px}
.usage-split-label{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:#6B7280}
.usage-split-label strong{font-family:'JetBrains Mono',monospace;color:#1A1A1A;font-weight:500}
.usage-line,.usage-bar-track{display:block;height:6px;border-radius:999px;background:#E5E7EB;overflow:hidden;margin-top:6px}
.usage-line span,.usage-bar-track span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#93C5FD,#22D3EE)}
.usage-line-output span{background:linear-gradient(90deg,#A7F3D0,#2D8B46)}
.usage-line-cost span{background:linear-gradient(90deg,#FDE68A,#D97706)}
.usage-trends{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
.usage-trend-title{font-size:9px;text-transform:uppercase;letter-spacing:1.4px;color:#9CA3AF;margin-bottom:6px}
.usage-bar-row{display:grid;grid-template-columns:62px 1fr 44px;gap:8px;align-items:center;font-family:'JetBrains Mono',monospace;font-size:9px;margin-top:5px}
.usage-bar-key{color:#6B7280}
.usage-bar-value{text-align:right;color:#1A1A1A}
.usage-empty{font-size:10px;color:#9CA3AF;line-height:1.4}

/* Details grid */
.details{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 16px;font-size:12px;color:#6B7280;margin-bottom:12px}
.details strong{color:#1A1A1A;margin-left:4px;font-weight:600}

/* Error */
.err{background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;padding:8px 12px;font-family:'JetBrains Mono',monospace;font-size:10px;color:#C1392B;margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Current task */
.task{border:1px solid #E7E1DA;border-radius:8px;padding:12px;margin-bottom:16px;background:#FCFBF8}
.task-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6B7280}
.task-head strong{font-family:'JetBrains Mono',monospace;font-size:11px;text-transform:uppercase}
.task-meta{margin-top:6px;font-family:'JetBrains Mono',monospace;font-size:10px;color:#1A1A1A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 12px;margin-top:10px;font-size:11px}
.task-grid div{display:flex;justify-content:space-between;gap:8px;border-top:1px solid #EFEDEA;padding-top:6px}
.task-grid span{color:#6B7280}
.task-grid strong{font-family:'JetBrains Mono',monospace;font-weight:500;color:#1A1A1A;text-align:right;overflow:hidden;text-overflow:ellipsis}
.task-detail{margin-top:8px;font-family:'JetBrains Mono',monospace;font-size:10px;color:#6B7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Cron */
.cron{margin-bottom:12px;border:1px solid #E7E1DA;border-radius:8px;padding:10px 12px;background:#FCFBF8}
.cron summary{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6B7280;cursor:pointer;user-select:none;margin-bottom:8px}
.cron-row{border-top:1px solid #EFEDEA;padding:9px 0}
.cron-row:first-of-type{border-top:0}
.cron-top{display:flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:10px}
.cron-id{color:#1A1A1A;font-weight:600}
.cron-kind,.cron-status{font-size:9px;text-transform:uppercase;letter-spacing:1px}
.cron-kind{color:#8B6914}
.cron-prompt{font-size:12px;color:#1A1A1A;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cron-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px;font-family:'JetBrains Mono',monospace;font-size:9px;color:#6B7280}
.cron-err{margin-top:6px;font-family:'JetBrains Mono',monospace;font-size:9px;color:#C1392B;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Audit */
.audit{margin-bottom:8px}
.audit summary{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6B7280;cursor:pointer;user-select:none}
.audit summary:hover{color:#1A1A1A}
.au-count{font-family:'JetBrains Mono',monospace;color:#D4D0CB;margin-left:4px}
.audit table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px;font-family:'JetBrains Mono',monospace}
.audit td{padding:2px 8px 2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.au-t{color:#D4D0CB}

/* Live logs */
.logs{margin-bottom:12px;border:1px solid #E7E1DA;border-radius:8px;padding:10px 12px;background:#FCFBF8}
.logs summary{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6B7280;cursor:pointer;user-select:none;margin-bottom:8px}
.log-row{display:grid;grid-template-columns:74px 1fr;gap:10px;border-top:1px solid #EFEDEA;padding:7px 0;font-family:'JetBrains Mono',monospace;font-size:10px}
.log-row:first-of-type{border-top:0}
.log-time{color:#D4D0CB}
.log-type{color:#1A1A1A;font-weight:500}
.log-detail{color:#6B7280;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log-scope{color:#B8B2AA;margin-top:2px}

/* Footer */
.card-foot{font-family:'JetBrains Mono',monospace;font-size:9px;color:#D4D0CB;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.footer{text-align:center;margin-top:48px;font-size:11px;color:#D4D0CB;letter-spacing:1px;text-transform:uppercase}
.footer code{font-family:'JetBrains Mono',monospace;color:#6B7280}

@media(max-width:600px){
  .grid{grid-template-columns:1fr}
  .stats{flex-wrap:wrap;gap:24px}
  .header{flex-direction:column;align-items:flex-start;gap:8px}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div>
      <h1>CC Telegram Bridge</h1>
      <div class="sub">Instance Dashboard</div>
    </div>
    <div class="mark">${now.slice(0, 19).replace("T", " ")} UTC</div>
  </div>
  <div class="stats">${stats}</div>
  <div class="grid">${instances.length > 0 ? cards : '<div style="grid-column:1/-1;text-align:center;padding:80px 0;color:#6B7280;font-size:14px">No instances found.<br><code style="font-size:12px">telegram configure &lt;token&gt;</code></div>'}</div>
  <div class="footer">${options.live ? "Live read-only dashboard" : "Read-only snapshot"} &middot; <code>${options.live ? "telegram dashboard --live" : "telegram dashboard --live for live logs"}</code></div>
</div>
${options.live ? `<script id="dashboard-refresh">
const refreshMs = ${Math.max(1, options.refreshSeconds ?? 2) * 1000};
const detailsStateKey = "cctb.dashboard.details";
function readDetailsState() {
  try {
    return JSON.parse(localStorage.getItem(detailsStateKey) || "{}");
  } catch {
    return {};
  }
}
function writeDetailsState(state) {
  try {
    localStorage.setItem(detailsStateKey, JSON.stringify(state));
  } catch {
    // Local storage can be disabled; live refresh still works without it.
  }
}
function rememberDetailsState() {
  const state = readDetailsState();
  document.querySelectorAll("details[data-panel]").forEach((details) => {
    state[details.dataset.panel] = details.open;
  });
  writeDetailsState(state);
}
function restoreDetailsState() {
  const state = readDetailsState();
  document.querySelectorAll("details[data-panel]").forEach((details) => {
    if (Object.prototype.hasOwnProperty.call(state, details.dataset.panel)) {
      details.open = Boolean(state[details.dataset.panel]);
    }
  });
}
async function refreshDashboard() {
  try {
    rememberDetailsState();
    const response = await fetch("/fragment", { cache: "no-store" });
    if (!response.ok) return;
    document.body.innerHTML = await response.text();
    restoreDetailsState();
  } catch {
    // Keep the last rendered snapshot visible if the local server is stopped.
  }
}
document.addEventListener("toggle", (event) => {
  if (event.target instanceof HTMLDetailsElement && event.target.dataset.panel) {
    rememberDetailsState();
  }
}, true);
restoreDetailsState();
setInterval(refreshDashboard, refreshMs);
</script>` : ""}
</body>
</html>`;
}

function extractBodyFragment(html: string): string {
  const open = /<body[^>]*>/i.exec(html);
  const closeIndex = html.toLowerCase().lastIndexOf("</body>");
  const body = open && closeIndex > open.index
    ? html.slice(open.index + open[0].length, closeIndex)
    : html;
  return body
    .replace(/<script id="dashboard-refresh">[\s\S]*?<\/script>/i, "")
    .trim();
}

function openBrowser(fp: string): void {
  const cmd = process.platform === "win32" ? `start "" "${fp}"` : process.platform === "darwin" ? `open "${fp}"` : `xdg-open "${fp}"`;
  exec(cmd, () => {});
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function collectInstanceSnapshots(env: DashboardEnv, deps: DashboardDeps = {}): Promise<InstanceSnapshot[]> {
  const explicitTargets = resolveDashboardTargets(env);
  if (explicitTargets.length > 0) {
    return Promise.all(explicitTargets.map((target) => ci(env, target, deps)));
  }

  const cd = resolveChannelsDir(env);
  let names: string[];
  try { names = (await readdir(cd, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { names = []; }
  return Promise.all(names.map((name) => ci(env, { name, stateDir: path.join(cd, name) }, deps)));
}

export async function generateDashboard(env: DashboardEnv, outputPath?: string): Promise<string> {
  const instances = await collectInstanceSnapshots(env);
  const html = renderHtml(instances);
  const outDir = env.CODEX_TELEGRAM_STATE_DIR ?? resolveChannelsDir(env);
  const out = outputPath ?? path.join(outDir, "dashboard.html");
  await writeFile(out, html, "utf8");
  openBrowser(out);
  return out;
}

export async function serveDashboard(
  env: DashboardEnv,
  options: ServeDashboardOptions = {},
): Promise<LiveDashboardServer> {
  const host = options.host ?? "127.0.0.1";
  const refreshSeconds = options.refreshSeconds ?? 2;
  const server = createServer(async (req, res) => {
    const requestPath = new URL(req.url ?? "/", `http://${host}`).pathname;
    if (requestPath === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("ok\n");
      return;
    }

    if (requestPath === "/fragment") {
      try {
        const instances = await collectInstanceSnapshots(env);
        const fragment = extractBodyFragment(renderHtml(instances, { live: true }));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(fragment);
      } catch (error) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (requestPath !== "/" && requestPath !== "/index.html") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("not found\n");
      return;
    }

    try {
      const instances = await collectInstanceSnapshots(env);
      const html = renderHtml(instances, { refreshSeconds, live: true });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  const closed = new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    await closeServer(server);
    throw new Error("dashboard server did not expose a listening address");
  }
  const url = `http://${host}:${address.port}/`;
  if (options.open !== false) {
    openBrowser(url);
  }

  return {
    url,
    server,
    closed,
    close: () => closeServer(server),
  };
}
