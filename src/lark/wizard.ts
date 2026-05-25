import { registerApp } from "@larksuiteoapi/node-sdk";
import qrcode from "qrcode-terminal";

import { writeLarkEnvFile } from "./env-file.js";
import { formatLarkProvisioningResult, provisionLarkApp, type LarkProvisioningResult } from "./provisioning.js";
import type { LarkRuntimeEnv } from "./service.js";

export interface LarkWizardLogger {
  log(message?: unknown, ...optionalParams: unknown[]): void;
}

export interface LarkWizardRegisterAppResult {
  client_id: string;
  client_secret: string;
  user_info?: {
    open_id?: string;
    tenant_brand?: "feishu" | "lark";
  };
}

export interface LarkWizardRegisterAppOptions {
  domain?: string;
  larkDomain?: string;
  source?: string;
  signal?: AbortSignal;
  onQRCodeReady: (info: { url: string; expireIn: number }) => void;
  onStatusChange?: (info: { status: "polling" | "slow_down" | "domain_switched"; interval?: number }) => void;
}

export interface LarkWizardOptions {
  registerAppImpl?: (options: LarkWizardRegisterAppOptions) => Promise<LarkWizardRegisterAppResult>;
  generateQRCode?: (url: string) => void;
  provisionApp?: (input: { appId: string; appSecret: string; domain?: string; logger?: LarkWizardLogger }) => Promise<LarkProvisioningResult>;
}

export async function runLarkWizard(env: LarkRuntimeEnv, logger: LarkWizardLogger = console, options: LarkWizardOptions = {}): Promise<string> {
  const register = options.registerAppImpl ?? registerApp;
  const generateQRCode = options.generateQRCode ?? ((url: string) => qrcode.generate(url, { small: true }));
  logger.log("Starting Feishu/Lark PersonalAgent registration wizard.");
  logger.log("Scan the QR code with the Feishu/Lark mobile app, then choose or create a PersonalAgent app.");

  const result: LarkWizardRegisterAppResult = await register({
    ...resolveLarkRegistrationDomains(env.LARK_DOMAIN),
    source: "cc-telegram-bridge",
    onQRCodeReady: (info) => {
      logger.log("");
      generateQRCode(info.url);
      logger.log("");
      logger.log(`QR expires in about ${Math.max(1, Math.round(info.expireIn / 60))} minute(s).`);
      logger.log(`Open directly: ${info.url}`);
      logger.log("");
    },
    onStatusChange: (info) => {
      if (info.status === "domain_switched") {
        logger.log("Detected Lark international tenant; switching registration domain.");
      } else if (info.status === "slow_down") {
        logger.log("Registration polling slowed down by the server.");
      }
    },
  });

  const tenantBrand = result.user_info?.tenant_brand;
  const domain = tenantBrand === "lark" ? "lark" : tenantBrand === "feishu" ? "feishu" : env.LARK_DOMAIN;
  const envPath = await writeLarkEnvFile(env, {
    appId: result.client_id,
    appSecret: result.client_secret,
    ...(domain ? { domain } : {}),
    requireMentionInGroup: true,
  });

  logger.log("Lark app registration complete.");
  logger.log(`App ID: ${result.client_id}`);
  logger.log(`Tenant: ${domain ?? "default"}`);
  if (result.user_info?.open_id) {
    logger.log(`Operator open_id: ${result.user_info.open_id}`);
  }
  logger.log(`Saved credentials to ${envPath}`);
  try {
    const provisioning = await (options.provisionApp ?? provisionLarkApp)({
      appId: result.client_id,
      appSecret: result.client_secret,
      ...(domain ? { domain } : {}),
      logger,
    });
    for (const line of formatLarkProvisioningResult(provisioning)) {
      logger.log(line);
    }
  } catch (error) {
    logger.log(`Lark permission provisioning check failed: ${error instanceof Error ? error.message : String(error)}`);
    logger.log("The app credentials were saved; run `node dist/src/index.js lark doctor` and check the Feishu developer console if callbacks or media fail.");
  }
  logger.log("Run: node dist/src/index.js lark doctor");
  logger.log("Run: node dist/src/index.js lark run");

  return envPath;
}

function resolveLarkRegistrationDomains(domain: string | undefined): { domain?: string; larkDomain?: string } {
  if (!domain) {
    return {};
  }
  const normalized = domain.trim().toLowerCase();
  if (normalized === "feishu") {
    return { domain: "accounts.feishu.cn" };
  }
  if (normalized === "lark") {
    return { domain: "accounts.larksuite.com", larkDomain: "accounts.larksuite.com" };
  }
  return { domain };
}
