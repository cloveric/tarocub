import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

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

export default function App() {
  const [instances, setInstances] = useState<InstanceSummary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

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
        <button className="btn ghost" onClick={() => void loadInstances()} title="Refresh instances">
          Refresh
        </button>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-head">
            <span>Instances</span>
            {instances && <span className="count">{instances.length}</span>}
          </div>
          <InstanceList
            instances={instances}
            error={listError}
            selected={selected}
            onSelect={setSelected}
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

      {toast && (
        <div className={`toast toast-${toast.kind}`} role="status">
          {toast.text}
          <button className="toast-x" onClick={() => setToast(null)} aria-label="Dismiss">
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
        <button className="btn" onClick={() => void load()}>
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
