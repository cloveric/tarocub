import type { Locale } from "../telegram/message-renderer.js";
import { sendLarkCardWithFallback } from "./card-delivery.js";
import type { LarkChannelLike, LarkSendOptions } from "./types.js";

// Feishu/Lark returns code 99991672 (and friends) when the app lacks a required permission
// scope, and the lark-cli surfaces `required_scope=...`. We detect these so a missing-scope
// failure becomes an actionable "go authorize" card instead of a raw error — friendly to
// new operators who are still wiring up the bot's permissions.
const LARK_PERMISSION_ERROR_CODES = new Set([99991672, 99991671, 99991679]);

export function detectLarkMissingScope(error: unknown): { scope: string | null } | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const lower = message.toLowerCase();
  const directCode = typeof (error as { code?: unknown } | null)?.code === "number"
    ? (error as { code: number }).code
    : undefined;
  const codeInMessage = message.match(/\bcode[\s:=()]*?(\d{4,})/i);
  const code = directCode ?? (codeInMessage ? Number(codeInMessage[1]) : undefined);

  const byCode = code !== undefined && LARK_PERMISSION_ERROR_CODES.has(code);
  const byText = /required_scope/.test(lower)
    || /\b(no permission|permission denied|access denied|forbidden|insufficient (?:permission|scope)|scope (?:not granted|missing|required))\b/.test(lower)
    || /(无权限|权限不足|没有权限|缺少权限|未授权|应用权限不足)/.test(message);
  if (!byCode && !byText) {
    return null;
  }
  // Name the scope when the error carries it (required_scope=xxx, or an `im:message:send`
  // style token); otherwise the card just points to the permissions console.
  const scopeMatch = message.match(/required_scope[=:\s]+([a-z][a-z0-9_.]*(?::[a-z0-9_.]+)+)/i)
    || message.match(/\b((?:im|docx|docs|sheets|drive|calendar|contact|wiki|bitable|base|vc|task|minutes|board|mail)(?::[a-z0-9_.]+)+)\b/i);
  return { scope: scopeMatch ? (scopeMatch[1] ?? null) : null };
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
}): Record<string, unknown> {
  const locale = input.locale ?? "zh";
  const url = larkAppPermissionUrl(input.appId, input.domain);
  const scopeLine = input.scope
    ? (locale === "en" ? `Missing permission: \`${input.scope}\`` : `缺少权限：\`${input.scope}\``)
    : (locale === "en" ? "The bot is missing a Feishu/Lark app permission." : "机器人缺少一项飞书应用权限。");
  const body = locale === "en"
    ? `${scopeLine}\n\nThis operation needs a Feishu/Lark app permission the bot hasn't been granted. Open the developer console → **Permissions & Scopes**, add it, then re-publish the app version.`
    : `${scopeLine}\n\n这个操作需要一项机器人当前没有的飞书应用权限。点下面去开发者后台 →「**权限管理**」开通，然后发布新版本即可生效。`;
  const elements: Array<Record<string, unknown>> = [{ tag: "markdown", content: body }];
  if (url) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: locale === "en" ? "Open Permissions console" : "去权限管理授权" },
      type: "primary",
      behaviors: [{ type: "open_url", default_url: url }],
    });
  } else {
    elements.push({
      tag: "markdown",
      content: locale === "en"
        ? "Run `node dist/src/index.js lark doctor` to see which scopes are missing."
        : "运行 `node dist/src/index.js lark doctor` 可查看缺哪些权限。",
    });
  }
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: locale === "en" ? "Missing Feishu permission" : "缺少飞书权限" },
    },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: locale === "en" ? "⚠ Missing Feishu permission" : "⚠ 缺少飞书权限" },
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
  const card = renderLarkScopeAuthCard({ scope: missing.scope, appId: input.appId, domain: input.domain, locale: input.locale });
  const fallbackText = input.locale === "en"
    ? `Missing Feishu permission${missing.scope ? ` (${missing.scope})` : ""}. Open the developer console → Permissions & Scopes to authorize.`
    : `缺少飞书权限${missing.scope ? `（${missing.scope}）` : ""}。请到开发者后台「权限管理」开通后重试。`;
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
