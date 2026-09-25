import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { consumeUiToken } from "./ui-token";

// ---------------------------------------------------------------------------
// API contract (see src/ui/ui-api.ts). Every request carries the per-process
// token as the `x-ui-token` header. The token arrives in the initial URL
// (?token=<hex>) because the server gates `/` too; we never keep it in the URL
// bar beyond the first read.
// ---------------------------------------------------------------------------

const TOKEN = consumeUiToken({
  href: window.location.href,
  storage: sessionStorage,
  history: window.history,
});

interface InstanceSummary {
  name: string;
  engine: string;
  model: string | null;
  effort: string | null;
  locale: string;
  running: boolean;
  pid: number | null;
  hasLarkEnv: boolean;
}

interface InstanceConfig {
  engine: string;
  model: string | null;
  effort: string | null;
  locale: string;
  verbosity: number;
  budgetUsd: number | null;
  meetingEnabled: boolean;
}

type ConfigPatch = Partial<{
  engine: string;
  model: string;
  effort: string;
  locale: string;
  verbosity: number;
  budgetUsd: number | null;
}>;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "x-ui-token": TOKEN };
  if (init?.body) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json
        ? String((json as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return json as T;
}

const ENGINES = ["codex", "claude", "kimi", "deepseek", "antigravity"] as const;
const ENGINE_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  kimi: "Kimi Code",
  deepseek: "DeepSeek Harness",
  antigravity: "Antigravity",
};
// The config schema (z.enum(EFFORT_LEVELS)) only accepts these; blank = unset.
const EFFORTS = ["", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
const ENGINE_EFFORTS: Record<string, readonly string[]> = {
  codex: EFFORTS,
  claude: ["", "low", "medium", "high", "xhigh", "max"],
  kimi: ["", "low", "high", "max"],
  deepseek: ["", "low", "high", "max"],
  antigravity: ["", "low", "medium", "high"],
};
const LOCALES = [
  { value: "en", label: "English (en)" },
  { value: "zh", label: "中文 (zh)" },
] as const;
const VERBOSITIES = [0, 1, 2] as const;

interface Toast {
  kind: "success" | "error" | "info";
  text: string;
}

type View = "config" | "files";

const INITIAL_VIEW: View = window.location.hash === "#files" ? "files" : "config";

export default function App() {
  const [instances, setInstances] = useState<InstanceSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [view, setView] = useState<View>(INITIAL_VIEW);
  // The file scan can take seconds, so it only starts the first time the
  // File Center is opened; afterwards it stays mounted to keep its results.
  const [filesOpened, setFilesOpened] = useState(INITIAL_VIEW === "files");

  const switchView = useCallback((next: View) => {
    setView(next);
    setSidebarOpen(false);
    if (next === "files") setFilesOpened(true);
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}${next === "files" ? "#files" : ""}`);
  }, []);

  const loadInstances = useCallback(async () => {
    setListError(null);
    try {
      const data = await api<{ instances: InstanceSummary[] }>("/api/instances");
      setInstances(data.instances);
      setSelected((prev) => {
        if (prev && data.instances.some((i) => i.name === prev)) return prev;
        return data.instances[0]?.name ?? null;
      });
    } catch (err) {
      setInstances([]);
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void loadInstances();
  }, [loadInstances]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [sidebarOpen]);

  const onSaved = useCallback(
    (text: string) => {
      setToast({ kind: "success", text });
      void loadInstances();
    },
    [loadInstances],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🐾</span>
          <span className="brand-name">TaroCub</span>
          <span className="brand-sub">Config Console</span>
        </div>
        <nav className="view-switch" aria-label="控制台视图">
          <button
            type="button"
            className={`view-tab${view === "config" ? " active" : ""}`}
            aria-current={view === "config" ? "page" : undefined}
            onClick={() => switchView("config")}
          >
            Bot 配置
          </button>
          <button
            type="button"
            className={`view-tab view-tab-files${view === "files" ? " active" : ""}`}
            aria-current={view === "files" ? "page" : undefined}
            onClick={() => switchView("files")}
          >
            文件中心
          </button>
        </nav>
        <div className="topbar-actions" hidden={view !== "config"}>
          <button
            className="btn ghost mobile-nav-toggle"
            type="button"
            aria-expanded={sidebarOpen}
            aria-controls="instance-sidebar"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            Instances
          </button>
          <button type="button" className="btn ghost" onClick={() => void loadInstances()} title="Refresh instances">
            Refresh
          </button>
        </div>
      </header>

      <div className="layout" hidden={view !== "config"}>
        {sidebarOpen && (
          <button
            type="button"
            className="sidebar-backdrop"
            aria-label="Close instance list"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <aside id="instance-sidebar" className={`sidebar${sidebarOpen ? " open" : ""}`}>
          <div className="sidebar-head">
            <span>Instances</span>
            {instances && <span className="count">{instances.length}</span>}
          </div>
          <InstanceList
            instances={instances}
            error={listError}
            selected={selected}
            onSelect={(name) => {
              setSelected(name);
              setSidebarOpen(false);
            }}
          />
        </aside>

        <main className="content">
          {selected ? (
            <ConfigPanel
              key={selected}
              name={selected}
              onSaved={onSaved}
              onError={(text) => setToast({ kind: "error", text })}
            />
          ) : (
            <EmptyState hasError={Boolean(listError)} />
          )}
        </main>
      </div>

      {filesOpened && (
        <main className="files-view" hidden={view !== "files"}>
          <FileCenter active={view === "files"} notify={setToast} />
        </main>
      )}

      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status">
          {toast.text}
          <button type="button" className="toast-x" onClick={() => setToast(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function InstanceList({
  instances,
  error,
  selected,
  onSelect,
}: {
  instances: InstanceSummary[] | null;
  error: string | null;
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  if (instances === null) {
    return <div className="muted pad">Loading…</div>;
  }
  if (error) {
    return <div className="notice error pad">{error}</div>;
  }
  if (instances.length === 0) {
    return <div className="muted pad">No instances found under ~/.cctb</div>;
  }
  return (
    <ul className="inst-list">
      {instances.map((inst) => (
        <li key={inst.name}>
          <button
            type="button"
            className={`inst${inst.name === selected ? " active" : ""}`}
            onClick={() => onSelect(inst.name)}
          >
            <span className={`dot ${inst.running ? "on" : "off"}`} title={inst.running ? "running" : "stopped"} />
            <span className="inst-name">{inst.name}</span>
            <span className="badge">{ENGINE_LABELS[inst.engine] ?? inst.engine}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ hasError }: { hasError: boolean }) {
  return (
    <div className="empty">
      <div className="empty-icon">🐾</div>
      <h2>{hasError ? "Could not load instances" : "No instance selected"}</h2>
      <p className="muted">
        {hasError
          ? "Check that TaroCub can read ~/.cctb, then Refresh."
          : "Pick an instance from the left to view and edit its configuration."}
      </p>
    </div>
  );
}

function ConfigPanel({
  name,
  onSaved,
  onError,
}: {
  name: string;
  onSaved: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [loaded, setLoaded] = useState<InstanceConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Form fields (strings for controlled inputs).
  const [engine, setEngine] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [locale, setLocale] = useState("en");
  const [verbosity, setVerbosity] = useState("0");
  const [budget, setBudget] = useState("");

  const hydrate = useCallback((cfg: InstanceConfig) => {
    setEngine(cfg.engine);
    setModel(cfg.model ?? "");
    setEffort(cfg.effort ?? "");
    setLocale(cfg.locale);
    setVerbosity(String(cfg.verbosity));
    setBudget(cfg.budgetUsd != null ? String(cfg.budgetUsd) : "");
  }, []);

  const load = useCallback(async () => {
    setLoaded(null);
    setError(null);
    try {
      const data = await api<{ instance: string; config: InstanceConfig }>(
        `/api/instances/${encodeURIComponent(name)}/config`,
      );
      setLoaded(data.config);
      hydrate(data.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [name, hydrate]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch: ConfigPatch = useMemo(() => {
    if (!loaded) return {};
    const next: ConfigPatch = {};
    if (engine !== loaded.engine) next.engine = engine;
    if (model.trim() !== (loaded.model ?? "")) next.model = model.trim();
    if (effort !== (loaded.effort ?? "")) next.effort = effort;
    if (locale !== loaded.locale) next.locale = locale;
    if (Number(verbosity) !== loaded.verbosity) next.verbosity = Number(verbosity);
    const budgetNum = budget.trim() === "" ? null : Number(budget);
    const loadedBudget = loaded.budgetUsd ?? null;
    if (budgetNum !== loadedBudget) next.budgetUsd = budgetNum;
    return next;
  }, [loaded, engine, model, effort, locale, verbosity, budget]);

  const dirtyKeys = Object.keys(patch);
  const budgetInvalid = budget.trim() !== "" && !(Number(budget) > 0);
  const effortOptions = ENGINE_EFFORTS[engine] ?? EFFORTS;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (dirtyKeys.length === 0 || budgetInvalid) return;
    setSaving(true);
    try {
      const res = await api<{ config: InstanceConfig; appliesOn: string }>(
        `/api/instances/${encodeURIComponent(name)}/config`,
        { method: "POST", body: JSON.stringify(patch) },
      );
      setLoaded(res.config);
      hydrate(res.config);
      onSaved(`Saved ${name}. Applies on the instance's next restart.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="panel">
        <div className="notice error">{error}</div>
        <button type="button" className="btn" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!loaded) {
    return <div className="panel muted">Loading configuration…</div>;
  }

  return (
    <form className="panel" onSubmit={onSubmit}>
      <div className="panel-head">
        <div>
          <h1>{name}</h1>
          <p className="muted panel-sub">Changes are written to disk and applied on the instance's next restart.</p>
        </div>
        <span className={`vc-pill ${loaded.meetingEnabled ? "on" : "off"}`}>
          VC meeting: {loaded.meetingEnabled ? "on" : "off"}
        </span>
      </div>

      <div className="grid">
        <Field label="Engine" hint="Which CLI backend this instance drives.">
          <select value={engine} onChange={(e) => {
            const nextEngine = e.target.value;
            setEngine(nextEngine);
            if (!(ENGINE_EFFORTS[nextEngine] ?? EFFORTS).includes(effort)) setEffort("");
          }}>
            {ENGINES.map((v) => (
              <option key={v} value={v}>
                {ENGINE_LABELS[v]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Model" hint="Free-form model id (leave blank for the engine default).">
          <input
            type="text"
            value={model}
            placeholder="engine default"
            onChange={(e) => setModel(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </Field>

        <Field label="Effort" hint="Reasoning effort; blank = unset.">
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            {effortOptions.map((v) => (
              <option key={v || "_blank"} value={v}>
                {v === "" ? "— (unset)" : v}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Locale" hint="Bot reply language.">
          <select value={locale} onChange={(e) => setLocale(e.target.value)}>
            {LOCALES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Verbosity" hint="0 = terse · 1 = normal · 2 = detailed.">
          <select value={verbosity} onChange={(e) => setVerbosity(e.target.value)}>
            {VERBOSITIES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Budget (USD)" hint="Optional per-turn spend cap; blank clears it.">
          <input
            type="number"
            min="0"
            step="0.01"
            value={budget}
            placeholder="none"
            onChange={(e) => setBudget(e.target.value)}
          />
          {budgetInvalid && <span className="field-err">Must be greater than 0, or blank.</span>}
        </Field>
      </div>

      <div className="actions">
        <span className="muted dirty-note">
          {dirtyKeys.length === 0 ? "No changes" : `${dirtyKeys.length} change${dirtyKeys.length > 1 ? "s" : ""}: ${dirtyKeys.join(", ")}`}
        </span>
        <div className="actions-btns">
          <button
            type="button"
            className="btn ghost"
            disabled={saving || dirtyKeys.length === 0}
            onClick={() => hydrate(loaded)}
          >
            Reset
          </button>
          <button type="submit" className="btn primary" disabled={saving || dirtyKeys.length === 0 || budgetInvalid}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// File Center (GET /api/files, POST /api/files/labels, POST /api/files/reveal).
// Read-only inventory: it explains storage units and records user labels; it
// never deletes, moves, or cleans anything.
// ---------------------------------------------------------------------------

type FileCategory =
  | "browser"
  | "project"
  | "deliverable"
  | "download"
  | "environment"
  | "cache"
  | "temporary"
  | "source"
  | "unknown";
type FileSafety = "protected" | "important" | "active" | "rebuildable" | "temporary" | "review";
type FileOrigin = "bridge-input" | "runtime" | "workspace" | "unknown";

interface FileBucket {
  key: string;
  units: number;
  allocatedBytes: number;
}

interface FileUnit {
  id: string;
  name: string;
  absolutePath: string;
  relativePath: string;
  rootKind: "workspace" | "inbox" | "asr";
  instances: string[];
  kind: "file" | "directory" | "symlink" | "collection";
  category: FileCategory;
  categorySource: "system" | "user";
  safety: FileSafety;
  origin: FileOrigin;
  allocatedBytes: number;
  logicalBytes: number;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  lastModifiedAt: string;
  topExtensions: Array<{ extension: string; files: number; allocatedBytes: number }>;
  largestFiles: Array<{ name: string; relativePath: string; allocatedBytes: number }>;
  reasons: string[];
  important: boolean;
  note?: string;
  partial: boolean;
  errorCount: number;
}

interface FileInventory {
  generatedAt: string;
  totalAllocatedBytes: number;
  totalLogicalBytes: number;
  unitCount: number;
  byCategory: FileBucket[];
  bySafety: FileBucket[];
  warnings: string[];
  units: FileUnit[];
}

interface FileLabel {
  category?: FileCategory;
  important?: boolean;
  note?: string;
  updatedAt: string;
}

interface FileLabelPatch {
  important?: boolean;
  category?: FileCategory | null;
  note?: string | null;
}

const FILE_CATEGORIES: readonly FileCategory[] = [
  "project",
  "deliverable",
  "source",
  "download",
  "browser",
  "environment",
  "cache",
  "temporary",
  "unknown",
];

const CATEGORY_META: Record<FileCategory, { label: string; hint: string }> = {
  browser: { label: "浏览器数据", hint: "浏览器的登录状态、Cookie 和配置档案，里面可能有账号凭据。" },
  project: { label: "项目", hint: "Bot 在工作区里处理的代码仓库或工作目录。" },
  deliverable: { label: "成果文件", hint: "Bot 生成或整理出的文档、图片、报告等产出。" },
  download: { label: "下载与附件", hint: "你在聊天里发给 Bot 的文件，Bot 先把它们存到这里再处理。" },
  environment: { label: "运行环境", hint: "Python、Node 等依赖环境，通常可以重新安装。" },
  cache: { label: "缓存", hint: "为了加速而保存的中间数据或模型文件，一般可以重新下载或生成。" },
  temporary: { label: "临时文件", hint: "Bridge 或工具在处理任务时产生的临时内容。" },
  source: { label: "素材", hint: "作为输入使用的素材、资料或原始文件。" },
  unknown: { label: "未识别", hint: "系统没有找到可靠依据来判断它的用途，需要你来确认。" },
};

const SAFETY_ORDER: readonly FileSafety[] = ["protected", "important", "active", "review", "rebuildable", "temporary"];

const SAFETY_META: Record<FileSafety, { label: string; hint: string }> = {
  protected: {
    label: "受保护",
    hint: "包含浏览器登录态或凭据形态的文件。移动或删除它可能让 Bot 需要重新登录。",
  },
  important: { label: "已标记重要", hint: "你把它标记为了重要，盘点时会一直这样提示。" },
  active: { label: "正在使用", hint: "最近 15 分钟内仍有写入，Bot 很可能正在使用它。" },
  rebuildable: {
    label: "可重建",
    hint: "通常可以重新安装或生成。这不代表可以放心删除——删除前请确认没有 Bot 仍在依赖它。",
  },
  temporary: { label: "临时内容", hint: "由 Bridge 或工具在处理过程中生成。是否还需要，取决于对应任务是否已经结束。" },
  review: { label: "需要判断", hint: "系统无法确定它是否还有用。本页面不会处理它，需要你自己判断。" },
};

const ORIGIN_LABELS: Record<FileOrigin, string> = {
  "bridge-input": "Bot 收到的文件",
  runtime: "Bot 运行时生成",
  workspace: "Bot 工作区内容",
  unknown: "来源未知",
};

const ROOT_LABELS: Record<FileUnit["rootKind"], string> = {
  workspace: "工作区",
  inbox: "收件箱",
  asr: "语音转写",
};

const KIND_LABELS: Record<FileUnit["kind"], string> = {
  file: "文件",
  directory: "文件夹",
  symlink: "符号链接",
  collection: "合集",
};

type FileSort = "size" | "updated" | "name";

interface FileFilters {
  query: string;
  bot: string;
  category: string;
  safety: string;
  sort: FileSort;
}

const DEFAULT_FILE_FILTERS: FileFilters = { query: "", bot: "", category: "", safety: "", sort: "size" };
const FILE_PAGE_SIZE = 150;
const NOTE_MAX_LENGTH = 500;

function categoryLabel(key: string): string {
  return CATEGORY_META[key as FileCategory]?.label ?? key;
}

function safetyLabel(key: string): string {
  return SAFETY_META[key as FileSafety]?.label ?? key;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatCount(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatShare(part: number, total: number): string {
  if (total <= 0 || part <= 0) return "0%";
  const pct = (part / total) * 100;
  if (pct < 1) return "<1%";
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

function formatDateTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "未知";
  return new Date(time).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

function formatRelative(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "时间未知";
  const diff = time - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < minute) return "刚刚";
  if (abs < hour) return RELATIVE_TIME.format(Math.round(diff / minute), "minute");
  if (abs < day) return RELATIVE_TIME.format(Math.round(diff / hour), "hour");
  if (abs < 30 * day) return RELATIVE_TIME.format(Math.round(diff / day), "day");
  if (abs < 365 * day) return RELATIVE_TIME.format(Math.round(diff / (30 * day)), "month");
  return RELATIVE_TIME.format(Math.round(diff / (365 * day)), "year");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function applyLabel(unit: FileUnit, patch: FileLabelPatch, label: FileLabel | null): FileUnit {
  const next: FileUnit = { ...unit };
  if (patch.important !== undefined) {
    next.important = label?.important === true;
    if (next.important && next.safety !== "protected") next.safety = "important";
  }
  if (patch.note !== undefined) {
    next.note = label?.note;
  }
  // Clearing a category override can't be resolved locally (the system
  // category is only known to the scanner), so that waits for the rescan.
  if (patch.category !== undefined && label?.category) {
    next.category = label.category;
    next.categorySource = "user";
  }
  return next;
}

function FileCenter({ active, notify }: { active: boolean; notify: (toast: Toast) => void }) {
  const [inventory, setInventory] = useState<FileInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FileFilters>(DEFAULT_FILE_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(FILE_PAGE_SIZE);
  const requestRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  // Hand focus back to the row that opened the drawer (Safari doesn't focus
  // buttons on click, so document.activeElement can't be trusted for this).
  const closeDrawer = useCallback(() => {
    const id = selectedIdRef.current;
    setSelectedId(null);
    if (id) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`.unit[data-unit-id="${id}"]`)?.focus();
      });
    }
  }, []);

  const scan = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api<FileInventory>("/api/files");
      if (requestId !== requestRef.current) return;
      setInventory(data);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(errorText(err));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  const units = inventory?.units ?? [];
  const selectedUnit = selectedId ? units.find((unit) => unit.id === selectedId) ?? null : null;

  useEffect(() => {
    if (selectedId && inventory && !inventory.units.some((unit) => unit.id === selectedId)) {
      setSelectedId(null);
    }
  }, [inventory, selectedId]);

  useEffect(() => {
    setVisibleLimit(FILE_PAGE_SIZE);
  }, [filters]);

  const bots = useMemo(() => {
    const names = new Set<string>();
    for (const unit of units) for (const name of unit.instances) names.add(name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [units]);

  const filtered = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    const matches = units.filter((unit) => {
      if (filters.bot && !unit.instances.includes(filters.bot)) return false;
      if (filters.category && unit.category !== filters.category) return false;
      if (filters.safety && unit.safety !== filters.safety) return false;
      if (!query) return true;
      return [unit.name, unit.relativePath, unit.absolutePath, unit.note ?? ""].some((text) =>
        text.toLowerCase().includes(query),
      );
    });
    const sorted = [...matches];
    if (filters.sort === "size") {
      sorted.sort((a, b) => b.allocatedBytes - a.allocatedBytes);
    } else if (filters.sort === "updated") {
      sorted.sort((a, b) => (Date.parse(b.lastModifiedAt) || 0) - (Date.parse(a.lastModifiedAt) || 0));
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    }
    return sorted;
  }, [units, filters]);

  const filteredBytes = useMemo(() => filtered.reduce((sum, unit) => sum + unit.allocatedBytes, 0), [filtered]);
  const maxUnitBytes = useMemo(() => units.reduce((max, unit) => Math.max(max, unit.allocatedBytes), 0), [units]);
  const filtersActive =
    filters.query !== "" || filters.bot !== "" || filters.category !== "" || filters.safety !== "" || filters.sort !== "size";

  const setFilter = <K extends keyof FileFilters>(key: K, value: FileFilters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  const saveLabel = useCallback(
    async (unit: FileUnit, patch: FileLabelPatch, successText: string): Promise<boolean> => {
      try {
        const res = await api<{ unitId: string; label: FileLabel | null; inventory?: FileInventory }>(
          "/api/files/labels",
          {
            method: "POST",
            body: JSON.stringify({ unitId: unit.id, ...patch }),
          },
        );
        if (res.inventory) {
          // Authoritative post-save inventory: supersede any in-flight scan so
          // a stale result can't overwrite it.
          ++requestRef.current;
          setLoading(false);
          setError(null);
          setInventory(res.inventory);
          notify({ kind: "success", text: successText });
          return true;
        }
        setInventory((prev) =>
          prev
            ? { ...prev, units: prev.units.map((item) => (item.id === unit.id ? applyLabel(item, patch, res.label) : item)) }
            : prev,
        );
        notify({ kind: "success", text: successText });
        void scan();
        return true;
      } catch (err) {
        notify({ kind: "error", text: `保存失败：${errorText(err)}` });
        return false;
      }
    },
    [notify, scan],
  );

  const reveal = useCallback(
    async (unit: FileUnit) => {
      try {
        await api<{ unitId: string; revealed: boolean }>("/api/files/reveal", {
          method: "POST",
          body: JSON.stringify({ unitId: unit.id }),
        });
        notify({ kind: "success", text: `已在 Finder 中显示「${unit.name}」` });
      } catch (err) {
        notify({ kind: "error", text: `无法在 Finder 中显示：${errorText(err)}` });
      }
    },
    [notify],
  );

  if (!inventory) {
    return (
      <div className="files">
        <FileCenterHeader generatedAt={null} loading={loading} onRefresh={() => void scan()} />
        {error && !loading ? (
          <div className="files-card files-failed">
            <h2>盘点没有完成</h2>
            <p className="muted">{error}</p>
            <button type="button" className="btn fc" onClick={() => void scan()}>
              重试
            </button>
          </div>
        ) : (
          <ScanningState />
        )}
      </div>
    );
  }

  const visible = filtered.slice(0, visibleLimit);

  return (
    <div className="files">
      <FileCenterHeader generatedAt={inventory.generatedAt} loading={loading} onRefresh={() => void scan()} />

      {error && !loading && (
        <div className="files-soft-note" role="status">
          重新扫描没有完成：{error}。下面仍是上一次的盘点结果。
        </div>
      )}

      <FileSummary
        inventory={inventory}
        botCount={bots.length}
        category={filters.category}
        safety={filters.safety}
        onCategory={(key) => setFilter("category", filters.category === key ? "" : key)}
        onSafety={(key) => setFilter("safety", filters.safety === key ? "" : key)}
      />

      {inventory.warnings.length > 0 && (
        <details className="files-notes">
          <summary>
            <span className="files-notes-dot" aria-hidden="true" />
            有 {inventory.warnings.length} 条扫描提示：部分位置没能完整读取，相关数字可能偏小
          </summary>
          <ul>
            {inventory.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="files-filters" role="search">
        <label className="ff ff-search">
          <span className="ff-label">搜索</span>
          <input
            type="search"
            value={filters.query}
            placeholder="名称、路径或备注"
            onChange={(e) => setFilter("query", e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </label>
        <label className="ff">
          <span className="ff-label">Bot</span>
          <select value={filters.bot} onChange={(e) => setFilter("bot", e.target.value)}>
            <option value="">全部 Bot</option>
            {bots.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="ff">
          <span className="ff-label">类型</span>
          <select value={filters.category} onChange={(e) => setFilter("category", e.target.value)}>
            <option value="">全部类型</option>
            {FILE_CATEGORIES.map((key) => (
              <option key={key} value={key}>
                {CATEGORY_META[key].label}
              </option>
            ))}
          </select>
        </label>
        <label className="ff">
          <span className="ff-label">状态</span>
          <select value={filters.safety} onChange={(e) => setFilter("safety", e.target.value)}>
            <option value="">全部状态</option>
            {SAFETY_ORDER.map((key) => (
              <option key={key} value={key}>
                {SAFETY_META[key].label}
              </option>
            ))}
          </select>
        </label>
        <label className="ff">
          <span className="ff-label">排序</span>
          <select value={filters.sort} onChange={(e) => setFilter("sort", e.target.value as FileSort)}>
            <option value="size">占用从大到小</option>
            <option value="updated">最近更新优先</option>
            <option value="name">按名称</option>
          </select>
        </label>
        <button
          type="button"
          className="btn ghost ff-reset"
          disabled={!filtersActive}
          onClick={() => setFilters(DEFAULT_FILE_FILTERS)}
        >
          清除筛选
        </button>
      </div>

      <div className="files-count" aria-live="polite">
        {filtered.length === units.length
          ? `共 ${formatCount(units.length)} 个存储单元`
          : `显示 ${formatCount(filtered.length)} / ${formatCount(units.length)} 个存储单元`}
        <span className="files-count-bytes"> · 合计 {formatBytes(filteredBytes)}</span>
      </div>

      {units.length === 0 ? (
        <div className="files-card files-empty">
          <h2>还没有可盘点的文件</h2>
          <p className="muted">各 Bot 的工作区、收件箱和语音转写目录里暂时没有内容。</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="files-card files-empty">
          <h2>没有符合条件的存储单元</h2>
          <p className="muted">换个关键词，或清除筛选再看看。</p>
          <button type="button" className="btn ghost" onClick={() => setFilters(DEFAULT_FILE_FILTERS)}>
            清除筛选
          </button>
        </div>
      ) : (
        <ul className={`unit-list${loading ? " is-refreshing" : ""}`} aria-busy={loading}>
          {visible.map((unit) => (
            <li key={unit.id}>
              <UnitRow
                unit={unit}
                maxBytes={maxUnitBytes}
                totalBytes={inventory.totalAllocatedBytes}
                selected={unit.id === selectedId}
                onOpen={() => setSelectedId(unit.id)}
              />
            </li>
          ))}
        </ul>
      )}

      {filtered.length > visible.length && (
        <button
          type="button"
          className="btn ghost files-more"
          onClick={() => setVisibleLimit((limit) => limit + FILE_PAGE_SIZE)}
        >
          再显示 {Math.min(FILE_PAGE_SIZE, filtered.length - visible.length)} 个（还剩{" "}
          {formatCount(filtered.length - visible.length)} 个）
        </button>
      )}

      {active && selectedUnit && (
        <UnitDrawer
          unit={selectedUnit}
          totalBytes={inventory.totalAllocatedBytes}
          refreshing={loading}
          onClose={closeDrawer}
          onSaveLabel={saveLabel}
          onReveal={reveal}
          notify={notify}
        />
      )}
    </div>
  );
}

function FileCenterHeader({
  generatedAt,
  loading,
  onRefresh,
}: {
  generatedAt: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="files-hero">
      <div className="files-hero-text">
        <p className="files-eyebrow">只读盘点 · 不会删除任何文件</p>
        <h1>文件中心</h1>
        <p className="files-lede">
          这里把每个 Bot 在本机占用的空间整理成一个个「存储单元」：它是什么、属于哪个 Bot、为什么存在、能不能碰。
          本页面只负责看清楚和做标注，不会删除、移动或清理任何东西。
        </p>
      </div>
      <div className="files-hero-meta">
        <span className="files-stamp">
          {loading ? "正在扫描…" : generatedAt ? `盘点于 ${formatDateTime(generatedAt)}` : "尚未盘点"}
        </span>
        <button type="button" className="btn fc" onClick={onRefresh} disabled={loading}>
          {loading ? "扫描中…" : "重新扫描"}
        </button>
      </div>
      {loading && <div className="scan-progress" aria-hidden="true" />}
    </header>
  );
}

function ScanningState() {
  return (
    <div className="files-card scan-state" role="status" aria-live="polite">
      <div className="scan-copy">
        <span className="scan-pulse" aria-hidden="true" />
        <div>
          <strong>正在盘点各 Bot 的文件…</strong>
          <p className="muted">会逐个查看工作区、收件箱和语音转写目录并统计大小。文件多时需要一点时间，请稍候。</p>
        </div>
      </div>
      <div className="scan-skeleton" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className="skeleton-row" style={{ animationDelay: `${index * 120}ms` }} />
        ))}
      </div>
    </div>
  );
}

function FileSummary({
  inventory,
  botCount,
  category,
  safety,
  onCategory,
  onSafety,
}: {
  inventory: FileInventory;
  botCount: number;
  category: string;
  safety: string;
  onCategory: (key: string) => void;
  onSafety: (key: string) => void;
}) {
  const total = inventory.totalAllocatedBytes;
  const categories = [...inventory.byCategory].filter((b) => b.units > 0).sort((a, b) => b.allocatedBytes - a.allocatedBytes);
  const safeties = [...inventory.bySafety]
    .filter((b) => b.units > 0)
    .sort((a, b) => SAFETY_ORDER.indexOf(a.key as FileSafety) - SAFETY_ORDER.indexOf(b.key as FileSafety));

  return (
    <section className="files-summary files-card" aria-label="存储概览">
      <div className="summary-total">
        <span className="summary-label">磁盘实际占用</span>
        <span className="summary-number">{formatBytes(total)}</span>
        <span className="summary-sub">
          文件内容合计 {formatBytes(inventory.totalLogicalBytes)} · {formatCount(inventory.unitCount)} 个单元 ·{" "}
          {formatCount(botCount)} 个 Bot
        </span>
      </div>

      <div className="summary-dist">
        <div className="cat-bar" aria-hidden="true">
          {categories
            .filter((b) => b.allocatedBytes > 0)
            .map((bucket) => (
              <span
                key={bucket.key}
                className={`cat-seg cat-${bucket.key}${category && category !== bucket.key ? " dim" : ""}`}
                style={{ width: `${(bucket.allocatedBytes / Math.max(total, 1)) * 100}%` }}
                title={`${categoryLabel(bucket.key)} ${formatBytes(bucket.allocatedBytes)}`}
              />
            ))}
        </div>
        <div className="cat-legend">
          {categories.map((bucket) => (
            <button
              key={bucket.key}
              type="button"
              className={`cat-chip cat-${bucket.key}${category === bucket.key ? " active" : ""}`}
              aria-pressed={category === bucket.key}
              onClick={() => onCategory(bucket.key)}
              title={CATEGORY_META[bucket.key as FileCategory]?.hint}
            >
              <span className="cat-swatch" aria-hidden="true" />
              <span className="cat-chip-label">{categoryLabel(bucket.key)}</span>
              <span className="cat-chip-size">{formatBytes(bucket.allocatedBytes)}</span>
              <span className="cat-chip-meta">
                {formatShare(bucket.allocatedBytes, total)} · {formatCount(bucket.units)} 个
              </span>
            </button>
          ))}
        </div>
        {safeties.length > 0 && (
          <div className="safety-strip">
            <span className="safety-strip-label">按状态</span>
            {safeties.map((bucket) => (
              <button
                key={bucket.key}
                type="button"
                className={`safety-chip safety-${bucket.key}${safety === bucket.key ? " active" : ""}`}
                aria-pressed={safety === bucket.key}
                onClick={() => onSafety(bucket.key)}
                title={SAFETY_META[bucket.key as FileSafety]?.hint}
              >
                {safetyLabel(bucket.key)}
                <span className="safety-chip-count">{formatCount(bucket.units)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CategoryTag({ category, userSet }: { category: FileCategory; userSet?: boolean }) {
  return (
    <span className={`tag tag-cat cat-${category}`}>
      {categoryLabel(category)}
      {userSet && <span className="tag-mark" title="你设置的类型">·自定</span>}
    </span>
  );
}

function SafetyTag({ safety }: { safety: FileSafety }) {
  return <span className={`tag tag-safety safety-${safety}`}>{safetyLabel(safety)}</span>;
}

function BotBadges({ instances, limit = 3 }: { instances: string[]; limit?: number }) {
  const shown = instances.slice(0, limit);
  const rest = instances.length - shown.length;
  return (
    <>
      {shown.map((name) => (
        <span key={name} className="tag tag-bot">
          {name}
        </span>
      ))}
      {rest > 0 && (
        <span className="tag tag-bot" title={instances.slice(limit).join(", ")}>
          +{rest}
        </span>
      )}
    </>
  );
}

function UnitRow({
  unit,
  maxBytes,
  totalBytes,
  selected,
  onOpen,
}: {
  unit: FileUnit;
  maxBytes: number;
  totalBytes: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const scale = maxBytes > 0 ? Math.max(unit.allocatedBytes / maxBytes, unit.allocatedBytes > 0 ? 0.015 : 0) : 0;
  return (
    <button
      type="button"
      className={`unit cat-${unit.category}${selected ? " selected" : ""}`}
      data-unit-id={unit.id}
      onClick={onOpen}
      aria-haspopup="dialog"
    >
      <span className="unit-main">
        <span className="unit-title">
          <span className="unit-name">{unit.name}</span>
          {unit.important && (
            <span className="unit-star" role="img" title="已标记重要" aria-label="已标记重要">
              ★
            </span>
          )}
        </span>
        <span className="unit-path">
          {ROOT_LABELS[unit.rootKind]} · {KIND_LABELS[unit.kind]}
          {unit.relativePath ? ` · ${unit.relativePath}` : ""}
        </span>
        <span className="unit-tags">
          <CategoryTag category={unit.category} userSet={unit.categorySource === "user"} />
          <SafetyTag safety={unit.safety} />
          <BotBadges instances={unit.instances} />
        </span>
        <span className="unit-reason">{unit.note ? `备注：${unit.note}` : unit.reasons[0] ?? CATEGORY_META[unit.category].hint}</span>
      </span>
      <span className="unit-side">
        <span className="unit-size">{formatBytes(unit.allocatedBytes)}</span>
        <span className="unit-meter" aria-hidden="true">
          <span style={{ width: `${scale * 100}%` }} />
        </span>
        <span className="unit-meta">
          占 {formatShare(unit.allocatedBytes, totalBytes)} · {formatCount(unit.fileCount)} 个文件
        </span>
        <span className="unit-meta" title={formatDateTime(unit.lastModifiedAt)}>
          {formatRelative(unit.lastModifiedAt)}更新
          {unit.partial ? " · 统计不完整" : ""}
        </span>
      </span>
    </button>
  );
}

function UnitDrawer({
  unit,
  totalBytes,
  refreshing,
  onClose,
  onSaveLabel,
  onReveal,
  notify,
}: {
  unit: FileUnit;
  totalBytes: number;
  refreshing: boolean;
  onClose: () => void;
  onSaveLabel: (unit: FileUnit, patch: FileLabelPatch, successText: string) => Promise<boolean>;
  onReveal: (unit: FileUnit) => Promise<void>;
  notify: (toast: Toast) => void;
}) {
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [togglingImportant, setTogglingImportant] = useState(false);
  const [revealing, setRevealing] = useState(false);

  // Runs once per open: focus the close button, close on Escape, trap Tab.
  // The trap listens on window because focus can fall out of the drawer to
  // <body> (a focused button gets disabled while saving, or the label editor
  // remounts), and a handler on the drawer itself would never see that Tab.
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape while an IME is composing cancels the composition, not the drawer.
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      const drawer = drawerRef.current;
      if (event.key !== "Tab" || !drawer) return;
      const focusable = drawer.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!drawer.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const toggleImportant = async (next: boolean) => {
    setTogglingImportant(true);
    await onSaveLabel(unit, { important: next }, next ? `已把「${unit.name}」标记为重要` : `已取消「${unit.name}」的重要标记`);
    setTogglingImportant(false);
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(unit.absolutePath);
      notify({ kind: "success", text: "路径已复制" });
    } catch {
      notify({ kind: "error", text: "无法复制，请手动选中路径" });
    }
  };

  const safety = SAFETY_META[unit.safety];
  const editorKey = `${unit.id}:${unit.categorySource}:${unit.category}:${unit.note ?? ""}`;

  return (
    <>
      <button type="button" className="unit-drawer-backdrop" aria-label="关闭详情" tabIndex={-1} onClick={onClose} />
      <aside
        ref={drawerRef}
        className={`unit-drawer cat-${unit.category}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unit-drawer-title"
      >
        <header className="drawer-head">
          <div className="drawer-head-text">
            <span className="drawer-kicker">
              {ROOT_LABELS[unit.rootKind]} · {KIND_LABELS[unit.kind]}
              {refreshing && <span className="drawer-refreshing"> · 正在更新盘点…</span>}
            </span>
            <h2 id="unit-drawer-title">{unit.name}</h2>
            <div className="unit-tags">
              <CategoryTag category={unit.category} userSet={unit.categorySource === "user"} />
              <SafetyTag safety={unit.safety} />
              <BotBadges instances={unit.instances} limit={8} />
            </div>
          </div>
          <button type="button" ref={closeRef} className="drawer-close" aria-label="关闭详情" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="drawer-body">
          <section className={`safety-callout safety-${unit.safety}`}>
            <strong>{safety.label}</strong>
            <p>{safety.hint}</p>
          </section>

          {unit.partial && (
            <div className="files-soft-note">
              有 {formatCount(unit.errorCount)} 处内容没能读取，下面的大小和数量可能偏小。
            </div>
          )}

          <section className="drawer-section">
            <h3>为什么会有它</h3>
            <p className="drawer-cat-hint">{CATEGORY_META[unit.category].hint}</p>
            {unit.reasons.length > 0 && (
              <ul className="reason-list">
                {unit.reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            )}
          </section>

          <dl className="fact-grid">
            <div>
              <dt>磁盘实际占用</dt>
              <dd>
                {formatBytes(unit.allocatedBytes)}
                <span className="fact-sub">占全部 {formatShare(unit.allocatedBytes, totalBytes)}</span>
              </dd>
            </div>
            <div>
              <dt>文件内容大小</dt>
              <dd>{formatBytes(unit.logicalBytes)}</dd>
            </div>
            <div>
              <dt>包含</dt>
              <dd>
                {formatCount(unit.fileCount)} 个文件
                <span className="fact-sub">
                  {formatCount(unit.directoryCount)} 个文件夹
                  {unit.symlinkCount > 0 ? ` · ${formatCount(unit.symlinkCount)} 个符号链接` : ""}
                </span>
              </dd>
            </div>
            <div>
              <dt>最近修改</dt>
              <dd>
                {formatRelative(unit.lastModifiedAt)}
                <span className="fact-sub">{formatDateTime(unit.lastModifiedAt)}</span>
              </dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{ORIGIN_LABELS[unit.origin]}</dd>
            </div>
            <div>
              <dt>所属 Bot</dt>
              <dd>{unit.instances.length > 0 ? unit.instances.join("、") : "未知"}</dd>
            </div>
          </dl>

          <section className="drawer-section">
            <h3>位置</h3>
            <code className="path-block">{unit.absolutePath}</code>
            <div className="drawer-actions">
              <button
                type="button"
                className="btn fc"
                disabled={revealing}
                onClick={async () => {
                  setRevealing(true);
                  await onReveal(unit);
                  setRevealing(false);
                }}
              >
                {revealing ? "正在打开…" : "在 Finder 中显示"}
              </button>
              <button type="button" className="btn ghost" onClick={() => void copyPath()}>
                复制路径
              </button>
            </div>
          </section>

          {unit.topExtensions.length > 0 && (
            <section className="drawer-section">
              <h3>主要文件类型</h3>
              <ul className="ext-list">
                {unit.topExtensions.map((ext) => (
                  <li key={ext.extension || "_none"} className="ext-row">
                    <span className="ext-name">{ext.extension || "无扩展名"}</span>
                    <span className="ext-track" aria-hidden="true">
                      <span
                        style={{ width: `${unit.allocatedBytes > 0 ? (ext.allocatedBytes / unit.allocatedBytes) * 100 : 0}%` }}
                      />
                    </span>
                    <span className="ext-size">
                      {formatBytes(ext.allocatedBytes)} · {formatCount(ext.files)} 个
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {unit.largestFiles.length > 0 && (
            <section className="drawer-section">
              <h3>最大的几个文件</h3>
              <ol className="largest-list">
                {unit.largestFiles.map((file) => (
                  <li key={file.relativePath || file.name}>
                    <span className="largest-text">
                      <span className="largest-name">{file.name}</span>
                      {file.relativePath && file.relativePath !== file.name && (
                        <span className="largest-path">{file.relativePath}</span>
                      )}
                    </span>
                    <span className="largest-size">{formatBytes(file.allocatedBytes)}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="drawer-section label-section">
            <h3>你的标注</h3>
            <p className="drawer-cat-hint">标注只记录在 TaroCub 里，帮助你以后认出它；不会改动文件本身。</p>
            <label className="switch">
              <input
                type="checkbox"
                role="switch"
                checked={unit.important}
                disabled={togglingImportant}
                onChange={(e) => void toggleImportant(e.target.checked)}
              />
              <span className="switch-track" aria-hidden="true" />
              <span className="switch-text">
                标记为重要
                <span className="switch-hint">提醒自己和其他人：这里的东西不要动</span>
              </span>
            </label>
            <LabelEditor key={editorKey} unit={unit} onSave={onSaveLabel} />
          </section>
        </div>
      </aside>
    </>
  );
}

function LabelEditor({
  unit,
  onSave,
}: {
  unit: FileUnit;
  onSave: (unit: FileUnit, patch: FileLabelPatch, successText: string) => Promise<boolean>;
}) {
  const initialCategory = unit.categorySource === "user" ? unit.category : "";
  const initialNote = unit.note ?? "";
  const [category, setCategory] = useState<string>(initialCategory);
  const [note, setNote] = useState(initialNote);
  const [saving, setSaving] = useState(false);

  const patch: FileLabelPatch = {};
  if (category !== initialCategory) patch.category = category === "" ? null : (category as FileCategory);
  if (note.trim() !== initialNote) patch.note = note.trim() === "" ? null : note.trim();
  const dirty = Object.keys(patch).length > 0;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    setSaving(true);
    await onSave(unit, patch, `已保存「${unit.name}」的标注`);
    setSaving(false);
  };

  return (
    <form className="label-form" onSubmit={onSubmit}>
      <label className="ff">
        <span className="ff-label">类型</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">
            {unit.categorySource === "system" ? `自动识别（${categoryLabel(unit.category)}）` : "恢复自动识别"}
          </option>
          {FILE_CATEGORIES.map((key) => (
            <option key={key} value={key}>
              {CATEGORY_META[key].label}
            </option>
          ))}
        </select>
      </label>
      <label className="ff">
        <span className="ff-label">备注</span>
        <textarea
          value={note}
          rows={3}
          maxLength={NOTE_MAX_LENGTH}
          placeholder="例如：客户 A 的交付稿，项目结束前保留"
          onChange={(e) => setNote(e.target.value)}
        />
        <span className="field-hint">
          {note.length}/{NOTE_MAX_LENGTH}
        </span>
      </label>
      <div className="label-actions">
        <button
          type="button"
          className="btn ghost"
          disabled={!dirty || saving}
          onClick={() => {
            setCategory(initialCategory);
            setNote(initialNote);
          }}
        >
          还原
        </button>
        <button type="submit" className="btn fc" disabled={!dirty || saving}>
          {saving ? "保存中…" : "保存标注"}
        </button>
      </div>
    </form>
  );
}
