import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { registerApp } from "@larksuiteoapi/node-sdk";
import qrcode from "qrcode-terminal";

import { ensureLarkCliBridgeBindingConfig } from "./cli.js";
import { resolveLarkStateDir, writeLarkEnvFile } from "./env-file.js";
import { formatLarkProvisioningResult, provisionLarkApp, type LarkProvisioningResult } from "./provisioning.js";
import type { LarkRuntimeEnv } from "./config.js";

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
  initLarkCli?: (input: { appId: string; appSecret: string; brand: "feishu" | "lark"; stateDir: string; homeDir?: string }) => Promise<void>;
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
  try {
    const stateDir = resolveLarkStateDir(env);
    await (options.initLarkCli ?? initLarkCliFromWizard)({
      appId: result.client_id,
      appSecret: result.client_secret,
      brand: domain === "lark" ? "lark" : "feishu",
      stateDir,
      homeDir: env.HOME ?? env.USERPROFILE,
    });
    logger.log("lark-cli bound to bridge credentials through the lark-channel source.");
  } catch (error) {
    logger.log(`lark-cli init skipped: ${error instanceof Error ? error.message : String(error)}`);
    logger.log("Full Lark-native functionality requires lark-cli; basic chat can still run, but docs/newgroup/Drive-style actions need the CLI.");
    logger.log("Install/preflight: node dist/src/index.js lark cli preflight --install --identity bot-only");
    logger.log("Run: node dist/src/index.js lark cli bind --identity bot-only");
  }
  logger.log("Run: node dist/src/index.js lark doctor");
  logger.log("Run: node dist/src/index.js lark run");

  return envPath;
}

async function initLarkCliFromWizard(input: { appId: string; appSecret: string; brand: "feishu" | "lark"; stateDir: string; homeDir?: string }): Promise<void> {
  await ensureLarkCliBridgeBindingConfig({
    appId: input.appId,
    stateDir: input.stateDir,
    brand: input.brand,
    homeDir: input.homeDir,
    entrypoint: path.resolve(process.argv[1] ?? "dist/src/index.js"),
  });
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(input.homeDir ? { HOME: input.homeDir, USERPROFILE: input.homeDir } : {}),
      CCTB_LARK_STATE_DIR: input.stateDir,
      LARK_CHANNEL: "1",
    };
    delete childEnv.LARK_APP_SECRET;
    const child = execFileCallback(
      "lark-cli",
      ["config", "bind", "--source", "lark-channel", "--app-id", input.appId, "--identity", "bot-only"],
      { timeout: 30_000, maxBuffer: 512 * 1024, env: childEnv },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
    child.stdin?.end();
  });
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
