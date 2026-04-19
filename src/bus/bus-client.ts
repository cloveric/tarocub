import { isPeerAllowed, loadBusConfig } from "./bus-config.js";
import { lookupInstance, resolveChannelRoot } from "./bus-registry.js";
import {
  BusProtocolError,
  createBusTalkRequestEnvelope,
  parseBusTalkResponse,
} from "./bus-protocol.js";
import type { BusTalkResponse } from "./bus-server.js";

export interface BusDelegateInput {
  fromInstance: string;
  targetInstance: string;
  prompt: string;
  depth: number;
  stateDir: string;
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

  const body = JSON.stringify(createBusTalkRequestEnvelope({
    fromInstance: input.fromInstance,
    prompt: input.prompt,
    depth: input.depth + 1,
  }));

  const url = `http://127.0.0.1:${target.port}/api/talk`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60 * 1000);

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
      throw new BusProtocolError({
        message: `Delegation to "${input.targetInstance}" timed out after 60 seconds`,
        code: "timeout",
        retryable: true,
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
