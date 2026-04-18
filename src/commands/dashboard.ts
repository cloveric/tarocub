import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";

import type { EnvSource } from "../config.js";
import { readConfiguredBotToken } from "../service.js";
import { parseTimelineEvents } from "../state/timeline-log.js";
import { inspectInstanceServiceLiveness, type ServiceCommandDeps } from "./service.js";

export interface DashboardEnv extends Pick<EnvSource, "HOME" | "USERPROFILE" | "CODEX_TELEGRAM_STATE_DIR"> {}

export type DashboardDeps = Pick<ServiceCommandDeps, "cwd" | "isProcessAlive" | "isExpectedServiceProcess">;

function resolveChannelsDir(env: Pick<EnvSource, "HOME" | "USERPROFILE">): string {
  const homeDir = env.HOME ?? env.USERPROFILE;
  if (!homeDir) throw new Error("HOME or USERPROFILE is required");
  return path.join(homeDir, ".cctb");
}

interface InstanceSnapshot {
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
  usage: { requestCount: number; totalInputTokens: number; totalOutputTokens: number; totalCachedTokens: number; totalCostUsd: number; lastUpdatedAt: string };
  auditTotal: number;
  lastSuccess: string;
  lastFailure: string;
  lastError: string;
  recentAudit: Array<{ type: string; outcome: string; timestamp: string; detail?: string }>;
  timelineTotal: number;
  recentTimeline: Array<{ type: string; outcome: string; timestamp: string; detail?: string }>;
  stateDir: string;
}

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
  const runtimeState = await rj<{ lastHandledUpdateId?: number | null }>(path.join(d, "runtime-state.json"), {});
  const us = await rj<InstanceSnapshot["usage"]>(path.join(d, "usage.json"), { requestCount: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0, totalCostUsd: 0, lastUpdatedAt: "" });
  const aa = await aal(path.join(d, "audit.log.jsonl"));
  const timelineRaw = await readFile(path.join(d, "timeline.log.jsonl"), "utf8").catch(() => "");
  const timelineEvents = parseTimelineEvents(timelineRaw);
  const ra = aa.slice(-8).map(pa).filter((e): e is NonNullable<typeof e> => e !== null);
  const recentTimeline = timelineEvents.slice(-8).map(pt);
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
    lastError: (await ll(path.join(d, "service.stderr.log"))).slice(0, 200),
    recentAudit: ra, recentTimeline, stateDir: d,
  };
}

function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function ft(iso: string): string { if (!iso) return "--"; try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); } catch { return iso.slice(0, 16); } }

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

function renderHtml(instances: InstanceSnapshot[]): string {
  const now = new Date().toISOString();
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
    const engLabel = inst.engine.charAt(0).toUpperCase() + inst.engine.slice(1);
    const yoloLabel = inst.approvalMode === "bypass" ? " / Unsafe" : inst.approvalMode === "full-auto" ? " / YOLO" : "";
    const effortLabel = inst.effort !== "default" ? ` / ${inst.effort}` : "";
    const modelLabel = inst.model !== "default" ? ` / ${inst.model}` : "";
    const costStr = inst.usage.totalCostUsd > 0 ? `$${inst.usage.totalCostUsd.toFixed(4)}` : "--";
    const cacheRatio = (inst.usage.totalInputTokens + inst.usage.totalCachedTokens) > 0
      ? Math.round(inst.usage.totalCachedTokens / (inst.usage.totalInputTokens + inst.usage.totalCachedTokens) * 100) : 0;
    const pattern = geoPattern(inst.name, 280, 120);

    const auditRows = inst.recentAudit.map(ev => {
      const c = ev.outcome === "error" ? "#C1392B" : ev.outcome === "success" ? "#2D8B46" : "#6B7280";
      return `<tr><td class="au-t">${ft(ev.timestamp)}</td><td style="color:${c}">${esc(ev.type)}</td><td style="color:${c}">${ev.outcome}</td></tr>`;
    }).join("");
    const timelineRows = inst.recentTimeline.map(ev => {
      const c = ev.outcome === "error" ? "#C1392B" : ev.outcome === "success" ? "#2D8B46" : ev.outcome === "retry" ? "#8B6914" : "#6B7280";
      return `<tr><td class="au-t">${ft(ev.timestamp)}</td><td style="color:${c}">${esc(ev.type)}</td><td style="color:${c}">${esc(ev.outcome)}</td></tr>`;
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

        <div class="metrics">
          <div><span class="m-val">${inst.usage.requestCount.toLocaleString()}</span><span class="m-lbl">Requests</span></div>
          <div><span class="m-val">${costStr}</span><span class="m-lbl">Cost</span></div>
          <div><span class="m-val">${(inst.usage.totalInputTokens + inst.usage.totalOutputTokens).toLocaleString()}</span><span class="m-lbl">Tokens</span></div>
          <div><span class="m-val">${cacheRatio}%</span><span class="m-lbl">Cache</span></div>
        </div>

        <div class="details">
          <div>Sessions <strong>${inst.sessionBindings}</strong></div>
          <div>Paired <strong>${inst.pairedUsers}</strong></div>
          <div>Policy <strong>${inst.policy}</strong></div>
          <div>Locale <strong>${inst.locale}</strong></div>
          <div>Bus <strong>${inst.bus}</strong></div>
          <div>Budget <strong>${inst.budgetUsd !== null ? `$${inst.budgetUsd}` : "--"}</strong></div>
          <div>Last OK <strong style="color:#2D8B46">${ft(inst.lastSuccess)}</strong></div>
          <div>Last Err <strong style="color:#C1392B">${ft(inst.lastFailure)}</strong></div>
          <div>Verbosity <strong>${inst.verbosity}</strong></div>
        </div>

        ${inst.lastError ? `<div class="err">${esc(inst.lastError)}</div>` : ""}

        ${inst.recentAudit.length > 0 ? `
        <details class="audit">
          <summary>Activity <span class="au-count">${inst.auditTotal.toLocaleString()}</span></summary>
          <table>${auditRows}</table>
        </details>` : ""}

        ${inst.recentTimeline.length > 0 ? `
        <details class="audit">
          <summary>Timeline <span class="au-count">${inst.timelineTotal.toLocaleString()}</span></summary>
          <table>${timelineRows}</table>
        </details>` : ""}

        <div class="card-foot">${esc(inst.stateDir)}</div>
      </div>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
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
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(520px,1fr));gap:24px}

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

/* Details grid */
.details{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 16px;font-size:12px;color:#6B7280;margin-bottom:12px}
.details strong{color:#1A1A1A;margin-left:4px;font-weight:600}

/* Error */
.err{background:#FEF2F2;border:1px solid #FECACA;border-radius:6px;padding:8px 12px;font-family:'JetBrains Mono',monospace;font-size:10px;color:#C1392B;margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Audit */
.audit{margin-bottom:8px}
.audit summary{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6B7280;cursor:pointer;user-select:none}
.audit summary:hover{color:#1A1A1A}
.au-count{font-family:'JetBrains Mono',monospace;color:#D4D0CB;margin-left:4px}
.audit table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px;font-family:'JetBrains Mono',monospace}
.audit td{padding:2px 8px 2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.au-t{color:#D4D0CB}

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
  <div class="footer">Read-only snapshot &middot; <code>telegram dashboard</code> to refresh</div>
</div>
</body>
</html>`;
}

function openBrowser(fp: string): void {
  const cmd = process.platform === "win32" ? `start "" "${fp}"` : process.platform === "darwin" ? `open "${fp}"` : `xdg-open "${fp}"`;
  exec(cmd, () => {});
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
