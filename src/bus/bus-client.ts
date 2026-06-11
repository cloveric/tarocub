import { isPeerAllowed, loadBusConfig } from "./bus-config.js";
import { lookupInstance, resolveChannelRoot } from "./bus-registry.js";
import {
  BusProtocolError,
  createBusTalkRequestEnvelope,
  parseBusTalkResponse,
} from "./bus-protocol.js";
import { MAX_BODY_BYTES, type BusTalkResponse } from "./bus-server.js";

export interface BusDelegateInput {
  fromInstance: string;
  targetInstance: string;
  prompt: string;
  depth: number;
  stateDir: string;
  timeoutMs?: number;
}

// A delegated turn runs a full engine turn on the remote instance, which routinely
// exceeds 60s. The old 60s default silently aborted long /ask /chain /verify /board
// runs (and, being retryable, risked re-running them remotely). Default to 30min,
// overridable via CCTB_DELEGATION_TIMEOUT_MS for operators who want a tighter cap.
export const DEFAULT_DELEGATION_TIMEOUT_MS = 30 * 60_000;

export function resolveDefaultDelegationTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.CCTB_DELEGATION_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_DELEGATION_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DELEGATION_TIMEOUT_MS;
}

export async function delegateToInstance(input: BusDelegateInput): Promise<BusTalkResponse> {
  const busConfig = await loadBusConfig(input.stateDir);
  if (!busConfig) {
    throw new BusProtocolError({
      message: "Bus is not enabled on this instance",
      code: "bus_disabled",
      retryable: false,
    });
  }

  if (!isPeerAllowed(busConfig, input.targetInstance)) {
    throw new BusProtocolError({
      message: `Instance "${input.targetInstance}" is not in the peer list`,
      code: "peer_not_allowed",
      retryable: false,
    });
  }

  if (input.depth >= busConfig.maxDepth) {
    throw new BusProtocolError({
      message: `Max delegation depth (${busConfig.maxDepth}) exceeded`,
      code: "max_depth_exceeded",
      retryable: false,
    });
  }

  const body = JSON.stringify(createBusTalkRequestEnvelope({
    fromInstance: input.fromInstance,
    prompt: input.prompt,
    depth: input.depth + 1,
  }));

  // Reject oversized payloads locally (before the network round trip) so we don't
  // depend on the server's 413 flush racing a socket teardown — same non-retryable
  // semantics, no wasted connection.
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new BusProtocolError({
      message: `Delegation to "${input.targetInstance}" exceeds the ${MAX_BODY_BYTES}-byte request limit`,
      code: "request_too_large",
      retryable: false,
      fromInstance: input.targetInstance,
    });
  }

  const channelRoot = resolveChannelRoot(input.stateDir);
  // lookupInstance now probes the bus port, so a returned entry means the
  // server is actually reachable. A redundant PID check here would only
  // add false positives (PID alive but bus dead) — ECONNREFUSED from the
  // fetch() below gives us a more accurate error anyway.
  const target = await lookupInstance(channelRoot, input.targetInstance);
  if (!target) {
    throw new BusProtocolError({
      message: `Instance "${input.targetInstance}" is not running or not registered on the bus`,
      code: "instance_unavailable",
      retryable: true,
    });
  }

  const url = `http://127.0.0.1:${target.port}/api/talk`;
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? resolveDefaultDelegationTimeoutMs();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (target.secret) {
    headers.Authorization = `Bearer ${target.secret}`;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new BusProtocolError({
        message: `Invalid bus response from "${input.targetInstance}"`,
        code: "invalid_response",
        retryable: true,
        fromInstance: input.targetInstance,
      });
    }

    const parsed = parseBusTalkResponse(payload);
    if (!parsed) {
      throw new BusProtocolError({
        message: `Invalid bus response from "${input.targetInstance}"`,
        code: "invalid_response",
        retryable: true,
        fromInstance: input.targetInstance,
      });
    }

    if (!parsed.success) {
      throw new BusProtocolError({
        message: parsed.error ?? `Delegation to "${input.targetInstance}" failed`,
        code: parsed.errorCode ?? "unknown",
        retryable: parsed.retryable ?? false,
        fromInstance: parsed.fromInstance ?? input.targetInstance,
        protocolVersion: parsed.protocolVersion,
      });
    }

    return parsed;
  } catch (error) {
    if (error instanceof BusProtocolError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      // Not retryable: the remote turn may still be running, so an automatic retry
      // would double-execute it. The operator can resend deliberately if needed.
      throw new BusProtocolError({
        message: `Delegation to "${input.targetInstance}" timed out after ${Math.ceil(timeoutMs / 1000)} seconds`,
        code: "timeout",
        retryable: false,
        fromInstance: input.targetInstance,
      });
    }
    throw new BusProtocolError({
      message: `Delegation to "${input.targetInstance}" could not reach the bus server`,
      code: "instance_unavailable",
      retryable: true,
      fromInstance: input.targetInstance,
    });
  } finally {
    clearTimeout(timeout);
  }
}
