import path from "node:path";

import type { Locale } from "../telegram/message-renderer.js";

export interface LarkAccountCardInput {
  appId?: string;
  domain?: string;
  instanceName?: string;
  stateDir: string;
  locale: Locale;
}

export function isLarkAccountCommand(text: string): boolean {
  return /^\/account(?:@\w+)?(?:\s|$)/i.test(text.trim());
}

/**
 * Read-only "current Lark app" status card. App switching deliberately goes
 * through `lark wizard` (QR OAuth, no secret typed into chat) rather than an
 * in-card credential form, so the app secret never travels through Lark's
 * card-form submission path / server-side card cache.
 */
export function renderLarkAccountCard(input: LarkAccountCardInput): Record<string, unknown> {
  const labels = accountCardLabels(input.locale);
  const tenant = resolveTenantLabel(input.domain, input.locale);
  const lines = [
    `📋 **${labels.title}**`,
    "",
    `**App ID**: \`${maskAppId(input.appId)}\``,
    `**${labels.tenant}**: ${tenant}`,
    `**${labels.instance}**: ${input.instanceName ?? path.basename(input.stateDir)}`,
    `**${labels.stateDir}**: \`${input.stateDir}\``,
    "",
    labels.switchHint,
  ];
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: labels.title },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [{ tag: "markdown", content: lines.join("\n") }],
    },
  };
}

function maskAppId(appId: string | undefined): string {
  if (!appId) {
    return "(unknown)";
  }
  if (appId.length < 12) {
    return appId;
  }
  return `${appId.slice(0, 8)}****${appId.slice(-4)}`;
}

function resolveTenantLabel(domain: string | undefined, locale: Locale): string {
  const normalized = (domain ?? "").toLowerCase();
  if (normalized.includes("lark") || normalized === "1") {
    return locale === "en" ? "Lark (international)" : "Lark（海外）";
  }
  if (normalized.includes("feishu") || normalized === "" || normalized === "0") {
    return locale === "en" ? "Feishu (China)" : "飞书（国内）";
  }
  return domain ?? (locale === "en" ? "Feishu (China)" : "飞书（国内）");
}

function accountCardLabels(locale: Locale): {
  title: string;
  tenant: string;
  instance: string;
  stateDir: string;
  switchHint: string;
} {
  if (locale === "en") {
    return {
      title: "Current Lark app",
      tenant: "Tenant",
      instance: "Instance",
      stateDir: "State dir",
      switchHint: "_To switch the bound app, run `lark wizard` on the host and scan the QR code (no secret is typed into chat)._",
    };
  }
  return {
    title: "当前飞书应用",
    tenant: "租户",
    instance: "实例",
    stateDir: "状态目录",
    switchHint: "_要更换绑定的 app，请在本机运行 `lark wizard` 扫码绑定（不在聊天里输入 secret）。_",
  };
}
