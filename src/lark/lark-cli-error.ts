// lark-cli (>= 1.0.45) returns a typed error envelope: { ok:false, error:{ type, subtype,
// code, message, troubleshooter } }. `type:"authentication"` marks an auth-domain failure
// (missing scope, wrong token type, expired token, …). Preserving these typed fields on the
// thrown error — instead of collapsing to just the message string — lets the delivery layer
// reliably turn an auth/permission failure into an actionable card (see scope-auth.ts),
// rather than fuzzy-matching the human-readable message.

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
    if (envelope?.troubleshooter && envelope.troubleshooter.trim()) {
      this.troubleshooter = envelope.troubleshooter.trim();
    }
  }
}
