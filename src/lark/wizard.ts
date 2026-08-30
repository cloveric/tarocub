import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { registerApp } from "@larksuiteoapi/node-sdk";
import qrcode from "qrcode-terminal";

import { ensureLarkCliBridgeBindingConfig } from "./cli.js";
import { loadLarkRuntimeEnv, resolveLarkStateDir, writeLarkEnvFile } from "./env-file.js";
import { BASE_MESSAGE_SCOPE, GROUP_MSG_SCOPE } from "./group-scope-check.js";
import { REQUIRED_LARK_SCOPES, formatLarkProvisioningResult, provisionLarkApp, type LarkProvisioningResult } from "./provisioning.js";
import type { LarkRuntimeEnv } from "./config.js";

/** Max wait for the registration server to return a QR before failing fast. */
const QR_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Tenant scopes pre-filled into the PersonalAgent QR confirm page on every
 * registration: the /group all pair (never in the platform template) PLUS
 * every scope the bridge requires. The platform's default template used to
 * cover the required set, but it is server-side and drifts — it dropped
 * `docx:document:create` between June and August 2026, so a fresh bot came
 * out needing a second scan. Pre-filling the full required set makes the
 * wizard independent of that template; the SDK layers addons additively and
 * the confirm page shows only what the template lacks.
 */
export const DEFAULT_LARK_REGISTRATION_TENANT_SCOPES: readonly string[] = [
  ...new Set([...REQUIRED_LARK_SCOPES, BASE_MESSAGE_SCOPE, GROUP_MSG_SCOPE]),
];

export interface LarkRegistrationAddons {
  preset?: boolean;
  scopes?: { tenant?: string[]; user?: string[] };
}

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
  /** Update an EXISTING app's config (the confirm page shows the diff) instead of creating one. */
  appId?: string;
  /** Incremental scopes / events pre-filled into the confirm page. */
  addons?: LarkRegistrationAddons;
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

  const result = await registerLarkAppWithQr({
    register,
    generateQRCode,
    logger,
    registerOptions: {
      ...resolveLarkRegistrationDomains(env.LARK_DOMAIN),
      source: "tarocub",
      addons: { scopes: { tenant: [...DEFAULT_LARK_REGISTRATION_TENANT_SCOPES] } },
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
    for (const line of formatLarkProvisioningResult(provisioning, { appId: result.client_id, ...(domain ? { domain } : {}) })) {
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
    logger.log("Full Lark-native document creation requires lark-cli >= 1.0.41.");
    logger.log("For user-backed Docs/Drive/Sheets actions and bot-created document auto-grant, run these in a private terminal/chat:");
    logger.log("Run: node dist/src/index.js lark cli identity user-default");
    logger.log('Run: node dist/src/index.js lark auth start --recommend --domain docs,drive --scope "sheets:spreadsheet:create sheets:spreadsheet:write_only sheets:spreadsheet:read sheets:spreadsheet.meta:read"');
    logger.log("Run: node dist/src/index.js lark auth finish <device-code>");
    logger.log("Run: node dist/src/index.js lark auth status --verify");
  } catch (error) {
    logger.log(`lark-cli init skipped: ${error instanceof Error ? error.message : String(error)}`);
    logger.log("Full Lark-native functionality requires lark-cli >= 1.0.41; basic chat can still run, but docs/newgroup/Drive-style actions need the CLI.");
    logger.log("Install/update/preflight: node dist/src/index.js lark cli preflight --install --identity bot-only");
    logger.log("Run: node dist/src/index.js lark cli bind --identity bot-only");
    logger.log("After binding, switch to user-default and run `lark auth start`/`lark auth finish` for Docs/Drive/Sheets user-backed actions.");
  }
  logger.log("Run: node dist/src/index.js lark doctor");
  logger.log("Run: node dist/src/index.js lark run");

  return envPath;
}

/**
 * Drive one QR registration/update scan: guard the handshake (the SDK's HTTP
 * call has no socket timeout, so a blocked network used to hang here forever),
 * print the QR, and wait for the scan (bounded by the SDK's ~10min QR expiry).
 */
async function registerLarkAppWithQr(input: {
  register: (options: LarkWizardRegisterAppOptions) => Promise<LarkWizardRegisterAppResult>;
  generateQRCode: (url: string) => void;
  logger: LarkWizardLogger;
  registerOptions: Omit<LarkWizardRegisterAppOptions, "signal" | "onQRCodeReady" | "onStatusChange">;
}): Promise<LarkWizardRegisterAppResult> {
  const { logger, generateQRCode } = input;
  let qrReady = false;
  const controller = new AbortController();
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  const registration = input.register({
    ...input.registerOptions,
    signal: controller.signal,
    onQRCodeReady: (info) => {
      qrReady = true;
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
      }
      logger.log("");
      generateQRCode(info.url);
      logger.log("");
      logger.log(`QR expires in about ${Math.max(1, Math.round(info.expireIn / 60))} minute(s). Scan it with the Feishu/Lark app, or Ctrl-C to cancel.`);
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
  const handshakeGuard = new Promise<never>((_, reject) => {
    handshakeTimer = setTimeout(() => {
      if (!qrReady) {
        controller.abort();
        reject(new Error("Could not reach the Lark registration server (no QR within 30s). Check your network/VPN/proxy, then rerun the wizard."));
      }
    }, QR_HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();
  });
  try {
    return await Promise.race([registration, handshakeGuard]);
  } finally {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
    }
  }
}

/**
 * Add tenant scopes to an EXISTING app through the same QR flow: the confirm
 * page shows exactly the requested increments and the operator re-authorizes
 * with one scan. Personal-edition apps grant instantly; no console visit, no
 * bulk-import JSON. Credentials on disk are never rewritten — the scan must
 * come back with the configured app id, otherwise nothing is touched.
 */
export async function runLarkScopeAddWizard(
  env: LarkRuntimeEnv,
  scopes: readonly string[],
  logger: LarkWizardLogger = console,
  options: LarkWizardOptions = {},
): Promise<{ appId: string; scopes: string[] }> {
  const requested = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (requested.length === 0) {
    throw new Error("No scopes given. Example: lark scopes add im:message im:message.group_msg");
  }
  const loaded = await loadLarkRuntimeEnv(env);
  if (!loaded.LARK_APP_ID || !loaded.LARK_APP_SECRET) {
    throw new Error("No saved Lark credentials for this instance; run `lark wizard` first.");
  }
  const register = options.registerAppImpl ?? registerApp;
  const generateQRCode = options.generateQRCode ?? ((url: string) => qrcode.generate(url, { small: true }));
  logger.log(`Adding ${requested.length} scope(s) to app ${loaded.LARK_APP_ID}: ${requested.join(", ")}`);
  logger.log("Scan the QR code with the Feishu/Lark app; the confirm page lists exactly these increments.");

  const result = await registerLarkAppWithQr({
    register,
    generateQRCode,
    logger,
    registerOptions: {
      ...resolveLarkRegistrationDomains(loaded.LARK_DOMAIN),
      source: "tarocub",
      appId: loaded.LARK_APP_ID,
      addons: { scopes: { tenant: requested } },
    },
  });
  if (result.client_id !== loaded.LARK_APP_ID) {
    throw new Error(
      `The scan authorized app ${result.client_id}, not the configured ${loaded.LARK_APP_ID}; nothing was changed. Pick the configured app on the confirm page and retry.`,
    );
  }
  logger.log(`Scopes added to ${loaded.LARK_APP_ID}.`);
  try {
    const provisioning = await (options.provisionApp ?? provisionLarkApp)({
      appId: loaded.LARK_APP_ID,
      appSecret: loaded.LARK_APP_SECRET,
      ...(loaded.LARK_DOMAIN ? { domain: loaded.LARK_DOMAIN } : {}),
      logger,
    });
    for (const line of formatLarkProvisioningResult(provisioning, {
      appId: loaded.LARK_APP_ID,
      ...(loaded.LARK_DOMAIN ? { domain: loaded.LARK_DOMAIN } : {}),
    })) {
      logger.log(line);
    }
  } catch (error) {
    logger.log(`Lark permission provisioning check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  logger.log("Restart the instance so the running service sees the new scopes: `node dist/src/index.js lark service restart --defer`.");
  return { appId: loaded.LARK_APP_ID, scopes: requested };
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
