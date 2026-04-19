import { z } from "zod";

import type { BusTalkRequest, BusTalkResponse } from "./bus-server.js";

export const BUS_PROTOCOL_VERSION = 1 as const;
export const BUS_PROTOCOL_CAPABILITIES = ["structured-errors", "retryable-errors"] as const;

export class BusProtocolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly fromInstance?: string;
  readonly protocolVersion?: number;

  constructor(input: {
    message: string;
    code: string;
    retryable: boolean;
    fromInstance?: string;
    protocolVersion?: number;
  }) {
    super(input.message);
    this.name = "BusProtocolError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.fromInstance = input.fromInstance;
    this.protocolVersion = input.protocolVersion;
  }
}

const BusCapabilitiesSchema = z.array(z.enum(BUS_PROTOCOL_CAPABILITIES)).optional();

const BusTalkRequestSchema = z.object({
  fromInstance: z.string().min(1),
  prompt: z.string(),
  depth: z.number().int().nonnegative(),
  protocolVersion: z.literal(BUS_PROTOCOL_VERSION).optional().default(BUS_PROTOCOL_VERSION),
  capabilities: BusCapabilitiesSchema,
  ext: z.record(z.string(), z.unknown()).optional(),
}).strict();

const BusTalkResponseSchema = z.object({
  success: z.boolean(),
  text: z.string().optional(),
  fromInstance: z.string().min(1).optional(),
  error: z.string().optional(),
  errorCode: z.string().min(1).optional(),
  retryable: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
  protocolVersion: z.literal(BUS_PROTOCOL_VERSION).optional().default(BUS_PROTOCOL_VERSION),
  capabilities: BusCapabilitiesSchema,
}).passthrough();

export function createBusTalkRequestEnvelope(input: BusTalkRequest): BusTalkRequest {
  return {
    ...input,
    protocolVersion: BUS_PROTOCOL_VERSION,
    capabilities: [...BUS_PROTOCOL_CAPABILITIES],
  };
}

export function createBusTalkResponseEnvelope(input: BusTalkResponse): BusTalkResponse {
  return {
    ...input,
    protocolVersion: BUS_PROTOCOL_VERSION,
    capabilities: [...BUS_PROTOCOL_CAPABILITIES],
  };
}

export function createBusErrorResponse(input: {
  fromInstance?: string;
  error: string;
  errorCode: string;
  retryable: boolean;
  durationMs?: number;
}): BusTalkResponse {
  return createBusTalkResponseEnvelope({
    success: false,
    text: "",
    fromInstance: input.fromInstance,
    error: input.error,
    errorCode: input.errorCode,
    retryable: input.retryable,
    durationMs: input.durationMs,
  });
}

export function parseBusTalkRequest(body: string): BusTalkRequest | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    const result = BusTalkRequestSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseBusTalkResponse(payload: unknown): BusTalkResponse | null {
  const result = BusTalkResponseSchema.safeParse(payload);
  if (!result.success) {
    return null;
  }

  return {
    ...result.data,
    text: result.data.text ?? "",
  };
}
