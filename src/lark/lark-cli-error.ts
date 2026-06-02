// lark-cli (>= 1.0.45) returns a typed error envelope: { ok:false, error:{ type, subtype,
// code, message, troubleshooter } }. `type:"authentication"` marks an auth-domain failure
// (missing scope, wrong token type, expired token, …). Preserving these typed fields on the
// thrown error — instead of collapsing to just the message string — lets the delivery layer
// reliably turn an auth/permission failure into an actionable card (see scope-auth.ts),
// rather than fuzzy-matching the human-readable message.
//
// IMPORTANT: lark-cli writes that envelope to STDERR and EXITS NONZERO, so a promisified
// child_process.execFile REJECTS with an ExecFileException *before* the caller can read
// stdout — and its `.code` is the PROCESS exit status (2/3), NOT the lark error code. So the
// envelope must be recovered from the rejection's stderr (see larkCliErrorFromExec), or the
// typed error is never constructed for real failures.

export interface LarkCliErrorEnvelope {
  type?: string;
  subtype?: string;
  code?: number;
  message?: string;
  troubleshooter?: string;
  hint?: string;
}

export class LarkCliError extends Error {
  readonly larkType?: string;
  readonly larkSubtype?: string;
  readonly larkCode?: number;
  readonly troubleshooter?: string;

  constructor(envelope: LarkCliErrorEnvelope | undefined, fallbackMessage: string) {
    super((envelope?.message && envelope.message.trim()) || fallbackMessage);
    this.name = "LarkCliError";
    if (envelope?.type) {
      this.larkType = envelope.type;
    }
    if (envelope?.subtype) {
      this.larkSubtype = envelope.subtype;
    }
    if (typeof envelope?.code === "number") {
      this.larkCode = envelope.code;
    }
    // lark-cli's troubleshooter is a sentence with the URL embedded, e.g.
    // "排查建议查看(Troubleshooting suggestions): https://open.feishu.cn/search?...". Keep just
    // the URL so it embeds cleanly in a card link — the surrounding text (and its parens)
    // would otherwise break a markdown [label](url).
    if (envelope?.troubleshooter && envelope.troubleshooter.trim()) {
      const url = envelope.troubleshooter.match(/https?:\/\/[^\s)]+/);
      if (url) {
        this.troubleshooter = url[0];
      }
    }
  }
}

function parseLarkCliErrorEnvelope(stream: string | undefined): LarkCliErrorEnvelope | undefined {
  if (!stream) {
    return undefined;
  }
  // The envelope is a single JSON object, sometimes after a banner line — grab the outermost
  // {...} and parse it.
  const start = stream.indexOf("{");
  const end = stream.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(stream.slice(start, end + 1)) as { ok?: boolean; error?: LarkCliErrorEnvelope };
    if (parsed && parsed.ok === false && parsed.error && typeof parsed.error === "object") {
      return parsed.error;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// Convert a failed lark-cli invocation into a LarkCliError. lark-cli exits nonzero and writes
// its typed envelope to stderr, so a promisified execFile rejects with an ExecFileException
// (whose .stderr holds the envelope and .code is the exit status). Recover the typed envelope
// so the failure flows as a LarkCliError; if there's no parseable envelope, return the
// original error unchanged so message-based detection still gets a chance.
export function larkCliErrorFromExec(error: unknown, fallbackMessage: string): Error {
  if (error instanceof LarkCliError) {
    return error;
  }
  const streams = error as { stderr?: unknown; stdout?: unknown } | null;
  const stderr = typeof streams?.stderr === "string" ? streams.stderr : undefined;
  const stdout = typeof streams?.stdout === "string" ? streams.stdout : undefined;
  const envelope = parseLarkCliErrorEnvelope(stderr) ?? parseLarkCliErrorEnvelope(stdout);
  if (envelope) {
    return new LarkCliError(envelope, fallbackMessage);
  }
  return error instanceof Error ? error : new Error(fallbackMessage);
}
