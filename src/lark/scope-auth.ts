import type { Locale } from "../telegram/message-renderer.js";
import { sendLarkCardWithFallback } from "./card-delivery.js";
import { LarkCliError } from "./lark-cli-error.js";
import type { LarkChannelLike, LarkSendOptions } from "./types.js";

export interface LarkScopeDetection {
  /** The missing scope when nameable (e.g. `docx:document`), else null. */
  scope: string | null;
  /** "scope" = a missing permission/scope (→ 权限管理); "auth" = a broader auth-domain
   *  failure (token type/validity) where authorizing a scope may not be the whole fix. */
  kind: "scope" | "auth";
  /** Feishu's per-error troubleshooting URL, when the typed envelope carries one. */
  troubleshooter?: string;
}

// Feishu/Lark returns code 99991672 (and friends) when the app lacks a required permission
// scope, and the lark-cli surfaces `required_scope=...`. We detect these so a missing-scope
// failure becomes an actionable "go authorize" card instead of a raw error — friendly to
// new operators who are still wiring up the bot's permissions.
const LARK_PERMISSION_ERROR_CODES = new Set([99991672, 99991671, 99991679]);

// Name the scope when the error carries it (required_scope=xxx, or an `im:message:send`
// style token); otherwise the card just points to the permissions console.
function extractScopeFromMessage(message: string): string | null {
  const scopeMatch = message.match(/required_scope[=:\s]+([a-z][a-z0-9_.]*(?::[a-z0-9_.]+)+)/i)
    || message.match(/\b((?:im|docx|docs|sheets|drive|calendar|contact|wiki|bitable|base|vc|task|minutes|board|mail)(?::[a-z0-9_.]+)+)\b/i);
  return scopeMatch ? (scopeMatch[1] ?? null) : null;
}

export function detectLarkMissingScope(error: unknown): LarkScopeDetection | null {
  // 1) Typed lark-cli envelope (>= 1.0.45): `type:"authentication"` is authoritative for
  //    the lark-cli path — far more reliable than fuzzy-matching the message. A non-auth
  //    lark-cli error (e.g. type:"api" not_found) is NOT our concern → fall through to null.
  if (error instanceof LarkCliError) {
    const code = error.larkCode;
    const isScopeCode = code !== undefined && LARK_PERMISSION_ERROR_CODES.has(code);
    if (error.larkType === "authentication" || isScopeCode) {
      const scope = extractScopeFromMessage(error.message);
      const isScope = isScopeCode || scope !== null;
      return {
        scope: isScope ? scope : null,
        kind: isScope ? "scope" : "auth",
        ...(error.troubleshooter ? { troubleshooter: error.troubleshooter } : {}),
      };
    }
    return null;
  }

  // 2) SDK / generic errors: numeric permission code (99991672 …) or permission wording.
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  const directCode = typeof (error as { code?: unknown } | null)?.code === "number"
    ? (error as { code: number }).code
    : undefined;
  const codeInMessage = message.match(/\bcode[\s:=()]*?(\d{4,})/i);
  const code = directCode ?? (codeInMessage ? Number(codeInMessage[1]) : undefined);

  const byCode = code !== undefined && LARK_PERMISSION_ERROR_CODES.has(code);
  // Deliberately NOT matching generic "forbidden" / "access denied" / "未授权": those also
  // appear on non-scope failures (e.g. "Forbidden: bot not in chat"), and the delivery hook
  // tries this for EVERY tool error — a loose match would misdirect ordinary failures to the
  // "go authorize a scope" card. Only scope-specific wording counts here; numeric permission
  // codes and required_scope / scope tokens are the strong signals handled above/below.
  const byText = /required_scope/.test(lower)
    || /\b(no permission|permission denied|insufficient (?:permission|scope)|scope (?:not granted|missing|required))\b/.test(lower)
    || /(无权限|权限不足|没有权限|缺少权限|应用权限不足)/.test(message);
  const scope = extractScopeFromMessage(message);
  if (!byCode && !byText && scope === null) {
    return null;
  }
  return { scope, kind: "scope" };
}

// The app's "权限管理 / Permissions & Scopes" page in the Feishu/Lark developer console.
export function larkAppPermissionUrl(appId: string | undefined, domain: string | undefined): string | null {
  if (!appId) {
    return null;
  }
  const intl = domain ? /lark|larksuite|\.us|\.eu/i.test(domain) : false;
  const host = intl ? "open.larksuite.com" : "open.feishu.cn";
  return `https://${host}/app/${encodeURIComponent(appId)}/auth`;
}

export function renderLarkScopeAuthCard(input: {
  scope: string | null;
  appId?: string;
  domain?: string;
  locale?: Locale;
  kind?: "scope" | "auth";
  troubleshooter?: string;
}): Record<string, unknown> {
  const locale = input.locale ?? "zh";
  const en = locale === "en";
  const kind = input.kind ?? "scope";
  const url = larkAppPermissionUrl(input.appId, input.domain);

  let header: string;
  let body: string;
  if (kind === "auth") {
    // A typed auth-domain failure that isn't pinned to a named scope — could be a missing
    // permission OR a token type/validity issue, so the wording stays honest (not "go add
    // this scope") and leans on Feishu's own troubleshooting link.
    header = en ? "⚠ Feishu auth/permission failed" : "⚠ 飞书认证/权限未通过";
    body = en
      ? "A Feishu operation failed its authentication/permission check — it may be a missing scope, or a token type/validity issue. See the troubleshooting link below, or check the app's **Permissions & Scopes** in the developer console."
      : "一个飞书操作的**认证/权限**没通过——可能是缺权限，也可能是 token 类型或有效期问题。点下面看飞书的排查建议，或去开发者后台「**权限管理**」检查。";
  } else {
    const scopeLine = input.scope
      ? (en ? `Missing permission: \`${input.scope}\`` : `缺少权限：\`${input.scope}\``)
      : (en ? "The bot is missing a Feishu/Lark app permission." : "机器人缺少一项飞书应用权限。");
    header = en ? "⚠ Missing Feishu permission" : "⚠ 缺少飞书权限";
    body = en
      ? `${scopeLine}\n\nThis operation needs a Feishu/Lark app permission the bot hasn't been granted. Open the developer console → **Permissions & Scopes**, add it, then re-publish the app version.`
      : `${scopeLine}\n\n这个操作需要一项机器人当前没有的飞书应用权限。点下面去开发者后台 →「**权限管理**」开通，然后发布新版本即可生效。`;
  }

  const elements: Array<Record<string, unknown>> = [{ tag: "markdown", content: body }];
  if (url) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: en ? "Open Permissions console" : "去权限管理授权" },
      type: "primary",
      behaviors: [{ type: "open_url", default_url: url }],
    });
  } else if (kind === "scope") {
    elements.push({
      tag: "markdown",
      content: en
        ? "Run `node dist/src/index.js lark doctor` to see which scopes are missing."
        : "运行 `node dist/src/index.js lark doctor` 可查看缺哪些权限。",
    });
  }
  if (input.troubleshooter) {
    elements.push({
      tag: "markdown",
      content: en
        ? `🔎 [Feishu troubleshooting](${input.troubleshooter})`
        : `🔎 [飞书官方排查建议](${input.troubleshooter})`,
    });
  }
  const summary = kind === "auth"
    ? (en ? "Feishu auth/permission failed" : "飞书认证/权限未通过")
    : (en ? "Missing Feishu permission" : "缺少飞书权限");
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: summary },
    },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: header },
    },
    body: { direction: "vertical", padding: "12px 12px 12px 12px", elements },
  };
}

// Best-effort: if `error` is a missing-scope failure, deliver the actionable auth card and
// return true so the caller skips its raw error reply. Returns false otherwise (including
// when the card itself can't be sent — then the caller falls back to its normal error).
export async function maybeSendLarkScopeAuthCard(
  input: {
    channel: Pick<LarkChannelLike, "send">;
    chatId: string;
    appId?: string;
    domain?: string;
    options?: LarkSendOptions;
    locale: Locale;
  },
  error: unknown,
): Promise<boolean> {
  const missing = detectLarkMissingScope(error);
  if (!missing) {
    return false;
  }
  const card = renderLarkScopeAuthCard({
    scope: missing.scope,
    appId: input.appId,
    domain: input.domain,
    locale: input.locale,
    kind: missing.kind,
    ...(missing.troubleshooter ? { troubleshooter: missing.troubleshooter } : {}),
  });
  const en = input.locale === "en";
  const fallbackText = missing.kind === "auth"
    ? (en
      ? `Feishu auth/permission check failed.${missing.troubleshooter ? ` Troubleshooting: ${missing.troubleshooter}` : " Check the app's Permissions & Scopes."}`
      : `飞书认证/权限未通过。${missing.troubleshooter ? `排查建议：${missing.troubleshooter}` : "请到开发者后台「权限管理」检查。"}`)
    : (en
      ? `Missing Feishu permission${missing.scope ? ` (${missing.scope})` : ""}. Open the developer console → Permissions & Scopes to authorize.`
      : `缺少飞书权限${missing.scope ? `（${missing.scope}）` : ""}。请到开发者后台「权限管理」开通后重试。`);
  try {
    await sendLarkCardWithFallback({
      channel: input.channel,
      chatId: input.chatId,
      card,
      fallbackText,
      options: input.options,
      locale: input.locale,
    });
    return true;
  } catch {
    return false;
  }
}
