import type { CronRuntime } from "../runtime/cron-runtime.js";
import type { DeliveryAcceptedReceipt, DeliveryRejectedReceipt, DeliverySource } from "../telegram/delivery-ledger.js";
import type { TelegramApi } from "../telegram/api.js";
import type { Locale } from "../telegram/message-renderer.js";

export interface TelegramToolContext {
  cronRuntime: CronRuntime | null;
  stateDir: string;
  chatId: number;
  userId: number;
  chatType?: string;
  locale: Locale;
  instanceName?: string;
  updateId?: number;
  delivery?: {
    api: Pick<TelegramApi, "sendMessage" | "sendDocument" | "sendPhoto">;
    inboxDir: string;
    workspaceOverride?: string;
    requestOutputDir?: string;
    source?: DeliverySource;
    allowAnyAbsolutePath?: boolean;
    notifyRejected?: boolean;
    deliverTelegramResponse?: (
      api: Pick<TelegramApi, "sendMessage" | "sendDocument" | "sendPhoto">,
      chatId: number,
      text: string,
      inboxDir: string,
      workspaceOverride: string | undefined,
      requestOutputDir: string | undefined,
      locale: Locale,
      options?: {
        onFileAccepted?: (sourcePath: string) => void;
        onDeliveryAccepted?: (receipt: DeliveryAcceptedReceipt) => void;
        onDeliveryRejected?: (receipt: DeliveryRejectedReceipt) => void;
        source?: DeliverySource;
        allowAnyAbsolutePath?: boolean;
        notifyRejected?: boolean;
      },
    ) => Promise<number>;
    onFileAccepted?: (sourcePath: string) => void;
    onDeliveryAccepted?: (receipt: DeliveryAcceptedReceipt) => void;
    onDeliveryRejected?: (receipt: DeliveryRejectedReceipt) => void;
  };
}

export interface TelegramToolResult {
  ok: boolean;
  status?: "accepted" | "rejected" | "partial";
  message: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecuteTelegramToolInput {
  name: string;
  payload: unknown;
  context: TelegramToolContext;
}

export interface TelegramToolInputSchema {
  type: "object";
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  oneOf?: Array<Record<string, unknown>>;
  additionalProperties?: boolean;
}

export interface TelegramToolDefinition {
  name: string;
  description: string;
  examples?: Record<string, unknown>[];
  inputSchema?: TelegramToolInputSchema;
  execute: (payload: unknown, context: TelegramToolContext) => Promise<TelegramToolResult>;
}
